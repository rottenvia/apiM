//! Port of src/lib/wsl.ts: detecting WSL, parsing its output, translating paths, quoting,
//! building the wsl.exe argv, the sandbox bash runner, and every WSL error explanation.
//! Pure logic first; the live probes take the wsl program path so tests can use a fake.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const SANDBOX_DISTRO: &str = "apim-sandbox";
pub const LINUX_CWD: &str = "/root";
pub const ROOTFS_BASE: &str = "https://cloud-images.ubuntu.com/wsl/releases/24.04/current";
pub const ROOTFS_FILE: &str = "ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz";
pub const SANDBOX_ARGV_LIMIT: usize = 24_000;
pub const SELF_CHECK_MARKER: &str = "apim-selfcheck-7f3a";
pub const SANDBOX_PACKAGES: &[&str] = &[
    "xvfb", "x11-utils", "xdotool", "imagemagick", "python3", "python3-pip", "python3-venv", "nodejs", "npm",
    "build-essential", "git", "curl", "file", "unzip", "gdb", "strace",
];

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDistro {
    pub name: String,
    pub state: String,
    pub version: f64,
    pub is_default: bool,
}

#[derive(Clone, Debug, PartialEq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslStatus {
    pub installed: bool,
    pub distros: Vec<WslDistro>,
    pub default_distro: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// wsl.exe prints UTF-16LE (with a BOM, or with NULs in every other byte); anything else is UTF-8.
pub fn decode_wsl_output(raw: &[u8]) -> String {
    let utf16 = |b: &[u8]| {
        let units: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units).replace('\u{feff}', "")
    };
    if raw.len() >= 2 && raw[0] == 0xff && raw[1] == 0xfe {
        return utf16(&raw[2..]);
    }
    let sample = raw.len().min(64);
    let mut nul_evens = 0;
    let mut i = 1;
    while i < sample {
        if raw[i] == 0 {
            nul_evens += 1;
        }
        i += 2;
    }
    if sample > 4 && (nul_evens as f64) > sample as f64 / 4.0 {
        return utf16(raw);
    }
    String::from_utf8_lossy(raw).into_owned()
}

/// Parses `wsl --list --verbose`: skip the header line, read rows by position (header words are localised).
pub fn parse_wsl_distros(output: &str) -> Vec<WslDistro> {
    let lines: Vec<String> = output
        .split(['\n', '\r'])
        .map(|l| l.replace('\0', "").trim_end().to_string())
        .filter(|l| !l.trim().is_empty())
        .collect();
    if lines.len() <= 1 {
        return Vec::new();
    }
    let mut rows = Vec::new();
    for line in &lines[1..] {
        let is_default = line.trim_start().starts_with('*');
        let body = line.trim_start().strip_prefix('*').unwrap_or(line.trim_start());
        let cols: Vec<&str> = body.split_whitespace().collect();
        if cols.len() < 3 {
            continue;
        }
        let version: f64 = match cols[cols.len() - 1].parse() {
            Ok(v) if f64::is_finite(v) => v,
            _ => continue,
        };
        let state = cols[cols.len() - 2].to_string();
        let name = cols[..cols.len() - 2].join(" ");
        if name.is_empty() {
            continue;
        }
        rows.push(WslDistro { name, state, version, is_default });
    }
    rows
}

fn is_line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// Windows path to the /mnt form WSL sees. UNC \\wsl$ paths become their Linux view; relative paths keep Linux separators.
pub fn win_path_to_wsl(win: &str) -> String {
    let p = js_trim(win);
    if p.is_empty() {
        return String::new();
    }
    if p.starts_with('/') {
        return p.to_string();
    }
    // \\wsl$\<distro>[\rest] or \\wsl.localhost\<distro>[\rest], case-insensitive; rest must have no line break.
    let lower = p.to_ascii_lowercase();
    for prefix in [r"\\wsl$\", r"\\wsl.localhost\"] {
        if lower.starts_with(prefix) {
            let after = &p[prefix.len()..];
            let (distro, rest) = match after.find('\\') {
                Some(i) => (&after[..i], &after[i..]),
                None => (after, ""),
            };
            if !distro.is_empty() && !rest.contains(is_line_end) {
                let linux = rest.replace('\\', "/");
                return if linux.is_empty() { "/".to_string() } else { linux };
            }
        }
    }
    // Drive path: C:\x\y or D:/z -> /mnt/<drive>/... with trailing slashes removed.
    let b = p.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') && !p[3..].contains(is_line_end) {
        let rest = p[3..].replace('\\', "/");
        let joined = format!("/mnt/{}/{}", (b[0] as char).to_ascii_lowercase(), rest);
        return joined.trim_end_matches('/').to_string();
    }
    p.replace('\\', "/")
}

/// Shell-quotes one token for the Linux side: safe characters pass, everything else is single-quoted with '\'' escapes.
pub fn sh_quote(token: &str) -> String {
    if token.is_empty() {
        return "''".to_string();
    }
    if token.chars().all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c)) {
        return token.to_string();
    }
    format!("'{}'", token.replace('\'', "'\\''"))
}

#[derive(Clone, Debug, PartialEq)]
pub struct WslInvocation {
    pub command: String,
    pub args: Vec<String>,
}

/// Builds `wsl.exe -d <distro> -u <user> --cd <cwd> --exec [env K=V...] <command> <args...>`.
pub fn build_invocation(distro: Option<&str>, user: Option<&str>, cwd: Option<&str>, env: &[(String, String)], command: &str, args: &[String]) -> WslInvocation {
    let mut out: Vec<String> = Vec::new();
    if let Some(d) = distro {
        out.extend(["-d".into(), d.into()]);
    }
    if let Some(u) = user {
        out.extend(["-u".into(), u.into()]);
    }
    if let Some(c) = cwd {
        out.extend(["--cd".into(), c.into()]);
    }
    out.push("--exec".into());
    if !env.is_empty() {
        out.push("env".into());
        out.extend(env.iter().map(|(k, v)| format!("{k}={v}")));
    }
    out.push(command.into());
    out.extend(args.iter().cloned());
    WslInvocation { command: "wsl.exe".into(), args: out }
}

pub fn import_args(install_dir: &str, tarball: &str, version: u8) -> Vec<String> {
    vec!["--import".into(), SANDBOX_DISTRO.into(), install_dir.into(), tarball.into(), "--version".into(), version.to_string()]
}

/// Parses a SHA256SUMS listing and returns the lowercase hash for `file`.
pub fn expected_sha256(sums: &str, file: &str) -> Option<String> {
    for line in sums.split(['\n', '\r']) {
        let line = line.trim();
        if line.len() < 66 || !line.is_char_boundary(64) {
            continue;
        }
        let (hash, rest) = line.split_at(64);
        if !hash.chars().all(|c| c.is_ascii_hexdigit()) || !rest.starts_with(char::is_whitespace) {
            continue;
        }
        let r = rest.trim_start();
        let name = if r.starts_with('*') && r.len() > 1 { &r[1..] } else { r };
        if name.trim() == file {
            return Some(hash.to_ascii_lowercase());
        }
    }
    None
}

pub fn sandbox_wsl_conf() -> String {
    "[automount]\nenabled = false\nmountFsTab = false\n\n[interop]\nenabled = false\nappendWindowsPath = false\n\n[user]\ndefault = root\n".to_string()
}

pub fn wsl_setup_script() -> String {
    format!(
        "set -e\nexport DEBIAN_FRONTEND=noninteractive\napt-get update\napt-get install -y --no-install-recommends {}\nmkdir -p /ws\necho \"apim-wsl-setup-ok\"",
        SANDBOX_PACKAGES.join(" ")
    )
}

/// One directory per chat. Each non-[A-Za-z0-9_-] UTF-16 unit becomes "_", as the web's regex does.
pub fn sandbox_mount_point(workspace_id: &str) -> String {
    let mut s = String::from("/ws/");
    for c in workspace_id.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            s.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                s.push('_');
            }
        }
    }
    s
}

/// The bash every sandbox command runs through: $1 base64 command (or "-" for stdin), $2 mount point, $3 Windows folder.
/// Ported verbatim from the web's SANDBOX_RUNNER (its \${ escapes are plain ${ here).
pub const SANDBOX_RUNNER: &str = r#"m="$2"; w="$3"
work="${APIM_WORK:-/root/work}"
mkdir -p "$m" "$work"
errs=""
drvfs() {
  local e
  e=$(LIBMOUNT_FORCE_MOUNT2=always mount -t drvfs "$1" "$2" 2>&1) && return 0
  errs="$errs [mount $1: $e]"
  e=$(python3 -c 'import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
if libc.mount(sys.argv[1].encode(), sys.argv[2].encode(), b"drvfs", 0, b"") != 0:
    sys.exit("mount(2) " + sys.argv[1] + ": " + os.strerror(ctypes.get_errno()))' "$1" "$2" 2>&1) && return 0
  errs="$errs [$e]"
  return 1
}
if ! grep -qsF " $m " /proc/mounts; then
  if ! drvfs "$w" "$m"; then
    d="${w%%:*}"; rest="${w#?:}"; rest="${rest//\\//}"; rest="${rest#/}"
    r="${APIM_DRIVES:-/mnt/.apim}/$d"
    if [ "${#d}" = 1 ]; then
      mkdir -p "$r"
      grep -qsF " $r " /proc/mounts || drvfs "$d:\\" "$r"
      if [ -d "$r/$rest" ]; then
        LIBMOUNT_FORCE_MOUNT2=always mount --bind "$r/$rest" "$m" 2>/dev/null || m="$r/$rest"
        errs=""
      fi
    fi
    if [ -n "$errs" ]; then
      echo "[sandbox] the chat folder could not be mounted at $m:$errs. Working in $work instead: files there are NOT visible to your other tools." >&2
      m="$work"
    fi
  fi
fi
if [ -n "$DISPLAY" ] && command -v xdpyinfo >/dev/null && ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  n="${DISPLAY#:}"; rm -f "/tmp/.X$n-lock" "/tmp/.X11-unix/X$n"
  setsid Xvfb "$DISPLAY" -screen 0 1600x1000x24 -nolisten tcp </dev/null >/dev/null 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break; sleep 0.2; done
  echo "[sandbox] the off-screen display $DISPLAY had been stopped; started a fresh, empty one. Do not start or kill Xvfb yourself." >&2
fi
cd "$m" 2>/dev/null || cd /root
f=$(mktemp /tmp/apim-cmd.XXXXXX) || exit 125
if [ "$1" = "-" ]; then cat > "$f"; exec </dev/null; else printf %s "$1" | base64 -d > "$f"; fi
bash -l "$f"; s=$?
rm -f "$f"
exit $s"#;

/// Base64 (standard alphabet, padded), as Node's Buffer.toString("base64").
pub fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The runner's $1 for `script`, and the stdin to send when it is "-" (too long for the command line).
pub fn encode_sandbox_script(script: &str) -> (String, Option<String>) {
    let b64 = base64_encode(script.as_bytes());
    if b64.len() > SANDBOX_ARGV_LIMIT { ("-".into(), Some(script.to_string())) } else { (b64, None) }
}

/// A free X display in 57..90, never :99, :0 or :1 (what agents reach for and kill).
pub fn pick_display(used: &[u32]) -> String {
    (57..90).find(|n| !used.contains(n)).map_or(":89".into(), |n| format!(":{n}"))
}

pub fn xvfb_launch_args(display: &str) -> Vec<String> {
    [display, "-screen", "0", "1600x1000x24", "-nolisten", "tcp"].iter().map(|s| s.to_string()).collect()
}

pub fn capture_args(display: &str, out_wsl: &str) -> Vec<String> {
    ["-display", display, "-window", "root", out_wsl].iter().map(|s| s.to_string()).collect()
}

/// Whether this build can have wsl.exe at all.
pub fn platform_possible() -> bool {
    cfg!(windows)
}

/// Runs a program with a time limit and a byte cap on each stream. None when it could not start or was killed by the timeout.
pub struct Ran {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Runs a program to the end or until `limit`, reading both pipes in threads so a full pipe cannot hang it.
pub fn run_timed(program: &Path, args: &[String], limit: Duration, stdin: Option<&str>) -> Option<Ran> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    if let Some(text) = stdin {
        use std::io::Write;
        if let Some(mut pipe) = child.stdin.take() {
            let _ = pipe.write_all(text.as_bytes());
        }
    }
    let read = |mut p: Option<Box<dyn Read + Send>>| std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = p.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let out = read(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = read(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let started = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out.join();
                let _ = err.join();
                return None;
            }
        }
    };
    Some(Ran { code, stdout: out.join().unwrap_or_default(), stderr: err.join().unwrap_or_default() })
}

#[cfg(windows)]
fn hide(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
fn hide(_: &mut Command) {}

/// `wsl --list --verbose` and, when that shows nothing, `wsl --status`, as the web's probeWsl.
pub fn probe(wsl: &Path) -> WslStatus {
    if !platform_possible() {
        return WslStatus {
            installed: false,
            reason: Some("The app is not running on Windows, so there is no wsl.exe. The WSL sandbox is a Windows-only feature.".into()),
            ..Default::default()
        };
    }
    let Some(list) = run_timed(wsl, &["--list".into(), "--verbose".into()], Duration::from_secs(10), None) else {
        return WslStatus {
            installed: false,
            reason: Some("wsl.exe is not available. Install it from an elevated PowerShell with: wsl --install (one restart needed).".into()),
            ..Default::default()
        };
    };
    let distros = parse_wsl_distros(&decode_wsl_output(&list.stdout));
    let mut installed = list.code == Some(0) || !distros.is_empty();
    if !installed {
        installed = run_timed(wsl, &["--status".into()], Duration::from_secs(10), None).is_some_and(|r| r.code == Some(0));
    }
    if !installed {
        return WslStatus {
            installed: false,
            reason: Some("WSL is not turned on. From an administrator PowerShell run: wsl --install --no-distribution   then restart Windows once.".into()),
            ..Default::default()
        };
    }
    let default_distro = distros.iter().find(|d| d.is_default).or(distros.first()).map(|d| d.name.clone());
    WslStatus { installed: true, distros, default_distro, reason: None }
}

/// Picks the sandbox's own distro. Never the user's other distros.
pub fn choose_distro(status: &WslStatus) -> Result<String, (String, bool)> {
    if !status.installed {
        return Err((status.reason.clone().unwrap_or_else(|| "WSL is not installed.".into()), false));
    }
    if status.distros.iter().any(|d| d.name == SANDBOX_DISTRO) {
        return Ok(SANDBOX_DISTRO.into());
    }
    Err(("The sandbox is not set up yet. Open Settings -> Sandbox (or type /sandbox) and click Set up.".into(), true))
}

/// Matches the web's explainWslError. Keys on hex codes, which are the same in every Windows language.
pub fn explain_wsl_error(text: &str) -> Option<&'static str> {
    let t = text.to_lowercase();
    let has = |s: &str| t.contains(s);
    if has("0xc03a0014") || has("virtual disk support provider") {
        return Some("Windows could not create a virtual disk. Either the folder cannot hold one (compressed or encrypted, inside OneDrive, or not NTFS), or Windows' own virtual-disk drivers (FsDepends, vhdmp, vdrvroot) are missing or disabled. The second also breaks Docker Desktop, Hyper-V and mounting ISOs; see docs/restore-fsdepends.md.");
    }
    if has("wsl1_not_supported") || t.contains("wsl1 is not supported") || t.contains("wsl 1 is not supported") {
        return Some("WSL 1 is switched off on this PC. Click 'Turn on WSL 1 support' in this panel (it asks Windows for administrator rights), restart Windows, then click Set up again.");
    }
    if has("0x8007273f") || has("address incompatible with the requested protocol") {
        return Some("Windows refused the socket type WSL 2 uses to talk to its VM (Winsock error 10047). The Winsock catalog is damaged, usually by a VPN, antivirus or network tool that hooks it. As administrator run: netsh winsock reset   then restart Windows. A VPN may need reconnecting afterwards. The same fault breaks Docker Desktop.");
    }
    if has("0xd0000034") {
        return Some("Linux could not start: a Windows driver WSL opens on every start was not found. Seen on a cleaned-up Windows: the Plan 9 redirector (P9Rdr, behind \\\\wsl$) had its registration deleted while p9rdr.sys stayed. Click Set up again to check which one; if Windows only just turned WSL on, restart first (Start -> Power -> Restart).");
    }
    if has("hcs_e_service_not_available") || has("required feature is not installed") {
        return Some("WSL 2's virtual machine service is not installed (Virtual Machine Platform is off or did not finish installing). The sandbox uses WSL 1 instead, which needs neither.");
    }
    if has("0x80370102") {
        return Some("Virtualization is not available to WSL 2. Turn on 'Virtual Machine Platform' (Windows Features), and make sure virtualization (Intel VT-x / AMD SVM) is enabled in the BIOS, then restart.");
    }
    if has("0x8007019e") || has("0x8000000d") {
        return Some("The Windows Subsystem for Linux feature is not enabled. Click 'Turn on WSL' in this panel (or run: wsl --install --no-distribution as administrator), then restart Windows.");
    }
    if has("0x800701bc") || has("kernel") {
        return Some("WSL 2 needs its kernel updated. Run: wsl --update   then click Set up again.");
    }
    if has("0x80070070") || has("not enough space") {
        return Some("The drive is out of space. The sandbox needs about 4 GB free.");
    }
    if has("0x80070005") || has("access is denied") {
        return Some("Windows denied access to the sandbox folder. Pick a folder you own with APIM_SANDBOX_DIR, or check antivirus 'controlled folder access'.");
    }
    None
}

/// Signed exit code as the web prints it. Input is the unsigned 32-bit value Windows gives.
pub fn format_exit_code(code: Option<i64>) -> String {
    let Some(code) = code else { return "no exit code".into() };
    let signed = if code > 0x7fff_ffff { code - 0x1_0000_0000 } else { code };
    if signed.abs() > 0xffff {
        format!("{signed} (0x{:x})", code as u32)
    } else {
        signed.to_string()
    }
}

/// Process exit code as the web sees it (unsigned 32-bit on Windows).
pub fn exit_code_of(code: Option<i32>) -> Option<i64> {
    code.map(|c| c as u32 as i64)
}

pub struct InstallDirInfo {
    pub fs: String,
    pub drive_type: String,
    pub free_gb: f64,
    pub compressed: bool,
    pub encrypted: bool,
}

pub struct DirVerdict {
    pub fix_compression: bool,
    pub fix_encryption: bool,
    pub problems: Vec<String>,
}

/// Whether a folder can hold the sandbox disk, and what we may clear on our own folder.
pub fn assess_install_dir(dir: &str, info: &InstallDirInfo, onedrive_roots: &[String]) -> DirVerdict {
    let mut problems = Vec::new();
    let fs_name = info.fs.to_uppercase();
    if !fs_name.is_empty() && fs_name != "NTFS" && fs_name != "REFS" {
        problems.push(format!("{dir} is on a {} drive. A WSL disk needs NTFS (or ReFS); use a folder on your C: drive or set APIM_SANDBOX_DIR.", info.fs));
    }
    let dt = info.drive_type.to_lowercase();
    if dt.contains("network") || dt.contains("cdrom") || dt.contains("removable") {
        problems.push(format!("{dir} is on a {dt} drive. Use a local fixed drive."));
    }
    let lowered = dir.to_lowercase().replace('/', "\\");
    let synced = onedrive_roots
        .iter()
        .filter(|r| !r.is_empty())
        .map(|r| r.to_lowercase().replace('/', "\\").trim_end_matches('\\').to_string())
        .find(|r| lowered == *r || lowered.starts_with(&format!("{r}\\")));
    if let Some(root) = synced {
        problems.push(format!("{dir} is inside OneDrive ({root}). OneDrive cannot hold a WSL disk; set APIM_SANDBOX_DIR to a folder outside it."));
    }
    if info.free_gb.is_finite() && info.free_gb < 4.0 {
        problems.push(format!("Only {} GB free on that drive; the sandbox needs about 4 GB.", info.free_gb));
    }
    DirVerdict { fix_compression: info.compressed, fix_encryption: info.encrypted, problems }
}

/// PowerShell that creates the folder and prints its drive and attributes as one JSON line. ASCII only, CRLF.
pub fn install_dir_probe_script() -> String {
    [
        "param([string]$Dir)",
        "$ErrorActionPreference = \"Stop\"",
        "New-Item -ItemType Directory -Force -Path $Dir | Out-Null",
        "$item = Get-Item -LiteralPath $Dir -Force",
        "$attrs = $item.Attributes",
        "$drive = New-Object System.IO.DriveInfo([System.IO.Path]::GetPathRoot($item.FullName))",
        "[ordered]@{",
        "  fs = $drive.DriveFormat",
        "  driveType = [string]$drive.DriveType",
        "  freeGB = [math]::Round($drive.AvailableFreeSpace / 1GB, 1)",
        "  compressed = [bool]($attrs -band [System.IO.FileAttributes]::Compressed)",
        "  encrypted = [bool]($attrs -band [System.IO.FileAttributes]::Encrypted)",
        "} | ConvertTo-Json -Compress",
        "",
    ]
    .join("\r\n")
}

pub const VHD_SERVICES: &[&str] = &["FsDepends", "vhdmp", "vdrvroot", "vmcompute"];
pub const VHD_DRIVER_FILES: &[&str] = &["FsDepends.sys", "vhdmp.sys", "vdrvroot.sys"];

fn start_name(n: i64) -> Option<&'static str> {
    Some(match n {
        0 => "boot",
        1 => "system",
        2 => "automatic",
        3 => "on demand",
        4 => "DISABLED",
        _ => return None,
    })
}

/// `sc qc` output: exists unless the 1060 "not registered" code is printed; start type is the number after START_TYPE.
pub fn parse_sc_qc(text: &str) -> (bool, Option<i64>) {
    let bytes = text.as_bytes();
    let not_registered = text.match_indices("1060:").any(|(i, _)| i > 0 && bytes[i - 1].is_ascii_whitespace());
    if not_registered {
        return (false, None);
    }
    let start = find_after_key(text, "START_TYPE");
    (start.is_some() || text.contains("SERVICE_NAME"), start)
}

/// Finds `KEY\s*:\s*<digits>` and returns the digits as a number.
fn find_after_key(text: &str, key: &str) -> Option<i64> {
    for (i, _) in text.match_indices(key) {
        let rest = text[i + key.len()..].trim_start();
        if let Some(after) = rest.strip_prefix(':') {
            let digits: String = after.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
            if !digits.is_empty() {
                return digits.parse().ok();
            }
        }
    }
    None
}

/// `sc query` output: 1 stopped, 4 running. Not used by the diagnosis; kept for parity.
pub fn parse_sc_query(text: &str) -> Option<i64> {
    find_after_key(text, "STATE")
}

pub struct VhdFinding {
    pub component: String,
    pub problem: String,
    pub fix: String,
}

/// The web's diagnoseVhdStack. `services` maps each VHD service to its `sc qc` text; `files` to whether the driver file exists.
pub fn diagnose_vhd_stack(files: &[(&str, bool)], services: &[(&str, &str)]) -> Vec<VhdFinding> {
    let doc = "docs/restore-fsdepends.md";
    let mut out = Vec::new();
    for file in VHD_DRIVER_FILES {
        if files.iter().any(|(f, ok)| f == file && !ok) {
            out.push(VhdFinding {
                component: file.to_string(),
                problem: format!(r"the driver file C:\Windows\System32\drivers\{file} is missing"),
                fix: format!("no setting can bring it back; copy it from the Windows ISO ({doc}, \"If the driver file is missing\")"),
            });
        }
    }
    for name in VHD_SERVICES {
        let Some((_, qc)) = services.iter().find(|(n, _)| n == name) else { continue };
        let (exists, start) = parse_sc_qc(qc);
        if !exists {
            let fix = match *name {
                "FsDepends" => format!("recreate its registration step by step: {doc}, Steps 1-4 (make a restore point first)"),
                "vmcompute" => "turn on 'Virtual Machine Platform' in Windows Features, then restart".to_string(),
                _ => format!("a boot driver's registration cannot be safely rebuilt by hand; use {WINDOWS_REPAIR_SHORT}"),
            };
            out.push(VhdFinding { component: name.to_string(), problem: format!("{name} is not registered with Windows"), fix });
            continue;
        }
        if start == Some(4) {
            let restore = if *name == "vdrvroot" { 0 } else { 3 };
            out.push(VhdFinding {
                component: name.to_string(),
                problem: format!("{name} is DISABLED"),
                fix: format!(
                    "as administrator: sc.exe config {name} start= {} then restart ({} is the Windows default)",
                    if restore == 0 { "boot" } else { "demand" },
                    start_name(restore).unwrap_or("")
                ),
            });
        } else if *name == "vdrvroot" && start.is_some_and(|s| s != 0) {
            let s = start.unwrap_or(0);
            let shown = start_name(s).map_or(s.to_string(), str::to_string);
            out.push(VhdFinding {
                component: name.to_string(),
                problem: format!("vdrvroot starts \"{shown}\" instead of at boot"),
                fix: "as administrator: reg add HKLM\\SYSTEM\\CurrentControlSet\\Services\\vdrvroot /v Start /t REG_DWORD /d 0 /f   then restart".to_string(),
            });
        }
    }
    out
}

pub const WINDOWS_REPAIR_SHORT: &str = "Settings -> System -> Recovery -> \"Fix problems using Windows Update\" -> Reinstall now (keeps your files and apps)";

pub fn windows_repair_advice() -> String {
    format!(
        "Windows' own driver registrations are missing on this PC, which no app setting can restore safely. The reliable fix is Windows' repair install: {WINDOWS_REPAIR_SHORT}. On Windows 10, run the Media Creation Tool and choose \"Upgrade this PC now\" - same effect. It restores vdrvroot, FsDepends and the WSL drivers together, which also fixes Docker Desktop. If an anti-cheat or a debloat tool removed them, reinstalling that tool afterwards can remove them again."
    )
}

pub fn format_vhd_findings(findings: &[VhdFinding]) -> String {
    if findings.is_empty() {
        return "The virtual-disk drivers all look registered and enabled, so the fault is deeper (often an anti-cheat driver or a damaged VHD stack). Try `sc.exe start vhdmp` as administrator and see what it says, and the diskpart test in docs/restore-fsdepends.md, Step 4.".into();
    }
    let mut lines: Vec<String> = findings.iter().map(|f| format!("- {}. Fix: {}.", f.problem, f.fix)).collect();
    if findings.iter().any(|f| f.problem.contains("not registered") || f.problem.contains("is missing")) {
        lines.push(windows_repair_advice());
    }
    lines.join("\n")
}

pub const WSL1_DRIVER_FILES: &[&str] = &["lxcore.sys", "lxss.sys", "p9rdr.sys", "rdbss.sys"];
pub const WSL1_SERVICES: &[&str] = &["lxcore", "lxss", "P9Rdr", "Rdbss"];
pub const RDBSS_REPAIR_COMMAND: &str = "sc.exe create Rdbss type= filesys start= demand error= normal binPath= \\SystemRoot\\System32\\drivers\\rdbss.sys group= Network depend= Mup DisplayName= \"Redirected Buffering Sub System\"";
pub const P9RDR_REPAIR_COMMAND: &str = "sc.exe create P9Rdr type= kernel start= demand error= normal binPath= \\SystemRoot\\System32\\drivers\\p9rdr.sys depend= Rdbss DisplayName= \"Plan 9 Redirector Driver\"";

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Wsl1State {
    RedirectorUnregistered,
    RebootPending,
    FeatureOff,
    DriverUnregistered,
    Unknown,
}

pub struct Wsl1Probe {
    pub reboot_pending: bool,
    pub files: Vec<(String, bool)>,
    /// `sc qc` text per service, only for services that were checked.
    pub services: Vec<(String, String)>,
}

fn wsl1_file(p: &Wsl1Probe, name: &str) -> Option<bool> {
    p.files.iter().find(|(n, _)| n == name).map(|(_, v)| *v)
}

fn wsl1_missing(p: &Wsl1Probe, name: &str) -> bool {
    p.services.iter().any(|(n, qc)| n == name && !parse_sc_qc(qc).0)
}

/// Explains why "WSL 1 is not supported" appeared; three states, three fixes.
pub fn diagnose_wsl1(p: &Wsl1Probe) -> (Wsl1State, String) {
    let mut fixes: Vec<(&str, &str)> = Vec::new();
    if wsl1_file(p, "rdbss.sys") == Some(true) && wsl1_missing(p, "Rdbss") {
        fixes.push(("Rdbss", RDBSS_REPAIR_COMMAND));
    }
    if wsl1_file(p, "p9rdr.sys") == Some(true) && wsl1_missing(p, "P9Rdr") {
        fixes.push(("P9Rdr", P9RDR_REPAIR_COMMAND));
    }
    if !fixes.is_empty() {
        let names: Vec<&str> = fixes.iter().map(|(n, _)| *n).collect();
        let cmds: Vec<&str> = fixes.iter().map(|(_, c)| *c).collect();
        let undo: Vec<String> = names.iter().map(|n| format!("sc.exe delete {n}")).collect();
        return (
            Wsl1State::RedirectorUnregistered,
            format!(
                "Windows' Plan 9 redirector, which WSL opens on every start, cannot load: the service entry for {} was deleted (the driver files are still installed), so Linux cannot start. In an administrator PowerShell run:  {}  then  sc.exe start P9Rdr  and  Restart-Service WSLService -Force  and click Set up again. (Undo: {})",
                names.join(" and "),
                cmds.join("  then  "),
                undo.join(", ")
            ),
        );
    }
    if p.reboot_pending {
        return (Wsl1State::RebootPending, "Windows is waiting for a restart to finish turning features on. Use Start -> Power -> Restart (Shut down does not finish it), then click Set up again.".into());
    }
    if wsl1_file(p, "lxcore.sys") == Some(false) {
        return (Wsl1State::FeatureOff, "The WSL 1 driver (lxcore.sys) is not installed, so the 'Windows Subsystem for Linux' feature is off. Click 'Turn on WSL 1 support', approve the prompt, restart Windows, then click Set up.".into());
    }
    if wsl1_file(p, "lxcore.sys") == Some(true) && wsl1_missing(p, "lxcore") {
        return (Wsl1State::DriverUnregistered, format!("The WSL 1 driver file is installed but Windows has no registration for it (lxcore) - the same kind of damage as vdrvroot, so turning the feature on again cannot fix it. {}", windows_repair_advice()));
    }
    (Wsl1State::Unknown, format!("WSL 1's driver looks installed and registered, yet Windows still refuses it. If you have not restarted since turning it on, restart first. Otherwise: {}", windows_repair_advice()))
}

/// The DISM exit code from the elevated log ("dism-exit=3010"), or None.
pub fn parse_dism_exit(log: &str) -> Option<i64> {
    let i = log.find("dism-exit=")? + "dism-exit=".len();
    let rest = &log[i..];
    let (sign, digits) = match rest.strip_prefix('-') {
        Some(r) => (-1, r),
        None => (1, rest),
    };
    let d: String = digits.chars().take_while(|c| c.is_ascii_digit()).collect();
    d.parse::<i64>().ok().map(|v| sign * v)
}

pub struct DismExplain {
    pub ok: bool,
    pub restart: bool,
    pub message: String,
}

/// What a DISM exit code means for turning the WSL feature on.
pub fn explain_dism_exit(code: Option<i64>) -> DismExplain {
    let Some(code) = code else {
        return DismExplain { ok: false, restart: false, message: "The administrator prompt was declined or closed, so nothing changed.".into() };
    };
    match code {
        0 => DismExplain { ok: true, restart: false, message: "The WSL 1 feature is on.".into() },
        3010 => DismExplain { ok: true, restart: true, message: "The WSL 1 feature was turned on. Restart Windows (Start -> Power -> Restart), then click Set up.".into() },
        _ => {
            let hex = format!("{:x}", code as u32);
            if ["800f081f", "800f0906", "800f0907", "800f0922", "800f0950"].contains(&hex.as_str()) {
                DismExplain {
                    ok: false,
                    restart: false,
                    message: format!("DISM could not find or install the feature's files (0x{hex}): the Windows component store is damaged. {}", windows_repair_advice()),
                }
            } else {
                DismExplain { ok: false, restart: false, message: format!("DISM failed (exit {}); see the log above.", format_exit_code(Some(code))) }
            }
        }
    }
}

/// Elevated half of "Turn on WSL 1 support": runs DISM and wsl --install as admin, writing exit codes to $Log.
pub fn enable_wsl_elevated_script() -> String {
    [
        "param([string]$Log)",
        "$ErrorActionPreference = \"Continue\"",
        "function Note($t) { $t | Out-File -LiteralPath $Log -Append -Encoding utf8 }",
        "\"apim-enable-wsl\" | Out-File -LiteralPath $Log -Encoding utf8",
        "Note \"== dism: enable Microsoft-Windows-Subsystem-Linux\"",
        "$global:LASTEXITCODE = -1",
        "$out = & dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart 2>&1",
        "Note ($out | Out-String)",
        "Note (\"dism-exit=\" + $LASTEXITCODE)",
        "Note \"== wsl --install --no-distribution\"",
        "$global:LASTEXITCODE = -1",
        "$w = & wsl.exe --install --no-distribution 2>&1",
        "Note (($w | Out-String) -replace \"`0\", \"\")",
        "Note (\"wsl-exit=\" + $LASTEXITCODE)",
        "",
    ]
    .join("\r\n")
}

/// Unelevated launcher: asks Windows for administrator rights and waits.
pub fn enable_wsl_launcher_script() -> String {
    [
        "param([string]$Inner, [string]$Log)",
        "$ErrorActionPreference = \"Stop\"",
        "$argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('\"' + $Inner + '\"'), '-Log', ('\"' + $Log + '\"'))",
        "try {",
        "  Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList $argList",
        "} catch {",
        "  Write-Output \"apim-uac-declined\"",
        "  exit 1223",
        "}",
        "",
    ]
    .join("\r\n")
}

/// Did WSL 2 fail because this PC cannot run its VM at all? Then WSL 1 is the way forward.
pub fn wsl2_cannot_run_here(output: &str) -> Option<&'static str> {
    let t = output.to_lowercase();
    if t.contains("0xc03a0014") || t.contains("virtual disk support provider") {
        return Some("virtual-disk");
    }
    let hcs_word = t.match_indices("hcs_e_").any(|(i, _)| i == 0 || !t.as_bytes()[i - 1].is_ascii_alphanumeric() && t.as_bytes()[i - 1] != b'_');
    if t.contains("0x8007273f") || t.contains("address incompatible with the requested protocol") || t.contains("0x80370102") || t.contains("0x80370114") || t.contains("/createvm/") || hcs_word || t.contains("hcs/") || t.contains("required feature is not installed") {
        return Some("vm");
    }
    None
}

/// Where the sandbox keeps its disk: APIM_SANDBOX_DIR, else %LOCALAPPDATA%\apiM\sandbox on Windows, else <data>\sandbox.
pub fn sandbox_base_dir(apim_sandbox_dir: Option<&str>, localappdata: Option<&str>, windows: bool, data_dir: &Path) -> PathBuf {
    if let Some(d) = apim_sandbox_dir.map(str::trim).filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    if let Some(lad) = localappdata.map(str::trim).filter(|d| !d.is_empty()) {
        if windows {
            return PathBuf::from(format!("{}\\apiM\\sandbox", lad.replace('/', "\\").trim_end_matches('\\')));
        }
    }
    data_dir.join("sandbox")
}

/// Mount and display helpers shared with run.rs live here so tests can reach them.
pub fn sandbox_env(display: &str, extra: &[(String, String)]) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = vec![
        ("DISPLAY".into(), display.into()),
        ("HOME".into(), "/root".into()),
        ("NO_COLOR".into(), "1".into()),
        ("PYTHONUNBUFFERED".into(), "1".into()),
        ("DEBIAN_FRONTEND".into(), "noninteractive".into()),
    ];
    for (k, v) in extra {
        match env.iter_mut().find(|(ek, _)| ek == k) {
            Some(slot) => slot.1 = v.clone(),
            None => env.push((k.clone(), v.clone())),
        }
    }
    env
}

/// Builds the argv that runs `script` inside the sandbox for one chat, mounted at its per-chat point.
pub fn wrap_for_sandbox(distro: &str, display: &str, workspace_id: &str, workspace_win_dir: &str, script: &str, extra_env: &[(String, String)]) -> (WslInvocation, Option<String>) {
    let mount = sandbox_mount_point(workspace_id);
    let (arg, stdin) = encode_sandbox_script(script);
    let inv = build_invocation(
        Some(distro),
        Some("root"),
        Some(LINUX_CWD),
        &sandbox_env(display, extra_env),
        "bash",
        &["-c".into(), SANDBOX_RUNNER.into(), SANDBOX_DISTRO.into(), arg, mount, workspace_win_dir.into()],
    );
    (inv, stdin)
}

/// Bash that prints the sandbox display as base64 PNG on stdout, cropped to the visible windows.
pub const SANDBOX_CAPTURE_SCRIPT: &str = r#"wait_s="${APIM_SHOT_WAIT:-5}"; full="${APIM_SHOT_FULL:-0}"
box=""
if [ "$full" != 1 ] && command -v xdotool >/dev/null; then
  end=$(( $(date +%s) + wait_s ))
  while :; do
    box=$(for id in $(xdotool search --onlyvisible --maxdepth 1 . 2>/dev/null); do
        xdotool getwindowgeometry --shell "$id" 2>/dev/null
      done | awk -F= '
        /^X=/ { x = $2 } /^Y=/ { y = $2 } /^WIDTH=/ { w = $2 }
        /^HEIGHT=/ { h = $2
          if (w > 1 && h > 1) {
            if (!n || x < x0) x0 = x; if (!n || y < y0) y0 = y
            if (!n || x + w > x1) x1 = x + w; if (!n || y + h > y1) y1 = y + h
            n++
          } }
        END { if (n) { if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0
          printf "%dx%d+%d+%d", x1 - x0, y1 - y0, x0, y0 } }')
    if [ -n "$box" ] || [ "$(date +%s)" -ge "$end" ]; then break; fi
    sleep 0.3
  done
fi
if [ -n "$box" ]; then
  echo "[sandbox] cropped to the visible window(s), $box of the screen. full_screen:true captures everything." >&2
  import -display "$DISPLAY" -window root -crop "$box" +repage png:- | base64 -w0
else
  [ "$full" = 1 ] || echo "[sandbox] no window is visible on $DISPLAY after ${wait_s}s, so this is the whole, empty screen. Check the program is still running (read_process) and did not change DISPLAY." >&2
  import -display "$DISPLAY" -window root png:- | base64 -w0
fi"#;

/// The capture invocation for the sandbox display, waiting 0-30 s for a window.
pub fn capture_invocation(distro: &str, display: &str, workspace_id: &str, workspace_win_dir: &str, full_screen: bool, wait_seconds: Option<f64>) -> (WslInvocation, Option<String>) {
    let wait = wait_seconds.unwrap_or(5.0).round().clamp(0.0, 30.0) as u32;
    let extra = vec![
        ("APIM_SHOT_WAIT".to_string(), wait.to_string()),
        ("APIM_SHOT_FULL".to_string(), if full_screen { "1" } else { "0" }.to_string()),
    ];
    wrap_for_sandbox(distro, display, workspace_id, workspace_win_dir, SANDBOX_CAPTURE_SCRIPT, &extra)
}

/// What the end-of-setup self-check runs inside the sandbox.
pub fn self_check_script() -> String {
    [
        "echo \"check-folder: $(cat apim-selfcheck.txt 2>/dev/null || echo MISSING)\"",
        "echo written > from-sandbox.txt",
        "echo \"check-python: $(python3 --version 2>&1 | head -1)\"",
        "echo \"check-node: $(node --version 2>&1 | head -1)\"",
        "echo \"check-display: $(xdpyinfo -display \"$DISPLAY\" >/dev/null 2>&1 && echo ok || echo none)\"",
    ]
    .join("\n")
}

/// The value after `check-<key>: ` on its own line, trimmed, or "".
fn check_field(text: &str, key: &str) -> String {
    let prefix = format!("check-{key}: ");
    text.split(is_line_end).find_map(|line| line.strip_prefix(prefix.as_str())).map_or(String::new(), |v| v.trim().to_string())
}

/// Turns the self-check output into one line per thing checked. Returns (folder ok, lines).
pub fn interpret_self_check(output: &str, wrote_back: bool) -> (bool, Vec<String>) {
    let seen = check_field(output, "folder") == SELF_CHECK_MARKER;
    let folder = seen && wrote_back;
    let mount_note = output
        .split('\n')
        .find(|l| l.starts_with("[sandbox] the chat folder could not be mounted"))
        .map(|l| l.to_string());
    let mut lines = vec![if folder {
        "OK  the sandbox sees the chat folder and its files reach Windows".to_string()
    } else if seen {
        "!!  the sandbox can read the chat folder but what it writes does not reach Windows".to_string()
    } else {
        match mount_note {
            Some(n) => format!("!!  the sandbox cannot see the chat folder, so the agent works on copies in /root/work\n    {n}"),
            None => "!!  the sandbox cannot see the chat folder, so the agent works on copies in /root/work".to_string(),
        }
    }];
    let py = check_field(output, "python");
    lines.push(if py.starts_with("Python 3") { format!("OK  {py}") } else { format!("!!  python3: {}", if py.is_empty() { "no answer" } else { &py }) });
    let node = check_field(output, "node");
    let node_ok = node.starts_with('v') && node[1..].chars().next().is_some_and(|c| c.is_ascii_digit());
    lines.push(if node_ok {
        format!("OK  node {node}")
    } else if node.to_lowercase().contains("exec format error") {
        format!("!!  node fails with \"Exec format error\": the node it finds is not a Linux program ({node})")
    } else {
        format!("!!  node: {}", if node.is_empty() { "no answer" } else { &node })
    });
    lines.push(if check_field(output, "display") == "ok" { "OK  the off-screen display is up".into() } else { "!!  the off-screen display did not start".into() });
    if !output.lines().any(|l| l.starts_with("check-folder:")) {
        let head: Vec<u16> = output.trim().encode_utf16().take(300).collect();
        let shown = String::from_utf16_lossy(&head);
        lines.insert(0, format!("!!  the check itself did not run: {}", if shown.is_empty() { "no output" } else { &shown }));
    }
    (folder, lines)
}

/// The PNG inside a capture's stdout, or None. Lenient base64 like Node's: skips whitespace and non-alphabet bytes.
pub fn decode_capture(stdout: &str) -> Option<Vec<u8>> {
    let mut bits: u32 = 0;
    let mut n = 0;
    let mut out = Vec::new();
    for c in stdout.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = (bits << 6) | v as u32;
        n += 1;
        if n == 4 {
            out.extend([(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]);
            bits = 0;
            n = 0;
        }
    }
    match n {
        2 => out.push((bits >> 4) as u8),
        3 => {
            out.extend([(bits >> 10) as u8, (bits >> 2) as u8]);
        }
        _ => {}
    }
    const MAGIC: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    (out.len() > 8 && out[..8] == MAGIC).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16le(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    #[test]
    fn decodes_utf16_with_and_without_bom() {
        let text = "  NAME   STATE   VERSION\r\n* wsltest  Stopped  1\r\n";
        let mut bom = vec![0xff, 0xfe];
        bom.extend(utf16le(text));
        assert_eq!(decode_wsl_output(&bom), text);
        assert_eq!(decode_wsl_output(&utf16le(text)), text);
        assert_eq!(decode_wsl_output(b"plain text here"), "plain text here");
    }

    #[test]
    fn parses_the_table_on_this_machine() {
        let rows = parse_wsl_distros("  NAME            STATE           VERSION\r\n* wsltest         Stopped         1\r\n  apim-sandbox    Stopped         1\r\n");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], WslDistro { name: "wsltest".into(), state: "Stopped".into(), version: 1.0, is_default: true });
        assert!(!rows[1].is_default);
        assert_eq!(rows[1].name, "apim-sandbox");
    }

    #[test]
    fn distro_names_may_contain_spaces_and_bad_rows_are_skipped() {
        let rows = parse_wsl_distros("H\n  My Distro  Running  2\n  broken row\n  X  Running  two\n");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "My Distro");
        assert_eq!(rows[0].version, 2.0);
        assert!(parse_wsl_distros("only header").is_empty());
    }

    #[test]
    fn windows_paths_become_mnt_paths() {
        assert_eq!(win_path_to_wsl(r"C:\Users\me\ws"), "/mnt/c/Users/me/ws");
        assert_eq!(win_path_to_wsl("D:/data/"), "/mnt/d/data");
        assert_eq!(win_path_to_wsl("C:\\"), "/mnt/c");
        assert_eq!(win_path_to_wsl(r"\\wsl$\Ubuntu\home\x"), "/home/x");
        assert_eq!(win_path_to_wsl(r"\\WSL.localhost\Ubuntu"), "/");
        assert_eq!(win_path_to_wsl("/already/posix"), "/already/posix");
        assert_eq!(win_path_to_wsl(r"sub\dir"), "sub/dir");
        assert_eq!(win_path_to_wsl("  "), "");
    }

    #[test]
    fn hostile_paths_do_not_escape_or_break_out() {
        // A line break in the path makes the drive and UNC forms fail, so the relative form is returned.
        assert_eq!(win_path_to_wsl("C:\\a\nb"), "C:/a\nb");
        assert_eq!(win_path_to_wsl("\\\\wsl$\\Ubuntu\\x\ny"), "\\\\wsl$\\Ubuntu\\x\ny".replace('\\', "/"));
        // Drive-relative and UNC shares are not mapped to /mnt.
        assert_eq!(win_path_to_wsl("C:evil"), "C:evil");
        assert_eq!(win_path_to_wsl(r"\\server\share\x"), "//server/share/x");
    }

    #[test]
    fn quoting_keeps_hostile_tokens_inert() {
        assert_eq!(sh_quote("abc-1_2./:=@%+,"), "abc-1_2./:=@%+,");
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote("$(rm -rf /)"), "'$(rm -rf /)'");
        assert_eq!(sh_quote("`id`"), "'`id`'");
        assert_eq!(sh_quote("a\nb"), "'a\nb'");
        assert_eq!(sh_quote("..\\x"), "'..\\x'");
    }

    #[test]
    fn mount_point_is_one_safe_directory_per_chat() {
        assert_eq!(sandbox_mount_point("chat-1_a"), "/ws/chat-1_a");
        assert_eq!(sandbox_mount_point("../../etc"), "/ws/______etc");
        assert_eq!(sandbox_mount_point("a/b c"), "/ws/a_b_c");
        // A non-BMP character is two UTF-16 units, so two underscores, as in the web.
        assert_eq!(sandbox_mount_point("x😀"), "/ws/x__");
    }

    #[test]
    fn invocation_has_the_web_shape() {
        let inv = build_invocation(Some("apim-sandbox"), Some("root"), Some("/root"), &[("DISPLAY".into(), ":57".into())], "bash", &["-c".into(), "echo hi".into()]);
        assert_eq!(inv.command, "wsl.exe");
        assert_eq!(inv.args, ["-d", "apim-sandbox", "-u", "root", "--cd", "/root", "--exec", "env", "DISPLAY=:57", "bash", "-c", "echo hi"]);
        let bare = build_invocation(None, None, None, &[], "ls", &[]);
        assert_eq!(bare.args, ["--exec", "ls"]);
    }

    #[test]
    fn sha256sums_lookup() {
        let h = "a".repeat(64);
        let sums = format!("{h}  other.tar\n{}  *{ROOTFS_FILE}\n", "B".repeat(64));
        assert_eq!(expected_sha256(&sums, ROOTFS_FILE), Some("b".repeat(64)));
        assert_eq!(expected_sha256(&sums, "missing"), None);
        assert_eq!(expected_sha256("short  file", "file"), None);
    }

    #[test]
    fn script_encoding_switches_to_stdin_when_long() {
        let (arg, stdin) = encode_sandbox_script("echo hi");
        assert_eq!(arg, "ZWNobyBoaQ==");
        assert!(stdin.is_none());
        let long = "x".repeat(20_000);
        let (arg, stdin) = encode_sandbox_script(&long);
        assert_eq!(arg, "-");
        assert_eq!(stdin.as_deref(), Some(long.as_str()));
    }

    #[test]
    fn display_and_capture_defaults() {
        assert_eq!(pick_display(&[]), ":57");
        assert_eq!(pick_display(&[57, 58]), ":59");
        assert_eq!(pick_display(&(57..90).collect::<Vec<_>>()), ":89");
        let (inv, _) = capture_invocation("apim-sandbox", ":57", "c1", "C:\\w", false, Some(99.0));
        let env_at = inv.args.iter().position(|a| a == "env").unwrap();
        assert!(inv.args.contains(&"APIM_SHOT_WAIT=30".to_string()));
        assert!(inv.args.contains(&"APIM_SHOT_FULL=0".to_string()));
        assert!(env_at > 0);
    }

    #[test]
    fn self_check_reads_the_marker_and_the_tools() {
        let out = format!("check-folder: {SELF_CHECK_MARKER}\ncheck-python: Python 3.12.3\ncheck-node: v22.1.0\ncheck-display: ok\n");
        let (folder, lines) = interpret_self_check(&out, true);
        assert!(folder);
        assert_eq!(lines[0], "OK  the sandbox sees the chat folder and its files reach Windows");
        assert_eq!(lines[1], "OK  Python 3.12.3");
        assert_eq!(lines[2], "OK  node v22.1.0");
        assert_eq!(lines[3], "OK  the off-screen display is up");
        let (folder, lines) = interpret_self_check(&out, false);
        assert!(!folder);
        assert!(lines[0].starts_with("!!  the sandbox can read"));
    }

    #[test]
    fn self_check_names_missing_pieces() {
        let out = "[sandbox] the chat folder could not be mounted at /ws/x: nope\ncheck-folder: MISSING\ncheck-python: \ncheck-node: bash: node: Exec format error\ncheck-display: none\n";
        let (folder, lines) = interpret_self_check(out, false);
        assert!(!folder);
        assert!(lines[0].contains("cannot see the chat folder"));
        assert!(lines[0].ends_with("[sandbox] the chat folder could not be mounted at /ws/x: nope"));
        assert_eq!(lines[1], "!!  python3: no answer");
        assert!(lines[2].starts_with("!!  node fails with \"Exec format error\""));
        assert_eq!(lines[3], "!!  the off-screen display did not start");
        let (_, lines) = interpret_self_check("garbage", false);
        assert_eq!(lines[0], "!!  the check itself did not run: garbage");
    }

    #[test]
    fn capture_decodes_only_real_pngs() {
        let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
        let b64 = base64_encode(&png);
        assert_eq!(decode_capture(&b64), Some(png.to_vec()));
        assert_eq!(decode_capture(&format!("  {b64}\n")), Some(png.to_vec()));
        assert_eq!(decode_capture(&base64_encode(b"not a png at all")), None);
        assert_eq!(decode_capture(""), None);
    }

    #[test]
    fn wsl_errors_get_their_plain_words() {
        assert!(explain_wsl_error("Error code: Wsl/Service/RegisterDistro/0xc03a0014").unwrap().starts_with("Windows could not create a virtual disk."));
        assert!(explain_wsl_error("WSL1_NOT_SUPPORTED").unwrap().starts_with("WSL 1 is switched off"));
        assert!(explain_wsl_error("Wsl 1 is not supported").is_some());
        assert!(explain_wsl_error("0xd0000034").unwrap().contains("Plan 9 redirector"));
        assert!(explain_wsl_error("0x80370102").unwrap().starts_with("Virtualization is not available"));
        assert_eq!(explain_wsl_error("0x80070070"), Some("The drive is out of space. The sandbox needs about 4 GB free."));
        assert_eq!(explain_wsl_error("nothing known"), None);
    }

    #[test]
    fn exit_codes_print_like_the_web() {
        assert_eq!(format_exit_code(None), "no exit code");
        assert_eq!(format_exit_code(Some(0)), "0");
        assert_eq!(format_exit_code(Some(1)), "1");
        assert_eq!(format_exit_code(Some(4294967295)), "-1");
        assert_eq!(format_exit_code(Some(3221226505)), "-1073740791 (0xc0000409)");
        assert_eq!(exit_code_of(Some(-1)), Some(4294967295));
    }

    #[test]
    fn vhd_findings_match_the_web() {
        let files = [("FsDepends.sys", true), ("vhdmp.sys", false), ("vdrvroot.sys", true)];
        let services = [("FsDepends", "FAILED 1060:"), ("vhdmp", "START_TYPE : 3  DEMAND_START"), ("vdrvroot", "START_TYPE : 4  DISABLED"), ("vmcompute", "START_TYPE : 3")];
        let f = diagnose_vhd_stack(&files, &services);
        let problems: Vec<&str> = f.iter().map(|x| x.problem.as_str()).collect();
        assert_eq!(problems, [
            r"the driver file C:\Windows\System32\drivers\vhdmp.sys is missing",
            "FsDepends is not registered with Windows",
            "vdrvroot is DISABLED",
        ]);
        assert_eq!(f[2].fix, "as administrator: sc.exe config vdrvroot start= boot then restart (boot is the Windows default)");
        let text = format_vhd_findings(&f);
        assert!(text.ends_with(&windows_repair_advice()));
        assert!(format_vhd_findings(&[]).starts_with("The virtual-disk drivers all look registered"));
    }

    #[test]
    fn wsl1_states() {
        let p = Wsl1Probe { reboot_pending: false, files: vec![("rdbss.sys".into(), true), ("p9rdr.sys".into(), true)], services: vec![("Rdbss".into(), "FAILED 1060:".into()), ("P9Rdr".into(), "START_TYPE : 3".into())] };
        let (state, msg) = diagnose_wsl1(&p);
        assert_eq!(state, Wsl1State::RedirectorUnregistered);
        assert!(msg.contains(&format!("{RDBSS_REPAIR_COMMAND}")));
        assert!(msg.ends_with("(Undo: sc.exe delete Rdbss)"));
        let off = Wsl1Probe { reboot_pending: false, files: vec![("lxcore.sys".into(), false)], services: vec![] };
        assert_eq!(diagnose_wsl1(&off).0, Wsl1State::FeatureOff);
        let pending = Wsl1Probe { reboot_pending: true, files: vec![("lxcore.sys".into(), true)], services: vec![] };
        assert_eq!(diagnose_wsl1(&pending).0, Wsl1State::RebootPending);
    }

    #[test]
    fn dism_exit_codes() {
        assert_eq!(parse_dism_exit("log\ndism-exit=3010\n"), Some(3010));
        assert_eq!(parse_dism_exit("dism-exit=-1"), Some(-1));
        assert_eq!(parse_dism_exit("nothing"), None);
        assert!(explain_dism_exit(Some(3010)).restart);
        assert!(explain_dism_exit(Some(0)).ok);
        assert_eq!(explain_dism_exit(None).message, "The administrator prompt was declined or closed, so nothing changed.");
        assert!(explain_dism_exit(Some(0x800f081f)).message.contains("0x800f081f"));
        assert_eq!(explain_dism_exit(Some(5)).message, "DISM failed (exit 5); see the log above.");
    }

    #[test]
    fn install_dir_problems() {
        let info = InstallDirInfo { fs: "FAT32".into(), drive_type: "Removable".into(), free_gb: 2.5, compressed: true, encrypted: false };
        let v = assess_install_dir("E:\\x\\apiM\\distro", &info, &["C:\\Users\\me\\OneDrive".into()]);
        assert!(v.fix_compression && !v.fix_encryption);
        assert_eq!(v.problems.len(), 3);
        assert!(v.problems[0].starts_with("E:\\x\\apiM\\distro is on a FAT32 drive."));
        assert_eq!(v.problems[1], "E:\\x\\apiM\\distro is on a removable drive. Use a local fixed drive.");
        assert_eq!(v.problems[2], "Only 2.5 GB free on that drive; the sandbox needs about 4 GB.");
        let inside = InstallDirInfo { fs: "NTFS".into(), drive_type: "Fixed".into(), free_gb: 50.0, compressed: false, encrypted: false };
        let v = assess_install_dir("c:\\users\\me\\onedrive\\apim", &inside, &["C:\\Users\\me\\OneDrive\\".into()]);
        assert_eq!(v.problems, ["c:\\users\\me\\onedrive\\apim is inside OneDrive (c:\\users\\me\\onedrive). OneDrive cannot hold a WSL disk; set APIM_SANDBOX_DIR to a folder outside it."]);
    }

    #[test]
    fn sandbox_dir_defaults() {
        let data = Path::new("/d");
        assert_eq!(sandbox_base_dir(Some(" /x "), Some("C:\\L"), true, data), PathBuf::from("/x"));
        assert_eq!(sandbox_base_dir(None, Some("C:\\L\\"), true, data), PathBuf::from("C:\\L\\apiM\\sandbox"));
        assert_eq!(sandbox_base_dir(None, None, false, data), data.join("sandbox"));
    }

    #[test]
    fn scripts_are_ascii_and_crlf() {
        for s in [install_dir_probe_script(), enable_wsl_elevated_script(), enable_wsl_launcher_script()] {
            assert!(s.is_ascii());
            assert!(s.contains("\r\n") && !s.replace("\r\n", "").contains('\n'));
        }
        assert!(SANDBOX_RUNNER.contains("bash -l \"$f\"; s=$?"));
        assert!(SANDBOX_RUNNER.contains(r#"rest="${rest//\\//}""#));
    }

    #[test]
    fn setup_script_lists_every_package() {
        let s = wsl_setup_script();
        assert!(s.starts_with("set -e\n"));
        assert!(s.contains("--no-install-recommends xvfb x11-utils xdotool imagemagick"));
        assert!(s.ends_with("echo \"apim-wsl-setup-ok\""));
        assert_eq!(sandbox_wsl_conf().lines().last(), Some("default = root"));
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// Numbers compared as f64, so the web's 1 and the port's 1.0 are the same value.
    fn normalise(v: serde_json::Value) -> serde_json::Value {
        use serde_json::Value;
        match v {
            Value::Number(n) => serde_json::json!(n.as_f64()),
            Value::Array(a) => Value::Array(a.into_iter().map(normalise).collect()),
            Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, normalise(v))).collect()),
            other => other,
        }
    }

    /// Replays every pair in fixtures.json (the web's outputs, dumped by parity/dump.ts) through the port.
    #[test]
    fn replays_the_web_fixtures() {
        use serde_json::{Value, json};
        let fixtures: serde_json::Map<String, Value> = serde_json::from_str(include_str!("fixtures.json")).unwrap();
        let s = |v: &Value| v.as_str().unwrap_or_default().to_string();
        let strs = |v: &Value| -> Vec<String> { v.as_array().map(|a| a.iter().map(s).collect()).unwrap_or_default() };
        let mut checked = 0;
        for (name, cases) in &fixtures {
            for case in cases.as_array().unwrap() {
                let (input, want) = (&case[0], &case[1]);
                let got: Value = match name.as_str() {
                    "decodeWslOutput" => json!(decode_wsl_output(&unhex(input.as_str().unwrap()))),
                    "parseWslDistros" => serde_json::to_value(parse_wsl_distros(input.as_str().unwrap())).unwrap(),
                    "winPathToWsl" => json!(win_path_to_wsl(input.as_str().unwrap())),
                    "shQuote" => json!(sh_quote(input.as_str().unwrap())),
                    "buildWslInvocation" => {
                        let env: Vec<(String, String)> = input["env"].as_array().unwrap().iter().map(|p| (s(&p[0]), s(&p[1]))).collect();
                        let args = strs(&input["args"]);
                        let inv = build_invocation(input["distro"].as_str(), input["user"].as_str(), input["cwdWsl"].as_str(), &env, input["command"].as_str().unwrap(), &args);
                        json!({"command": inv.command, "args": inv.args})
                    }
                    "sandboxMountPoint" => json!(sandbox_mount_point(input.as_str().unwrap())),
                    "encodeSandboxScript" => {
                        let (arg, stdin) = encode_sandbox_script(input.as_str().unwrap());
                        json!({"arg": arg, "stdinLen": stdin.map(|t| t.len())})
                    }
                    "pickDisplay" => {
                        let used: Vec<u32> = input.as_array().unwrap().iter().map(|n| n.as_u64().unwrap() as u32).collect();
                        json!(pick_display(&used))
                    }
                    "expectedSha256" => json!(expected_sha256(input[0].as_str().unwrap(), input[1].as_str().unwrap())),
                    "importArgs" => json!(import_args(input[0].as_str().unwrap(), input[1].as_str().unwrap(), input[2].as_u64().unwrap() as u8)),
                    "sandboxWslConf" => json!(sandbox_wsl_conf()),
                    "wslSetupScript" => json!(wsl_setup_script()),
                    "sandboxRunner" => json!(SANDBOX_RUNNER),
                    "captureScript" => json!(SANDBOX_CAPTURE_SCRIPT),
                    "selfCheckScript" => json!(self_check_script()),
                    "interpretSelfCheck" => {
                        let (folder, lines) = interpret_self_check(input[0].as_str().unwrap(), input[1].as_bool().unwrap());
                        json!({"folder": folder, "lines": lines})
                    }
                    "decodeCapture" => json!(decode_capture(input.as_str().unwrap()).map(|b| base64_encode(&b))),
                    "sandboxBaseDir" => {
                        let env = &input[0];
                        json!(sandbox_base_dir(env["APIM_SANDBOX_DIR"].as_str(), env["LOCALAPPDATA"].as_str(), true, Path::new(input[1].as_str().unwrap())).to_string_lossy())
                    }
                    "formatExitCode" => json!(format_exit_code(input.as_i64())),
                    "explainWslError" => json!(explain_wsl_error(input.as_str().unwrap())),
                    "assessInstallDir" => {
                        let i = &input[1];
                        let info = InstallDirInfo {
                            fs: s(&i["fs"]),
                            drive_type: s(&i["driveType"]),
                            free_gb: i["freeGB"].as_f64().unwrap(),
                            compressed: i["compressed"].as_bool().unwrap(),
                            encrypted: i["encrypted"].as_bool().unwrap(),
                        };
                        let v = assess_install_dir(input[0].as_str().unwrap(), &info, &strs(&input[2]));
                        json!({"fixCompression": v.fix_compression, "fixEncryption": v.fix_encryption, "problems": v.problems})
                    }
                    "installDirProbeScript" => json!(install_dir_probe_script()),
                    "parseScQc" => {
                        let (exists, start) = parse_sc_qc(input.as_str().unwrap());
                        json!({"exists": exists, "startType": start})
                    }
                    "parseScQuery" => json!({"state": parse_sc_query(input.as_str().unwrap())}),
                    "diagnoseVhdStack" => {
                        let files_owned: Vec<(String, bool)> = input["files"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_bool().unwrap())).collect();
                        let files: Vec<(&str, bool)> = files_owned.iter().map(|(k, v)| (k.as_str(), *v)).collect();
                        let svc_owned: Vec<(String, String)> = input["services"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), s(&v["qc"]))).collect();
                        let services: Vec<(&str, &str)> = svc_owned.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
                        let findings = diagnose_vhd_stack(&files, &services);
                        json!(findings.iter().map(|f| json!({"component": f.component, "problem": f.problem, "fix": f.fix})).collect::<Vec<_>>())
                    }
                    "diagnoseWsl1" => {
                        let probe = Wsl1Probe {
                            reboot_pending: input["rebootPending"].as_bool().unwrap(),
                            files: input["files"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_bool().unwrap())).collect(),
                            services: input["services"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), s(v))).collect(),
                        };
                        let (state, message) = diagnose_wsl1(&probe);
                        json!({"state": state, "message": message})
                    }
                    "parseDismExit" => json!(parse_dism_exit(input.as_str().unwrap())),
                    "explainDismExit" => {
                        let d = explain_dism_exit(input.as_i64());
                        json!({"ok": d.ok, "restart": d.restart, "message": d.message})
                    }
                    "wsl2CannotRunHere" => json!(wsl2_cannot_run_here(input.as_str().unwrap())),
                    "enableWslElevatedScript" => json!(enable_wsl_elevated_script()),
                    "enableWslLauncherScript" => json!(enable_wsl_launcher_script()),
                    "formatVhdFindings" => {
                        let findings: Vec<VhdFinding> = input.as_array().unwrap().iter().map(|f| VhdFinding { component: s(&f["component"]), problem: s(&f["problem"]), fix: s(&f["fix"]) }).collect();
                        json!(format_vhd_findings(&findings))
                    }
                    "windowsRepairAdvice" => json!(windows_repair_advice()),
                    other => panic!("no port for fixture {other}"),
                };
                assert_eq!(normalise(got), normalise(want.clone()), "{name} differs for input {input}");
                checked += 1;
            }
        }
        assert_eq!(fixtures.len(), 33);
        assert!(checked > 150, "only {checked} pairs replayed");
    }

    #[test]
    fn choose_distro_needs_our_distro() {
        let mut st = WslStatus { installed: true, distros: vec![], default_distro: None, reason: None };
        assert_eq!(choose_distro(&st), Err(("The sandbox is not set up yet. Open Settings -> Sandbox (or type /sandbox) and click Set up.".into(), true)));
        st.distros.push(WslDistro { name: SANDBOX_DISTRO.into(), state: "Stopped".into(), version: 1.0, is_default: false });
        assert_eq!(choose_distro(&st), Ok(SANDBOX_DISTRO.to_string()));
        let off = WslStatus { installed: false, reason: Some("off".into()), ..Default::default() };
        assert_eq!(choose_distro(&off), Err(("off".into(), false)));
    }
}
