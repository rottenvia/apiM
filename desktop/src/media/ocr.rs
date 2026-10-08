//! Free local OCR for models that cannot see (src/lib/ocr.ts). With no vision key, or one that is out of credit, the
//! visible characters are scraped instead of refusing the picture.
//!
//! The web runs `tesseract` when it is installed and otherwise tesseract.js, a WebAssembly copy that downloads its
//! language data. The desktop does the same discovery and invocation (`tesseract <file> stdout -l eng --psm 6`, 45 s);
//! the JavaScript fallback has no Rust twin, so without the program the answer is the web's "Local OCR failed" wording.

use super::vision::{DEFAULT_VISION_MODEL, VisionResult, describe_image};
use super::{base64_lenient, js_trim};
use std::process::Stdio;
use std::time::Duration;

pub const OCR_NOTE: &str = "[OCR — free local scrape of visible text only. Layout and non-text details are not described. Add an OpenAI vision key in Settings for a full description.]";
pub const OCR_EMPTY: &str = "[OCR found no readable text. A photo or a UI without labels needs an OpenAI vision key in Settings.]";
/// The program looked up on the PATH.
pub const TESSERACT: &str = "tesseract";
const MAX_OCR_BYTES: usize = 8 * 1024 * 1024;

/// Trailing blanks off every line, runs of blank lines squeezed to one.
pub fn tidy_ocr_text(raw: &str) -> String {
    let text = raw.replace("\r\n", "\n").split('\n').map(|l| l.trim_end_matches([' ', '\t'])).collect::<Vec<_>>().join("\n");
    js_trim(&regex::Regex::new(r"\n{3,}").unwrap().replace_all(&text, "\n\n")).to_string()
}

/// Scraped text with a note saying it is not a full description.
pub fn format_ocr_description(raw: &str) -> String {
    let text = tidy_ocr_text(raw);
    if text.is_empty() { OCR_EMPTY.to_string() } else { format!("{text}\n\n{OCR_NOTE}") }
}

pub fn is_ocr_description(text: Option<&str>) -> bool {
    text.is_some_and(|t| t.contains("[OCR —") || t.contains("[OCR found"))
}

/// The bytes and file extension inside an image data URL.
fn data_url_to_bytes(data_url: &str) -> Option<(Vec<u8>, &'static str)> {
    let m = regex::Regex::new(r"(?i)^data:(image/[A-Za-z0-9_+.-]+);base64,(.+)$").unwrap().captures(data_url)?;
    let mime = m[1].to_lowercase();
    let ext = if mime.contains("jpeg") || mime.contains("jpg") {
        "jpg"
    } else if mime.contains("webp") {
        "webp"
    } else if mime.contains("gif") {
        "gif"
    } else if mime.contains("bmp") {
        "bmp"
    } else {
        "png"
    };
    Some((base64_lenient(&m[2]), ext))
}

/// The system Tesseract, when installed: None if it is missing, fails or takes longer than 45 seconds.
async fn ocr_with_cli(program: &str, bytes: &[u8], ext: &str) -> Option<String> {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    // The web leaves its temporary folder behind; this one is removed.
    let dir = std::env::temp_dir().join(format!("apim-ocr-{}-{}", std::process::id(), COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join(format!("shot.{ext}"));
    let mut cmd = tokio::process::Command::new(program);
    cmd.arg(&file).args(["stdout", "-l", "eng", "--psm", "6"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // no console window flashing up
    let out = match std::fs::write(&file, bytes) {
        Ok(()) => tokio::time::timeout(Duration::from_secs(45), cmd.output()).await,
        Err(_) => return None,
    };
    let _ = std::fs::remove_dir_all(&dir);
    match out {
        Ok(Ok(o)) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).into_owned()),
        _ => None,
    }
}

/// The text in a picture, or why there is none.
pub async fn extract_text_from_image(program: &str, data_url: &str) -> Result<String, String> {
    let Some((bytes, ext)) = data_url_to_bytes(data_url) else { return Err("Couldn't decode the image for OCR".into()) };
    if bytes.len() > MAX_OCR_BYTES {
        return Err("Image is too large for OCR".into());
    }
    if let Some(text) = ocr_with_cli(program, &bytes, ext).await {
        return Ok(text);
    }
    // ponytail: the web falls back to tesseract.js here; no WebAssembly OCR in this build, so a missing program is a failure.
    Err(format!("Local OCR failed: {program} was not found or did not finish, and there is no built-in OCR engine"))
}

pub async fn describe_with_ocr(program: &str, data_url: &str) -> VisionResult {
    match extract_text_from_image(program, data_url).await {
        Err(e) => VisionResult { error: Some(e), source: Some("ocr"), ..Default::default() },
        Ok(text) => VisionResult { description: Some(format_ocr_description(&text)), source: Some("ocr"), ..Default::default() },
    }
}

/// OpenAI vision when a key is present and working; free local OCR otherwise. When both fail, the vision error is the
/// one reported.
pub async fn describe_image_with_fallback(client: &reqwest::Client, base_url: &str, program: &str, data_url: &str, api_key: Option<&str>, model: &str, hint: Option<&str>) -> VisionResult {
    let key = api_key.map(js_trim).unwrap_or("");
    if key.is_empty() {
        return describe_with_ocr(program, data_url).await;
    }
    let model = if model.is_empty() { DEFAULT_VISION_MODEL } else { model };
    let vision = describe_image(client, base_url, data_url, key, model, hint).await;
    if vision.description.is_some() {
        return VisionResult { source: Some("vision"), ..vision };
    }
    let ocr = describe_with_ocr(program, data_url).await;
    if ocr.description.is_some() { ocr } else { vision }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::vision::stub::serve;

    #[test]
    fn scraped_text_is_tidied_and_flagged() {
        assert_eq!(tidy_ocr_text("a  \r\n\r\n\r\n\r\nb\t\n"), "a\n\nb");
        assert_eq!(format_ocr_description("Hello  \n"), format!("Hello\n\n{OCR_NOTE}"));
        assert_eq!(format_ocr_description(" \n "), OCR_EMPTY);
        assert!(is_ocr_description(Some(&format_ocr_description("x"))) && is_ocr_description(Some(OCR_EMPTY)) && !is_ocr_description(Some("plain")) && !is_ocr_description(None));
    }

    #[test]
    fn data_urls_are_decoded_like_node() {
        assert_eq!(data_url_to_bytes("data:image/JPEG;base64,AQID"), Some((vec![1, 2, 3], "jpg")));
        assert_eq!(data_url_to_bytes("data:image/svg+xml;base64,AQID"), Some((vec![1, 2, 3], "png")));
        assert_eq!(data_url_to_bytes("data:text/plain;base64,AQID"), None);
        assert_eq!(data_url_to_bytes("data:image/png;base64,AQ\nID"), None);
    }

    #[tokio::test]
    async fn without_the_program_the_failure_has_the_webs_prefix() {
        const NONE: &str = "no-such-tesseract-program";
        assert_eq!(extract_text_from_image(NONE, "nope").await.unwrap_err(), "Couldn't decode the image for OCR");
        let big = format!("data:image/png;base64,{}", "A".repeat(12 * 1024 * 1024));
        assert_eq!(extract_text_from_image(NONE, &big).await.unwrap_err(), "Image is too large for OCR");
        let r = describe_with_ocr(NONE, "data:image/png;base64,AQID").await;
        assert!(r.description.is_none() && r.source == Some("ocr") && r.error.unwrap().starts_with("Local OCR failed"));
    }

    #[tokio::test]
    async fn vision_first_then_ocr_and_the_vision_error_wins_when_both_fail() {
        const NONE: &str = "no-such-tesseract-program";
        let client = reqwest::Client::new();
        let (base, seen) = serve("200 OK", r#"{"choices":[{"message":{"content":"a cat"}}]}"#);
        let ok = describe_image_with_fallback(&client, &base, NONE, "data:image/png;base64,AQID", Some(" sk "), "", None).await;
        assert_eq!(ok, VisionResult { description: Some("a cat".into()), source: Some("vision"), ..Default::default() });
        assert!(seen.join().unwrap().contains("\"model\":\"gpt-4o-mini\""));
        let (base, seen) = serve("429 Too Many Requests", "{}");
        let both = describe_image_with_fallback(&client, &base, NONE, "data:image/png;base64,AQID", Some("sk"), "m", None).await;
        assert_eq!(both.error.as_deref(), Some("Vision API rate limit reached. Try again shortly."));
        let _ = seen.join();
        let keyless = describe_image_with_fallback(&client, "http://127.0.0.1:1", NONE, "data:image/png;base64,AQID", None, "m", None).await;
        assert_eq!(keyless.source, Some("ocr"));
    }
}

#[cfg(test)]
mod parity {
    use super::*;
    use crate::media::fixtures::ALL;

    #[test]
    fn tidying_matches_the_web() {
        for c in ALL["ocr"].as_array().unwrap() {
            let raw = c[0].as_str().unwrap();
            assert_eq!((tidy_ocr_text(raw).as_str(), format_ocr_description(raw).as_str()), (c[1].as_str().unwrap(), c[2].as_str().unwrap()), "{c}");
        }
        assert_eq!((OCR_NOTE, OCR_EMPTY), (ALL["ocrNote"][0].as_str().unwrap(), ALL["ocrNote"][1].as_str().unwrap()));
    }
}
