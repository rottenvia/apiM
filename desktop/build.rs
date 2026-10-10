//! Gives the Windows program its icon. `assets/apim.res` holds `assets/apim.ico`, compiled once
//! with `rc /fo apim.res apim.rc` (see `assets/make-icon.py`); the MSVC linker takes a .res file
//! as it is, so building needs no resource compiler.

fn main() {
    // When this build was made, shown at the foot of Settings: a pinned shortcut or a window left open may be an older
    // one. Taken again whenever a source file changes, so the same time means the same program.
    println!("cargo:rerun-if-changed=assets");
    println!("cargo:rerun-if-changed=src");
    let said = |program: &str, args: &[&str]| std::process::Command::new(program).args(args).output().ok().filter(|out| out.status.success()).map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|time| !time.is_empty());
    let built = said("powershell", &["-NoProfile", "-Command", "Get-Date -Format 'yyyy-MM-dd HH:mm'"]).or_else(|| said("date", &["+%Y-%m-%d %H:%M"])).unwrap_or_default();
    println!("cargo:rustc-env=APIM_BUILT={built}");
    let target = |name: &str| std::env::var(name).unwrap_or_default();
    if target("CARGO_CFG_TARGET_OS") == "windows" && target("CARGO_CFG_TARGET_ENV") == "msvc" {
        println!("cargo:rustc-link-arg-bins={}/assets/apim.res", target("CARGO_MANIFEST_DIR"));
    }
}
