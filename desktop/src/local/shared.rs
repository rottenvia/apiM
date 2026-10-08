//! Port of `src/lib/local-engine-shared.ts`: the Qwen sidecar's constants, build and preset catalog, size and fit
//! maths, flag parsing and the JSON shapes the UI and the `/api/local` route exchange. Pure data and maths, no I/O.

use regex::Regex;
use serde::{Deserialize, Serialize};

pub const ENGINE_PORT: u16 = 18765;
pub const ENGINE_HOST: &str = "127.0.0.1";
pub const DEFAULT_LOCAL_BASE_URL: &str = "http://127.0.0.1:18765/v1";
pub const DEFAULT_LOCAL_API_MODEL: &str = "qwen-3.8-27b";
pub const GGUF_FILE: &str = "Qwen3.8-27B-Q4_K_M.gguf";
/// bartowski Q4_K_M of official Qwen/Qwen3.8-27B.
pub const GGUF_BYTES: u64 = 17_772_537_440;
/// Weights count as downloaded at 98% of the catalog size: a 99% file is already usable.
pub const GGUF_MIN_BYTES: u64 = GGUF_BYTES * 98 / 100;
/// Unload the sidecar after this long with no local chat request.
pub const SIDECAR_IDLE_MS: u64 = 10 * 60 * 1000;
pub const GGUF_URL: &str = "https://huggingface.co/bartowski/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-Q4_K_M.gguf";
pub const MMPROJ_FILE: &str = "mmproj-Qwen3.8-27B-f16.gguf";
pub const MMPROJ_URL: &str = "https://huggingface.co/bartowski/Qwen3.8-27B-GGUF/resolve/main/mmproj-Qwen3.8-27B-f16.gguf";
/// Hugging Face lists the f16 projector as 928 MB.
pub const MMPROJ_BYTES: u64 = 928 * 1024 * 1024;
/// A partial projector is not usable; anything under this counts as missing.
pub const MMPROJ_MIN_BYTES: u64 = 100 * 1024 * 1024;
pub const LLAMA_CPP_RELEASE: &str = "b10566";
pub const LLAMA_CPP_RELEASE_API: &str = "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b10566";
/// Window the sidecar opens (the web's comment says "80K"; the number is 80 * 1024).
pub const SIDECAR_CTX: u64 = 81_920;
/// Output ceiling on the local wire. Input plus this must stay under SIDECAR_CTX.
pub const SIDECAR_MAX_OUTPUT: u64 = 6_144;
/// Rough token cost of the workspace tool schemas on the wire.
pub const LOCAL_TOOL_RESERVE: u64 = 10_000;
pub const KNOWN_BUILDS: [&str; 4] = ["auto", "cuda", "vulkan", "cpu"];
/// Backend picker: (id, label), in picker order.
pub const ENGINE_BUILDS: [(&str, &str); 4] = [("auto", "Auto (detect)"), ("cuda", "CUDA (NVIDIA)"), ("vulkan", "Vulkan"), ("cpu", "CPU only")];

/// The GPU this machine reports (nvidia-smi, DRI node, or macOS).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineGpu {
    Nvidia,
    Metal,
    Vulkan,
    None,
}

/// What the running sidecar does with the GPU, from the engine's own log. `in_use: None` means "no answer yet".
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineGpuState {
    pub detected: EngineGpu,
    pub in_use: Option<bool>,
    pub backend: Option<String>,
    pub offloaded: Option<String>,
    pub note: String,
    pub log_tail: Vec<String>,
}

/// One message on the download stream (`data: {...}` lines in the web).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum EngineDownloadEvent {
    Progress { label: String, completed: u64, total: u64, percent: Option<u32> },
    Status { message: String },
    Done,
    Error { message: String },
}

/// Flags the sidecar starts with: preset ids that are on, the user's own tokens, and the build choice.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SidecarSpecState {
    pub enabled: Vec<String>,
    pub extra: Vec<String>,
    /// Absent means "auto (detect)".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct SpecPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub blurb: &'static str,
    pub args: &'static [&'static str],
    /// On unless the user turns it off.
    pub on: bool,
}

/// Optional llama-server flags. MTP is on by default; the rest are opt-in because they can fail on CPU.
pub const SPEC_PRESETS: [SpecPreset; 3] = [
    SpecPreset {
        id: "mtp",
        label: "MTP draft · 2 tokens",
        blurb: "Uses the draft head already in the GGUF. Same answers, faster decode. ~0.8 GB extra.",
        args: &["--spec-type", "draft-mtp", "--spec-draft-n-max", "2"],
        on: true,
    },
    SpecPreset {
        id: "flash",
        label: "Flash attention",
        blurb: "Faster attention on NVIDIA / Metal. Leave off on CPU — it can refuse to start.",
        args: &["-fa", "on"],
        on: false,
    },
    SpecPreset {
        id: "shift",
        label: "Context shift",
        blurb: "When the window fills, shift old tokens instead of 400ing.",
        args: &["--context-shift"],
        on: false,
    },
];

/// What this PC can run: fitted GPU layers, CPU threads, VRAM and the layer count. `ngl` 99 means "all of it".
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarMachinePlan {
    pub ngl: u32,
    pub threads: u32,
    #[serde(rename = "vramMB")]
    pub vram_mb: u64,
    pub layers: u32,
    #[serde(rename = "ramFreeGB")]
    pub ram_free_gb: f64,
}

/// The `/api/local` GET body and the status the UI polls.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub gguf_ready: bool,
    pub gguf_bytes: u64,
    pub gguf_expected: u64,
    pub mmproj_ready: bool,
    pub mmproj_bytes: u64,
    pub mmproj_expected: u64,
    pub server_ready: bool,
    pub running: bool,
    pub base_url: String,
    pub api_model: String,
    pub hint: String,
    /// What the running llama-server actually opened. None if unknown.
    pub n_ctx: Option<u64>,
    pub spec: SidecarSpecState,
    pub gpu: EngineGpuState,
    pub gpu_plan: Option<SidecarMachinePlan>,
}

/// `Infinity`-safe "gguf is on disk" test used by every caller.
pub fn gguf_looks_complete(bytes: u64) -> bool {
    bytes >= GGUF_MIN_BYTES
}

/// The spec the web starts from: presets that are on, no extra flags, no build choice.
pub fn default_spec_state() -> SidecarSpecState {
    SidecarSpecState { enabled: SPEC_PRESETS.iter().filter(|p| p.on).map(|p| p.id.to_string()).collect(), extra: vec![], build: None }
}

/// JS `toFixed` for the digits used here: rounds half up, where Rust's `{:.N}` rounds half to even.
fn to_fixed(v: f64, digits: u32) -> String {
    let s = 10f64.powi(digits as i32);
    format!("{:.*}", digits as usize, (v * s).round() / s)
}

/// "1.5 GB" style sizes: one decimal under 10 of a unit, whole numbers above.
pub fn format_bytes(n: f64) -> String {
    if !n.is_finite() || n <= 0.0 {
        return "0 B".into();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let (mut v, mut i) = (n, 0);
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    let digits = if v >= 10.0 || i == 0 { 0 } else { 1 };
    format!("{} {}", to_fixed(v, digits), units[i])
}

/// Share of the download done, or None when the total is unknown.
pub fn download_percent(completed: f64, total: f64) -> Option<u32> {
    if !total.is_finite() || total <= 0.0 {
        return None;
    }
    Some(((completed / total) * 100.0).round().min(100.0) as u32)
}

/// Only Hugging Face (this GGUF) and official llama.cpp release assets.
pub fn is_allowed_download_url(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else { return false };
    if url.scheme() != "https" {
        return false;
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    const ALLOWED: [&str; 10] = [
        "huggingface.co",
        "hf.co",
        "cdn-lfs.huggingface.co",
        "cdn-lfs-us-1.huggingface.co",
        "cas-bridge.xethub.hf.co",
        "github.com",
        "api.github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
        "github-releases.githubusercontent.com",
    ];
    if !ALLOWED.contains(&host.as_str()) && !host.ends_with(".hf.co") {
        return false;
    }
    let path = url.path();
    if host == "github.com" || host == "api.github.com" {
        return path.contains("/ggml-org/llama.cpp/");
    }
    if host == "huggingface.co" || host == "hf.co" {
        return path.contains("/bartowski/Qwen3.8-27B-GGUF/") || path.contains(&format!("/{GGUF_FILE}"));
    }
    true
}

/// Pick the llama.cpp release asset for this machine. A CPU build always exists as the last resort.
/// `build` is the user's override ("auto" or None detects); `cuda` is "12" or "13" (Blackwell and newer need 13).
pub fn pick_llama_asset(names: &[String], platform: &str, arch: &str, gpu: EngineGpu, build: Option<&str>, cuda: &str) -> Option<String> {
    let names: Vec<&str> = names.iter().map(String::as_str).filter(|n| !n.is_empty()).collect();
    let has = |re: &str| -> Option<String> {
        let r = Regex::new(re).ok()?;
        names.iter().copied().find(|n| r.is_match(n)).map(String::from)
    };
    let build = build.unwrap_or("auto");
    let major = if cuda == "13" { "13" } else { "12" };
    let x64 = matches!(arch, "x64" | "x86_64");
    let arm = matches!(arch, "arm64" | "aarch64");
    let cuda_win = || has(&format!(r"llama-b\d+-bin-win-cuda-{major}\.\d+-x64\.zip$")).or_else(|| has(r"llama-b\d+-bin-win-cuda-\d+\.\d+-x64\.zip$"));
    let vulkan_win = || has(r"llama-b\d+-bin-win-vulkan-x64\.zip$");
    let cpu_win = || has(r"llama-b\d+-bin-win-cpu-x64\.zip$");
    let vulkan_linux = || has(r"llama-b\d+-bin-ubuntu-vulkan-x64\.tar\.gz$").or_else(|| has(r"llama-b\d+-bin-ubuntu-x64\.tar\.gz$"));
    let cpu_linux = || has(r"llama-b\d+-bin-ubuntu-x64\.tar\.gz$");
    match platform {
        // Metal is compiled in; there is no separate build to choose.
        "darwin" => if arm { has(r"llama-b\d+-bin-macos-arm64\.tar\.gz$") } else { has(r"llama-b\d+-bin-macos-x64\.tar\.gz$") },
        "win32" => {
            if build == "cuda" && x64 {
                cuda_win()
            } else if build == "vulkan" && x64 {
                vulkan_win().or_else(cpu_win)
            } else if build == "cpu" && x64 {
                cpu_win()
            } else if gpu == EngineGpu::Nvidia && x64 {
                cuda_win().or_else(vulkan_win).or_else(cpu_win)
            } else if x64 {
                vulkan_win().or_else(cpu_win)
            } else if arm {
                has(r"llama-b\d+-bin-win-cpu-arm64\.zip$")
            } else {
                None
            }
        }
        "linux" => {
            // No separate CUDA ubuntu asset; Vulkan also drives NVIDIA.
            if arm {
                has(r"llama-b\d+-bin-ubuntu-arm64\.tar\.gz$")
            } else if (build == "cuda" || build == "vulkan") && x64 {
                vulkan_linux()
            } else if build == "cpu" && x64 {
                cpu_linux()
            } else if gpu == EngineGpu::Vulkan || gpu == EngineGpu::Nvidia {
                vulkan_linux()
            } else {
                cpu_linux()
            }
        }
        _ => None,
    }
}

/// The Windows CUDA build needs its runtime DLLs from a second archive. Returns the matching cudart asset.
pub fn pick_cudart_asset(names: &[String], main: Option<&str>) -> Option<String> {
    let m = Regex::new(r"win-cuda-(\d+\.\d+)-(x64|arm64)\.zip$").ok()?.captures(main?)?;
    let (ver, arch) = (&m[1], &m[2]);
    let names: Vec<&str> = names.iter().map(String::as_str).filter(|n| !n.is_empty()).collect();
    let exact = Regex::new(&format!(r"cudart-llama-bin-win-cuda-{}-{arch}\.zip$", regex::escape(ver))).ok()?;
    let any = Regex::new(&format!(r"cudart-llama-bin-win-cuda-\d+\.\d+-{arch}\.zip$")).ok()?;
    names.iter().copied().find(|n| exact.is_match(n)).or_else(|| names.iter().copied().find(|n| any.is_match(n))).map(String::from)
}

/// Output ceiling for a request: the sidecar's own limit for Qwen, the model's documented window otherwise (chat/route.ts:2820-2828).
pub fn output_ceiling(qwen: bool, model_max: u64) -> u64 {
    if qwen { SIDECAR_MAX_OUTPUT } else { model_max }
}

/// Whether a chosen build asset needs the separate cudart archive.
pub fn needs_cudart(main: Option<&str>) -> bool {
    main.is_some_and(|m| Regex::new(r"win-cuda-\d").is_ok_and(|r| r.is_match(m)))
}

/// Which CUDA major a card needs, from its compute capability ("8.9", "12.0"). Unknown stays on "12".
pub fn cuda_major_for_compute_cap(cap: Option<&str>) -> &'static str {
    let digits: String = cap.unwrap_or("").trim().chars().take_while(|c| c.is_ascii_digit()).collect();
    match digits.parse::<u32>() {
        Ok(m) if m >= 12 => "13",
        _ => "12",
    }
}

/// How many layers fit on the card (99 = all of them). Mirrors `planGpuLayers`: weights plus q8_0 KV per layer,
/// with 3 GiB reserved for the OS, compute buffers and the vision tower. Unknown shape keeps the old 99.
pub fn plan_gpu_layers(vram_mb: f64, gguf_bytes: f64, block_count: f64, kv_bytes_per_token: f64, ctx_tokens: f64, mmproj_bytes: f64) -> u32 {
    const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
    if !(vram_mb > 0.0 && block_count > 0.0) || !(kv_bytes_per_token > 0.0) {
        return 99;
    }
    let per_layer = gguf_bytes / block_count + (kv_bytes_per_token * ctx_tokens) / block_count;
    if !(per_layer > 0.0) {
        return 99;
    }
    let reserve = 2.0 * GIB + 1.0 * GIB + mmproj_bytes.max(0.0);
    let avail = vram_mb * 1024.0 * 1024.0 - reserve;
    if avail <= 0.0 {
        return 0;
    }
    let fits = (avail / per_layer).floor();
    if fits >= block_count {
        return 99;
    }
    fits.max(0.0) as u32
}

/// One human line for the status panel, or None when there is no plan to show.
pub fn format_gpu_plan(plan: Option<&SidecarMachinePlan>) -> Option<String> {
    let p = plan?;
    if p.vram_mb == 0 || p.layers == 0 {
        return None;
    }
    let vram = format!("{} GB", (p.vram_mb as f64 / 1024.0).round() as u64);
    // Under 4 GB free, the CPU layers swap and read as "GPU burns, nothing comes".
    let ram = if p.ram_free_gb > 0.0 && p.ram_free_gb < 4.0 {
        format!(" Only {} GB RAM free — close other apps or the CPU layers will swap.", to_fixed(p.ram_free_gb, 1))
    } else {
        String::new()
    };
    Some(if p.ngl >= 99 || p.ngl >= p.layers {
        format!("Offload plan: all {} layers on the GPU ({vram} VRAM).{ram}", p.layers)
    } else if p.ngl == 0 {
        format!("Offload plan: CPU only — the 27B does not fit in {vram} of VRAM. It still answers, roughly 10x slower than on a bigger card.{ram}")
    } else {
        format!("Offload plan: {}/{} layers on the GPU ({vram} card — the rest runs on CPU).{ram}", p.ngl, p.layers)
    })
}

/// The one-line status under the title. Takes the same flags as `engineHint`.
pub fn engine_hint(gguf_ready: bool, mmproj_ready: bool, server_ready: bool, running: bool, gguf_bytes: f64) -> String {
    if running && gguf_ready {
        return if !mmproj_ready {
            "Sidecar is up, but the vision projector is missing — click Download so Qwen can see images and video.".into()
        } else {
            "Qwen is loaded on this PC (~25–30 GB committed). Unload it when you switch to Ox or DeepSeek so the RAM comes back.".into()
        };
    }
    if gguf_ready && server_ready {
        return if !mmproj_ready {
            "Downloaded. Get the vision projector (~0.9 GB) so Qwen can see images, then Start. It is not using RAM until you Start.".into()
        } else {
            "Downloaded. Start only when you want to chat with Qwen — Unload frees the 25–30 GB.".into()
        };
    }
    if gguf_ready {
        return "Weights are on disk. The engine binary is still missing — click Download.".into();
    }
    if gguf_bytes > 0.0 {
        return "Partial download on disk — click Download to resume. Qwen is not loaded in RAM yet.".into();
    }
    "Download Qwen 3.8 27B into this app (~16.5 GB plus a 0.9 GB vision projector). Your PC runs it; nothing is sent to a cloud provider.".into()
}

/// Split a typed flag line into argv tokens. Rejects shell metacharacters and anything that is not a plain flag.
pub fn parse_user_flags(raw: &str) -> Result<Vec<String>, String> {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    if parts.is_empty() {
        return Err("Empty flag.".into());
    }
    if !parts[0].starts_with('-') {
        return Err("Start with a flag, e.g. --spec-draft-p-min 0.85".into());
    }
    let flag = Regex::new(r"^--?[A-Za-z0-9][A-Za-z0-9_.-]*$").map_err(|e| e.to_string())?;
    let value = Regex::new(r"^[A-Za-z0-9_.:%=,+/-]+$").map_err(|e| e.to_string())?;
    for p in &parts {
        if p.chars().any(|c| ";|&$`\n\r<>\\".contains(c)) {
            return Err("That flag has a shell character.".into());
        }
        if p.starts_with('-') {
            if !flag.is_match(p) {
                return Err(format!("Not a flag: {p}"));
            }
        } else if !value.is_match(p) {
            return Err(format!("Not a safe value: {p}"));
        }
    }
    Ok(parts.iter().map(|s| s.to_string()).collect())
}

/// Identifies one launch: a new id means the flags changed and the engine must restart.
pub fn sidecar_launch_id(spec: &SidecarSpecState, machine: Option<&SidecarMachinePlan>) -> String {
    let mut enabled = spec.enabled.clone();
    enabled.sort();
    let plan = machine.map(|m| format!("-ngl{}-t{}", m.ngl, m.threads)).unwrap_or_default();
    format!("c{SIDECAR_CTX}-q8-{}-{}{plan}", enabled.join("+"), spec.extra.join(" "))
}

/// argv for llama-server. Host is loopback-only on purpose. Without a machine plan the old static flags are used.
pub fn sidecar_args(gguf: &str, mmproj: Option<&str>, spec: &SidecarSpecState, machine: Option<&SidecarMachinePlan>) -> Vec<String> {
    let ngl = machine.map_or(99, |m| m.ngl.min(99));
    let threads = machine.map_or(0, |m| m.threads.max(1));
    let mut a: Vec<String> = [
        "-m", gguf, "-a", DEFAULT_LOCAL_API_MODEL, "--host", ENGINE_HOST, "--port",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.push(ENGINE_PORT.to_string());
    a.extend(["--jinja", "--reasoning-format", "deepseek", "-c"].iter().map(|s| s.to_string()));
    a.push(SIDECAR_CTX.to_string());
    a.extend(["-ngl".to_string(), ngl.to_string(), "--cache-type-k".into(), "q8_0".into(), "--cache-type-v".into(), "q8_0".into()]);
    // Smaller batches cut the prefill spike on a 73k-token agent prompt.
    a.extend(["-b", "512", "-ub", "256", "--parallel", "1", "--timeout", "3600"].iter().map(|s| s.to_string()));
    if threads > 0 {
        a.extend(["--threads".to_string(), threads.to_string(), "--threads-batch".into(), threads.to_string()]);
    }
    for p in SPEC_PRESETS.iter().filter(|p| spec.enabled.iter().any(|e| e == p.id)) {
        a.extend(p.args.iter().map(|s| s.to_string()));
    }
    a.extend(spec.extra.iter().cloned());
    if let Some(m) = mmproj {
        a.push("--mmproj".into());
        a.push(m.into());
    }
    a
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::{Value, json};

    /// Input/output pairs dumped from the web's functions by scratch gen-fixtures.ts.
    pub(crate) fn fx(key: &str) -> Vec<(Value, Value)> {
        let all: Value = serde_json::from_str(include_str!("fixtures.json")).unwrap();
        all[key].as_array().unwrap().iter().map(|c| (c[0].clone(), c[1].clone())).collect()
    }
    fn gpu(v: &Value) -> EngineGpu {
        serde_json::from_value(v.clone()).unwrap()
    }
    fn plan(v: &Value) -> Option<SidecarMachinePlan> {
        serde_json::from_value(v.clone()).ok()
    }
    fn strs(v: &Value) -> Vec<String> {
        v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn catalog_and_labels_match_web() {
        let builds: Value = ENGINE_BUILDS.iter().map(|(i, l)| json!({"id": i, "label": l})).collect();
        assert_eq!(builds, fx("ENGINE_BUILDS")[0].1);
        assert_eq!(serde_json::to_value(SPEC_PRESETS).unwrap(), fx("SPEC_PRESETS")[0].1);
        assert_eq!(serde_json::to_value(default_spec_state()).unwrap(), fx("defaultSpecState")[0].1);
    }

    #[test]
    fn text_and_size_maths_match_web() {
        for (i, o) in fx("formatBytes") {
            assert_eq!(format_bytes(i.as_f64().unwrap()), o.as_str().unwrap(), "formatBytes {i}");
        }
        for (i, o) in fx("downloadPercent") {
            let a = i.as_array().unwrap();
            assert_eq!(download_percent(a[0].as_f64().unwrap(), a[1].as_f64().unwrap()).map(u64::from), o.as_u64(), "downloadPercent {i}");
        }
        for (i, o) in fx("ggufLooksComplete") {
            assert_eq!(gguf_looks_complete(i.as_u64().unwrap()), o.as_bool().unwrap(), "ggufLooksComplete {i}");
        }
        for (i, o) in fx("formatGpuPlan") {
            assert_eq!(format_gpu_plan(plan(&i).as_ref()).as_deref(), o.as_str(), "formatGpuPlan {i}");
        }
        for (i, o) in fx("engineHint") {
            let b = |k: &str| i[k].as_bool().unwrap();
            assert_eq!(engine_hint(b("ggufReady"), b("mmprojReady"), b("serverReady"), b("running"), i["ggufBytes"].as_f64().unwrap()), o.as_str().unwrap(), "engineHint {i}");
        }
    }

    #[test]
    fn asset_picks_match_web() {
        for (i, o) in fx("pickLlamaAsset") {
            let p = &i[1];
            let got = pick_llama_asset(&strs(&i[0]), p["platform"].as_str().unwrap(), p["arch"].as_str().unwrap(), gpu(&p["gpu"]), p["build"].as_str(), p["cuda"].as_str().unwrap());
            assert_eq!(got.as_deref(), o.as_str(), "pickLlamaAsset {p}");
        }
        for (i, o) in fx("pickCudartAsset") {
            assert_eq!(pick_cudart_asset(&strs(&i[0]), i[1].as_str()).as_deref(), o.as_str(), "pickCudartAsset {i}");
        }
        for (i, o) in fx("needsCudart") {
            assert_eq!(needs_cudart(i.as_str()), o.as_bool().unwrap(), "needsCudart {i}");
        }
        for (i, o) in fx("cudaMajorForComputeCap") {
            assert_eq!(cuda_major_for_compute_cap(i.as_str()), o.as_str().unwrap(), "cudaMajorForComputeCap {i}");
        }
    }

    #[test]
    fn plan_flags_and_urls_match_web() {
        for (i, o) in fx("planGpuLayers") {
            let f = |k: &str| i[k].as_f64().unwrap();
            let got = plan_gpu_layers(f("vramMB"), f("ggufBytes"), f("blockCount"), f("kvBytesPerToken"), f("ctxTokens"), f("mmprojBytes"));
            assert_eq!(got as u64, o.as_u64().unwrap(), "planGpuLayers {i}");
        }
        for (i, o) in fx("sidecarLaunchId") {
            let spec: SidecarSpecState = serde_json::from_value(i[0].clone()).unwrap();
            assert_eq!(sidecar_launch_id(&spec, plan(&i[1]).as_ref()), o.as_str().unwrap(), "sidecarLaunchId {i}");
        }
        for (i, o) in fx("sidecarArgs") {
            let spec: SidecarSpecState = serde_json::from_value(i[2].clone()).unwrap();
            assert_eq!(sidecar_args(i[0].as_str().unwrap(), i[1].as_str(), &spec, plan(&i[3]).as_ref()), strs(&o), "sidecarArgs {i}");
        }
        for (i, o) in fx("parseUserFlags") {
            let got = match parse_user_flags(i.as_str().unwrap()) {
                Ok(t) => json!({"ok": true, "tokens": t}),
                Err(e) => json!({"ok": false, "error": e}),
            };
            assert_eq!(got, o, "parseUserFlags {i}");
        }
        for (i, o) in fx("isAllowedDownloadUrl") {
            assert_eq!(is_allowed_download_url(i.as_str().unwrap()), o.as_bool().unwrap(), "isAllowedDownloadUrl {i}");
        }
    }
}
