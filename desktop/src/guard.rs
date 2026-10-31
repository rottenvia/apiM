//! Shared between apiM (the window) and the guardian service (`src/bin/guardian.rs`): where the two processes hand
//! off to each other, the lock flag the phone flips, and the one decision the guardian's watch loop makes.
//!
//! The guardian runs as LocalSystem, whose own `%APPDATA%` is the system profile, not the user's, so it cannot find
//! the user's data folder the way apiM does. apiM (which knows the real paths) writes them to `C:\ProgramData\apiM`,
//! which SYSTEM and the user can both reach; the guardian reads them there. The secret itself is not copied — the
//! pointer names the data folder, and the guardian reads `remote.json` from it, the same file apiM paired with.
#![allow(dead_code)] // Shared by two binaries; each uses a different subset.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The Windows service name (the key under which it is registered) and the name shown in services.msc.
pub const SERVICE: &str = "apiMGuardian";
pub const SERVICE_DISPLAY: &str = "apiM Guardian";

/// `C:\ProgramData\apiM`: written by the elevated install and by apiM, read by the guardian (SYSTEM).
pub fn shared_dir() -> PathBuf {
    std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData")).join("apiM")
}

pub fn pointer_path() -> PathBuf {
    shared_dir().join("guardian.json")
}

pub fn lock_path() -> PathBuf {
    shared_dir().join("lock.json")
}

/// What apiM tells the guardian: the exe to relaunch, the data folder that holds `remote.json` (the paired secret),
/// and the port apiM listens on, which the guardian sits one above.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Pointer {
    pub apim: PathBuf,
    pub data_dir: PathBuf,
    pub user_port: u16,
}

impl Pointer {
    pub fn guardian_port(&self) -> u16 {
        guardian_port(self.user_port)
    }
}

/// The guardian listens one port above apiM's, so both can be up at once with no clash. Wraps at the top of the
/// range rather than overflowing (a port of 65535 is not a real apiM, but the arithmetic must not panic).
pub fn guardian_port(user_port: u16) -> u16 {
    user_port.wrapping_add(1)
}

/// The flag the phone flips. A struct, not a bare bool, so a later field (who locked it, when) does not break the
/// file format.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Lock {
    pub locked: bool,
}

pub fn read_pointer() -> Option<Pointer> {
    serde_json::from_slice(&std::fs::read(pointer_path()).ok()?).ok()
}

pub fn write_pointer(pointer: &Pointer) -> std::io::Result<()> {
    std::fs::create_dir_all(shared_dir())?;
    std::fs::write(pointer_path(), serde_json::to_vec_pretty(pointer).unwrap_or_default())
}

/// Off when the file is missing or unreadable: the guard defaults to doing nothing, never to locking the PC on its
/// own.
pub fn read_lock() -> Lock {
    std::fs::read(lock_path()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

pub fn write_lock(lock: &Lock) -> std::io::Result<()> {
    std::fs::create_dir_all(shared_dir())?;
    std::fs::write(lock_path(), serde_json::to_vec_pretty(lock).unwrap_or_default())
}

/// The reads the guardian needs from `remote.json` without apiM's private `Config` type: just the paired secret.
pub fn read_secret(data_dir: &std::path::Path) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(data_dir.join("remote.json")).ok()?).ok()?;
    value.get("secret")?.as_str().map(str::to_owned)
}

/// The one decision the watch loop makes: relaunch apiM only while the phone has it locked and only when it is not
/// already up. Off → the guardian never relaunches, so a normal close stays closed.
pub fn should_relaunch(locked: bool, apim_running: bool) -> bool {
    locked && !apim_running
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relaunch_only_when_locked_and_apim_down() {
        assert!(should_relaunch(true, false), "locked and down: bring it back");
        assert!(!should_relaunch(true, true), "locked but already up: leave it");
        assert!(!should_relaunch(false, false), "unlocked: a close stays closed");
        assert!(!should_relaunch(false, true), "unlocked and up: nothing to do");
    }

    #[test]
    fn guardian_sits_one_port_above_apim() {
        assert_eq!(guardian_port(47100), 47101);
        assert_eq!(guardian_port(u16::MAX), 0, "wraps instead of panicking");
    }

    #[test]
    fn pointer_round_trips_through_json() {
        let pointer = Pointer { apim: PathBuf::from(r"C:\apiM\apim.exe"), data_dir: PathBuf::from(r"C:\data"), user_port: 47100 };
        let bytes = serde_json::to_vec(&pointer).unwrap();
        assert_eq!(serde_json::from_slice::<Pointer>(&bytes).unwrap(), pointer);
        assert_eq!(pointer.guardian_port(), 47101);
    }

    #[test]
    fn lock_defaults_off() {
        assert!(!Lock::default().locked);
    }
}
