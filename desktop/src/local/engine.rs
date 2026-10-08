//! Port of `src/lib/local-engine.ts`: finds and runs the llama.cpp sidecar that serves Qwen 3.8 27B on loopback,
//! downloads its weights and engine, and reports what the machine is doing. The route's actions are the `pub async`
//! functions at the bottom (status, start, stop, restart, ensure, set_opts, download). Call them from a background
//! thread through a tokio runtime (`Runtime::new()`, as ui/github.rs does). The UI always uses ENGINE_PORT.
//!
//! Functions that probe, spawn or kill take the port as a parameter, so the tests run against a stub server on a
//! free port and never touch the real sidecar.
//! ponytail: nvidia-smi calls have no 2 s timeout (the web has one); std gives no free-RAM figure, so ram_free_gb is 0
//! and the low-RAM warning never shows (the web reads os.freemem()).
//! ponytail: stop_engine does not kill llama-server by image name (the web does). A stray llama-server on another port
//! is left alone; the sidecar's own port and pid file are still killed.
//! ponytail: a pid from the file is killed only when its image is llama-server (the web trusts the file).

use super::shared::*;
use regex::Regex;
use reqwest::header::{CONTENT_LENGTH, LOCATION, RANGE, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const APP_UA: &str = "apiM-local-engine";
const HOLD_MSG: &str = "An old llama-server is still holding the port. End llama-server in Task Manager and click Restart.";
/// The sidecar this app started. Its stderr is teed to the log file.
static CHILD: Mutex<Option<Child>> = Mutex::new(None);
/// Plan cache: status polls every few seconds, so the GGUF header is read at most every two minutes.
static PLAN_CACHE: Mutex<Option<(Instant, String, SidecarMachinePlan)>> = Mutex::new(None);

/// The engine folder. Same place as the web's `localEngineRoot()` when the app runs from a checkout (data/local-engine).
pub fn root() -> PathBuf {
    crate::store::data_dir().join("local-engine")
}
fn gguf_path() -> PathBuf {
    root().join(GGUF_FILE)
}
fn projector_path() -> PathBuf {
    root().join(MMPROJ_FILE)
}
fn bin_dir() -> PathBuf {
    root().join("bin")
}
fn archive_path(name: &str) -> PathBuf {
    root().join("cache").join(name)
}
fn pid_path() -> PathBuf {
    root().join("sidecar.pid")
}
fn spec_path() -> PathBuf {
    root().join("spec-opts.json")
}
fn launch_stamp_path() -> PathBuf {
    root().join("sidecar.launch")
}
fn engine_log_path() -> PathBuf {
    root().join("sidecar.log")
}
fn build_stamp_path() -> PathBuf {
    root().join("sidecar.build")
}
fn last_used_path() -> PathBuf {
    root().join("last-used")
}

fn file_size(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}
/// Run a helper with no console window (CREATE_NO_WINDOW), as the rest of the desktop does.
fn quiet(mut c: Command) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}
fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}
fn mmproj_present() -> Option<PathBuf> {
    (file_size(&projector_path()) >= MMPROJ_MIN_BYTES).then(projector_path)
}
fn ev_status(message: &str) -> EngineDownloadEvent {
    EngineDownloadEvent::Status { message: message.into() }
}
/// Progress event; `percent` is None while the total is unknown.
fn ev_progress(label: &str, completed: u64, total: u64) -> EngineDownloadEvent {
    EngineDownloadEvent::Progress { label: label.into(), completed, total, percent: download_percent(completed as f64, total as f64) }
}

// ---- hardware ----

/// The llama-server binary anywhere under bin/ (the archive nests it). Depth-limited like the web's walk.
pub fn find_server_binary() -> Option<PathBuf> {
    let want = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    find_in(&bin_dir(), want, 0)
}
fn find_in(dir: &Path, want: &str, depth: u32) -> Option<PathBuf> {
    if depth > 6 {
        return None;
    }
    let entries: Vec<std::fs::DirEntry> = std::fs::read_dir(dir).ok()?.flatten().collect();
    if let Some(e) = entries.iter().find(|e| e.file_type().is_ok_and(|t| t.is_file()) && e.file_name().to_str() == Some(want)) {
        return Some(e.path());
    }
    entries.iter().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).find_map(|e| find_in(&e.path(), want, depth + 1))
}

/// What the machine reports. Metal on macOS, NVIDIA when nvidia-smi lists a GPU, Vulkan for a DRI node on Linux.
pub fn detect_gpu() -> EngineGpu {
    if cfg!(target_os = "macos") {
        return EngineGpu::Metal;
    }
    if let Ok(o) = quiet(Command::new("nvidia-smi")).arg("-L").output() {
        if o.status.success() && String::from_utf8_lossy(&o.stdout).to_ascii_uppercase().contains("GPU") {
            return EngineGpu::Nvidia;
        }
    }
    if cfg!(target_os = "linux") && Path::new("/dev/dri/renderD128").exists() {
        return EngineGpu::Vulkan;
    }
    EngineGpu::None
}

#[derive(Debug, Clone, PartialEq)]
struct NvidiaGpu {
    vram_mb: u64,
    compute_cap: String,
}

/// One nvidia-smi call for VRAM and compute capability. None when there is no NVIDIA driver.
fn query_nvidia_gpu() -> Option<NvidiaGpu> {
    let o = quiet(Command::new("nvidia-smi")).args(["--query-gpu=memory.total,compute_cap", "--format=csv,noheader,nounits"]).output().ok()?;
    if !o.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&o.stdout).into_owned();
    let first = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut parts = first.split(',').map(str::trim);
    let vram_mb: u64 = parts.next()?.parse().ok().filter(|v| *v > 0)?;
    Some(NvidiaGpu { vram_mb, compute_cap: parts.next().unwrap_or("").to_string() })
}
fn detect_cuda_major() -> &'static str {
    cuda_major_for_compute_cap(query_nvidia_gpu().as_ref().map(|g| g.compute_cap.as_str()))
}

/// What this PC can run: fitted layers, threads, VRAM and the layer count. Idle (ngl 99, layers 0) when unknown.
pub fn plan_sidecar_machine(gguf: &Path, mmproj: Option<&Path>, spec: &SidecarSpecState) -> SidecarMachinePlan {
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get() as u32);
    let idle = SidecarMachinePlan { ngl: 99, threads, vram_mb: 0, layers: 0, ram_free_gb: 0.0 };
    let Some(gpu) = query_nvidia_gpu() else { return idle };
    if spec.build.as_deref() == Some("cpu") {
        return idle;
    }
    let mm_bytes = mmproj.map_or(0, file_size);
    let key = format!("{}:{}:{}", spec.build.as_deref().unwrap_or("auto"), file_size(gguf), mm_bytes);
    let mut cache = PLAN_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((at, k, plan)) = cache.as_ref() {
        if *k == key && at.elapsed() < Duration::from_secs(120) {
            return SidecarMachinePlan { threads, ..plan.clone() };
        }
    }
    let plan = match read_gguf_model_info(gguf) {
        Some(info) => SidecarMachinePlan {
            ngl: plan_gpu_layers(gpu.vram_mb as f64, file_size(gguf) as f64, info.block_count as f64, info.kv_bytes_per_token as f64, SIDECAR_CTX as f64, mm_bytes as f64),
            threads,
            vram_mb: gpu.vram_mb,
            layers: info.block_count as u32,
            ram_free_gb: 0.0,
        },
        None => idle,
    };
    *cache = Some((Instant::now(), key, plan.clone()));
    plan
}

// ---- status ----

/// The whole status panel: files on disk, what runs, the GPU, the plan and the hint. `port` is ENGINE_PORT in the app.
async fn status_at(port: u16) -> EngineStatus {
    maybe_unload_idle(port).await;
    let bytes = file_size(&gguf_path());
    let projector = file_size(&projector_path());
    let gguf_ready = gguf_looks_complete(bytes);
    let mmproj_ready = projector >= MMPROJ_MIN_BYTES;
    let server = find_server_binary().is_some();
    let running = is_listening(port).await;
    let n_ctx = if running { read_ctx(port).await } else { None };
    let spec = read_spec_state();
    let gpu = build_gpu_state(running, &spec);
    let mp = mmproj_present();
    let gpu_plan = gguf_ready.then(|| plan_sidecar_machine(&gguf_path(), mp.as_deref(), &spec));
    EngineStatus {
        gguf_ready,
        gguf_bytes: bytes,
        gguf_expected: GGUF_BYTES,
        mmproj_ready,
        mmproj_bytes: projector,
        mmproj_expected: MMPROJ_BYTES,
        server_ready: server,
        running,
        base_url: DEFAULT_LOCAL_BASE_URL.into(),
        api_model: DEFAULT_LOCAL_API_MODEL.into(),
        hint: engine_hint(gguf_ready, mmproj_ready, server, running, bytes as f64),
        n_ctx,
        spec,
        gpu,
        gpu_plan,
    }
}

/// What the engine log says about the GPU. The fit warning outranks the offload line: on Windows the allocs spill to
/// shared RAM instead of failing, so the log can claim 64/64 offloaded while every token crawls over PCIe.
fn build_gpu_state(running: bool, spec: &SidecarSpecState) -> EngineGpuState {
    let detected = detect_gpu();
    let log_tail = read_log_tail(30);
    if !running {
        let note = if detected == EngineGpu::None {
            "No GPU detected — Qwen would run on the CPU, which is many times slower for a 27B. If this PC has a GPU, check the driver and the backend choice below."
        } else {
            "Engine not running — start it and the GPU state appears here."
        };
        return EngineGpuState { detected, in_use: None, backend: None, offloaded: None, note: note.into(), log_tail };
    }
    let r = parse_gpu_log(&log_tail.join("\n"));
    let note = if let Some(ngl) = r.fit_warning_ngl {
        // 0 layers means "no real plan" (unknown card or shape); comparing against 99 would lie.
        let planned = Some(plan_sidecar_machine(&gguf_path(), mmproj_present().as_deref(), spec)).filter(|p| p.layers > 0).map(|p| p.ngl);
        match planned {
            Some(p) if p < ngl => format!(
                "Stale engine flags: this launch was told -ngl {ngl} but the card fits {p} — it is spilling to shared RAM and crawling. Click Restart below to relaunch with the fitted count."
            ),
            _ => format!(
                "The engine could not fit the requested {ngl} layers into free VRAM — another app may be holding the card. Close GPU apps and click Restart below."
            ),
        }
    } else if r.in_use == Some(true) {
        format!(
            "GPU in use — {} layers offloaded to {}.",
            r.offloaded.clone().unwrap_or_default(),
            r.backend.clone().unwrap_or_else(|| "the GPU".into())
        )
    } else if r.in_use == Some(false) {
        let why = r.failed_line.as_ref().map(|l| format!(" Log line: “{}”", l.trim().chars().take(160).collect::<String>())).unwrap_or_default();
        format!(
            "Running on the CPU, so every reply is many times slower than it should be.{why}{}",
            if detected == EngineGpu::Nvidia {
                " Update the NVIDIA driver, or set the backend to Vulkan below, then Download and Start."
            } else {
                " Set a different backend below (Vulkan or CPU), then Download and Start."
            }
        )
    } else {
        "GPU state: the engine log has not reported its offload yet — it does so right after start.".into()
    };
    EngineGpuState { detected, in_use: r.in_use, backend: r.backend, offloaded: r.offloaded, note, log_tail }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuLogReading {
    pub in_use: Option<bool>,
    pub backend: Option<String>,
    pub offloaded: Option<String>,
    pub failed_line: Option<String>,
    pub fit_warning_ngl: Option<u32>,
}

/// Where the compute went, from the engine's own log. A young log is "unknown" (None), not "CPU".
pub fn parse_gpu_log(text: &str) -> GpuLogReading {
    static FAIL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)(no devices found|device\(s?\) found: 0|failed to initialize|init failed|out of memory|cannot allocate|cuda.*(?:error|failed)|vulkan.*(?:error|failed|not available)|no gpu|gl context.*fail)").unwrap()
    });
    static FIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)n_gpu_layers already set by user to (\d+)").unwrap());
    static OFF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)offloaded (\d+/\d+) layers to GPU(?:\s*\((\w+)\))?").unwrap());
    let lines: Vec<&str> = text.split('\n').collect();
    let failed_line = lines.iter().rev().find(|l| FAIL.is_match(l)).map(|l| l.to_string());
    let fit_warning_ngl = lines.iter().find_map(|l| FIT.captures(l)).and_then(|c| c[1].parse::<u32>().ok());
    for line in lines.iter().rev() {
        if let Some(m) = OFF.captures(line) {
            let counts = m[1].to_string();
            let done: u64 = counts.split('/').next().and_then(|d| d.parse().ok()).unwrap_or(0);
            return GpuLogReading {
                in_use: Some(done > 0),
                backend: m.get(2).map(|b| b.as_str().to_uppercase()),
                offloaded: Some(counts),
                failed_line: if done == 0 { failed_line } else { None },
                fit_warning_ngl,
            };
        }
    }
    // No offload line yet but a backend failure was logged: the "GPU 0%, CPU 100%" case.
    if failed_line.is_some() {
        return GpuLogReading { in_use: Some(false), backend: None, offloaded: None, failed_line, fit_warning_ngl };
    }
    GpuLogReading { in_use: None, backend: None, offloaded: None, failed_line: None, fit_warning_ngl }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GgufModelInfo {
    pub block_count: u64,
    /// Full-model KV cache bytes per token at q8_0.
    pub kv_bytes_per_token: u64,
}

/// Layer count and KV shape from the first 8 MB of the GGUF header. No mmap, no weights. None on anything unexpected.
pub fn read_gguf_model_info(gguf: &Path) -> Option<GgufModelInfo> {
    let mut head = Vec::new();
    std::fs::File::open(gguf).ok()?.take(8 * 1024 * 1024).read_to_end(&mut head).ok()?;
    parse_gguf(&head)
}

struct Cur<'a> {
    b: &'a [u8],
    p: usize,
}
impl Cur<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let s = self.b.get(self.p..self.p.checked_add(n)?)?;
        self.p += n;
        Some(s)
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }
    fn string(&mut self) -> Option<String> {
        let n = usize::try_from(self.u64()?).ok()?;
        Some(String::from_utf8_lossy(self.take(n)?).into_owned())
    }
    /// Skip one value of GGUF type `t`. Arrays longer than 300k are refused: a Qwen3 vocab is ~152K.
    fn skip(&mut self, t: u32) -> Option<()> {
        match t {
            8 => self.string().map(|_| ()),
            9 => {
                let elem = self.u32()?;
                let len = self.u64()?;
                if len > 300_000 {
                    return None;
                }
                if elem == 8 {
                    for _ in 0..len {
                        self.string()?;
                    }
                    Some(())
                } else {
                    let n = gguf_value_size(elem)? * len as usize;
                    self.take(n).map(|_| ())
                }
            }
            _ => self.take(gguf_value_size(t)?).map(|_| ()),
        }
    }
}
/// Fixed sizes by GGUF type id (strings and arrays are handled by the caller).
fn gguf_value_size(t: u32) -> Option<usize> {
    match t {
        0 | 1 | 7 => Some(1),
        2 | 3 => Some(2),
        4 | 5 | 6 => Some(4),
        10 | 11 | 12 => Some(8),
        _ => None,
    }
}
fn have_all(arch: Option<&str>, n: &HashMap<String, u64>) -> bool {
    let Some(a) = arch else { return false };
    [".block_count", ".embedding_length", ".attention.head_count", ".attention.head_count_kv"].iter().all(|k| n.get(&format!("{a}{k}")).copied().unwrap_or(0) > 0)
}
fn parse_gguf(b: &[u8]) -> Option<GgufModelInfo> {
    let mut c = Cur { b, p: 0 };
    if c.take(4)? != b"GGUF" {
        return None;
    }
    c.take(4)?; // version
    c.u64()?; // tensor count
    let kv = c.u64()?;
    if kv > 10_000 {
        return None;
    }
    let mut nums: HashMap<String, u64> = HashMap::new();
    let mut arch: Option<String> = None;
    for _ in 0..kv {
        let key = c.string()?;
        let t = c.u32()?;
        if t == 4 {
            nums.insert(key, c.u32()? as u64);
        } else if key == "general.architecture" && t == 8 {
            arch = Some(c.string()?);
        } else {
            c.skip(t)?;
        }
        // The shape keys come before the multi-MB tokenizer tables: stop as soon as they are in hand.
        if have_all(arch.as_deref(), &nums) {
            break;
        }
    }
    let a = arch.as_deref()?;
    if !have_all(Some(a), &nums) {
        return None;
    }
    let g = |k: &str| nums.get(&format!("{a}.{k}")).copied().unwrap_or(0);
    let (block, emb, heads, kv_heads) = (g("block_count"), g("embedding_length"), g("attention.head_count"), g("attention.head_count_kv"));
    if emb % heads != 0 {
        return None;
    }
    Some(GgufModelInfo { block_count: block, kv_bytes_per_token: block * kv_heads * (emb / heads) * 2 })
}

// ---- probes of the running sidecar ----

fn base(port: u16) -> String {
    format!("http://{ENGINE_HOST}:{port}")
}
async fn get_ok(port: u16, path: &str, ms: u64) -> Option<reqwest::Response> {
    let client = reqwest::Client::builder().no_proxy().build().ok()?;
    client.get(format!("{}{path}", base(port))).timeout(Duration::from_millis(ms)).send().await.ok()
}
/// True when /health or /v1/models answers 2xx on the port.
async fn is_listening(port: u16) -> bool {
    for path in ["/health", "/v1/models"] {
        if get_ok(port, path, 800).await.is_some_and(|r| r.status().is_success()) {
            return true;
        }
    }
    false
}
/// The window the sidecar opened, from /props or /slots.
async fn read_ctx(port: u16) -> Option<u64> {
    for path in ["/props", "/slots"] {
        let Some(r) = get_ok(port, path, 1_200).await else { continue };
        if !r.status().is_success() {
            continue;
        }
        if let Ok(v) = r.json::<Value>().await {
            if let Some(n) = walk_nctx(&v, 0) {
                return Some(n);
            }
        }
    }
    None
}
/// Same walk as the web: the first n_ctx key, else the first positive number.
fn walk_nctx(v: &Value, depth: u32) -> Option<u64> {
    if depth > 8 {
        return None;
    }
    match v {
        Value::Number(_) => v.as_f64().filter(|x| x.is_finite() && *x > 0.0).map(|x| x as u64),
        Value::Array(items) => items.iter().find_map(|i| walk_nctx(i, depth + 1)),
        Value::Object(map) => {
            if let Some(n) = map.get("n_ctx").and_then(Value::as_f64) {
                return Some(n as u64);
            }
            map.values().find_map(|i| walk_nctx(i, depth + 1))
        }
        _ => None,
    }
}
async fn wait_for_health(port: u16, ms: u64) -> bool {
    let until = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < until {
        if is_listening(port).await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    false
}
async fn wait_until_stopped(port: u16, ms: u64) {
    let until = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < until {
        if !is_listening(port).await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
/// Stop the sidecar when no chat asked for it for SIDECAR_IDLE_MS. Runs on every status poll.
async fn maybe_unload_idle(port: u16) -> bool {
    if !is_listening(port).await {
        return false;
    }
    let last = std::fs::read_to_string(last_used_path()).ok().and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0);
    // No stamp: do not kill a sidecar that is still booting.
    if last == 0 || now_ms().saturating_sub(last) < SIDECAR_IDLE_MS {
        return false;
    }
    stop_engine_at(port);
    true
}
/// Mark the sidecar as used now. Chat calls this so the idle timer restarts.
pub fn touch_sidecar_used() {
    let _ = std::fs::create_dir_all(root());
    let _ = std::fs::write(last_used_path(), now_ms().to_string());
}

/// Whether a URL points at the in-app sidecar (loopback, ENGINE_PORT). The chat path starts the engine only then.
pub fn is_managed_engine_url(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else { return false };
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]") {
        return false;
    }
    u.port_or_known_default() == Some(ENGINE_PORT)
}

// ---- download ----

/// GET with redirects followed by hand, so every hop is checked against the allow-list. Range resumes a .part file.
async fn follow_allowed(url: &str, range: Option<u64>, allow: &dyn Fn(&str) -> bool) -> Result<reqwest::Response, String> {
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let mut cur = url.to_string();
    for _ in 0..6 {
        if !allow(&cur) {
            return Err("That download is not on the allow-list.".into());
        }
        let mut req = client.get(cur.as_str()).header(USER_AGENT, APP_UA);
        if let Some(r) = range {
            req = req.header(RANGE, format!("bytes={r}-"));
        }
        let res = req.send().await.map_err(|e| e.to_string())?;
        if ![301u16, 302, 303, 307, 308].contains(&res.status().as_u16()) {
            return Ok(res);
        }
        let loc = res.headers().get(LOCATION).and_then(|v| v.to_str().ok()).ok_or("Download redirected without a location.")?.to_string();
        cur = reqwest::Url::parse(&cur).and_then(|b| b.join(&loc)).map_err(|e| e.to_string())?.to_string();
    }
    Err("Too many redirects while downloading.".into())
}

/// Stream `url` into `dest` through `dest.part`, resuming an existing part file. `allow` is the URL check (the app passes
/// is_allowed_download_url; the tests pass a stub-friendly one). `progress` gets (completed, total), total 0 if unknown.
pub async fn download_file_with(url: &str, dest: &Path, allow: &dyn Fn(&str) -> bool, cancel: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<(), String> {
    if !allow(url) {
        return Err("That download is not on the allow-list.".into());
    }
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let mut existing = file_size(&part);
    let mut res = follow_allowed(url, (existing > 0).then_some(existing), allow).await?;
    let code = res.status().as_u16();
    if code == 200 {
        // Server ignored Range: start over.
        existing = 0;
        let _ = std::fs::remove_file(&part);
    } else if code != 206 && !res.status().is_success() {
        return Err(format!("Download failed ({code})."));
    }
    let declared = res.headers().get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    let total = if code == 206 && existing > 0 && declared > 0 {
        existing + declared
    } else {
        declared
    };
    let append = existing > 0 && code == 206;
    let mut file = OpenOptions::new().write(true).create(true).append(append).truncate(!append).open(&part).map_err(|e| e.to_string())?;
    let mut completed = existing;
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        if cancel.load(Ordering::Relaxed) {
            return Err("Download cancelled.".into());
        }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        completed += chunk.len() as u64;
        progress(completed, total);
    }
    drop(file);
    std::fs::rename(&part, dest).map_err(|e| e.to_string())
}

/// (name, download url) for every asset of the pinned llama.cpp release.
async fn list_llama_assets_with(api_url: &str, allow: &dyn Fn(&str) -> bool) -> Result<Vec<(String, String)>, String> {
    let res = follow_allowed(api_url, None, allow).await?;
    if !res.status().is_success() {
        return Err(format!("Could not list llama.cpp {LLAMA_CPP_RELEASE} ({}).", res.status().as_u16()));
    }
    let data: Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(data["assets"]
        .as_array()
        .map_or(vec![], |a| a.iter().filter_map(|x| Some((x["name"].as_str()?.to_string(), x["browser_download_url"].as_str()?.to_string()))).collect()))
}

/// Unpack an archive with the tools this machine has: tar (zip on Windows too), unzip, or Python's zipfile.
fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let a = archive.to_string_lossy().into_owned();
    let d = dest.to_string_lossy().into_owned();
    let lower = a.to_ascii_lowercase();
    if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        return run(&["tar", "-xzf", a.as_str(), "-C", d.as_str()]).map_err(|e| if e.trim().is_empty() { "Could not unpack the engine archive.".into() } else { e.trim().to_string() });
    }
    if cfg!(windows) && run(&["tar", "-xf", a.as_str(), "-C", d.as_str()]).is_ok() {
        return Ok(());
    }
    if run(&["unzip", "-o", a.as_str(), "-d", d.as_str()]).is_ok() {
        return Ok(());
    }
    let py = if cfg!(windows) { "python" } else { "python3" };
    if run(&[py, "-m", "zipfile", "-e", a.as_str(), d.as_str()]).is_ok() {
        return Ok(());
    }
    Err("Could not unpack the engine zip (need tar, unzip, or Python).".into())
}
/// Ok on exit 0. Err carries stderr, or nothing when the program did not start.
fn run(args: &[&str]) -> Result<(), String> {
    match quiet(Command::new(args[0])).args(&args[1..]).output() {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(String::from_utf8_lossy(&o.stderr).into_owned()),
        Err(_) => Err(String::new()),
    }
}

/// Fetch the weights, the vision projector and the matching llama.cpp build (plus the CUDA runtime when needed).
/// Stops a running sidecar first so its files can be replaced. Ends with Done. Errors come back as Err.
async fn download_engine(cancel: &AtomicBool, emit: &mut dyn FnMut(EngineDownloadEvent)) -> Result<(), String> {
    emit(ev_status("Stopping Qwen so its files can be replaced…"));
    stop_engine_at(ENGINE_PORT);
    wait_until_stopped(ENGINE_PORT, 15_000).await;

    let gguf = gguf_path();
    if !gguf_looks_complete(file_size(&gguf)) {
        emit(ev_status("Downloading Qwen 3.8 27B onto this PC…"));
        let mut prog = |c: u64, t: u64| emit(ev_progress("Weights", c, if t > 0 { t } else { GGUF_BYTES }));
        download_file_with(GGUF_URL, &gguf, &is_allowed_download_url, cancel, &mut prog).await?;
    }
    let projector = projector_path();
    if file_size(&projector) < MMPROJ_MIN_BYTES {
        emit(ev_status("Downloading the vision projector so Qwen can see images and video…"));
        let mut prog = |c: u64, t: u64| emit(ev_progress("Vision", c, if t > 0 { t } else { MMPROJ_BYTES }));
        download_file_with(MMPROJ_URL, &projector, &is_allowed_download_url, cancel, &mut prog).await?;
    }

    let spec = read_spec_state();
    let assets = list_llama_assets_with(LLAMA_CPP_RELEASE_API, &is_allowed_download_url).await?;
    let names: Vec<String> = assets.iter().map(|a| a.0.clone()).collect();
    let (platform, arch) = (node_platform(), node_arch());
    let wanted = pick_llama_asset(&names, platform, arch, detect_gpu(), spec.build.as_deref(), detect_cuda_major());
    let Some((asset_name, asset_url)) = wanted.and_then(|w| assets.iter().find(|a| a.0 == w).cloned()) else {
        return Err(format!("No llama.cpp build for {platform}/{arch} in {LLAMA_CPP_RELEASE}."));
    };

    // Reinstall when the build changed, the binary is gone, or the binary on disk is a different backend than picked.
    let installed = read_build_stamp();
    let server_now = find_server_binary();
    let has_binary = server_now.is_some();
    let on_disk = if has_binary { installed_backend(server_now.as_deref()) } else { None };
    let want_cuda = asset_name.contains("-win-cuda-");
    let want_vulkan = asset_name.contains("-vulkan");
    let backend_wrong = if want_cuda {
        on_disk != Some("cuda")
    } else if want_vulkan {
        on_disk != Some("vulkan") && on_disk != Some("cuda")
    } else if asset_name.contains("-win-cpu-") {
        on_disk == Some("cuda")
    } else {
        false
    };
    let need_main = !has_binary || installed.as_deref() != Some(asset_name.as_str()) || backend_wrong;
    let main = Some(asset_name.as_str());
    let cudart = if needs_cudart(main) { pick_cudart_asset(&names, main).and_then(|n| assets.iter().find(|a| a.0 == n).cloned()) } else { None };
    if needs_cudart(main) && cudart.is_none() {
        return Err(format!(
            "The {LLAMA_CPP_RELEASE} release ships no CUDA runtime archive for {asset_name}, so the CUDA build cannot work. Select Vulkan in Engine backend and click Download again."
        ));
    }
    let need_cudart = cudart.is_some() && (need_main || !cudart_present(find_server_binary().as_deref()));

    if need_main {
        if installed.as_deref() != Some(asset_name.as_str()) || backend_wrong {
            emit(ev_status(&format!("Switching engine build ({} → {asset_name})…", installed.as_deref().unwrap_or("CPU build without stamp"))));
            let _ = std::fs::remove_dir_all(bin_dir());
        }
        emit(ev_status("Downloading the local engine…"));
        let archive = archive_path(&asset_name);
        let mut prog = |c: u64, t: u64| emit(ev_progress("Engine", c, t));
        download_file_with(&asset_url, &archive, &is_allowed_download_url, cancel, &mut prog).await?;
        emit(ev_status("Unpacking the engine…"));
        extract_archive(&archive, &bin_dir())?;
        let server = find_server_binary().ok_or("Unpacked the engine but llama-server was not inside it.")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&server, std::fs::Permissions::from_mode(0o755));
        }
        #[cfg(not(unix))]
        let _ = &server;
        write_build_stamp(&asset_name)?;
    }

    // The Windows CUDA build loads cudart/cuBLAS from a second archive; without it ggml-cuda fails and runs on CPU.
    if let (Some((cname, curl)), true) = (cudart, need_cudart) {
        emit(ev_status("Downloading the CUDA runtime (~390 MB)…"));
        let rt = archive_path(&cname);
        let mut prog = |c: u64, t: u64| emit(ev_progress("CUDA", c, t));
        download_file_with(&curl, &rt, &is_allowed_download_url, cancel, &mut prog).await?;
        emit(ev_status("Installing the CUDA runtime…"));
        install_cudart(&rt, find_server_binary().as_deref())?;
    }
    emit(EngineDownloadEvent::Done);
    Ok(())
}

/// Are the CUDA runtime DLLs beside the server? cublasLt64 is in every shipped cudart archive.
fn cudart_present(server: Option<&Path>) -> bool {
    let Some(s) = server else { return false };
    if !cfg!(windows) {
        return false;
    }
    let dir = s.parent().unwrap_or(Path::new("."));
    ["cublasLt64_12.dll", "cublasLt64_13.dll", "cudart64_12.dll", "cudart64_13.dll"].iter().any(|d| dir.join(d).exists())
}

/// The runtime DLLs the CUDA build expects beside the server but cannot find. Names follow the CUDA major of the build.
fn missing_cudart_dlls(dir: &Path, main: Option<&str>) -> Vec<String> {
    let major = if main.is_some_and(|m| m.contains("win-cuda-13.")) { "13" } else { "12" };
    [format!("cudart64_{major}.dll"), format!("cublas64_{major}.dll"), format!("cublasLt64_{major}.dll")].into_iter().filter(|d| !dir.join(d).exists()).collect()
}

/// Which backend the installed binary carries: by the shared plugin libraries beside it, not by a stamp.
fn installed_backend(server: Option<&Path>) -> Option<&'static str> {
    server?;
    let mut names = Vec::new();
    collect_names(&bin_dir(), 0, &mut names);
    if names.iter().any(|n| n.find("ggml-").is_some_and(|i| n[i..].contains("cuda"))) {
        return Some("cuda");
    }
    if names.iter().any(|n| n.find("ggml-").is_some_and(|i| n[i..].contains("vulkan")) || n.contains("vulkan-1")) {
        return Some("vulkan");
    }
    Some("cpu")
}
fn collect_names(dir: &Path, depth: u32, out: &mut Vec<String>) {
    if depth > 8 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_ascii_lowercase();
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            collect_names(&e.path(), depth + 1, out);
        } else if name.ends_with(".dll") || (!cfg!(windows) && (name.contains("ggml-cuda") || name.contains("ggml-vulkan"))) {
            out.push(name);
        }
    }
}
fn collect_dlls(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 8 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            collect_dlls(&p, depth + 1, out);
        } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("dll")) {
            out.push(p);
        }
    }
}

/// Unpack the cudart archive into a staging folder and copy its DLLs beside llama-server.
fn install_cudart(archive: &Path, server: Option<&Path>) -> Result<(), String> {
    let Some(server) = server else { return Ok(()) };
    let staging = bin_dir().join("__cudart_tmp");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let result = install_cudart_into(archive, server, &staging);
    let _ = std::fs::remove_dir_all(&staging);
    result
}
fn install_cudart_into(archive: &Path, server: &Path, staging: &Path) -> Result<(), String> {
    extract_archive(archive, staging)?;
    let mut dlls = Vec::new();
    collect_dlls(staging, 0, &mut dlls);
    if dlls.is_empty() {
        return Err("The CUDA runtime archive held no DLLs — the download may be corrupt. Delete it from the engine cache and click Download again.".into());
    }
    let dir = server.parent().unwrap_or(Path::new("."));
    let mut failures = Vec::new();
    for dll in &dlls {
        let name = dll.file_name().unwrap_or_default();
        if let Err(e) = std::fs::copy(dll, dir.join(name)) {
            failures.push(format!("{} ({e})", name.to_string_lossy()));
        }
    }
    if !failures.is_empty() {
        let shown = failures.iter().take(3).cloned().collect::<Vec<_>>().join("; ");
        let more = if failures.len() > 3 { format!(" (+{} more)", failures.len() - 3) } else { String::new() };
        return Err(format!("Could not install the CUDA runtime beside llama-server: {shown}{more}. If llama-server is running, Unload it first, then Download again."));
    }
    if !cudart_present(Some(server)) {
        return Err("The CUDA runtime copied but its DLLs are still not visible beside llama-server — an antivirus or a permissions problem may be eating them. Check the engine folder, then Download again.".into());
    }
    Ok(())
}

// ---- state files (same names and shapes as the web) ----

fn read_build_stamp() -> Option<String> {
    std::fs::read_to_string(build_stamp_path()).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}
fn write_build_stamp(name: &str) -> Result<(), String> {
    std::fs::create_dir_all(root()).map_err(|e| e.to_string())?;
    std::fs::write(build_stamp_path(), name).map_err(|e| e.to_string())
}

/// The saved flags. Missing or broken fields fall back to the defaults, as the web does.
pub fn read_spec_state() -> SidecarSpecState {
    let fallback = default_spec_state();
    let Ok(raw) = std::fs::read_to_string(spec_path()) else { return fallback };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else { return fallback };
    let strings = |k: &str| v[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<String>>());
    SidecarSpecState {
        enabled: strings("enabled").unwrap_or(fallback.enabled),
        extra: strings("extra").unwrap_or_default(),
        build: v["build"].as_str().filter(|b| KNOWN_BUILDS.contains(b)).map(String::from),
    }
}
fn write_spec_state(spec: &SidecarSpecState) -> Result<(), String> {
    std::fs::create_dir_all(root()).map_err(|e| e.to_string())?;
    std::fs::write(spec_path(), serde_json::to_string_pretty(spec).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
/// First run only: GPU machines start with flash attention on. Once the file exists the user's choice sticks.
fn ensure_spec_file() {
    if spec_path().exists() {
        return;
    }
    let mut base = default_spec_state();
    if detect_gpu() != EngineGpu::None && !base.enabled.iter().any(|e| e == "flash") {
        base.enabled.push("flash".into());
    }
    let _ = write_spec_state(&base);
}
fn launch_matches(id: &str) -> bool {
    std::fs::read_to_string(launch_stamp_path()).is_ok_and(|s| s.trim() == id)
}
/// Last lines of the engine log, oldest first. Bounded so status stays cheap.
fn read_log_tail(lines: usize) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(engine_log_path()) else { return vec![] };
    let all: Vec<&str> = text.trim_end().split('\n').filter(|l| !l.trim().is_empty()).collect();
    all[all.len().saturating_sub(lines)..].iter().map(|s| s.to_string()).collect()
}

// ---- process control ----

/// Append the spawn line first, so the log panel shows the exact flags this launch got.
fn log_spawn(argv: &[String]) {
    let _ = std::fs::create_dir_all(root());
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(engine_log_path()) {
        let _ = writeln!(f, "[apiM] spawn: {}", argv.join(" "));
    }
}

/// Start llama-server hidden, record its pid, and tee its stderr to the log. Keeps the first 400 characters for errors.
fn launch(server: &Path, argv: &[String], err: &std::sync::Arc<Mutex<String>>) -> Result<(), String> {
    let mut cmd = quiet(Command::new(server));
    cmd.args(argv).current_dir(server.parent().unwrap_or(Path::new("."))).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let _ = std::fs::write(pid_path(), child.id().to_string());
    if let Some(mut stderr) = child.stderr.take() {
        let err = std::sync::Arc::clone(err);
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = stderr.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(engine_log_path()) {
                    let _ = f.write_all(text.as_bytes());
                }
                let mut e = err.lock().unwrap_or_else(|p| p.into_inner());
                if e.chars().count() < 400 {
                    e.push_str(&text);
                }
            }
        });
    }
    *CHILD.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);
    Ok(())
}

/// Kill one process and its children. taskkill /T on Windows so npm-style child trees go too.
fn kill_pid(pid: u32) {
    // Never kill this process: the port scan can see our own stub server in the tests.
    if pid == 0 || pid == std::process::id() {
        return;
    }
    let p = pid.to_string();
    if cfg!(windows) {
        let _ = quiet(Command::new("taskkill")).args(["/pid", p.as_str(), "/T", "/F"]).output();
    } else {
        let _ = Command::new("kill").args(["-9", p.as_str()]).output();
    }
}

/// Every pid listening on the port, on any address.
fn pids_on_port(port: u16) -> Vec<u32> {
    let mut found = BTreeSet::new();
    if cfg!(windows) {
        if let Ok(o) = quiet(Command::new("netstat")).args(["-ano", "-p", "tcp"]).output() {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                let t: Vec<&str> = line.split_whitespace().collect();
                if t.len() >= 5 && line.to_ascii_uppercase().contains("LISTENING") && t[1].ends_with(&format!(":{port}")) {
                    if let Ok(pid) = t[t.len() - 1].parse::<u32>() {
                        found.insert(pid);
                    }
                }
            }
        }
    } else {
        let port_arg = format!("-iTCP:{port}");
        if let Ok(o) = Command::new("lsof").args(["-nP", port_arg.as_str(), "-sTCP:LISTEN", "-t"]).output() {
            found.extend(String::from_utf8_lossy(&o.stdout).split_whitespace().filter_map(|t| t.parse::<u32>().ok()));
        }
        let p = port.to_string();
        if let Ok(o) = Command::new("fuser").args(["-n", "tcp", p.as_str()]).output() {
            let both = format!("{} {}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
            found.extend(both.split_whitespace().filter_map(|t| t.parse::<u32>().ok()));
        }
    }
    found.into_iter().filter(|p| *p > 0 && *p != std::process::id()).collect()
}

/// True when `pid` runs the llama-server this app launches. A pid file outlives its process and Windows reuses pids,
/// so the number in the file proves nothing until the image name agrees.
fn is_engine_process(pid: u32) -> bool {
    let out = if cfg!(windows) {
        let filter = format!("PID eq {pid}");
        quiet(Command::new("tasklist")).args(["/FI", filter.as_str(), "/FO", "CSV", "/NH"]).output()
    } else {
        Command::new("ps").args(["-p", pid.to_string().as_str(), "-o", "comm="]).output()
    };
    let Ok(o) = out else { return false };
    let text = String::from_utf8_lossy(&o.stdout).trim().to_ascii_lowercase();
    if cfg!(windows) { text.contains("\"llama-server.exe\"") } else { text == "llama-server" }
}

/// Stop the sidecar: the child this app started, the pid file, and anything on the port. True if anything was killed.
fn stop_engine_at(port: u16) -> bool {
    let mut killed = false;
    let child = CHILD.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(mut c) = child {
        kill_pid(c.id());
        let _ = c.kill();
        killed = true;
    }
    if let Ok(raw) = std::fs::read_to_string(pid_path()) {
        if let Ok(pid) = raw.trim().parse::<u32>() {
            // The file may be stale: kill only a process that really is the engine. The file is dropped below either way.
            if pid > 0 && is_engine_process(pid) {
                kill_pid(pid);
                killed = true;
            }
        }
    }
    for pid in pids_on_port(port) {
        kill_pid(pid);
        killed = true;
    }
    let _ = std::fs::remove_file(pid_path());
    killed
}

/// Thousands separators, as JS toLocaleString gives for the window sizes in the messages.
fn commas(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Launch llama-server with the planned flags and wait for it to answer. Retries once without flash attention if the
/// log blames it. Checks that the window opened at SIDECAR_CTX, not an old server's smaller one.
async fn spawn_sidecar(port: u16, server: &Path, gguf: &Path, mmproj: Option<&Path>, spec: &SidecarSpecState, machine: &SidecarMachinePlan) -> Result<(), String> {
    stop_engine_at(port);
    wait_until_stopped(port, 10_000).await;
    if is_listening(port).await {
        return Err(HOLD_MSG.into());
    }
    let _ = std::fs::create_dir_all(root());
    let _ = std::fs::write(engine_log_path(), "");
    let g = gguf.to_string_lossy().into_owned();
    let m = mmproj.map(|p| p.to_string_lossy().into_owned());
    let argv = sidecar_args(&g, m.as_deref(), spec, Some(machine));
    log_spawn(&argv);
    let err = std::sync::Arc::new(Mutex::new(String::new()));
    launch(server, &argv, &err)?;
    let mut up = wait_for_health(port, 180_000).await;
    let mut launched = spec.clone();

    if !up && spec.enabled.iter().any(|e| e == "flash") && read_log_tail(200).join("\n").to_ascii_lowercase().contains("flash") {
        // Flash attention refused this GPU. Retry once without it and persist that, so the next Start matches.
        let mut fixed = spec.clone();
        fixed.enabled.retain(|e| e != "flash");
        write_spec_state(&fixed)?;
        launched = fixed.clone();
        stop_engine_at(port);
        wait_until_stopped(port, 10_000).await;
        if is_listening(port).await {
            return Err(HOLD_MSG.into());
        }
        let _ = std::fs::write(engine_log_path(), "");
        let argv2 = sidecar_args(&g, m.as_deref(), &fixed, Some(machine));
        log_spawn(&argv2);
        launch(server, &argv2, &err)?;
        up = wait_for_health(port, 180_000).await;
    }

    if !up {
        let text: String = err.lock().unwrap_or_else(|p| p.into_inner()).trim().chars().take(400).collect();
        return Err(if text.is_empty() { "The local engine started but is not answering yet. Give it a moment and try Start again.".into() } else { text });
    }
    if let Some(ctx) = read_ctx(port).await.filter(|c| *c < SIDECAR_CTX) {
        stop_engine_at(port);
        wait_until_stopped(port, 8_000).await;
        return Err(format!(
            "Qwen came up on a {}-token window, not {}. An old llama-server is still answering. End llama-server in Task Manager and click Restart.",
            commas(ctx),
            commas(SIDECAR_CTX)
        ));
    }
    let _ = std::fs::write(launch_stamp_path(), sidecar_launch_id(&launched, Some(machine)));
    touch_sidecar_used();
    Ok(())
}

/// Start the sidecar at `port` if the files and a server binary are there. Reuses a healthy one with matching flags.
async fn start_at(port: u16) -> Result<(), String> {
    ensure_spec_file();
    let spec = read_spec_state();
    let g = gguf_path();
    let mp = mmproj_present();
    let machine = plan_sidecar_machine(&g, mp.as_deref(), &spec);
    let wanted = sidecar_launch_id(&spec, Some(&machine));
    if is_listening(port).await {
        let ctx = read_ctx(port).await;
        if launch_matches(&wanted) && ctx.is_some_and(|c| c >= SIDECAR_CTX) {
            touch_sidecar_used();
            return Ok(());
        }
        // Too small, unknown, or stale flags: kill the old process for real.
        stop_engine_at(port);
        wait_until_stopped(port, 10_000).await;
    }
    if !gguf_looks_complete(file_size(&g)) {
        return Err("Qwen 3.8 27B is not downloaded yet. Open Settings and click Download.".into());
    }
    let Some(server) = find_server_binary() else {
        return Err("The local engine is not installed yet. Click Download in Settings.".into());
    };
    let installed = read_build_stamp();
    if let Some(b) = spec.build.as_deref().filter(|b| *b != "auto") {
        if !cfg!(target_os = "macos") {
            if let Some(i) = installed.as_deref().filter(|i| !i.contains(b)) {
                return Err(format!("The installed engine is the {i} build, but {b} is selected. Click Download in Settings to fetch the {b} build."));
            }
        }
    }
    if cfg!(windows) {
        // Refuse a CPU-only build when a GPU exists, and a CUDA build whose runtime DLLs are missing. Name the fix.
        let gpu = detect_gpu();
        let backend = installed_backend(Some(&server));
        let want = match spec.build.as_deref() {
            Some("cuda") => "cuda",
            Some("vulkan") => "vulkan",
            _ => match gpu {
                EngineGpu::Nvidia => "cuda",
                EngineGpu::Vulkan => "vulkan",
                _ => "cpu",
            },
        };
        let inst = installed.as_deref().unwrap_or("");
        let on_cpu = backend == Some("cpu") || inst.ends_with("-cpu-x64.zip");
        let on_cuda = backend == Some("cuda") || inst.contains("-win-cuda-");
        if (want == "cuda" || want == "vulkan") && on_cpu {
            return Err(if want == "cuda" {
                "This PC has an NVIDIA GPU but the installed engine is the CPU-only build (it has no CUDA backend in it), which is why Qwen runs at 100% CPU and ~0% GPU. Open Settings, select the CUDA (NVIDIA) backend and click Download — it replaces the engine with the GPU build and installs the CUDA runtime it needs, then Start."
                    .into()
            } else {
                "The installed engine is the CPU-only build but a GPU backend is selected. Open Settings, select Vulkan and click Download to fetch the GPU engine.".into()
            });
        }
        if on_cuda && !cudart_present(Some(&server)) {
            let missing = missing_cudart_dlls(server.parent().unwrap_or(Path::new(".")), installed.as_deref());
            let names = if missing.is_empty() { String::new() } else { format!(" — missing beside llama-server: {}", missing.join(", ")) };
            return Err(format!(
                "The CUDA engine is installed but its runtime libraries (cudart / cuBLAS) are missing{names}, so ggml-cuda cannot load and the engine falls back to CPU. Open Settings and click Download — it fetches the ~390 MB CUDA runtime archive and installs the DLLs beside llama-server. If Download just ran, a running llama-server may have locked them — Unload, Download, then Start."
            ));
        }
    }
    spawn_sidecar(port, &server, &g, mp.as_deref(), &spec, &machine).await
}

/// Save the flags, bounce the sidecar, start it again.
async fn apply_spec_at(port: u16, spec: &SidecarSpecState) -> Result<(), String> {
    write_spec_state(spec)?;
    stop_engine_at(port);
    wait_until_stopped(port, 10_000).await;
    start_at(port).await
}

/// Start only when the weights and the engine binary are present (chat calls this before it streams).
async fn ensure_at(port: u16) -> Result<(), String> {
    let s = status_at(port).await;
    if !s.gguf_ready || !s.server_ready {
        return Err("Qwen 3.8 27B is not on this PC yet. Open Settings and click Download.".into());
    }
    start_at(port).await
}

// ---- the /api/local route, as functions a UI calls from a background thread ----

/// The route's response body for start, restart, stop, set-opts and ensure: {ok, error?, status}.
#[derive(Debug, Clone, Serialize)]
pub struct ActionResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub status: EngineStatus,
}

/// The route's set-opts body. Absent fields keep their current value; `build` absent resets to auto (as the web does).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetOpts {
    pub enabled: Option<Vec<String>>,
    pub extra: Option<Vec<String>>,
    pub add_flag: Option<String>,
    pub build: Option<String>,
}

async fn finish(r: Result<(), String>) -> ActionResult {
    let (ok, error) = match r {
        Ok(()) => (true, None),
        Err(e) => (false, Some(e)),
    };
    ActionResult { ok, error, status: status().await }
}

/// GET /api/local, and the POST "status" action.
pub async fn status() -> EngineStatus {
    status_at(ENGINE_PORT).await
}
pub async fn start() -> ActionResult {
    finish(start_at(ENGINE_PORT).await).await
}
pub async fn stop() -> ActionResult {
    stop_engine_at(ENGINE_PORT);
    ActionResult { ok: true, error: None, status: status().await }
}
pub async fn restart() -> ActionResult {
    stop_engine_at(ENGINE_PORT);
    finish(start_at(ENGINE_PORT).await).await
}
// ponytail: the card never calls ensure (the web's card does not either); the chat path uses chat_ready instead.
#[allow(dead_code)]
pub async fn ensure() -> ActionResult {
    finish(ensure_at(ENGINE_PORT).await).await
}
/// The chat route's gate for a request aimed at the in-app sidecar (chat/route.ts:822-841): start it, then check the window.
/// Err is the text the route answers with a 503.
pub async fn chat_ready() -> Result<(), String> {
    ensure_at(ENGINE_PORT).await?;
    match read_ctx(ENGINE_PORT).await {
        Some(ctx) if ctx < SIDECAR_CTX => Err(format!(
            "Qwen is still on a {}-token window (need {}). Open Settings → On this PC → Restart. An old llama-server is still holding the port.",
            commas(ctx),
            commas(SIDECAR_CTX)
        )),
        _ => Ok(()),
    }
}
/// Errors (bad flag text) come back as Err, which the route answers with a 400.
pub async fn set_opts(req: SetOpts) -> Result<ActionResult, String> {
    let current = read_spec_state();
    let mut extra = req.extra.unwrap_or_else(|| current.extra.clone());
    if let Some(flag) = req.add_flag.as_deref().filter(|f| !f.trim().is_empty()) {
        extra.extend(parse_user_flags(flag)?);
    }
    let build = req.build.filter(|b| KNOWN_BUILDS.contains(&b.as_str()));
    let next = SidecarSpecState { enabled: req.enabled.unwrap_or(current.enabled), extra, build };
    Ok(finish(apply_spec_at(ENGINE_PORT, &next).await).await)
}
/// The route's download action: the engine's events, then the route's closing "Downloaded" status and Done.
/// Cancel by setting `cancel`. The web's "Download cancelled." text comes through as an Error event.
pub async fn download(cancel: &AtomicBool, emit: &mut dyn FnMut(EngineDownloadEvent)) {
    match download_engine(cancel, emit).await {
        Ok(()) => {
            emit(ev_status("Downloaded. Click Start when you want Qwen in RAM."));
            emit(EngineDownloadEvent::Done);
        }
        Err(message) => emit(EngineDownloadEvent::Error { message }),
    }
}

#[cfg(test)]
mod tests {
    use super::super::shared::tests::fx;
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const FILE: &[u8] = b"0123456789ABCDEF";
    /// Tests that set APIM_DATA_ROOT take this, so the environment is never changed under another one.
    static DATA_ROOT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn http(status: &str, extra: &str, body: &[u8]) -> Vec<u8> {
        let mut v = format!("HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
        v.extend_from_slice(body);
        v
    }

    /// Stub server on a bound listener: health, props, an asset list, a redirect and a ranged file.
    async fn serve(l: tokio::net::TcpListener) {
        let port = l.local_addr().unwrap().port();
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let mut n = 0;
                while !buf[..n].windows(4).any(|w| w == b"\r\n\r\n") && n < buf.len() {
                    let k = s.read(&mut buf[n..]).await.unwrap_or(0);
                    if k == 0 {
                        break;
                    }
                    n += k;
                }
                let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let range = req.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("range: bytes=").and_then(|r| r.trim_end_matches('-').parse::<usize>().ok()));
                let body = match path.as_str() {
                    "/health" => http("200 OK", "", b"ok"),
                    "/props" => http("200 OK", "", br#"{"default_generation_settings":{"n_ctx":81920},"total_slots":1}"#),
                    "/api/assets" => {
                        let j = format!(r#"{{"assets":[{{"name":"llama-b10566-bin-win-cpu-x64.zip","browser_download_url":"http://127.0.0.1:{port}/dl/file.bin"}}]}}"#);
                        http("200 OK", "", j.as_bytes())
                    }
                    "/redir" => http("302 Found", &format!("Location: http://127.0.0.1:{port}/dl/file.bin\r\n"), b""),
                    "/dl/file.bin" => match range {
                        Some(r) if r < FILE.len() => http("206 Partial Content", &format!("Content-Range: bytes {r}-{}/{}\r\n", FILE.len() - 1, FILE.len()), &FILE[r..]),
                        _ => http("200 OK", "", FILE),
                    },
                    _ => http("404 Not Found", "", b""),
                };
                let _ = s.write_all(&body).await;
                let _ = s.shutdown().await;
            });
        }
    }

    #[test]
    fn gpu_log_matches_web() {
        for (i, o) in fx("parseGpuLog") {
            assert_eq!(serde_json::to_value(parse_gpu_log(i.as_str().unwrap())).unwrap(), o, "parseGpuLog {i}");
        }
    }

    #[test]
    fn gguf_header_gives_layers_and_kv_shape() {
        fn s(v: &str) -> Vec<u8> {
            let mut b = (v.len() as u64).to_le_bytes().to_vec();
            b.extend_from_slice(v.as_bytes());
            b
        }
        let nums = [("qwen3.block_count", 64u32), ("qwen3.embedding_length", 5120), ("qwen3.attention.head_count", 40), ("qwen3.attention.head_count_kv", 8)];
        let mut b = b"GGUF".to_vec();
        b.extend(3u32.to_le_bytes());
        b.extend(0u64.to_le_bytes());
        b.extend(((nums.len() + 1) as u64).to_le_bytes());
        b.extend(s("general.architecture"));
        b.extend(8u32.to_le_bytes());
        b.extend(s("qwen3"));
        for (k, v) in nums {
            b.extend(s(k));
            b.extend(4u32.to_le_bytes());
            b.extend(v.to_le_bytes());
        }
        assert_eq!(parse_gguf(&b), Some(GgufModelInfo { block_count: 64, kv_bytes_per_token: 64 * 8 * 128 * 2 }));
        assert_eq!(parse_gguf(&b[..20]), None, "a cut-off header is not a plan");
    }

    #[test]
    fn ctx_walk_and_managed_url() {
        assert_eq!(walk_nctx(&serde_json::json!({"default_generation_settings": {"n_ctx": 81920}, "total_slots": 1}), 0), Some(81920));
        assert!(is_managed_engine_url("http://127.0.0.1:18765/v1"));
        assert!(!is_managed_engine_url("http://127.0.0.1:11434/v1"));
        assert!(!is_managed_engine_url("https://api.example.com:18765/v1"));
    }

    #[tokio::test]
    async fn download_resumes_follows_redirects_and_honours_cancel() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(serve(l));
        let dir = std::env::temp_dir().join(format!("alo-dl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let no = AtomicBool::new(false);
        let yes = AtomicBool::new(true);
        let always = |_: &str| true;

        // A .part file with 8 bytes resumes through a redirect: the ranged 206 finishes the file.
        let dest = dir.join("file.bin");
        std::fs::write(dir.join("file.bin.part"), &FILE[..8]).unwrap();
        download_file_with(&format!("http://127.0.0.1:{port}/redir"), &dest, &always, &no, &mut |_: u64, _: u64| {}).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), FILE);

        // A plain 200 writes the whole file.
        let whole = dir.join("whole.bin");
        download_file_with(&format!("http://127.0.0.1:{port}/dl/file.bin"), &whole, &always, &no, &mut |_: u64, _: u64| {}).await.unwrap();
        assert_eq!(std::fs::read(&whole).unwrap(), FILE);

        // Cancel is checked before each chunk.
        let err = download_file_with(&format!("http://127.0.0.1:{port}/dl/file.bin"), &dir.join("c.bin"), &always, &yes, &mut |_: u64, _: u64| {}).await.unwrap_err();
        assert_eq!(err, "Download cancelled.");

        // The real allow-list refuses the loopback stub.
        let refused = download_file_with(&format!("http://127.0.0.1:{port}/redir"), &dir.join("x.bin"), &is_allowed_download_url, &no, &mut |_: u64, _: u64| {}).await.unwrap_err();
        assert_eq!(refused, "That download is not on the allow-list.");

        let assets = list_llama_assets_with(&format!("http://127.0.0.1:{port}/api/assets"), &always).await.unwrap();
        assert_eq!(assets, vec![("llama-b10566-bin-win-cpu-x64.zip".to_string(), format!("http://127.0.0.1:{port}/dl/file.bin"))]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Starts the engine (from a fake .cmd program), reads its status, and stops it. The port is a free one. The stub
    /// comes up 3 s after the spawn starts: spawn's own stop (netstat) runs first and must see the port free, then its
    /// health wait finds the stub. Windows only (the fake is a .cmd).
    #[tokio::test(flavor = "multi_thread")]
    async fn sidecar_start_status_and_stop_with_a_fake_program() {
        if !cfg!(windows) {
            return;
        }
        let _lock = DATA_ROOT_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let dir = std::env::temp_dir().join(format!("alo-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // SAFETY: the tests that read the data root hold DATA_ROOT_LOCK while the variable points at their own folder.
        unsafe { std::env::set_var("APIM_DATA_ROOT", &dir) };
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();

        let st = status_at(port).await;
        assert!(!st.gguf_ready && !st.running && st.hint.starts_with("Download Qwen 3.8 27B"), "{st:?}");

        let fake = dir.join("fake-llama-server.cmd");
        std::fs::write(&fake, "@echo off\r\nping -n 120 127.0.0.1 >nul\r\n").unwrap();
        let gguf = gguf_path();
        std::fs::create_dir_all(root()).unwrap();
        std::fs::write(&gguf, b"not a model").unwrap();
        let stub = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(3_000)).await;
            serve(tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap()).await;
        });

        let machine = SidecarMachinePlan { ngl: 99, threads: 4, vram_mb: 0, layers: 0, ram_free_gb: 0.0 };
        let spec = default_spec_state();
        spawn_sidecar(port, &fake, &gguf, None, &spec, &machine).await.unwrap();
        assert!(is_listening(port).await);
        assert_eq!(read_ctx(port).await, Some(81920));
        assert!(std::fs::read_to_string(engine_log_path()).unwrap().starts_with("[apiM] spawn:"));
        assert_eq!(std::fs::read_to_string(launch_stamp_path()).unwrap(), sidecar_launch_id(&spec, Some(&machine)));
        assert!(pid_path().exists());

        assert!(stop_engine_at(port));
        assert!(!pid_path().exists());
        stub.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A pid file left over from an old run can name any live process. Stop must leave that process alone. Windows only.
    #[test]
    fn stale_pid_file_never_kills_another_process() {
        if !cfg!(windows) {
            return;
        }
        let _lock = DATA_ROOT_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let dir = std::env::temp_dir().join(format!("alo-stale-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // SAFETY: see the sidecar test; DATA_ROOT_LOCK is held.
        unsafe { std::env::set_var("APIM_DATA_ROOT", &dir) };
        std::fs::create_dir_all(root()).unwrap();

        let mut other = quiet(Command::new("ping")).args(["-n", "30", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
        std::fs::write(pid_path(), other.id().to_string()).unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();

        stop_engine_at(port);
        assert!(other.try_wait().unwrap().is_none(), "stop killed a process that is not the engine");
        assert!(!pid_path().exists(), "the stale pid file is dropped");
        let _ = other.kill();
        let _ = other.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
