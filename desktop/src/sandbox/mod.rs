//! Native port of the web WSL sandbox: wsl.rs (wsl.ts), setup.rs (sandbox-setup.ts), run.rs (sandbox-run.ts).
pub mod run;
pub mod setup;
pub mod wsl;

/// Test-only: a fake wsl.exe (`examples/fake_wsl.rs`, which `cargo test` builds; APIM_FAKE_WSL overrides), so no test ever runs the real one.
#[cfg(test)]
pub fn fake_wsl() -> std::path::PathBuf {
    let built = || std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().join("examples").join(format!("fake_wsl{}", std::env::consts::EXE_SUFFIX));
    std::env::var_os("APIM_FAKE_WSL").map_or_else(built, Into::into)
}

/// Test-only: the sandbox state is process-wide, so tests that touch it take this in turn.
#[cfg(test)]
pub fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}
