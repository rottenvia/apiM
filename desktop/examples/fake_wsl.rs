// Stand-in for wsl.exe in the sandbox tests: answers the argv shapes `src/sandbox` produces. Built by `cargo test` only.
use base64::Engine;
use std::io::{Read, Write};

fn table() -> Vec<u8> {
    let text = "  NAME            STATE           VERSION\r\n* wsltest         Stopped         1\r\n  apim-sandbox    Stopped         1\r\n";
    let mut b = vec![0xff, 0xfe];
    for u in text.encode_utf16() {
        b.extend(u.to_le_bytes());
    }
    b
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let has = |s: &str| args.iter().any(|a| a == s);
    if has("--list") {
        std::io::stdout().write_all(&table()).unwrap();
        return;
    }
    if has("--status") {
        println!("WSL2 is unable to start since virtualisation is not enabled on this machine.");
        std::process::exit(1);
    }
    if has("--import") || has("--set-version") || has("--terminate") || has("--unregister") || has("pkill") || has("Xvfb") {
        return;
    }
    if args.iter().any(|a| a.contains("apt-get")) {
        println!("apim-wsl-setup-ok");
        return;
    }
    if has("sh") {
        let mut s = String::new();
        let _ = std::io::stdin().read_to_string(&mut s);
        return;
    }
    let n = args.len();
    if n < 3 {
        std::process::exit(2);
    }
    let (arg, win) = (args[n - 3].clone(), args[n - 1].clone());
    let script = if arg == "-" {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).unwrap();
        s
    } else {
        String::from_utf8(base64::engine::general_purpose::STANDARD.decode(&arg).unwrap()).unwrap()
    };
    if script.contains("SLEEP") {
        std::thread::sleep(std::time::Duration::from_secs(30));
    } else if script.contains("CANNOT") {
        eprintln!("Wsl/Service/CreateInstance/0xd0000034");
        std::process::exit(1);
    } else if script.contains("FAIL") {
        println!("boom");
        std::process::exit(3);
    } else if script.contains("BIG") {
        println!("{}", "x".repeat(30_000));
    } else if script.contains("from-sandbox.txt") {
        std::fs::write(std::path::Path::new(&win).join("from-sandbox.txt"), "written").unwrap();
        println!("check-folder: apim-selfcheck-7f3a\ncheck-python: Python 3.12.3\ncheck-node: v22.1.0\ncheck-display: ok");
    } else if script.contains("import -display") {
        eprintln!("[sandbox] cropped to the visible window(s), 300x200+0+0 of the screen. full_screen:true captures everything.");
        let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
        println!("{}", base64::engine::general_purpose::STANDARD.encode(png));
    } else {
        println!("hello from fake");
    }
}
