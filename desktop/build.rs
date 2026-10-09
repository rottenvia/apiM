//! Gives the Windows program its icon. `assets/apim.res` holds `assets/apim.ico`, compiled once
//! with `rc /fo apim.res apim.rc` (see `assets/make-icon.py`); the MSVC linker takes a .res file
//! as it is, so building needs no resource compiler.

fn main() {
    println!("cargo:rerun-if-changed=assets/apim.res");
    let target = |name: &str| std::env::var(name).unwrap_or_default();
    if target("CARGO_CFG_TARGET_OS") == "windows" && target("CARGO_CFG_TARGET_ENV") == "msvc" {
        println!("cargo:rustc-link-arg-bins={}/assets/apim.res", target("CARGO_MANIFEST_DIR"));
    }
}
