//! Video frames (src/lib/video-frames.ts). A clip attached to a model that can see is sampled into a strip of stills
//! (about 2 per second, at most 32, longest edge 768, JPEG quality 72) instead of shipping the whole MP4.
//!
//! The web asks the browser's `<video>` element to decode and seek; the desktop has no browser, and decoding MP4 is not
//! something to hand-port. So the sampling plan, the sizes and the JPEG step are ported as they are, and the decoder is
//! the `ffmpeg` program when it is installed (never bundled). Like the web, when the clip cannot be decoded the caller
//! falls back to sending the native clip.

use super::attachments::{MAX_VIDEO_BYTES, Video, read_video_file, video_too_big};
use super::data_url;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

/// Target sampling rate before the frame cap.
pub const TARGET_FPS: f64 = 2.0;
/// Hard cap; past it the frames spread out to cover the whole clip.
pub const MAX_FRAMES: usize = 32;
/// Longest edge of any sampled frame.
pub const MAX_DIM: u32 = 768;
pub const JPEG_QUALITY: u8 = 72;
/// The web waits 10 s for the video's metadata.
const METADATA_TIMEOUT: Duration = Duration::from_secs(10);
/// The web waits 4 s for a seek; a program has to start first, so a frame gets longer.
const FRAME_TIMEOUT: Duration = Duration::from_secs(10);

/// One sampled still, stored on a message as the web's `{ dataUrl, t }`.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    /// JPEG data URL.
    pub data_url: String,
    /// Seconds into the clip.
    pub t: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Frames {
    pub frames: Vec<Frame>,
    pub duration_sec: f64,
    /// Uniform spacing between frames in seconds.
    pub interval_sec: f64,
}

/// How many frames and how far apart: full coverage, so past the cap the interval stretches and the last frame still
/// lands near the end of the clip.
pub fn sampling_plan(duration: f64) -> Result<(usize, f64), String> {
    if !duration.is_finite() || duration <= 0.0 {
        return Err("the clip has no usable duration".into());
    }
    let wanted = MAX_FRAMES.min(((duration * TARGET_FPS + 0.5).floor() as usize).max(1));
    Ok((wanted, duration / wanted as f64))
}

/// Where in the clip frame `i` is taken.
pub fn frame_time(duration: f64, interval: f64, i: usize) -> f64 {
    (duration - 1e-3).min(i as f64 * interval)
}

/// The size a frame is scaled to: never larger than the clip, longest edge at most `MAX_DIM`.
pub fn frame_size(width: u32, height: u32) -> (u32, u32) {
    let (vw, vh) = (if width == 0 { MAX_DIM } else { width } as f64, if height == 0 { MAX_DIM } else { height } as f64);
    let scale = (MAX_DIM as f64 / vw.max(vh)).min(1.0);
    (((vw * scale).round() as u32).max(1), ((vh * scale).round() as u32).max(1))
}

fn command(program: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // no console window flashing up
    cmd
}

/// The clip's length in seconds, read from what `ffmpeg -i` prints about it.
async fn duration_of(ffmpeg: &str, path: &Path) -> Result<f64, String> {
    let mut cmd = command(ffmpeg);
    cmd.args(["-hide_banner", "-i"]).arg(path).stdout(Stdio::null()).stderr(Stdio::piped());
    let out = match tokio::time::timeout(METADATA_TIMEOUT, cmd.output()).await {
        Err(_) => return Err("the video's metadata never loaded".into()),
        Ok(Err(e)) => return Err(format!("{ffmpeg} could not be started ({e}), so the clip cannot be decoded here")),
        Ok(Ok(out)) => out,
    };
    let info = String::from_utf8_lossy(&out.stderr);
    let found = regex::Regex::new(r"Duration: ([0-9]+):([0-9]+):([0-9]+(?:\.[0-9]+)?)").unwrap().captures(&info);
    let Some(c) = found else { return Err(if info.contains("Video:") { "the clip has no usable duration" } else { "this program cannot decode this video" }.into()) };
    Ok(c[1].parse::<f64>().unwrap_or(0.0) * 3600.0 + c[2].parse::<f64>().unwrap_or(0.0) * 60.0 + c[3].parse::<f64>().unwrap_or(0.0))
}

/// One still, scaled to fit `MAX_DIM`, as a JPEG data URL.
async fn frame_at(ffmpeg: &str, path: &Path, t: f64) -> Result<String, String> {
    let mut cmd = command(ffmpeg);
    cmd.args(["-v", "error", "-ss", &format!("{t:.3}"), "-i"]).arg(path);
    cmd.args(["-frames:v", "1", "-vf", &format!("scale=w='min({MAX_DIM},iw)':h='min({MAX_DIM},ih)':force_original_aspect_ratio=decrease"), "-f", "image2pipe", "-c:v", "png", "-"]).stdout(Stdio::piped()).stderr(Stdio::null());
    let timed_out = || format!("seek to {t:.2}s timed out");
    let out = tokio::time::timeout(FRAME_TIMEOUT, cmd.output()).await.map_err(|_| timed_out())?.map_err(|_| "seek failed".to_string())?;
    let picture = image::load_from_memory(&out.stdout).map_err(|_| "seek failed".to_string())?.to_rgb8();
    let mut jpeg = Vec::new();
    use image::ImageEncoder;
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY).write_image(picture.as_raw(), picture.width(), picture.height(), image::ExtendedColorType::Rgb8).map_err(|_| "seek failed".to_string())?;
    Ok(data_url("image/jpeg", &jpeg))
}

/// Samples a clip into stills with `ffmpeg`. `progress` hears (done, total) after every frame.
pub async fn extract_video_frames(ffmpeg: &str, path: &Path, mut progress: impl FnMut(usize, usize)) -> Result<Frames, String> {
    let duration = duration_of(ffmpeg, path).await?;
    let (wanted, interval) = sampling_plan(duration)?;
    let mut frames = Vec::new();
    for i in 0..wanted {
        let t = frame_time(duration, interval, i);
        frames.push(Frame { data_url: frame_at(ffmpeg, path, t).await?, t });
        progress(i + 1, wanted);
    }
    Ok(Frames { frames, duration_sec: duration, interval_sec: interval })
}

/// A clip as sampled stills, the fast path. Falls back to the native clip when it cannot be decoded, under the same name,
/// so either mode can be switched to the other.
pub async fn read_video_file_frames(ffmpeg: &str, path: &Path, progress: impl FnMut(usize, usize)) -> Result<Video, String> {
    let name = path.file_name().map_or_else(|| "file".to_string(), |n| n.to_string_lossy().into_owned());
    let size = std::fs::metadata(path).map_err(|_| format!("Couldn't read {name}"))?.len();
    if size > MAX_VIDEO_BYTES {
        return Err(video_too_big(&name, size));
    }
    match extract_video_frames(ffmpeg, path, progress).await {
        Ok(r) => Ok(Video { name, size, data_url: None, frames: r.frames, duration_sec: r.duration_sec, frame_interval_sec: r.interval_sec }),
        Err(_) => read_video_file(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plan_matches_the_web() {
        assert_eq!(sampling_plan(0.2).unwrap(), (1, 0.2));
        assert_eq!(sampling_plan(5.0).unwrap(), (10, 0.5));
        assert_eq!(sampling_plan(100.0).unwrap(), (32, 3.125));
        assert_eq!(sampling_plan(0.0).unwrap_err(), "the clip has no usable duration");
        assert_eq!(sampling_plan(f64::NAN).unwrap_err(), "the clip has no usable duration");
        assert_eq!((frame_time(5.0, 0.5, 0), frame_time(5.0, 0.5, 3), frame_time(1.0, 1.0, 1)), (0.0, 1.5, 0.999));
        assert_eq!((frame_size(1920, 1080), frame_size(320, 240), frame_size(1000, 3000), frame_size(0, 0)), ((768, 432), (320, 240), (256, 768), (768, 768)));
    }

    #[tokio::test]
    async fn an_undecodable_clip_falls_back_to_the_native_one() {
        let dir = std::env::temp_dir().join(format!("apim-video-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("clip.mp4"), [0u8, 1, 2]).unwrap();
        let err = extract_video_frames("no-such-ffmpeg-program", &dir.join("clip.mp4"), |_, _| {}).await.unwrap_err();
        assert!(err.contains("could not be started"), "{err}");
        let video = read_video_file_frames("no-such-ffmpeg-program", &dir.join("clip.mp4"), |_, _| {}).await.unwrap();
        assert_eq!((video.data_url.as_deref(), video.frames.len()), (Some("data:video/mp4;base64,AAEC"), 0));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Needs ffmpeg on the PATH; skipped without it.
    #[tokio::test]
    async fn a_real_clip_becomes_frames() {
        let dir = std::env::temp_dir().join(format!("apim-video-real-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("t.mp4");
        let made = command("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10", "-pix_fmt", "yuv420p"]).arg(&clip).status().await;
        if !made.is_ok_and(|s| s.success()) {
            return;
        }
        let mut seen = Vec::new();
        let video = read_video_file_frames("ffmpeg", &clip, |done, total| seen.push((done, total))).await.unwrap();
        assert_eq!((video.data_url.is_none(), video.frames.len(), video.frame_interval_sec, seen.last().copied()), (true, 6, 0.5, Some((6, 6))));
        assert!((video.duration_sec - 3.0).abs() < 0.1, "{}", video.duration_sec);
        let first = &video.frames[0];
        let jpeg = image::load_from_memory(&crate::media::base64_lenient(first.data_url.strip_prefix("data:image/jpeg;base64,").unwrap())).unwrap();
        assert_eq!((first.t, jpeg.width(), jpeg.height()), (0.0, 320, 240));
        let _ = std::fs::remove_dir_all(dir);
    }
}
