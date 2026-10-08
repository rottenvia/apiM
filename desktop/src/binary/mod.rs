//! Static executable analysis: a port of the web app's binaries.ts, binary-artifacts.ts, binary-decompiler.ts,
//! binary-ledger.ts and binary-types.ts. Reads bytes only; the target is never run.
//! The tools that use it are in `tools/binary.rs`; the ledger text for the system prompt comes from
//! `ledger::{read_binary_ledger, format_binary_ledger_for_prompt, replace_binary_ledger}`.

// The ledger prompt block and the upload helpers are not called until the prompt builder and the upload UI use them.
#![allow(dead_code)]

pub mod artifacts;
pub mod decompiler;
pub mod formats;
pub mod ledger;
pub mod pe;
pub mod types;

/// Tiny hand-assembled binaries shared by the tests (and by the recorded TypeScript outputs in fixtures.json).
#[cfg(test)]
pub(crate) mod fixtures {
    use super::pe::samples::{noise, pe32_managed, pe64};

    fn with_tail(mut head: Vec<u8>, tail: &[u8]) -> Vec<u8> {
        head.extend_from_slice(tail);
        head
    }

    pub fn elf64() -> Vec<u8> {
        let mut elf = vec![0u8; 64];
        elf[..4].copy_from_slice(b"\x7fELF");
        elf[4] = 2;
        elf[5] = 1;
        with_tail(elf, b"libc.so.6\0GLIBC_2.2.5\0/lib64/ld-linux-x86-64.so.2\0https://example.com/update\0Failed to open config\0")
    }
    pub fn macho_arm64() -> Vec<u8> {
        with_tail(vec![0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1, 0, 0, 0, 0], b"/usr/lib/libSystem.B.dylib\0__TEXT\0__text\0")
    }
    pub fn fat() -> Vec<u8> {
        with_tail(vec![0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2], b"fat header with two slices")
    }
    pub fn class_file() -> Vec<u8> {
        with_tail(vec![0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34], b"java/lang/Object\0main\0([Ljava/lang/String;)V\0")
    }
    pub fn dex() -> Vec<u8> {
        with_tail(b"dex\n035\0".to_vec(), b"Lcom/example/App;\0onCreate\0")
    }
    pub fn wasm() -> Vec<u8> {
        with_tail(b"\0asm\x01\0\0\0".to_vec(), b"env\0memory\0_start\0")
    }
    pub fn pyc() -> Vec<u8> {
        with_tail(vec![0x55, 0x0d, 0x0d, 0x0a], b"\xe3\0\0\0print_hello\0__main__\0")
    }
    pub fn jar() -> Vec<u8> {
        with_tail(b"PK\x03\x04".to_vec(), b"META-INF/MANIFEST.MF\0Main-Class: Main\0")
    }
    pub fn legacy_ne() -> Vec<u8> {
        let mut dos = vec![0u8; 0x100];
        dos[..2].copy_from_slice(b"MZ");
        dos[0x3c] = 0x80;
        dos[0x80..0x82].copy_from_slice(b"NE");
        with_tail(dos, b"This program requires Microsoft Windows.\0")
    }
    pub fn unknown() -> Vec<u8> {
        with_tail(noise(300, 5), b"plain text inside, loadme.dll and some text\0")
    }
    /// Noise around an embedded PE, Lua bytecode and source, a ZIP, a PNG and a PDF: the carving target.
    pub fn blob() -> Vec<u8> {
        let mut blob = noise(3000, 21);
        blob.extend_from_slice(&pe32_managed());
        blob.extend_from_slice(&noise(700, 22));
        blob.extend_from_slice(b"\x1bLuaQ\0\x01\x04\x08\0 compiled chunk\0");
        blob.extend_from_slice(&noise(200, 23));
        blob.extend_from_slice(b" local x = 1 function run() for k,v in pairs(t) do require('a') end end local y = 2 -- padding padding padding ");
        blob.extend_from_slice(b"\0PK\x03\x04zip body\0PK\x05\x06\0\0\0\0\0\0\0\0\x10\0\0\0\x10\0\0\0\0\0");
        blob.extend_from_slice(b"\x89PNG\r\n\x1a\nbody IEND\xaeB`\x82");
        blob.extend_from_slice(b"%PDF-1.4 body %%EOF\n");
        blob.extend_from_slice(&noise(5000, 24));
        blob
    }

    /// Fixture bytes by the name the cases use.
    pub fn by_name(name: &str) -> Vec<u8> {
        match name {
            "sample64.exe" => pe64(),
            "managed32.exe" => pe32_managed(),
            "elf64" => elf64(),
            "macho_arm64" => macho_arm64(),
            "fat.bin" => fat(),
            "Main.class" => class_file(),
            "classes.dex" => dex(),
            "mod.wasm" => wasm(),
            "code.pyc" => pyc(),
            "app.jar" => jar(),
            "legacy.exe" => legacy_ne(),
            "unknown.bin" => unknown(),
            "blob.bin" => blob(),
            other => panic!("no fixture named {other}"),
        }
    }
}
