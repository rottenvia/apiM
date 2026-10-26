//! Computer use, while the Computer toggle is on: `computer_look` sees the user's screen, `computer_act` runs a batch
//! of mouse and keyboard steps and sees it again. The Windows side is `crate::computer`.
//!
//! Faster than one screenshot per click: a call carries every step the model can foresee, and the picture of the
//! result comes back with it, so "open, wait for the window, click Play" is one round instead of six. More accurate
//! than reading a point off the picture: a step may name the text it wants clicked, and the app finds it on screen
//! (UI Automation for named controls, Windows' own OCR for everything drawn, games included) and clicks its centre.

use super::{Ctx, Output, bool_arg, num_arg, str_arg};
use crate::computer::{self as os, Button};
use image::RgbaImage;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::io::AsyncBufReadExt;

pub const NAMES: &[&str] = &["computer_look", "computer_act"];

/// The model sees the screen fitted into this: 1366x768 is what vision models read whole, and a 1440p screen
/// shrinks less than 2x into it.
const FRAME: (f64, f64) = (1366.0, 768.0);
/// Steps in one call, and the longest one call may take.
const MAX_STEPS: usize = 40;
const MAX_CALL: Duration = Duration::from_secs(180);
/// A wait_for gives up after this unless told otherwise.
const WAIT_FOR: u64 = 30_000;
/// Screenshots kept per chat: the oldest go.
const KEPT_SHOTS: usize = 300;

pub fn schemas() -> Vec<Value> {
    vec![
        json!({ "type": "function", "function": {
            "name": "computer_look",
            "description": "See the user's screen as it is now: a screenshot fitted into 1366x768 and the open windows, front first. Its pixels are the coordinates computer_act takes. `zoom` shows a part of it enlarged, to read small text or aim precisely. `text` also lists every line of text on the screen with its position (read by OCR). `window` brings a window to the front first. computer_act already returns a fresh screenshot after every batch: do not look again just to see its result.",
            "parameters": { "type": "object", "properties": {
                "zoom": { "type": "array", "items": { "type": "number" }, "description": "[x1, y1, x2, y2] in screenshot pixels: that area, enlarged." },
                "text": { "type": "boolean", "description": "Also list the text on the screen, line by line, with where each line is." },
                "window": { "type": "string", "description": "Bring this window to the front before looking: part of its title, or its program's name." }
            }, "required": [] }
        }}),
        json!({ "type": "function", "function": {
            "name": "computer_act",
            "description": "Use the user's mouse and keyboard. `steps` run in order, then a fresh screenshot of the result comes back (as from computer_look), with numbered rings where you clicked. Put every step you can foresee into one call (open the program, wait for its window, click, type, press Enter) instead of one call per step: each call is a whole round. Coordinates are pixels of the latest screenshot. To click something that shows text (a button, a tab, a menu item, a link, a game's menu) give the text instead of a point, {\"click\": \"Play\"}: the app finds it on screen itself and clicks its centre, which is far more accurate than a point read off the picture. The run stops at the first step that fails, and at once if the user moves the mouse: they are using the computer, so say what you were doing and leave it.",
            "parameters": { "type": "object", "properties": {
                "steps": { "type": "array", "items": { "type": "object" }, "description": "Each step is one of:\n{\"click\": [x, y]} or {\"click\": \"text on screen\"}, with optional \"button\": \"right\"|\"middle\", \"double\": true, \"with\": \"ctrl\"|\"shift\"|\"alt\" held during the click, \"nth\": 2 for the second match of the text in reading order\n{\"move\": [x, y]}\n{\"drag\": [[x1, y1], [x2, y2]]}\n{\"scroll\": \"down\"|\"up\"|\"left\"|\"right\", \"amount\": 3, \"at\": [x, y]}\n{\"type\": \"text to type\"} (a line break presses Enter)\n{\"key\": \"enter\"|\"ctrl+s\"|\"alt+f4\"|\"f5\"|\"win+r\", \"repeat\": 1}\n{\"hold\": \"w\" or \"shift+w\", \"ms\": 1500}: keys held down, for games\n{\"wait\": 1000}: milliseconds\n{\"wait_for\": \"text or window title\", \"timeout\": 30000}: until it shows on the screen\n{\"open\": \"notepad\"|\"C:\\\\path\\\\app.exe\"|\"https://...\"|\"roblox-studio:\", \"args\": \"...\"}: as a double-click would\n{\"focus\": \"window title or program name\"}" }
            }, "required": ["steps"] }
        }}),
    ]
}

// ---------------------------------------------------------------- the frame the model sees

/// How the screenshot's pixels sit on the screen's.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Frame {
    /// The desktop's top-left corner, in screen pixels (negative with a monitor left of the main one).
    x: i32,
    y: i32,
    /// Screen pixels per screenshot pixel: never below 1, a small screen is not blown up.
    scale: f64,
    w: u32,
    h: u32,
}

impl Frame {
    fn of((x, y, w, h): (i32, i32, i32, i32)) -> Frame {
        let scale = (w as f64 / FRAME.0).max(h as f64 / FRAME.1).max(1.0);
        Frame { x, y, scale, w: (w as f64 / scale).round() as u32, h: (h as f64 / scale).round() as u32 }
    }
    fn now() -> Frame {
        Frame::of(os::screen())
    }
    fn to_screen(&self, (px, py): (f64, f64)) -> (i32, i32) {
        (self.x + (px * self.scale).round() as i32, self.y + (py * self.scale).round() as i32)
    }
    fn from_screen(&self, (sx, sy): (i32, i32)) -> (i32, i32) {
        (((sx - self.x) as f64 / self.scale).round() as i32, ((sy - self.y) as f64 / self.scale).round() as i32)
    }
    /// A point the model gave, held to the screenshot.
    fn point(&self, (px, py): (f64, f64)) -> Result<(i32, i32), String> {
        if px < 0.0 || py < 0.0 || px > self.w as f64 || py > self.h as f64 {
            return Err(format!("({px}, {py}) is outside the {}x{} screenshot", self.w, self.h));
        }
        Ok(self.to_screen((px, py)))
    }
    /// The whole screen, fitted into the frame.
    fn fit(&self, full: &RgbaImage) -> RgbaImage {
        if self.scale > 1.0 { image::imageops::resize(full, self.w, self.h, image::imageops::FilterType::Triangle) } else { full.clone() }
    }
}

// ---------------------------------------------------------------- steps

#[derive(Clone, Debug, PartialEq)]
enum Target {
    Point(f64, f64),
    /// Text on the screen, and which of its matches in reading order (1 is the first).
    Text(String, usize),
}

#[derive(Clone, Debug, PartialEq)]
enum Step {
    Click { at: Target, button: Button, double: bool, with: Vec<(u16, bool)> },
    Move(Target),
    Drag(Target, Target),
    Scroll { at: Option<Target>, notches: i32, horizontal: bool },
    Type(String),
    Key { keys: Vec<(u16, bool)>, name: String, repeat: u32 },
    Hold { keys: Vec<(u16, bool)>, name: String, ms: u64 },
    Wait(u64),
    WaitFor { text: String, ms: u64 },
    Open { target: String, args: String },
    Focus(String),
}

fn number(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str()?.trim().parse().ok())
}

fn target(v: &Value, nth: usize) -> Result<Target, String> {
    match v {
        Value::Array(a) if a.len() == 2 => match (number(&a[0]), number(&a[1])) {
            (Some(x), Some(y)) => Ok(Target::Point(x, y)),
            _ => Err("a point is two numbers, [x, y]".into()),
        },
        Value::Object(o) if o.contains_key("x") => match (number(&o["x"]), number(&o["y"])) {
            (Some(x), Some(y)) => Ok(Target::Point(x, y)),
            _ => Err("a point is two numbers, [x, y]".into()),
        },
        Value::String(text) if !text.trim().is_empty() => Ok(Target::Text(text.trim().to_string(), nth.max(1))),
        _ => Err("expected a point [x, y] or the text to find on the screen".into()),
    }
}

fn keys(text: &str) -> Result<Vec<(u16, bool)>, String> {
    os::combo(text)
}

/// One step as the model wrote it. Every step of a call is read before any runs, so a typo in the fifth does not
/// leave the first four done and the rest not.
fn step(v: &Value) -> Result<Step, String> {
    let nth = num_arg(v, "nth").unwrap_or(1) as usize;
    let ms = |key: &str, default: u64, max: u64| num_arg(v, key).unwrap_or(default).min(max);
    if let Some(at) = v.get("click") {
        let button = match str_arg(v, "button").to_ascii_lowercase().as_str() {
            "" | "left" => Button::Left,
            "right" => Button::Right,
            "middle" => Button::Middle,
            other => return Err(format!("\"button\": \"{other}\" is not left, right or middle")),
        };
        let with = if str_arg(v, "with").is_empty() { Vec::new() } else { keys(str_arg(v, "with"))? };
        return Ok(Step::Click { at: target(at, nth)?, button, double: bool_arg(v, "double"), with });
    }
    if let Some(at) = v.get("move") {
        return Ok(Step::Move(target(at, nth)?));
    }
    if let Some(Value::Array(ends)) = v.get("drag") {
        if ends.len() == 2 {
            return Ok(Step::Drag(target(&ends[0], 1)?, target(&ends[1], 1)?));
        }
    }
    if v.get("drag").is_some() {
        return Err("a drag is two points, [[x1, y1], [x2, y2]]".into());
    }
    if let Some(way) = v.get("scroll") {
        let amount = num_arg(v, "amount").unwrap_or(3).clamp(1, 50) as i32;
        let (notches, horizontal) = match way.as_str().unwrap_or("").to_ascii_lowercase().as_str() {
            "down" => (-amount, false),
            "up" => (amount, false),
            "left" => (-amount, true),
            "right" => (amount, true),
            _ => return Err("\"scroll\" is \"up\", \"down\", \"left\" or \"right\"".into()),
        };
        let at = v.get("at").map(|at| target(at, nth)).transpose()?;
        return Ok(Step::Scroll { at, notches, horizontal });
    }
    if let Some(text) = v.get("type") {
        return Ok(Step::Type(text.as_str().map_or_else(|| text.to_string(), str::to_string)));
    }
    if let Some(name) = v.get("key").and_then(Value::as_str) {
        return Ok(Step::Key { keys: keys(name)?, name: name.to_string(), repeat: num_arg(v, "repeat").unwrap_or(1).clamp(1, 50) as u32 });
    }
    if let Some(name) = v.get("hold").and_then(Value::as_str) {
        return Ok(Step::Hold { keys: keys(name)?, name: name.to_string(), ms: ms("ms", 1_000, 30_000) });
    }
    if let Some(wait) = v.get("wait") {
        return number(wait).map(|n| Step::Wait((n.max(0.0) as u64).min(60_000))).ok_or_else(|| "\"wait\" is milliseconds, a number".into());
    }
    if let Some(text) = v.get("wait_for").and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
        return Ok(Step::WaitFor { text: text.trim().to_string(), ms: ms("timeout", WAIT_FOR, 120_000) });
    }
    if let Some(target) = v.get("open").and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
        return Ok(Step::Open { target: target.trim().to_string(), args: str_arg(v, "args").to_string() });
    }
    if let Some(window) = v.get("focus").and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
        return Ok(Step::Focus(window.trim().to_string()));
    }
    Err("it has none of click, move, drag, scroll, type, key, hold, wait, wait_for, open, focus".into())
}

fn steps(args: &Value) -> Result<Vec<Step>, String> {
    // Some models send the list as its JSON text.
    let list = match &args["steps"] {
        Value::String(text) => serde_json::from_str::<Value>(text).unwrap_or(Value::Null),
        other => other.clone(),
    };
    let Some(list) = list.as_array().filter(|l| !l.is_empty()) else {
        return Err("No steps. Pass \"steps\": a list such as [{\"click\": \"Play\"}, {\"wait\": 2000}].".into());
    };
    if list.len() > MAX_STEPS {
        return Err(format!("{} steps is more than one call takes ({MAX_STEPS}). Send the first part, look at the result, then the rest.", list.len()));
    }
    list.iter().enumerate().map(|(i, v)| step(v).map_err(|why| format!("Step {} ({v}) was not understood: {why}. Nothing was done.", i + 1))).collect()
}

// ---------------------------------------------------------------- text on the screen

/// Text on the screen, in screen pixels: a control UI Automation names, or a line or word OCR read.
#[derive(Clone, Debug, PartialEq)]
struct Spot {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    text: String,
}

impl Spot {
    fn centre(&self) -> (i32, i32) {
        (self.x + self.w / 2, self.y + self.h / 2)
    }
}

#[derive(Debug, Default)]
struct Seen {
    /// Named controls of the window in front.
    controls: Vec<Spot>,
    /// OCR's lines, each with its words.
    lines: Vec<(Spot, Vec<Spot>)>,
}

/// Prints `L` (a line) and `W` (a word of the last line) rows, then `OCR`, then `U` (a control) rows and `END`: kind,
/// x, y, w, h, text. A line's box is its words' (left out here: PowerShell's pipelines took longer over it than the
/// OCR itself). `R` is UI Automation's own idea of the desktop, which a program Windows scales for its DPI sees smaller
/// than it is. OCR goes first: UI Automation waits on the window it asks, and one that hangs (Roblox Studio does)
/// would hold the whole read for 20 seconds and lose what OCR had read.
const READ_SCREEN: &str = r#"param([string]$image, [long]$hwnd)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Row($kind, $r, $text) { [Console]::Out.WriteLine("$kind`t$([int]$r.X)`t$([int]$r.Y)`t$([int]$r.Width)`t$([int]$r.Height)`t$(($text -replace '\s+', ' ').Trim())") }
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(-1); $t.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($image)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($engine -eq $null) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'en-US')) }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$stream.Dispose()
foreach ($line in $result.Lines) {
  Row 'L' @{ X = 0; Y = 0; Width = 0; Height = 0 } $line.Text
  foreach ($w in $line.Words) { Row 'W' $w.BoundingRect $w.Text }
}
[Console]::Out.WriteLine('OCR')
if ($hwnd -ne 0) {
  try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $A = [System.Windows.Automation.AutomationElement]
    Row 'R' $A::RootElement.Current.BoundingRectangle ''
    $named = New-Object System.Windows.Automation.NotCondition (New-Object System.Windows.Automation.PropertyCondition ($A::NameProperty, ''))
    foreach ($e in $A::FromHandle([IntPtr]$hwnd).FindAll([System.Windows.Automation.TreeScope]::Descendants, $named)) {
      $c = $e.Current
      if (-not $c.IsOffscreen -and $c.BoundingRectangle.Width -gt 0) { Row 'U' $c.BoundingRectangle $c.Name }
    }
  } catch {}
}
[Console]::Out.WriteLine('END')
"#;

/// Reads `READ_SCREEN`'s rows. OCR's are pixels of the picture, which starts at the desktop's corner `origin`;
/// UI Automation's are scaled back up when its desktop came out narrower than the real one, `width`.
fn parse_seen(out: &str, origin: (i32, i32), width: i32) -> Seen {
    let mut seen = Seen::default();
    let mut ui_scale = 1.0;
    for row in out.lines() {
        let f: Vec<&str> = row.splitn(6, '\t').collect();
        if f.len() < 6 {
            continue;
        }
        let n = |i: usize| f[i].trim().parse::<f64>().unwrap_or(0.0);
        let spot = |s: f64, dx: i32, dy: i32| Spot { x: dx + (n(1) * s).round() as i32, y: dy + (n(2) * s).round() as i32, w: (n(3) * s).round() as i32, h: (n(4) * s).round() as i32, text: f[5].trim().to_string() };
        match f[0] {
            "R" if n(3) > 0.0 => ui_scale = width as f64 / n(3),
            "U" if !f[5].trim().is_empty() => seen.controls.push(spot(ui_scale, 0, 0)),
            "L" => seen.lines.push((spot(1.0, origin.0, origin.1), Vec::new())),
            "W" => {
                if let Some((line, words)) = seen.lines.last_mut() {
                    let word = spot(1.0, origin.0, origin.1);
                    if words.is_empty() {
                        (line.x, line.y, line.w, line.h) = (word.x, word.y, word.w, word.h);
                    } else {
                        let (right, bottom) = ((line.x + line.w).max(word.x + word.w), (line.y + line.h).max(word.y + word.h));
                        (line.x, line.y) = (line.x.min(word.x), line.y.min(word.y));
                        (line.w, line.h) = (right - line.x, bottom - line.y);
                    }
                    words.push(word);
                }
            }
            _ => {}
        }
    }
    seen
}

/// Lower case, letters and digits only, one space between words: "Play!" and "play" are the same label.
fn norm(text: &str) -> String {
    text.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Where `needle` is on the screen, best first. A whole control name or OCR line that is the text beats a run of
/// words inside a longer one; a word that only contains it ("Play" in "Playground") is no match, it is how a
/// wrong button gets clicked. Controls come before OCR at the same strength, then reading order. What lies inside
/// `avoid` (this app's own window, whose chat quotes the very text being looked for) counts only when nothing else does.
fn find(seen: &Seen, needle: &str, avoid: &[(i32, i32, i32, i32)]) -> Vec<Spot> {
    let want = norm(needle);
    if want.is_empty() {
        return Vec::new();
    }
    let want_words: Vec<&str> = want.split(' ').collect();
    let mut hits: Vec<(u8, bool, Spot)> = Vec::new();
    for c in &seen.controls {
        let name = norm(&c.text);
        let score = if name == want { 4 } else if format!(" {name} ").contains(&format!(" {want} ")) { 2 } else { 0 };
        if score > 0 {
            hits.push((score, true, c.clone()));
        }
    }
    for (line, words) in &seen.lines {
        if norm(&line.text) == want {
            hits.push((3, false, line.clone()));
            continue;
        }
        let normed: Vec<String> = words.iter().map(|w| norm(&w.text)).collect();
        // OCR splits on spaces; a word of its own may still hold "File:" or "(F5)", which norm() takes apart.
        let flat: Vec<(usize, &str)> = normed.iter().enumerate().flat_map(|(i, w)| w.split(' ').filter(|p| !p.is_empty()).map(move |p| (i, p))).collect();
        for start in 0..flat.len() {
            if flat.len() - start >= want_words.len() && flat[start..start + want_words.len()].iter().map(|(_, w)| *w).eq(want_words.iter().copied()) {
                let (first, last) = (flat[start].0, flat[start + want_words.len() - 1].0);
                let (a, b) = (&words[first], &words[last]);
                let (x, y) = (a.x.min(b.x), a.y.min(b.y));
                let bottom = words[first..=last].iter().map(|w| w.y + w.h).max().unwrap_or(y);
                hits.push((2, false, Spot { x, y, w: (b.x + b.w - x).max(1), h: (bottom - y).max(1), text: line.text.clone() }));
            }
        }
    }
    let inside = |s: &Spot| {
        let (x, y) = s.centre();
        avoid.iter().any(|&(l, t, r, b)| x >= l && x < r && y >= t && y < b)
    };
    if hits.iter().any(|h| !inside(&h.2)) {
        hits.retain(|h| !inside(&h.2));
    }
    hits.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then((a.2.y / 8, a.2.x).cmp(&(b.2.y / 8, b.2.x))));
    let best = hits.first().map_or(0, |h| h.0);
    hits.into_iter().filter(|h| h.0 == best).map(|h| h.2).collect()
}

/// Lines on the screen that share a word with `needle`, to say what is there when it is not.
fn near(seen: &Seen, needle: &str) -> Vec<String> {
    let want: Vec<String> = norm(needle).split(' ').filter(|w| w.len() > 1).map(str::to_string).collect();
    let mut out: Vec<String> = seen.controls.iter().chain(seen.lines.iter().map(|(l, _)| l)).filter(|s| want.iter().any(|w| norm(&s.text).contains(w.as_str()))).map(|s| s.text.clone()).collect();
    out.dedup();
    out.truncate(10);
    out
}

/// Every control named in the window in front and every line of text on the screen, as of now.
// ponytail: a fresh PowerShell per read, about a second of it start-up. Keep one running and feed it requests if
// text clicks are ever the slow part of a run.
async fn read_screen(want_controls: bool) -> Result<(Seen, RgbaImage), String> {
    let full = tokio::task::block_in_place(os::capture)?;
    let (x, y, w, _) = os::screen();
    let dir = std::env::temp_dir().join("apim-screen");
    let _ = std::fs::create_dir_all(&dir);
    let script = dir.join("read-screen-1.ps1");
    if std::fs::read_to_string(&script).ok().as_deref() != Some(READ_SCREEN) {
        std::fs::write(&script, READ_SCREEN).map_err(|e| format!("could not write the OCR script: {e}"))?;
    }
    // Two reads at once (two chats) must not share a picture.
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let picture = dir.join(format!("screen-{}-{}.bmp", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    // Uncompressed: a 1440p picture is written in milliseconds, where a PNG takes a tenth of a second.
    tokio::task::block_in_place(|| image::DynamicImage::ImageRgba8(full.clone()).to_rgb8().save(&picture)).map_err(|e| format!("could not save the screen for OCR: {e}"))?;
    let front = if want_controls { os::windows().into_iter().find(|w| w.foreground).map_or(0, |w| w.hwnd) } else { 0 };
    let mut cmd = tokio::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]).arg(&script).arg(&picture).arg(front.to_string());
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().map_err(|e| format!("could not start PowerShell to read the screen: {e}"))?;
    let mut rows = tokio::io::BufReader::new(child.stdout.take().expect("piped")).lines();
    let (mut text, mut ocr_done) = (String::new(), None::<Instant>);
    let started = Instant::now();
    loop {
        // 20 s for the whole read; once OCR is in, 2.5 s more for the controls, and then on without them.
        let left = match ocr_done {
            Some(at) => Duration::from_millis(2_500).saturating_sub(at.elapsed()),
            None => Duration::from_secs(20).saturating_sub(started.elapsed()),
        };
        match tokio::time::timeout(left, rows.next_line()).await {
            Ok(Ok(Some(row))) if row == "END" => break,
            Ok(Ok(Some(row))) if row == "OCR" => ocr_done = Some(Instant::now()),
            Ok(Ok(Some(row))) => {
                text.push_str(&row);
                text.push('\n');
            }
            Ok(_) => break,
            Err(_) => break,
        }
    }
    let _ = child.start_kill();
    let _ = std::fs::remove_file(&picture);
    if ocr_done.is_none() {
        if started.elapsed() >= Duration::from_secs(20) {
            return Err("reading the text on the screen took more than 20 seconds".into());
        }
        let mut why = String::new();
        if let Some(mut err) = child.stderr.take() {
            let _ = tokio::time::timeout(Duration::from_millis(500), tokio::io::AsyncReadExt::read_to_string(&mut err, &mut why)).await;
        }
        return Err(format!("Windows could not read the text on the screen: {}", why.lines().find(|l| !l.trim().is_empty()).unwrap_or("no reason given")));
    }
    Ok((parse_seen(&text, (x, y), w), full))
}

// ---------------------------------------------------------------- pictures

/// The rings' colour: a hot pink that no common UI uses, edged in white so it shows on dark and light alike.
const MARK: [u8; 3] = [255, 46, 99];
const EDGE: [u8; 3] = [255, 255, 255];

fn blend(img: &mut RgbaImage, x: i32, y: i32, colour: [u8; 3], alpha: f32) {
    if alpha <= 0.0 || x < 0 || y < 0 || x >= img.width() as i32 || y >= img.height() as i32 {
        return;
    }
    let px = img.get_pixel_mut(x as u32, y as u32);
    for i in 0..3 {
        px[i] = (px[i] as f32 * (1.0 - alpha.min(1.0)) + colour[i] as f32 * alpha.min(1.0)).round() as u8;
    }
}

/// An anti-aliased band `width` wide around the circle of radius `r` (r 0 is a filled disc of radius `width`).
fn band(img: &mut RgbaImage, (cx, cy): (f32, f32), r: f32, width: f32, colour: [u8; 3]) {
    let reach = (r + width + 2.0).ceil() as i32;
    for y in cy as i32 - reach..=cy as i32 + reach {
        for x in cx as i32 - reach..=cx as i32 + reach {
            let d = (x as f32 + 0.5 - cx).hypot(y as f32 + 0.5 - cy);
            let off = if r == 0.0 { d - width } else { (d - r).abs() - width / 2.0 };
            blend(img, x, y, colour, 0.5 - off);
        }
    }
}

/// 3x5 digits, a row to a byte: the step numbers beside the rings.
const DIGITS: [[u8; 5]; 10] = [
    [7, 5, 5, 5, 7],
    [2, 6, 2, 2, 7],
    [7, 1, 7, 4, 7],
    [7, 1, 7, 1, 7],
    [5, 5, 7, 1, 1],
    [7, 4, 7, 1, 7],
    [7, 4, 7, 5, 7],
    [7, 1, 2, 2, 2],
    [7, 5, 7, 5, 7],
    [7, 5, 7, 1, 7],
];

/// A ring where a click landed, with its step's number in a tag beside it. Open in the middle: a dot there hid the
/// very thing clicked (a button's word, a checkbox), and with it whether the click took. Sized for the chat, which
/// shows the picture at about 0.4x: smaller, the ring was a speck there and the number could not be read.
fn mark(img: &mut RgbaImage, at: (f32, f32), label: Option<usize>) {
    const R: f32 = 18.0;
    band(img, at, R, 7.0, EDGE);
    band(img, at, R, 3.5, MARK);
    let Some(n) = label else { return };
    let text = n.to_string();
    let (dot, gap) = (3, 2);
    let tw = text.len() as i32 * (3 * dot + gap) - gap;
    let (w, h) = (tw + 10, 5 * dot + 10);
    // Up and to the right of the ring, turned round where that would leave the picture.
    let left = if at.0 as i32 + 16 + w > img.width() as i32 { at.0 as i32 - 16 - w } else { at.0 as i32 + 16 };
    let top = if at.1 as i32 - 16 - h < 0 { at.1 as i32 + 16 } else { at.1 as i32 - 16 - h };
    // A pill: the white edge, then the colour.
    for y in top - 1..top + h + 1 {
        for x in left - 1..left + w + 1 {
            let inside = |pad: i32| x >= left - pad && x < left + w + pad && y >= top - pad && y < top + h + pad;
            let corner = |pad: i32| {
                let (cx, cy) = (x.clamp(left + 4 - pad, left + w - 5 + pad), y.clamp(top + 4 - pad, top + h - 5 + pad));
                ((x - cx) * (x - cx) + (y - cy) * (y - cy)) as f32 <= ((4 + pad) * (4 + pad)) as f32
            };
            if inside(1) && corner(1) {
                blend(img, x, y, if inside(0) && corner(0) { MARK } else { EDGE }, 1.0);
            }
        }
    }
    for (i, c) in text.bytes().enumerate() {
        let glyph = DIGITS[(c - b'0') as usize];
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..3 {
                if bits & (4 >> col) != 0 {
                    for dy in 0..dot {
                        for dx in 0..dot {
                            blend(img, left + 5 + i as i32 * (3 * dot + gap) + col * dot + dx, top + 5 + row as i32 * dot + dy, EDGE, 1.0);
                        }
                    }
                }
            }
        }
    }
}

/// Saves a picture for the model and the chat, as JPEG: a tenth of a PNG's bytes, the same to a model's eye.
fn save(ctx: &Ctx, img: &RgbaImage, tag: &str) -> Result<PathBuf, String> {
    let dir = ctx.state_dir.join("screen");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not keep the screenshot: {e}"))?;
    let path = dir.join(format!("{}-{tag}.jpg", chrono::Local::now().format("%Y%m%d-%H%M%S%3f")));
    let file = std::fs::File::create(&path).map_err(|e| format!("could not keep the screenshot: {e}"))?;
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(file), 85);
    image::DynamicImage::ImageRgba8(img.clone()).to_rgb8().write_with_encoder(encoder).map_err(|e| format!("could not keep the screenshot: {e}"))?;
    let mut kept: Vec<PathBuf> = std::fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.path()).collect();
    kept.sort();
    for old in kept.iter().take(kept.len().saturating_sub(KEPT_SHOTS)) {
        let _ = std::fs::remove_file(old);
    }
    Ok(path)
}

// ---------------------------------------------------------------- what the model is told

/// The open windows, front first, in screenshot pixels.
fn windows_text(frame: &Frame) -> String {
    let mut lines = Vec::new();
    for w in os::windows().iter().filter(|w| w.title != "Program Manager").take(20) {
        let who = if w.process.eq_ignore_ascii_case("apim") { format!("{}: this app, where the user talks to you", w.process) } else { w.process.clone() };
        let place = if w.minimized || w.rect.0 <= -30000 {
            "minimized".to_string()
        } else {
            let (x1, y1) = frame.from_screen((w.rect.0, w.rect.1));
            let (x2, y2) = frame.from_screen((w.rect.2, w.rect.3));
            format!("at {x1},{y1} to {x2},{y2}")
        };
        lines.push(format!("- \"{}\" ({who}){}, {place}", w.title, if w.foreground { ", in front" } else { "" }));
    }
    if lines.is_empty() { "No windows are open.".to_string() } else { format!("Windows, front first:\n{}", lines.join("\n")) }
}

fn frame_line(frame: &Frame) -> String {
    let (_, _, w, h) = os::screen();
    if frame.scale > 1.0 {
        format!("Screenshot: {}x{}, the {w}x{h} desktop shrunk {:.2}x. Coordinates for computer_act are pixels of this screenshot.", frame.w, frame.h, frame.scale)
    } else {
        format!("Screenshot: {}x{}, the whole desktop. Coordinates for computer_act are pixels of this screenshot.", frame.w, frame.h)
    }
}

/// OCR's lines in screenshot pixels, top to bottom, each with the point that clicks it.
fn text_listing(seen: &Seen, frame: &Frame) -> String {
    let mut lines: Vec<&Spot> = seen.lines.iter().map(|(l, _)| l).collect();
    lines.sort_by_key(|l| (l.y / 8, l.x));
    let shown: Vec<String> = lines.iter().take(200).map(|l| {
        let (x, y) = frame.from_screen(l.centre());
        format!("({x},{y}) {}", l.text)
    }).collect();
    let more = if lines.len() > shown.len() { format!("\n…and {} more lines", lines.len() - shown.len()) } else { String::new() };
    if shown.is_empty() { "No text was read on the screen.".to_string() } else { format!("Text on the screen (the point clicks the line's centre):\n{}{more}", shown.join("\n")) }
}

fn off(ctx: &Ctx) -> Option<Output> {
    (!ctx.settings.computer_use).then(|| Output::fail("Computer use is off: the user has the Computer toggle switched off, so the screen, mouse and keyboard are not yours to use. Do it another way, or ask the user to switch it on."))
}

fn find_window(name: &str) -> Option<os::Win> {
    os::windows().into_iter().filter(|w| !w.title.is_empty()).filter_map(|w| crate::browser::window::rank(name, &w.title, &w.process).map(|r| (r, w))).min_by_key(|(r, _)| *r).map(|(_, w)| w)
}

// ---------------------------------------------------------------- computer_look

pub async fn look(ctx: &Ctx, args: &Value) -> Output {
    if let Some(off) = off(ctx) {
        return off;
    }
    let mut notes = Vec::new();
    let window = str_arg(args, "window").trim();
    if !window.is_empty() {
        match find_window(window) {
            Some(w) => {
                if !tokio::task::block_in_place(|| os::focus(&w)) {
                    notes.push(format!("Windows kept another window in front of \"{}\"; click it to bring it forward.", w.title));
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            None => return Output::fail(format!("No open window matches \"{window}\".\n\n{}", windows_text(&Frame::now()))),
        }
    }
    let frame = Frame::now();
    let want_text = bool_arg(args, "text");
    let (seen, full) = if want_text {
        match read_screen(false).await {
            Ok((seen, full)) => (Some(seen), full),
            Err(why) => return Output::fail(format!("Could not read the screen: {why}")),
        }
    } else {
        match tokio::task::block_in_place(os::capture) {
            Ok(full) => (None, full),
            Err(why) => return Output::fail(format!("Could not see the screen: {why}")),
        }
    };
    let zoom: Vec<f64> = args["zoom"].as_array().map(|a| a.iter().filter_map(number).collect()).unwrap_or_default();
    let (picture, head) = if zoom.len() == 4 {
        let (x1, y1, x2, y2) = (zoom[0].min(zoom[2]).max(0.0), zoom[1].min(zoom[3]).max(0.0), zoom[0].max(zoom[2]).min(frame.w as f64), zoom[1].max(zoom[3]).min(frame.h as f64));
        if x2 - x1 < 4.0 || y2 - y1 < 4.0 {
            return Output::fail(format!("The zoom [{}, {}, {}, {}] has no area inside the {}x{} screenshot.", zoom[0], zoom[1], zoom[2], zoom[3], frame.w, frame.h));
        }
        let (sx, sy) = frame.to_screen((x1, y1));
        let (ex, ey) = frame.to_screen((x2, y2));
        let (cx, cy) = ((sx - frame.x) as u32, (sy - frame.y) as u32);
        let crop = image::imageops::crop_imm(&full, cx, cy, ((ex - sx) as u32).min(full.width() - cx), ((ey - sy) as u32).min(full.height() - cy)).to_image();
        // Shown up to 3x the screen's own pixels, to fill the frame: small text is read better large.
        let k = (FRAME.0 / crop.width() as f64).min(FRAME.1 / crop.height() as f64).min(3.0);
        let picture = if (k - 1.0).abs() > 0.05 { image::imageops::resize(&crop, (crop.width() as f64 * k) as u32, (crop.height() as f64 * k) as u32, image::imageops::FilterType::CatmullRom) } else { crop };
        let shown = picture.width() as f64 / (x2 - x1);
        let head = format!(
            "Zoomed on [{x1:.0}, {y1:.0}, {x2:.0}, {y2:.0}] of the screenshot, shown {shown:.1}x larger ({}x{}). Coordinates for computer_act are still those of the whole screenshot: a point (a, b) in this zoom is ({x1:.0} + a/{shown:.1}, {y1:.0} + b/{shown:.1}) there.",
            picture.width(),
            picture.height()
        );
        (picture, head)
    } else {
        (frame.fit(&full), frame_line(&frame))
    };
    let path = match tokio::task::block_in_place(|| save(ctx, &picture, "look")) {
        Ok(path) => path,
        Err(why) => return Output::fail(why),
    };
    let mut text = vec![head, windows_text(&frame)];
    if let Some(seen) = &seen {
        text.push(text_listing(seen, &frame));
    }
    text.extend(notes);
    text.push("The screenshot is attached.".into());
    let summary = if zoom.len() == 4 { "Zoomed in on the screen".to_string() } else { "Looked at the screen".to_string() };
    Output { image: Some(path.clone()), look: Some(path), ..Output::ok(text.join("\n\n"), summary) }
}

// ---------------------------------------------------------------- computer_act

/// The user has taken the mouse: it is not where the last step left it. A game that holds the pointer in the middle
/// of its window (first person) moves it too, so a pointer at the window's centre is not taken for the user's.
// ponytail: the centre test is the only tell of a captured pointer; a game that parks it elsewhere would stop every run.
fn user_moved(last: (i32, i32)) -> bool {
    let now = os::cursor();
    if (now.0 - last.0).abs() <= 2 && (now.1 - last.1).abs() <= 2 {
        return false;
    }
    !os::windows().iter().find(|w| w.foreground).is_some_and(|w| {
        let (cx, cy) = ((w.rect.0 + w.rect.2) / 2, (w.rect.1 + w.rect.3) / 2);
        (now.0 - cx).abs() <= 3 && (now.1 - cy).abs() <= 3
    })
}

const TAKEN: &str = "the user moved the mouse, so they are using the computer. Nothing more was done: tell them what you were doing, and do not take the mouse back until they say so";

/// Sleeps `ms`, a slice at a time, and Err as soon as the user takes the mouse.
async fn rest(ms: u64, last: (i32, i32)) -> Result<(), String> {
    let until = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < until {
        if user_moved(last) {
            return Err(TAKEN.into());
        }
        tokio::time::sleep((until - Instant::now()).min(Duration::from_millis(100))).await;
    }
    Ok(())
}

struct Run {
    frame: Frame,
    /// Where the pointer was left, to tell the user's hand from ours.
    last: (i32, i32),
    /// Clicks to ring on the picture: screen point and step number.
    marks: Vec<((i32, i32), usize)>,
}

impl Run {
    /// A step's point on the screen: given, or found by its text.
    async fn locate(&mut self, at: &Target) -> Result<((i32, i32), String), String> {
        match at {
            Target::Point(x, y) => Ok((self.frame.point((*x, *y))?, String::new())),
            Target::Text(text, nth) => {
                // This app's own windows, where its chat shows what is being looked for.
                let own: Vec<(i32, i32, i32, i32)> = os::windows().iter().filter(|w| w.process.eq_ignore_ascii_case("apim") && !w.minimized).map(|w| w.rect).collect();
                // Read again for a moment when it is not there yet: the window a click just opened is still drawing.
                let mut tries = 0;
                let (seen, hits) = loop {
                    let (seen, _) = read_screen(true).await?;
                    let hits = find(&seen, text, &own);
                    tries += 1;
                    if hits.len() >= *nth || tries == 3 {
                        break (seen, hits);
                    }
                    rest(300, self.last).await?;
                };
                let Some(hit) = hits.get(nth - 1) else {
                    let near = near(&seen, text);
                    let said = if near.is_empty() { String::new() } else { format!(" On the screen with a word of it: {}.", near.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(", ")) };
                    return Err(match hits.len() {
                        0 => format!("\"{text}\" is not on the screen (nothing named so, and OCR did not read it).{said} Look at the screenshot and give a point instead."),
                        n => format!("\"{text}\" is on the screen {n} time{}, not {nth}.", if n == 1 { "" } else { "s" }),
                    });
                };
                let (x, y) = self.frame.from_screen(hit.centre());
                let others = if hits.len() > 1 { format!(", match {nth} of {} in reading order", hits.len()) } else { String::new() };
                let what = if norm(&hit.text) == norm(text) { String::new() } else { format!(" in \"{}\"", hit.text) };
                Ok((hit.centre(), format!(" \"{text}\"{what} at ({x}, {y}){others}")))
            }
        }
    }

    fn go(&mut self, to: (i32, i32)) -> Result<(), String> {
        os::move_to(to.0, to.1)?;
        // Where it really is: a game that holds the pointer inside its window keeps it from where it was sent, and
        // that is not the user's hand.
        self.last = os::cursor();
        Ok(())
    }

    async fn run(&mut self, n: usize, step: &Step) -> Result<String, String> {
        if user_moved(self.last) {
            return Err(TAKEN.into());
        }
        let pause = || std::thread::sleep(Duration::from_millis(35));
        match step {
            Step::Click { at, button, double, with } => {
                let (to, found) = self.locate(at).await?;
                tokio::task::block_in_place(|| -> Result<(), String> {
                    self.go(to)?;
                    // Hovered first: some buttons take a click only once they have seen the pointer arrive.
                    pause();
                    for k in with {
                        os::key(*k, true)?;
                    }
                    for _ in 0..if *double { 2 } else { 1 } {
                        os::press(*button, true)?;
                        pause();
                        os::press(*button, false)?;
                        pause();
                    }
                    for k in with.iter().rev() {
                        os::key(*k, false)?;
                    }
                    Ok(())
                })?;
                self.marks.push((to, n));
                let kind = match (button, double) {
                    (Button::Left, false) => "clicked",
                    (Button::Left, true) => "double-clicked",
                    (Button::Right, _) => "right-clicked",
                    (Button::Middle, _) => "middle-clicked",
                };
                let (x, y) = self.frame.from_screen(to);
                Ok(if found.is_empty() { format!("{kind} ({x}, {y})") } else { format!("{kind}{found}") })
            }
            Step::Move(at) => {
                let (to, found) = self.locate(at).await?;
                tokio::task::block_in_place(|| self.go(to))?;
                let (x, y) = self.frame.from_screen(to);
                Ok(if found.is_empty() { format!("moved to ({x}, {y})") } else { format!("moved to{found}") })
            }
            Step::Drag(from, to) => {
                let (a, _) = self.locate(from).await?;
                let (b, _) = self.locate(to).await?;
                tokio::task::block_in_place(|| -> Result<(), String> {
                    self.go(a)?;
                    pause();
                    os::press(Button::Left, true)?;
                    // In steps: a drag that jumps straight to its end is a click to many programs.
                    for i in 1..=12 {
                        self.go((a.0 + (b.0 - a.0) * i / 12, a.1 + (b.1 - a.1) * i / 12))?;
                        std::thread::sleep(Duration::from_millis(15));
                    }
                    pause();
                    os::press(Button::Left, false)
                })?;
                self.marks.push((a, n));
                self.marks.push((b, n));
                let (fa, fb) = (self.frame.from_screen(a), self.frame.from_screen(b));
                Ok(format!("dragged ({}, {}) to ({}, {})", fa.0, fa.1, fb.0, fb.1))
            }
            Step::Scroll { at, notches, horizontal } => {
                if let Some(at) = at {
                    let (to, _) = self.locate(at).await?;
                    tokio::task::block_in_place(|| self.go(to))?;
                }
                tokio::task::block_in_place(|| os::wheel(*notches, *horizontal))?;
                let way = match (horizontal, *notches > 0) {
                    (false, true) => "up",
                    (false, false) => "down",
                    (true, true) => "right",
                    (true, false) => "left",
                };
                Ok(format!("scrolled {way} {}", notches.abs()))
            }
            Step::Type(text) => {
                tokio::task::block_in_place(|| os::text(text))?;
                Ok(format!("typed {} character{}", text.chars().count(), if text.chars().count() == 1 { "" } else { "s" }))
            }
            Step::Key { keys, name, repeat } => {
                tokio::task::block_in_place(|| -> Result<(), String> {
                    for _ in 0..*repeat {
                        for k in keys {
                            os::key(*k, true)?;
                        }
                        pause();
                        for k in keys.iter().rev() {
                            os::key(*k, false)?;
                        }
                        pause();
                    }
                    Ok(())
                })?;
                Ok(format!("pressed {name}{}", if *repeat > 1 { format!(" {repeat} times") } else { String::new() }))
            }
            Step::Hold { keys, name, ms } => {
                tokio::task::block_in_place(|| keys.iter().try_for_each(|k| os::key(*k, true)))?;
                let held = rest(*ms, self.last).await;
                // Let go whatever happened: a key left down keeps a game's character walking.
                tokio::task::block_in_place(|| keys.iter().rev().try_for_each(|k| os::key(*k, false)))?;
                held?;
                Ok(format!("held {name} for {:.1}s", *ms as f64 / 1000.0))
            }
            Step::Wait(ms) => {
                rest(*ms, self.last).await?;
                Ok(format!("waited {:.1}s", *ms as f64 / 1000.0))
            }
            Step::WaitFor { text, ms } => {
                let started = Instant::now();
                let limit = Duration::from_millis(*ms);
                loop {
                    let lower = text.to_lowercase();
                    if let Some(w) = os::windows().into_iter().find(|w| w.title.to_lowercase().contains(&lower)) {
                        return Ok(format!("\"{}\" was open after {:.1}s", w.title, started.elapsed().as_secs_f64()));
                    }
                    if let Ok((seen, _)) = read_screen(true).await {
                        if !find(&seen, text, &[]).is_empty() {
                            return Ok(format!("\"{text}\" was on the screen after {:.1}s", started.elapsed().as_secs_f64()));
                        }
                    }
                    if started.elapsed() >= limit {
                        return Err(format!("\"{text}\" did not show on the screen within {:.0}s", limit.as_secs_f64()));
                    }
                    rest(400, self.last).await?;
                }
            }
            Step::Open { target, args } => {
                let pid = tokio::task::block_in_place(|| os::open(target, args))?;
                Ok(match pid {
                    Some(pid) => format!("opened {target} (pid {pid})"),
                    None => format!("opened {target}"),
                })
            }
            Step::Focus(name) => {
                let Some(w) = find_window(name) else { return Err(format!("no open window matches \"{name}\"")) };
                let front = tokio::task::block_in_place(|| os::focus(&w));
                tokio::time::sleep(Duration::from_millis(150)).await;
                if front { Ok(format!("brought \"{}\" to the front", w.title)) } else { Err(format!("Windows kept another window in front of \"{}\"; click it instead", w.title)) }
            }
        }
    }
}

pub async fn act(ctx: &Ctx, args: &Value) -> Output {
    if let Some(off) = off(ctx) {
        return off;
    }
    let steps = match steps(args) {
        Ok(steps) => steps,
        Err(why) => return Output::fail(why),
    };
    // One pair of hands: two chats driving the mouse at once would each click into the other's work.
    static HANDS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _hands = HANDS.lock().await;
    let mut run = Run { frame: Frame::now(), last: os::cursor(), marks: Vec::new() };
    let started = Instant::now();
    let (mut done, mut stopped) = (Vec::new(), None);
    for (i, step) in steps.iter().enumerate() {
        if started.elapsed() > MAX_CALL {
            stopped = Some((i, format!("the call ran past {} seconds; send the rest in another call", MAX_CALL.as_secs())));
            break;
        }
        match run.run(i + 1, step).await {
            Ok(what) => done.push(format!("{}. {what}", i + 1)),
            Err(why) => {
                stopped = Some((i, why));
                break;
            }
        }
    }
    // A moment for the screen to show what the last step did, unless it was a wait already.
    if !matches!(steps.get(done.len().saturating_sub(1)), Some(Step::Wait(_) | Step::WaitFor { .. })) {
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
    let frame = Frame::now();
    let picture = tokio::task::block_in_place(|| {
        os::capture().map(|full| {
            let mut picture = frame.fit(&full);
            let numbered = run.marks.len() > 1;
            for (at, n) in &run.marks {
                let (x, y) = frame.from_screen(*at);
                mark(&mut picture, (x as f32, y as f32), numbered.then_some(*n));
            }
            picture
        })
    });
    let shot = picture.and_then(|p| tokio::task::block_in_place(|| save(ctx, &p, "act")));
    let mut text = Vec::new();
    if !done.is_empty() {
        text.push(format!("Done:\n{}", done.join("\n")));
    }
    if let Some((i, why)) = &stopped {
        let left = steps.len() - i - 1;
        text.push(format!("Step {} failed: {why}.{}", i + 1, if left > 0 { format!(" The {left} step{} after it {} not run.", if left == 1 { "" } else { "s" }, if left == 1 { "was" } else { "were" }) } else { String::new() }));
    }
    text.push(frame_line(&frame));
    text.push(windows_text(&frame));
    let mut shown = None;
    match shot {
        Ok(path) => {
            text.push(if run.marks.is_empty() { "The screenshot of the screen now is attached.".into() } else { "The screenshot of the screen now is attached; pink rings mark where you clicked.".into() });
            shown = Some(path);
        }
        Err(why) => text.push(format!("No screenshot: {why}.")),
    }
    let summary = summary(&steps[..done.len()], stopped.as_ref().map(|(_, why)| why.as_str()));
    Output { ok: stopped.is_none(), image: shown.clone(), look: shown, ..Output::ok(text.join("\n\n"), summary) }
}

/// The step row's line: what was done, in a few words.
fn summary(done: &[Step], failed: Option<&str>) -> String {
    let words: Vec<String> = done
        .iter()
        .filter_map(|s| match s {
            Step::Click { at: Target::Text(t, _), .. } => Some(format!("clicked \"{t}\"")),
            Step::Click { .. } => Some("clicked".into()),
            Step::Drag(..) => Some("dragged".into()),
            Step::Scroll { .. } => Some("scrolled".into()),
            Step::Type(_) => Some("typed".into()),
            Step::Key { name, .. } => Some(format!("pressed {name}")),
            Step::Hold { name, .. } => Some(format!("held {name}")),
            Step::WaitFor { text, .. } => Some(format!("waited for \"{text}\"")),
            Step::Open { target, .. } => Some(format!("opened {}", target.rsplit(['\\', '/']).next().unwrap_or(target))),
            Step::Focus(name) => Some(format!("focused \"{name}\"")),
            Step::Move(_) | Step::Wait(_) => None,
        })
        .collect();
    // The same word over and over reads once, counted.
    let mut runs: Vec<(String, usize)> = Vec::new();
    for w in words {
        match runs.last_mut() {
            Some((last, n)) if *last == w => *n += 1,
            _ => runs.push((w, 1)),
        }
    }
    let mut line = runs.iter().map(|(w, n)| if *n > 1 { format!("{w} ×{n}") } else { w.clone() }).collect::<Vec<_>>().join(", ");
    if let Some(why) = failed {
        let why = why.split(['.', ';']).next().unwrap_or(why);
        line = if line.is_empty() { format!("Stopped: {why}") } else { format!("{line}; stopped: {why}") };
    }
    let mut chars = line.chars();
    let first: String = chars.next().map(|c| c.to_uppercase().collect()).unwrap_or_default();
    let line = format!("{first}{}", chars.as_str());
    if line.chars().count() > 120 { format!("{}…", line.chars().take(119).collect::<String>()) } else if line.is_empty() { "Used the computer".into() } else { line }
}

/// The screenshots this reply sent, all but the newest few taken out once there are many: each one is sent again with
/// every later request. Taken out in a batch, so the cached start of the request changes once in several rounds, not
/// every round. Returns how many were taken out.
pub fn forget_old_screens(messages: &mut [Value], keep: usize, batch: usize) -> usize {
    let shown: Vec<usize> = (0..messages.len()).filter(|&i| messages[i]["role"] == "user" && messages[i]["content"][0]["text"].as_str().is_some_and(|t| t.starts_with("[tool image]")) && messages[i]["content"].as_array().is_some_and(|c| c.len() > 1)).collect();
    if shown.len() < keep + batch {
        return 0;
    }
    let old = &shown[..shown.len() - keep];
    for &i in old {
        messages[i]["content"] = json!([{ "type": "text", "text": "[tool image] (an older picture, taken out to save room: what it showed is in the results around it; look again for the screen as it is now)" }]);
    }
    old.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_are_read_whole_or_not_at_all() {
        let ok = serde_json::json!({ "steps": [
            { "click": "Play" }, { "click": [100, 200], "button": "right", "double": true }, { "click": "Run", "nth": 2 },
            { "type": "hi\n" }, { "key": "ctrl+s", "repeat": 2 }, { "hold": "w", "ms": 1500 }, { "wait": 500 },
            { "wait_for": "Roblox Studio" }, { "open": "notepad" }, { "scroll": "down", "amount": 5, "at": [10, 10] },
            { "drag": [[1, 2], [3, 4]] }, { "focus": "apiM" }, { "move": { "x": 5, "y": "6" } }
        ] });
        let read = steps(&ok).unwrap();
        assert_eq!(read[0], Step::Click { at: Target::Text("Play".into(), 1), button: Button::Left, double: false, with: vec![] });
        assert_eq!(read[1], Step::Click { at: Target::Point(100.0, 200.0), button: Button::Right, double: true, with: vec![] });
        assert_eq!(read[2], Step::Click { at: Target::Text("Run".into(), 2), button: Button::Left, double: false, with: vec![] });
        assert_eq!(read[9], Step::Scroll { at: Some(Target::Point(10.0, 10.0)), notches: -5, horizontal: false });
        assert_eq!(read[12], Step::Move(Target::Point(5.0, 6.0)));
        // A list sent as text is read; one bad step refuses the whole call.
        assert_eq!(steps(&serde_json::json!({ "steps": "[{\"wait\": 10}]" })).unwrap(), [Step::Wait(10)]);
        let bad = steps(&serde_json::json!({ "steps": [{ "wait": 10 }, { "key": "ctrl+banana" }] })).unwrap_err();
        assert!(bad.starts_with("Step 2 ") && bad.contains("banana") && bad.ends_with("Nothing was done."), "{bad}");
        assert!(steps(&serde_json::json!({ "steps": [{ "jump": 1 }] })).unwrap_err().contains("none of click"));
        assert!(steps(&serde_json::json!({})).is_err());
    }

    #[test]
    fn the_frame_maps_both_ways() {
        let f = Frame::of((0, 0, 2560, 1440));
        assert_eq!((f.w, f.h), (1365, 768));
        assert_eq!(f.to_screen((683.0, 384.0)), (1281, 720));
        assert_eq!(f.from_screen((1281, 720)), (683, 384));
        assert!(f.point((1400.0, 10.0)).unwrap_err().contains("outside"));
        // A small screen is not blown up; a monitor left of the main one starts below zero.
        let small = Frame::of((-1280, 0, 1280, 720));
        assert_eq!((small.scale, small.w, small.to_screen((0.0, 0.0))), (1.0, 1280, (-1280, 0)));
    }

    #[test]
    fn text_is_found_whole_not_inside_another_word() {
        let out = "R\t0\t0\t1280\t720\t\nU\t10\t10\t40\t20\tPlay\nL\t0\t0\t0\t0\tPlay Solo (F5)\nW\t100\t50\t40\t20\tPlay\nW\t150\t52\t40\t20\tSolo\nW\t200\t50\t40\t20\t(F5)\nL\t0\t0\t0\t0\tPlayground\nW\t0\t300\t90\t20\tPlayground\nL\t0\t0\t0\t0\tplay!\nW\t0\t400\t50\t20\tplay!\n";
        // UI Automation saw a desktop half the size: its control is scaled up; OCR's rows are moved to the desktop's corner.
        let seen = parse_seen(out, (-100, 0), 2560);
        assert_eq!(seen.controls[0], Spot { x: 20, y: 20, w: 80, h: 40, text: "Play".into() });
        // A line's box is its words'.
        assert_eq!(seen.lines[0].0, Spot { x: 0, y: 50, w: 140, h: 22, text: "Play Solo (F5)".into() });
        let hits = find(&seen, "play", &[]);
        // The control named exactly that wins over OCR's exact line "play!".
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "Play");
        // Without the control: the exact line, never "Playground".
        let ocr_only = Seen { controls: vec![], lines: seen.lines.clone() };
        assert_eq!(find(&ocr_only, "Play", &[]).iter().map(|h| h.text.as_str()).collect::<Vec<_>>(), ["play!"]);
        // The same words in this app's own window lose to any match outside it, even a weaker one.
        let own = [(-110, 390, 0, 430)];
        assert_eq!(find(&ocr_only, "Play", &own).iter().map(|h| h.text.as_str()).collect::<Vec<_>>(), ["Play Solo (F5)"]);
        assert_eq!(find(&Seen { controls: vec![], lines: ocr_only.lines[2..].to_vec() }, "Play", &own).len(), 1);
        // A run of words inside a line is boxed to those words alone.
        let solo = find(&ocr_only, "solo f5", &[]);
        assert_eq!((solo[0].x, solo[0].y, solo[0].w, solo[0].h), (50, 50, 90, 22));
        assert!(find(&ocr_only, "ground", &[]).is_empty());
        assert!(near(&ocr_only, "Playground menu").contains(&"Playground".to_string()));
    }

    #[test]
    fn the_summary_reads_as_a_line() {
        let done = [Step::Open { target: "C:\\Roblox\\RobloxStudioBeta.exe".into(), args: String::new() }, Step::WaitFor { text: "Studio".into(), ms: 1 }, Step::Click { at: Target::Text("Play".into(), 1), button: Button::Left, double: false, with: vec![] }, Step::Key { keys: vec![], name: "tab".into(), repeat: 1 }, Step::Key { keys: vec![], name: "tab".into(), repeat: 1 }];
        assert_eq!(summary(&done, None), "Opened RobloxStudioBeta.exe, waited for \"Studio\", clicked \"Play\", pressed tab ×2");
        assert_eq!(summary(&[], Some("the user moved the mouse, so they are using it")), "Stopped: the user moved the mouse, so they are using it");
    }

    #[test]
    fn marks_stay_inside_the_picture() {
        let mut img = RgbaImage::from_pixel(60, 40, image::Rgba([0, 0, 0, 255]));
        mark(&mut img, (20.0, 20.0), Some(12));
        mark(&mut img, (58.0, 38.0), None);
        // The ring, and the spot it rings left as it was.
        assert_eq!(img.get_pixel(38, 20).0[..3], MARK);
        assert_eq!(img.get_pixel(20, 20).0[..3], [0, 0, 0]);
    }

    #[test]
    fn old_screens_go_in_a_batch() {
        let pic = |n: u32| serde_json::json!({ "role": "user", "content": [{ "type": "text", "text": "[tool image] The image(s) you asked to view:" }, { "type": "image_url", "image_url": { "url": format!("data:{n}") } }] });
        let mut messages: Vec<Value> = (0..7).map(pic).collect();
        assert_eq!(forget_old_screens(&mut messages, 3, 5), 0);
        messages.push(pic(7));
        assert_eq!(forget_old_screens(&mut messages, 3, 5), 5);
        assert_eq!(messages[4]["content"].as_array().unwrap().len(), 1);
        assert_eq!(messages[5]["content"][1]["image_url"]["url"], "data:5");
        // Taken out already, they are not counted again.
        assert_eq!(forget_old_screens(&mut messages, 3, 5), 0);
    }
}
