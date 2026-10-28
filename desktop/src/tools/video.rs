//! Agentic video watching, after Gemini's agentic mode and the user's own `eyes` tool: the model navigates a video
//! instead of being fed every frame. A cheap overview of the whole thing first (one contact sheet, a text map), then
//! the stretches (`video_look`) and single frames (`video_frame`) that matter, the cuts (`video_scenes`) and the speech
//! (`video_transcript`) to decide where to look. Every tool ends in text or a picture, which is all a model takes in.
//!
//! ffmpeg, ffprobe and yt-dlp are the programs found on PATH (never bundled). Every call runs with no console window
//! and a timeout, on tokio's process support, and the picture work runs on the blocking pool.
//!
//! Timestamp labels are drawn in Rust, not with ffmpeg's drawtext: drawtext needs ffmpeg built with freetype, a font
//! file at a path whose colon must be escaped for the filter syntax (`C\:/Windows/Fonts/arial.ttf`), and a second
//! escaping level for the text itself. A label is only digits and a colon, so a 5x7 bitmap font in `tag` has no
//! dependency, no escaping, and looks the same on every machine. The grid is composed with the `image` crate.

use super::{Ctx, Output, num_arg, str_arg};
use image::{DynamicImage, ImageEncoder, Rgba, RgbaImage, imageops::FilterType};
use regex::Regex;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

pub const NAMES: &[&str] = &["video_overview", "video_look", "video_frame", "video_scenes", "video_transcript"];

/// Width of every contact sheet, and the gap around each frame in it.
const SHEET_W: u32 = 1280;
const GAP: u32 = 2;
const OVERVIEW_FRAMES: usize = 16;
const DEFAULT_LOOK: usize = 12;
const MAX_LOOK: usize = 24;
const MAX_SCENES: usize = 60;
/// A frame is enlarged at most this much, to a long edge of `ZOOM_EDGE`; a whole frame is only shrunk above `FULL_EDGE`.
const MAX_ZOOM: f64 = 4.0;
const ZOOM_EDGE: f64 = 1280.0;
const FULL_EDGE: u32 = 1920;
/// Frames fetched at once: ffmpeg is a process per frame, and a handful keeps a laptop responsive.
const PARALLEL: usize = 6;

pub fn schemas() -> Vec<Value> {
    let source = json!({ "type": "string", "description": "A path to a video in the workspace, or an http(s) URL (downloaded once with yt-dlp, 720p at most, into .video/)." });
    vec![
        json!({ "type": "function", "function": {
            "name": "video_overview",
            "description": "Start here to watch a video. Gives its length, size, frame rate, audio, title, chapters and whether subtitles exist, and one contact sheet: 16 frames evenly spaced over the whole video, each labeled with its time (mm:ss). Then narrow down: video_scenes for the cuts, video_look for a stretch, video_frame for detail you must read, video_transcript for speech. Cite timestamps in your answer.",
            "parameters": { "type": "object", "properties": { "source": source }, "required": ["source"] }
        }}),
        json!({ "type": "function", "function": {
            "name": "video_look",
            "description": "See what happens in one stretch of a video: a contact sheet of frames evenly spaced between `start` and `end`, each labeled with its time. Narrower stretches show finer motion; use it after video_overview or video_scenes has pointed at the stretch, and cite the timestamps you saw.",
            "parameters": { "type": "object", "properties": {
                "source": source,
                "start": { "type": "string", "description": "Seconds (\"90\") or \"mm:ss\" (\"1:30\")." },
                "end": { "type": "string", "description": "Seconds or \"mm:ss\". Default: the end of the video." },
                "frames": { "type": "integer", "description": "How many frames, 1 to 24. Default 12." }
            }, "required": ["source", "start"] }
        }}),
        json!({ "type": "function", "function": {
            "name": "video_frame",
            "description": "One frame of a video at full resolution, for reading small text or detail. `crop` takes a box as fractions of the frame (0 to 1, from the top-left) and enlarges it: read the box off a contact sheet or an earlier frame, then ask for a tighter one. Cite the time in your answer.",
            "parameters": { "type": "object", "properties": {
                "source": source,
                "at": { "type": "string", "description": "Seconds or \"mm:ss\"." },
                "crop": { "type": "object", "description": "A box as fractions of the frame: x and y of its top-left corner, w and h its size. {\"x\":0.5,\"y\":0,\"w\":0.5,\"h\":0.25} is the top-right quarter strip.", "properties": {
                    "x": { "type": "number" }, "y": { "type": "number" }, "w": { "type": "number" }, "h": { "type": "number" }
                }, "required": ["x", "y", "w", "h"] }
            }, "required": ["source", "at"] }
        }}),
        json!({ "type": "function", "function": {
            "name": "video_scenes",
            "description": "The times where the picture changes (cuts, new slides, a new screen), as text, at most 60, strongest first if there are more. It compares brightness, so a change between two equally bright pictures can be missed. A map of where to look: take these times to video_look or video_frame, and call video_overview first for the whole video. A screen recording changes gradually, so lower the threshold for it.",
            "parameters": { "type": "object", "properties": {
                "source": source,
                "threshold": { "type": "number", "description": "0 to 1: how different a frame must be from the one before. Default 0.3; 0.1 finds subtler changes." }
            }, "required": ["source"] }
        }}),
        json!({ "type": "function", "function": {
            "name": "video_transcript",
            "description": "What is said in a video, with timestamps: its subtitles when it has them (downloaded for a URL, or embedded), else a local speech transcription when that is installed, else it says no transcript is available. Read it early for any talk or tutorial, then use the times in it to video_look at the moments it names. `start` and `end` read a part; the result is cached. Cite timestamps.",
            "parameters": { "type": "object", "properties": {
                "source": source,
                "start": { "type": "string", "description": "Seconds or \"mm:ss\". Default: the beginning." },
                "end": { "type": "string", "description": "Seconds or \"mm:ss\". Default: the end." }
            }, "required": ["source"] }
        }}),
    ]
}

pub async fn run(name: &str, ctx: &Ctx, args: &Value) -> Output {
    match name {
        "video_overview" => overview(ctx, args).await,
        "video_look" => look(ctx, args).await,
        "video_frame" => frame(ctx, args).await,
        "video_scenes" => scenes(ctx, args).await,
        _ => transcript(ctx, args).await,
    }
}

// ---------------------------------------------------------------- programs

fn missing(program: &str) -> String {
    match program {
        "yt-dlp" => "yt-dlp is not installed or not on PATH, so a URL cannot be fetched: install it (winget install yt-dlp.yt-dlp, or pip install yt-dlp) and try again.".into(),
        "python" => "Python is not installed or not on PATH.".into(),
        _ => format!("{program} is not installed or not on PATH: install FFmpeg (winget install Gyan.FFmpeg), which brings ffmpeg and ffprobe, and try again."),
    }
}

/// The last `n` characters of a program's complaint: the reason is at the end.
fn tail(text: &str, n: usize) -> String {
    let text = text.trim();
    let skip = text.chars().count().saturating_sub(n);
    text.chars().skip(skip).collect()
}

/// Runs a program to its end with no console window. A timeout drops the wait, and dropping kills the child
/// (`kill_on_drop`), so nothing is left running when a tool gives up.
async fn exec(program: &str, args: &[String], secs: u64) -> Result<std::process::Output, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // no console window flashing up
    let child = cmd.spawn().map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { missing(program) } else { format!("{program} could not be started: {e}") })?;
    match tokio::time::timeout(Duration::from_secs(secs), child.wait_with_output()).await {
        Ok(Ok(out)) => Ok(out),
        Ok(Err(e)) => Err(format!("{program} failed: {e}")),
        Err(_) => Err(format!("{program} took longer than {secs} s and was stopped.")),
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn on_path(name: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(format!("{name}.exe")).is_file() || dir.join(name).is_file()))
}

// ---------------------------------------------------------------- time

/// Seconds from a number or text: "90", "90s", "1:30", "1:02:03", "1:30.5".
fn seconds(v: &Value) -> Option<f64> {
    if let Some(n) = v.as_f64() {
        return Some(n).filter(|n| n.is_finite() && *n >= 0.0);
    }
    let text = v.as_str()?.trim().trim_end_matches('s');
    text.split(':').try_fold(0.0, |total, part| part.trim().parse::<f64>().ok().filter(|n| n.is_finite() && *n >= 0.0).map(|n| total * 60.0 + n))
}

/// An optional time argument. A model that fills every field sends "" for the ones it means to leave out.
fn time_arg(args: &Value, key: &str) -> Result<Option<f64>, String> {
    match &args[key] {
        Value::Null => Ok(None),
        Value::String(text) if text.trim().is_empty() => Ok(None),
        v => seconds(v).map(Some).ok_or_else(|| format!("{key} must be seconds (\"90\") or mm:ss (\"1:30\"), not {v}.")),
    }
}

/// mm:ss, or h:mm:ss from an hour on. Whole seconds are cut, not rounded, as a player shows them: a label never runs ahead of its frame.
fn clock(t: f64) -> String {
    let total = (t.max(0.0) + 1e-3) as u64;
    if total >= 3600 { format!("{}:{:02}:{:02}", total / 3600, total / 60 % 60, total % 60) } else { format!("{:02}:{:02}", total / 60, total % 60) }
}

/// A moment inside the video, for the seek: the very last instant has no frame to decode.
fn clamp_t(t: f64, dur: f64) -> f64 {
    t.clamp(0.0, (dur - 0.1).max(0.0))
}

// ---------------------------------------------------------------- the source

struct Media {
    path: PathBuf,
    /// `.video/<id>/`: everything made from this video is kept here (a URL's download and subtitles too).
    dir: PathBuf,
    /// As the model named it.
    shown: String,
    title: Option<String>,
    chapters: Vec<(f64, String)>,
    url: bool,
}

struct Info {
    dur: f64,
    w: u64,
    h: u64,
    fps: f64,
    audio: bool,
    subs: usize,
    title: Option<String>,
    chapters: Vec<(f64, String)>,
}

fn short_hash(text: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(text.as_bytes()))[..12].to_string()
}

fn relative(ctx: &Ctx, p: &Path) -> String {
    p.strip_prefix(&ctx.root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

/// A downloaded video in `dir`. Exactly `media.<ext>`: yt-dlp leaves `media.f137.mp4` parts when a merge fails.
fn downloaded(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| p.file_stem().is_some_and(|n| n == "media") && p.extension().and_then(|e| e.to_str()).is_some_and(|e| ["mp4", "mkv", "webm", "mov", "m4v", "avi", "flv"].contains(&e)))
}

/// The video behind `source`: a file inside the workspace, or a URL downloaded once.
async fn open(ctx: &Ctx, args: &Value) -> Result<Media, String> {
    let src = str_arg(args, "source").trim();
    if src.is_empty() {
        return Err("source is required: a path to a video in the workspace, or an http(s) URL.".into());
    }
    let make_dir = |id: &str| {
        let dir = ctx.root.join(".video").join(id);
        std::fs::create_dir_all(&dir).map(|_| dir.clone()).map_err(|e| format!("Cannot create {}: {e}", dir.display()))
    };
    if src.starts_with("http://") || src.starts_with("https://") {
        let dir = make_dir(&short_hash(src))?;
        if downloaded(&dir).is_none() {
            // Not the user's own machine or network: the same wall fetch_url has.
            crate::search::assert_public_url_resolved(src, false).await?;
            // ponytail: `--js-runtimes` is for yt-dlp 2025.11 and later; an older one rejects the option. Drop it if that matters.
            let mut a: Vec<String> = ["--no-playlist", "--no-progress", "--ignore-errors", "--socket-timeout", "30", "-f", "bv*[height<=720]+ba/b[height<=720]/b", "-S", "ext:mp4:m4a", "--merge-output-format", "mp4", "--write-info-json", "--write-subs", "--write-auto-subs", "--sub-langs", "en,en-US,en-GB,.*-orig", "--sub-format", "json3/vtt/srt/best"].map(String::from).to_vec();
            if !on_path("deno") && on_path("node") {
                a.extend(["--js-runtimes", "node"].map(String::from));
            }
            a.extend(["-o".into(), s(&dir.join("media.%(ext)s")), src.into()]);
            let out = exec("yt-dlp", &a, 1200).await?;
            if downloaded(&dir).is_none() {
                return Err(format!("yt-dlp could not download {src}: {}", tail(&String::from_utf8_lossy(&out.stderr), 400)));
            }
        }
        let path = downloaded(&dir).ok_or("the download is gone")?;
        let meta: Value = std::fs::read(dir.join("media.info.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let chapters = meta["chapters"].as_array().into_iter().flatten().filter_map(|c| Some((c["start_time"].as_f64()?, c["title"].as_str()?.to_string()))).collect();
        return Ok(Media { path, dir, shown: src.into(), title: meta["title"].as_str().map(str::to_string), chapters, url: true });
    }
    let path = crate::snapshots::resolve_inside(&ctx.root, src)?;
    let meta = std::fs::metadata(&path).map_err(|_| format!("{src} does not exist in the workspace."))?;
    if !meta.is_file() {
        return Err(format!("{src} is a folder, not a video."));
    }
    let stamp = meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    let dir = make_dir(&short_hash(&format!("{}|{}|{stamp}", src.replace('\\', "/"), meta.len())))?;
    Ok(Media { path, dir, shown: src.into(), title: None, chapters: Vec::new(), url: false })
}

/// What ffprobe says about the file.
async fn probe(m: &Media) -> Result<Info, String> {
    let a: Vec<String> = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters"].map(String::from).into_iter().chain([s(&m.path)]).collect();
    let out = exec("ffprobe", &a, 30).await?;
    let j: Value = serde_json::from_slice(&out.stdout).ok().filter(|_| out.status.success()).ok_or_else(|| format!("ffprobe could not read {}: {}", m.shown, tail(&String::from_utf8_lossy(&out.stderr), 300)))?;
    let streams = j["streams"].as_array().cloned().unwrap_or_default();
    let kind = |k: &'static str| streams.iter().filter(move |st| st["codec_type"] == k);
    let video = kind("video").find(|st| st["disposition"]["attached_pic"] != 1).ok_or_else(|| format!("{} has no video stream.", m.shown))?;
    let num = |v: &Value| v.as_str().and_then(|t| t.parse::<f64>().ok()).or_else(|| v.as_f64());
    let dur = num(&j["format"]["duration"]).or_else(|| num(&video["duration"])).filter(|d| *d > 0.0).ok_or_else(|| format!("{} has no usable duration.", m.shown))?;
    let rate = video["avg_frame_rate"].as_str().and_then(|r| r.split_once('/')).and_then(|(n, d)| Some(n.parse::<f64>().ok()? / d.parse::<f64>().ok().filter(|d| *d > 0.0)?)).unwrap_or(0.0);
    let chapters = j["chapters"].as_array().into_iter().flatten().filter_map(|c| Some((num(&c["start_time"])?, c["tags"]["title"].as_str().unwrap_or("").to_string()))).collect();
    Ok(Info {
        dur,
        w: video["width"].as_u64().unwrap_or(0),
        h: video["height"].as_u64().unwrap_or(0),
        fps: rate,
        audio: kind("audio").next().is_some(),
        subs: kind("subtitle").count(),
        title: j["format"]["tags"]["title"].as_str().map(str::to_string),
        chapters,
    })
}

async fn open_probed(ctx: &Ctx, args: &Value) -> Result<(Media, Info), String> {
    let m = open(ctx, args).await?;
    let info = probe(&m).await?;
    Ok((m, info))
}

/// Subtitle files for this video: downloaded ones in its folder, or `clip.en.srt` beside `clip.mp4`. JSON3 first.
fn subtitle_files(m: &Media) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut scan = |dir: &Path, stem: Option<&str>, exts: &[&str]| {
        for p in std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()) {
            let named = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if p.extension().and_then(|e| e.to_str()).is_some_and(|e| exts.contains(&e)) && stem.is_none_or(|st| named.starts_with(&format!("{st}."))) {
                found.push(p);
            }
        }
    };
    scan(&m.dir, None, &["json3", "vtt", "srt"]);
    if !m.url {
        if let (Some(parent), Some(stem)) = (m.path.parent(), m.path.file_stem().and_then(|n| n.to_str())) {
            scan(parent, Some(stem), &["vtt", "srt"]);
        }
    }
    found.sort_by_key(|p| (p.extension().is_none_or(|e| e != "json3"), p.as_os_str().len()));
    found
}

// ---------------------------------------------------------------- pictures

/// One frame at `t`. `width` shrinks it (never enlarges); None keeps the source size. `-ss` before `-i` seeks to the
/// nearest keyframe and decodes forward, so the frame is the one at `t`, not the keyframe before it. BMP over the pipe:
/// it costs the encoder nothing, and a 1080p frame is a few megabytes of loopback.
async fn grab(path: &Path, t: f64, width: Option<u32>) -> Result<DynamicImage, String> {
    let mut a: Vec<String> = ["-v", "error", "-ss", &format!("{t:.3}"), "-i"].map(String::from).into_iter().chain([s(path), "-frames:v".into(), "1".into()]).collect();
    if let Some(w) = width {
        a.extend(["-vf".into(), format!("scale='min({w},iw)':-2")]);
    }
    a.extend(["-f", "image2pipe", "-c:v", "bmp", "-"].map(String::from));
    let out = exec("ffmpeg", &a, 60).await?;
    image::load_from_memory(&out.stdout).map_err(|_| format!("ffmpeg gave no frame at {}: {}", clock(t), tail(&String::from_utf8_lossy(&out.stderr), 200)))
}

fn save_jpeg(img: &DynamicImage, path: &Path, quality: u8) -> Result<(), String> {
    let rgb = img.to_rgb8();
    let file = std::fs::File::create(path).map_err(|e| format!("Cannot write {}: {e}", path.display()))?;
    image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(file), quality).write_image(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8).map_err(|e| format!("Cannot write {}: {e}", path.display()))
}

/// "0123456789:." as 5x7 bitmaps, one row per byte.
const GLYPHS: [[u8; 7]; 12] = [
    [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
    [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
    [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
    [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
    [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
    [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
    [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
    [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
    [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
    [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
    [0b00000, 0b00100, 0b00100, 0b00000, 0b00100, 0b00100, 0b00000],
    [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00100],
];

fn fill(img: &mut RgbaImage, x: u32, y: u32, w: u32, h: u32, px: Rgba<u8>) {
    for yy in y..(y + h).min(img.height()) {
        for xx in x..(x + w).min(img.width()) {
            img.put_pixel(xx, yy, px);
        }
    }
}

/// `text` (digits, colons, dots) in yellow on black at (x, y), each bitmap pixel `k` pixels square.
fn tag(img: &mut RgbaImage, x: u32, y: u32, text: &str, k: u32) {
    let n = text.chars().count() as u32;
    fill(img, x, y, (n * 6 + 1) * k, 9 * k, Rgba([0, 0, 0, 255]));
    for (i, c) in text.chars().enumerate() {
        let Some(glyph) = c.to_digit(10).map(|d| d as usize).or(match c { ':' => Some(10), '.' => Some(11), _ => None }) else { continue };
        for (row, bits) in GLYPHS[glyph].iter().enumerate() {
            for col in 0..5u32 {
                if bits >> (4 - col) & 1 == 1 {
                    fill(img, x + (i as u32 * 6 + col + 1) * k, y + (row as u32 + 1) * k, k, k, Rgba([255, 224, 0, 255]));
                }
            }
        }
    }
}

/// The frames in a grid `cols` wide, each with its time in its top-left corner, saved as a JPEG.
fn compose(cells: &[(String, DynamicImage)], cols: u32, out: &Path) -> Result<(), String> {
    let cols = cols.min(cells.len() as u32).max(1);
    let rows = (cells.len() as u32).div_ceil(cols);
    let cw = cells.iter().map(|c| c.1.width()).max().unwrap_or(1);
    let ch = cells.iter().map(|c| c.1.height()).max().unwrap_or(1);
    let mut canvas = RgbaImage::from_pixel(cols * cw + GAP * (cols + 1), rows * ch + GAP * (rows + 1), Rgba([16, 16, 16, 255]));
    let k = (cw / 100).max(2);
    for (i, (label, img)) in cells.iter().enumerate() {
        let (x, y) = (GAP + i as u32 % cols * (cw + GAP), GAP + i as u32 / cols * (ch + GAP));
        image::imageops::overlay(&mut canvas, &img.to_rgba8(), x as i64, y as i64);
        tag(&mut canvas, x + k, y + k, label, k);
    }
    save_jpeg(&DynamicImage::ImageRgba8(canvas), out, 82)
}

/// Grabs the frames at `times`, lays them out `cols` wide and saves the sheet. Gives back the labels of the frames that made it in.
async fn sheet(path: &Path, dur: f64, times: &[f64], cols: u32, out: &Path) -> Result<Vec<String>, String> {
    let cw = ((SHEET_W - GAP * (cols + 1)) / cols) & !1;
    // A task per frame, `PARALLEL` of them running: stream combinators over borrowed futures made `tools::run` not provably Send.
    let slots = Arc::new(tokio::sync::Semaphore::new(PARALLEL));
    let jobs: Vec<_> = times
        .iter()
        .map(|t| {
            let (path, t, slots) = (path.to_path_buf(), clamp_t(*t, dur), slots.clone());
            tokio::spawn(async move {
                let _slot = slots.acquire_owned().await;
                grab(&path, t, Some(cw)).await.map(|img| (t, img))
            })
        })
        .collect();
    let (mut cells, mut why) = (Vec::new(), None);
    for job in jobs {
        match job.await.map_err(|e| e.to_string()).and_then(|got| got) {
            Ok(cell) => cells.push(cell),
            Err(e) => why = why.or(Some(e)),
        }
    }
    if cells.is_empty() {
        return Err(why.unwrap_or_else(|| "no frames".into()));
    }
    let names = labels(&cells.iter().map(|c| c.0).collect::<Vec<_>>());
    let cells: Vec<(String, DynamicImage)> = names.iter().cloned().zip(cells.into_iter().map(|c| c.1)).collect();
    let out = out.to_path_buf();
    tokio::task::spawn_blocking(move || compose(&cells, cols, &out)).await.map_err(|e| e.to_string())??;
    Ok(names)
}

pub(crate) fn can_see(ctx: &Ctx) -> bool {
    crate::models::resolve(&ctx.settings.model, &ctx.settings.custom_models).vision == crate::models::Vision::Native
}

/// Said with every sheet: a model took the tags for a timer that is part of the video.
const TAGGED: &str = "each with its time in a yellow tag in its top-left corner (drawn by this tool, not part of the video)";

const BLIND: &str = "The current model cannot see pictures, so none is attached to you (the user sees it under the step). Work from the times, scenes and transcript, which are text.";

/// The labels of frames at `times`: mm:ss, with tenths when two frames would otherwise read the same (a short video).
fn labels(times: &[f64]) -> Vec<String> {
    let whole: Vec<String> = times.iter().map(|t| clock(*t)).collect();
    let tie = whole.windows(2).any(|w| w[0] == w[1]);
    times.iter().zip(whole).map(|(t, w)| if tie { format!("{w}.{}", ((t + 1e-3) * 10.0) as u64 % 10) } else { w }).collect()
}

/// A sheet's output: the user sees it under the step, a model that can see gets it with the next message.
fn with_sheet(ctx: &Ctx, picture: PathBuf, text: String, summary: String) -> Output {
    Output { image: Some(picture.clone()), look: can_see(ctx).then_some(picture), ..Output::ok(text, summary) }
}

fn name_of(m: &Media, info: &Info) -> String {
    m.title.clone().or_else(|| info.title.clone()).unwrap_or_else(|| m.shown.rsplit(['/', '\\']).next().unwrap_or(&m.shown).to_string())
}

// ---------------------------------------------------------------- the tools

async fn overview(ctx: &Ctx, args: &Value) -> Output {
    let (m, info) = match open_probed(ctx, args).await {
        Ok(x) => x,
        Err(e) => return Output::fail(e),
    };
    let times: Vec<f64> = (0..OVERVIEW_FRAMES).map(|i| (i as f64 + 0.5) * info.dur / OVERVIEW_FRAMES as f64).collect();
    let picture = m.dir.join("overview.jpg");
    let used = match sheet(&m.path, info.dur, &times, 4, &picture).await {
        Ok(used) => used,
        Err(e) => return Output::fail(format!("Could not make the contact sheet: {e}")),
    };
    let subs = if !subtitle_files(&m).is_empty() { if m.url { "yes (downloaded)" } else { "yes (sidecar file)" } } else if info.subs > 0 { "yes (embedded)" } else { "no" };
    let name = name_of(&m, &info);
    let mut text = format!("Video: {name}\nSource: {}{}\n", m.shown, if m.url { format!(" (downloaded to {})", relative(ctx, &m.path)) } else { String::new() });
    text += &format!("Length: {} ({:.1} s) | Size: {}x{} | {:.2} fps | Audio: {} | Subtitles: {subs}\n", clock(info.dur), info.dur, info.w, info.h, info.fps, if info.audio { "yes" } else { "no" });
    let chapters = if m.chapters.is_empty() { &info.chapters } else { &m.chapters };
    if !chapters.is_empty() {
        let shown: Vec<String> = chapters.iter().take(40).map(|(t, title)| format!("{} {title}", clock(*t))).collect();
        text += &format!("Chapters: {}{}\n", shown.join("; "), if chapters.len() > 40 { format!("; and {} more", chapters.len() - 40) } else { String::new() });
    }
    text += &format!("Contact sheet {}: {} frames evenly spaced over the whole video, left to right and top to bottom, {TAGGED}: {}.\n", relative(ctx, &picture), used.len(), used.join(", "));
    text += "Next: video_scenes for the cuts, video_look {start,end} for a stretch, video_frame {at,crop} for detail, video_transcript for speech. Cite timestamps.";
    if !can_see(ctx) {
        text += &format!("\n{BLIND}");
    }
    with_sheet(ctx, picture, text, format!("Overview of {name} ({})", clock(info.dur)))
}

async fn look(ctx: &Ctx, args: &Value) -> Output {
    let (m, info) = match open_probed(ctx, args).await {
        Ok(x) => x,
        Err(e) => return Output::fail(e),
    };
    let (start, end) = match (time_arg(args, "start"), time_arg(args, "end")) {
        (Ok(a), Ok(b)) => (a.unwrap_or(0.0), b.unwrap_or(info.dur).min(info.dur)),
        (Err(e), _) | (_, Err(e)) => return Output::fail(e),
    };
    if start >= info.dur {
        return Output::fail(format!("start {} is past the end: the video is {} long.", clock(start), clock(info.dur)));
    }
    if end <= start {
        return Output::fail(format!("end must come after start ({} to {}).", clock(start), clock(end)));
    }
    let n = num_arg(args, "frames").filter(|n| *n > 0).map_or(DEFAULT_LOOK, |n| (n as usize).min(MAX_LOOK));
    let times: Vec<f64> = if n == 1 { vec![(start + end) / 2.0] } else { (0..n).map(|i| start + (end - start) * i as f64 / (n - 1) as f64).collect() };
    let cols = match n {
        1..=3 => n as u32,
        6 | 9 => 3,
        _ => 4,
    };
    let picture = m.dir.join(format!("look-{}-{}-{n}.jpg", (start * 1000.0) as u64, (end * 1000.0) as u64));
    let used = match sheet(&m.path, info.dur, &times, cols, &picture).await {
        Ok(used) => used,
        Err(e) => return Output::fail(format!("Could not make the contact sheet: {e}")),
    };
    let step = if n > 1 { format!(", {:.1} s apart", (end - start) / (n - 1) as f64) } else { String::new() };
    let mut text = format!("Contact sheet {} of {}: {} frames from {} to {}{step}, left to right and top to bottom, {TAGGED}: {}.\nNarrow start/end to see finer motion; video_frame {{at,crop}} reads detail. Cite timestamps.", relative(ctx, &picture), name_of(&m, &info), used.len(), clock(start), clock(end), used.join(", "));
    if !can_see(ctx) {
        text += &format!("\n{BLIND}");
    }
    with_sheet(ctx, picture, text, format!("Looked at {}-{} of {}", clock(start), clock(end), name_of(&m, &info)))
}

async fn frame(ctx: &Ctx, args: &Value) -> Output {
    let (m, info) = match open_probed(ctx, args).await {
        Ok(x) => x,
        Err(e) => return Output::fail(e),
    };
    let at = match time_arg(args, "at") {
        Ok(Some(at)) => at,
        Ok(None) => return Output::fail("at is required: the time of the frame, in seconds or mm:ss."),
        Err(e) => return Output::fail(e),
    };
    if at > info.dur {
        return Output::fail(format!("at {} is past the end: the video is {} long.", clock(at), clock(info.dur)));
    }
    let crop = match &args["crop"] {
        Value::Object(o) if !o.is_empty() => {
            let g = |k: &str| o.get(k).and_then(|v| v.as_f64().or_else(|| v.as_str()?.trim().parse().ok())).filter(|n| n.is_finite());
            match (g("x"), g("y"), g("w"), g("h")) {
                (Some(x), Some(y), Some(w), Some(h)) if x >= 0.0 && y >= 0.0 && w > 0.0 && h > 0.0 && x + w <= 1.001 && y + h <= 1.001 => Some((x, y, w.min(1.0 - x), h.min(1.0 - y))),
                _ => return Output::fail("crop is {x, y, w, h} as fractions of the frame, 0 to 1 from the top-left, with x+w and y+h at most 1."),
            }
        }
        _ => None,
    };
    let img = match grab(&m.path, clamp_t(at, info.dur), None).await {
        Ok(img) => img,
        Err(e) => return Output::fail(e),
    };
    let (iw, ih) = (img.width(), img.height());
    let cropped = crop.map(|(x, y, w, h)| {
        let px = ((x * iw as f64).round() as u32).min(iw - 1);
        let py = ((y * ih as f64).round() as u32).min(ih - 1);
        (px, py, ((w * iw as f64).round() as u32).clamp(1, iw - px), ((h * ih as f64).round() as u32).clamp(1, ih - py))
    });
    let picture = m.dir.join(match crop {
        Some((x, y, w, h)) => format!("frame-{}-crop-{:.0}-{:.0}-{:.0}-{:.0}.jpg", (at * 1000.0) as u64, x * 1000.0, y * 1000.0, w * 1000.0, h * 1000.0),
        None => format!("frame-{}.jpg", (at * 1000.0) as u64),
    });
    let out = picture.clone();
    let sized = tokio::task::spawn_blocking(move || {
        let part = match cropped {
            Some((x, y, w, h)) => img.crop_imm(x, y, w, h),
            None => img,
        };
        let long = part.width().max(part.height());
        // A box is enlarged to read small text; a whole frame is only shrunk when it is bigger than a model reads.
        let scale = if cropped.is_some() { (ZOOM_EDGE / long as f64).clamp(1.0, MAX_ZOOM) } else { (FULL_EDGE as f64 / long as f64).min(1.0) };
        let part = if (scale - 1.0).abs() > 0.01 { part.resize_exact((part.width() as f64 * scale).round() as u32, (part.height() as f64 * scale).round() as u32, FilterType::Lanczos3) } else { part };
        save_jpeg(&part, &out, 90).map(|_| (part.width(), part.height(), scale))
    })
    .await;
    let (ow, oh, scale) = match sized {
        Ok(Ok(x)) => x,
        Ok(Err(e)) => return Output::fail(e),
        Err(e) => return Output::fail(e.to_string()),
    };
    let name = name_of(&m, &info);
    let mut text = format!("Frame of {name} at {} ({at:.2} s), source {iw}x{ih}: {} ({ow}x{oh}).", clock(at), relative(ctx, &picture));
    if let Some((px, py, pw, ph)) = cropped {
        text += &format!(" Cropped to the box at ({px},{py}) {pw}x{ph} px of the frame, enlarged {scale:.1}x; a tighter box reads finer detail.");
    }
    if !can_see(ctx) {
        text += &format!("\n{BLIND}");
    }
    with_sheet(ctx, picture, text, format!("Frame at {} of {name}", clock(at)))
}

async fn scenes(ctx: &Ctx, args: &Value) -> Output {
    let (m, info) = match open_probed(ctx, args).await {
        Ok(x) => x,
        Err(e) => return Output::fail(e),
    };
    let threshold = args["threshold"].as_f64().or_else(|| args["threshold"].as_str()?.trim().parse().ok()).filter(|t| *t > 0.0).map_or(0.3, |t| t.clamp(0.01, 0.95));
    // Scored on a shrunk picture: the score is a difference of whole frames, and decoding is most of the time.
    // metadata=print writes `pts_time:` and `lavfi.scene_score=` lines to stdout for every frame that passes.
    let filter = format!("scale=320:-2,select='gt(scene,{threshold})',metadata=print:file=-");
    let a: Vec<String> = ["-hide_banner", "-nostats", "-v", "error", "-i"].map(String::from).into_iter().chain([s(&m.path), "-an".into(), "-sn".into(), "-vf".into(), filter, "-f".into(), "null".into(), "-".into()]).collect();
    let out = match exec("ffmpeg", &a, 900).await {
        Ok(out) if out.status.success() => out,
        Ok(out) => return Output::fail(format!("ffmpeg could not scan {}: {}", m.shown, tail(&String::from_utf8_lossy(&out.stderr), 300))),
        Err(e) => return Output::fail(format!("{e} Use video_look on a stretch instead.")),
    };
    let (mut found, mut at) = (Vec::<(f64, f64)>::new(), 0.0);
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(t) = line.split("pts_time:").nth(1).and_then(|t| t.trim().parse::<f64>().ok()) {
            at = t;
        } else if let Some(score) = line.strip_prefix("lavfi.scene_score=").and_then(|v| v.trim().parse::<f64>().ok()) {
            found.push((at, score));
        }
    }
    let name = name_of(&m, &info);
    if found.is_empty() {
        return Output::ok(format!("No scene changes in {name} at threshold {threshold}: the picture is steady or changes gradually. Lower the threshold (0.1), or video_look at a stretch."), format!("No scene changes in {name}"));
    }
    let total = found.len();
    if total > MAX_SCENES {
        found.sort_by(|a, b| b.1.total_cmp(&a.1));
        found.truncate(MAX_SCENES);
        found.sort_by(|a, b| a.0.total_cmp(&b.0));
    }
    let list: Vec<String> = found.iter().map(|(t, score)| format!("{}.{} ({score:.2})", clock(*t), (t.fract() * 10.0) as u32)).collect();
    let cap = if total > MAX_SCENES { format!(" {total} found; these are the {MAX_SCENES} strongest, in time order. A higher threshold gives fewer.") } else { String::new() };
    let text = format!("Scene changes in {name} ({}) at threshold {threshold}, as time (strength 0 to 1):{cap}\n{}\nA scene runs from one of these to the next. video_look {{start,end}} shows what happens in one; video_frame {{at}} reads one moment. Cite timestamps.", clock(info.dur), list.join(", "));
    Output::ok(text, format!("{} scene changes in {name}", found.len()))
}

// ---------------------------------------------------------------- the transcript

/// One line of speech: start, end, text.
struct Cue(f64, f64, String);

fn parse_json3(text: &str) -> Vec<Cue> {
    let v: Value = serde_json::from_str(text).unwrap_or_default();
    v["events"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| {
            let line: String = e["segs"].as_array()?.iter().filter_map(|seg| seg["utf8"].as_str()).collect();
            let line = line.replace('\n', " ").trim().to_string();
            let start = e["tStartMs"].as_f64()? / 1000.0;
            (!line.is_empty()).then(|| Cue(start, start + e["dDurationMs"].as_f64().unwrap_or(0.0) / 1000.0, line))
        })
        .collect()
}

/// SRT and WebVTT alike: a `start --> end` line, then text up to a blank line.
// ponytail: YouTube's own WebVTT repeats each caption as it rolls; only an identical neighbour is dropped. The JSON3 that yt-dlp is asked for first has no such repeats.
fn parse_cues(text: &str) -> Vec<Cue> {
    static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new("<[^>]*>").unwrap());
    let at = |t: &str| seconds(&Value::from(t.trim().replace(',', ".")));
    let mut rows: Vec<Cue> = Vec::new();
    let mut lines = text.lines().peekable();
    while let Some(line) = lines.next() {
        let Some((from, to)) = line.split_once("-->") else { continue };
        let (Some(start), Some(end)) = (at(from), at(to.split_whitespace().next().unwrap_or(""))) else { continue };
        let mut body = Vec::new();
        while let Some(l) = lines.next_if(|l| !l.trim().is_empty()) {
            body.push(TAG.replace_all(l, "").trim().to_string());
        }
        let body = body.join(" ").trim().to_string();
        if !body.is_empty() && !matches!(rows.last(), Some(last) if last.2 == body) {
            rows.push(Cue(start, end, body));
        }
    }
    rows
}

/// Local speech recognition, as the user's `eyes` does it: faster-whisper, int8 on the CPU, silence skipped, and the
/// classic hallucination on noise (probably not speech, low confidence) dropped.
const WHISPER: &str = r#"
import sys, json, os
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
from faster_whisper import WhisperModel
segs, _ = WhisperModel("base", device="cpu", compute_type="int8").transcribe(sys.argv[1], vad_filter=True)
print(json.dumps([[round(s.start, 2), round(s.end, 2), s.text.strip()] for s in segs if s.text.strip() and not (s.no_speech_prob > 0.5 and s.avg_logprob < -0.8)]))
"#;

/// The speech in the video and where it came from: subtitles, then an embedded subtitle stream, then whisper.
async fn find_speech(m: &Media, info: &Info) -> Result<(Vec<Cue>, &'static str), String> {
    for file in subtitle_files(m) {
        let Ok(bytes) = std::fs::read(&file) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        let rows = if file.extension().is_some_and(|e| e == "json3") { parse_json3(&text) } else { parse_cues(&text) };
        if !rows.is_empty() {
            return Ok((rows, if m.url { "downloaded captions" } else { "a subtitle file" }));
        }
    }
    if info.subs > 0 {
        let a: Vec<String> = ["-v", "error", "-i"].map(String::from).into_iter().chain([s(&m.path)]).chain(["-map", "0:s:0", "-f", "srt", "-"].map(String::from)).collect();
        // A picture-based subtitle (DVD, PGS) cannot become text: ffmpeg fails and the next source is tried.
        if let Ok(out) = exec("ffmpeg", &a, 120).await.map(|o| parse_cues(&String::from_utf8_lossy(&o.stdout))) {
            if !out.is_empty() {
                return Ok((out, "embedded subtitles"));
            }
        }
    }
    if !info.audio {
        return Err(format!("No transcript is available: {} has no audio track and no subtitles.", m.shown));
    }
    let have = exec("python", &["-c".into(), "import faster_whisper".into()], 60).await;
    if !have.as_ref().is_ok_and(|o| o.status.success()) {
        let why = match have {
            Err(e) => e,
            Ok(_) => "the faster_whisper module is not installed".into(),
        };
        return Err(format!("No transcript is available: {} has no subtitles, and it cannot be transcribed here ({why}). Install it with: pip install faster-whisper.", m.shown));
    }
    // ponytail: the whole audio in one call, 30 minutes at most, "base" on the CPU. A long video wants chunks and a progress line.
    let out = exec("python", &["-c".into(), WHISPER.into(), s(&m.path)], 1800).await?;
    let json = String::from_utf8_lossy(&out.stdout).lines().rev().find(|l| l.trim_start().starts_with('[')).map(str::to_string);
    let rows: Vec<Value> = out.status.success().then_some(()).and_then(|_| serde_json::from_str(&json?).ok()).ok_or_else(|| format!("Transcription failed: {}", tail(&String::from_utf8_lossy(&out.stderr), 300)))?;
    let cues = rows.iter().filter_map(|r| Some(Cue(r[0].as_f64()?, r[1].as_f64()?, r[2].as_str()?.to_string()))).collect();
    Ok((cues, "local speech transcription (whisper base)"))
}

/// The lines of speech between `from` and `to`, a line per stretch of up to ~20 s. Stops at `budget` characters and
/// says where it stopped.
fn render(rows: &[Cue], from: f64, to: f64, budget: usize) -> (String, Option<f64>) {
    let mut lines: Vec<(f64, String)> = Vec::new();
    for c in rows.iter().filter(|c| c.1 > from && c.0 < to) {
        match lines.last_mut() {
            Some((t, text)) if c.0 - *t < 20.0 && text.len() < 240 => {
                text.push(' ');
                text.push_str(&c.2);
            }
            _ => lines.push((c.0, c.2.clone())),
        }
    }
    let mut out = String::new();
    for (i, (t, text)) in lines.iter().enumerate() {
        let line = format!("[{}] {text}\n", clock(*t));
        if i > 0 && out.len() + line.len() > budget {
            return (out, Some(*t));
        }
        out.push_str(&line);
    }
    (out, None)
}

async fn transcript(ctx: &Ctx, args: &Value) -> Output {
    let (m, info) = match open_probed(ctx, args).await {
        Ok(x) => x,
        Err(e) => return Output::fail(e),
    };
    let (from, to) = match (time_arg(args, "start"), time_arg(args, "end")) {
        (Ok(a), Ok(b)) => (a.unwrap_or(0.0), b.unwrap_or(info.dur)),
        (Err(e), _) | (_, Err(e)) => return Output::fail(e),
    };
    let cache = m.dir.join("transcript.json");
    let cached: Option<(Vec<Cue>, String)> = std::fs::read(&cache).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).map(|j| (j["rows"].as_array().into_iter().flatten().filter_map(|r| Some(Cue(r[0].as_f64()?, r[1].as_f64()?, r[2].as_str()?.to_string()))).collect(), j["via"].as_str().unwrap_or("").to_string()));
    let (rows, via) = match cached {
        Some(done) => done,
        None => match find_speech(&m, &info).await {
            Ok((rows, via)) => {
                let table: Vec<Value> = rows.iter().map(|c| json!([c.0, c.1, c.2])).collect();
                let _ = std::fs::write(&cache, json!({ "via": via, "rows": table }).to_string());
                (rows, via.to_string())
            }
            Err(why) => return Output::fail(why),
        },
    };
    let name = name_of(&m, &info);
    let (body, more) = render(&rows, from, to, ctx.read_chars);
    if body.is_empty() {
        return Output::ok(format!("Transcript of {name} (from {via}): nothing is said between {} and {}.", clock(from), clock(to)), format!("No speech in {name}"));
    }
    let mut text = format!("Transcript of {name} (from {via}), {} to {}:\n{body}", clock(from), clock(to.min(info.dur)));
    if let Some(next) = more {
        text += &format!("(Cut at {} to fit: ask again with start=\"{}\" for the rest.)\n", clock(next), clock(next));
    }
    text += "Use these times with video_look or video_frame to see what is on screen when it is said. Cite timestamps.";
    Output::ok(text, format!("Transcript of {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_and_subtitles_are_read() {
        assert_eq!([json!(90), json!("90"), json!("1:30"), json!("1:30.5"), json!("1:01:01"), json!("12s")].map(|v| seconds(&v)), [Some(90.0), Some(90.0), Some(90.0), Some(90.5), Some(3661.0), Some(12.0)]);
        assert_eq!([json!("x"), json!(-1), json!("1:x"), json!(null)].map(|v| seconds(&v)), [None; 4]);
        assert_eq!((clock(75.4), clock(3725.0)), ("01:15".to_string(), "1:02:05".to_string()));
        let rows = parse_cues("WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500 align:start\n<c>Hello</c> there\n\n00:03.500 --> 00:05,000\nHello there\n\n2\n00:00:06,000 --> 00:00:07,000\nBye\n");
        assert_eq!(rows.iter().map(|c| (c.0, c.1, c.2.as_str())).collect::<Vec<_>>(), [(1.0, 3.5, "Hello there"), (6.0, 7.0, "Bye")]);
        let rows = parse_json3(r#"{"events":[{"tStartMs":1500,"dDurationMs":2000,"segs":[{"utf8":"Hi "},{"utf8":"you"}]},{"tStartMs":4000},{"tStartMs":5000,"dDurationMs":100,"segs":[{"utf8":"\n"}]}]}"#);
        assert_eq!(rows.iter().map(|c| (c.0, c.1, c.2.as_str())).collect::<Vec<_>>(), [(1.5, 3.5, "Hi you")]);
    }

    /// Watches a 6-second test clip made by ffmpeg itself. Skipped where ffmpeg is not installed.
    #[tokio::test]
    async fn a_test_clip_is_watched_through_every_tool() {
        let has = |p: &str| std::process::Command::new(p).arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
        if !has("ffmpeg") || !has("ffprobe") {
            eprintln!("skipped: ffmpeg is not on PATH");
            return;
        }
        let root = crate::tools::scratch("video");
        let made = std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=6:size=320x240:rate=10", "-pix_fmt", "yuv420p"]).arg(root.join("clip.mp4")).status().unwrap();
        assert!(made.success());
        let mut ctx = crate::tools::test_ctx(&root, crate::store::Approval::Auto);
        // A model that can see, so the pictures ride with the answer.
        ctx.settings.model = crate::models::all(&[]).into_iter().find(|m| m.vision == crate::models::Vision::Native).unwrap().id;
        let dims = |p: &Option<PathBuf>| image::image_dimensions(p.as_ref().expect("a picture")).unwrap();

        let out = overview(&ctx, &json!({ "source": "clip.mp4" })).await;
        assert!(out.ok, "{}", out.text);
        let (w, h) = dims(&out.image);
        assert!((1200..=1300).contains(&w) && h > 600, "{w}x{h}");
        assert_eq!(out.look, out.image);
        assert!(out.text.contains("Length: 00:06 (6.0 s)") && out.text.contains("320x240") && out.text.contains("Audio: no") && out.text.contains("Subtitles: no"), "{}", out.text);

        let out = look(&ctx, &json!({ "source": "clip.mp4", "start": "1", "end": "0:04", "frames": 6 })).await;
        assert!(out.ok, "{}", out.text);
        assert!(out.text.contains("6 frames from 00:01 to 00:04") && out.text.contains("00:01.0, 00:01.6, 00:02.2, 00:02.8, 00:03.4, 00:04.0"), "{}", out.text);
        assert!(dims(&out.image).0 > 900);
        assert!(!look(&ctx, &json!({ "source": "clip.mp4", "start": "9" })).await.ok);

        let out = frame(&ctx, &json!({ "source": "clip.mp4", "at": "2.5", "crop": { "x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5 } })).await;
        assert!(out.ok, "{}", out.text);
        // 160x120 of the 320x240 frame, enlarged 4x (the most) to 640x480.
        assert_eq!(dims(&out.image), (640, 480), "{}", out.text);
        let out = frame(&ctx, &json!({ "source": "clip.mp4", "at": 1 })).await;
        assert_eq!(dims(&out.image), (320, 240));
        assert!(!frame(&ctx, &json!({ "source": "clip.mp4", "at": 1, "crop": { "x": 0.8, "y": 0, "w": 0.5, "h": 1 } })).await.ok);

        let out = scenes(&ctx, &json!({ "source": "clip.mp4", "threshold": 0.01 })).await;
        assert!(out.ok && out.image.is_none(), "{}", out.text);
        assert!(out.text.contains("Scene changes in clip.mp4") || out.text.contains("No scene changes"), "{}", out.text);

        let out = transcript(&ctx, &json!({ "source": "clip.mp4" })).await;
        assert!(!out.ok && out.text.contains("no audio track"), "{}", out.text);

        // The workspace is a wall: a path out of it, and a file that is not there.
        assert!(!overview(&ctx, &json!({ "source": "../clip.mp4" })).await.ok);
        assert!(overview(&ctx, &json!({ "source": "nope.mp4" })).await.text.contains("does not exist"));
        let _ = std::fs::remove_dir_all(root);
    }
}
