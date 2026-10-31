//! The apiM guardian: a small Windows service that stays up from boot so the phone reaches the PC even when apiM is
//! closed, wakes apiM on the phone's word, and — once the phone flips the lock — keeps apiM alive by relaunching it
//! whenever anything kills it.
//!
//! It runs as LocalSystem. A user-level process (where most malware runs) cannot kill a LocalSystem service, so the
//! relaunch wins against that class. It never marks itself a critical process, so no kill BSODs the PC; against a
//! virus that already holds admin or SYSTEM it cannot win, and does not pretend to. Shutdown defence is auto-start
//! at boot (a forced shutdown is clean, and the service returns), not an unreliable veto.
//!
//! Modes (argv[1]):
//! - `install --apim <exe> --data <dir> --port <n>`  register + configure + start (needs admin; apiM elevates it)
//! - `uninstall`                                     stop + delete (needs admin)
//! - `run`                                           the SCM entry point
//! - `console`                                       run in the foreground for testing; Ctrl+C kills it
//!
//! It shares `remote.rs` (the phone wire protocol) and `guard.rs` (the cross-process files and the lock decision)
//! with apiM by source, each binary compiling its own copy; the wire format is the same, so the paired phone talks
//! to either.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(not(windows))]
fn main() {
    eprintln!("the apiM guardian runs only on Windows");
}

#[cfg(windows)]
#[path = "../guard.rs"]
mod guard;
#[cfg(windows)]
#[allow(dead_code)] // The phone protocol module carries apiM's whole view model; the guardian uses a slice of it.
#[path = "../remote.rs"]
mod remote;

#[cfg(windows)]
fn main() {
    match std::env::args().nth(1).unwrap_or_default().as_str() {
        "install" => imp::install(),
        "uninstall" => imp::uninstall(),
        "console" => imp::console(),
        "run" => imp::service_dispatch(),
        other => eprintln!("usage: guardian [install|uninstall|console|run] (got {other:?})"),
    }
}

#[cfg(windows)]
mod imp {
    use super::{guard, remote};
    use std::ffi::{OsStr, OsString};
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::Notify;
    use windows_service::service::{
        ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept, ServiceErrorControl, ServiceExitCode, ServiceFailureActions,
        ServiceFailureResetPeriod, ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

    // ------------------------------------------------------------------ install / uninstall

    /// Reads `--apim`, `--data`, `--port` from the command line (apiM passes its own paths, since the guardian's own
    /// profile is SYSTEM's, not the user's).
    fn flag(name: &str) -> Option<String> {
        let args: Vec<String> = std::env::args().collect();
        args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
    }

    pub fn install() {
        let apim = flag("--apim").map(PathBuf::from).unwrap_or_default();
        let data_dir = flag("--data").map(PathBuf::from).unwrap_or_default();
        let user_port = flag("--port").and_then(|p| p.parse().ok()).unwrap_or(remote::PORT);
        if apim.as_os_str().is_empty() || data_dir.as_os_str().is_empty() {
            eprintln!("install needs --apim <exe> and --data <dir>");
            return;
        }
        let pointer = guard::Pointer { apim, data_dir, user_port };
        if let Err(e) = guard::write_pointer(&pointer) {
            eprintln!("could not write the pointer: {e}");
            return;
        }
        // Lock off unless it is already set: install must never lock the PC on its own.
        if !guard::lock_path().exists() {
            let _ = guard::write_lock(&guard::Lock::default());
        }
        // Lock the shared folder down so a user-level virus cannot flip the flag off or repoint the guardian: only
        // SYSTEM and administrators write, everyone reads. Done with icacls rather than hand-rolled ACL FFI.
        let dir = guard::shared_dir();
        let _ = std::process::Command::new("icacls")
            .arg(&dir)
            .args(["/inheritance:r", "/grant:r", "SYSTEM:(OI)(CI)F", "Administrators:(OI)(CI)F", "Users:(OI)(CI)R"])
            .status();

        // Open the guardian's port through Windows Firewall: a service gets no interactive allow prompt, so without
        // this the phone cannot reach it even while it is running. Private and domain networks only, as apiM's own
        // port is allowed; set the Wi-Fi to Private if the phone still cannot reach it.
        let _ = std::process::Command::new("netsh").args(["advfirewall", "firewall", "delete", "rule", "name=apiM Guardian"]).status();
        let _ = std::process::Command::new("netsh")
            .args(["advfirewall", "firewall", "add", "rule", "name=apiM Guardian", "dir=in", "action=allow", "protocol=TCP", &format!("localport={}", guard::guardian_port(user_port)), "profile=private,domain"])
            .status();

        let exe = std::env::current_exe().expect("the guardian knows its own path");
        let manager = match ServiceManager::local_computer(None::<&OsStr>, ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("could not reach the service manager (run elevated): {e}");
                return;
            }
        };
        let info = ServiceInfo {
            name: OsString::from(guard::SERVICE),
            display_name: OsString::from(guard::SERVICE_DISPLAY),
            service_type: ServiceType::OWN_PROCESS,
            start_type: ServiceStartType::AutoStart,
            error_control: ServiceErrorControl::Normal,
            executable_path: exe,
            launch_arguments: vec![OsString::from("run")],
            dependencies: vec![],
            account_name: None, // LocalSystem
            account_password: None,
        };
        let service = match manager.create_service(&info, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START) {
            Ok(s) => s,
            Err(_) => match manager.open_service(guard::SERVICE, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("could not create or open the service: {e}");
                    return;
                }
            },
        };
        // Restart on any stop, crash or kill. Without the non-crash flag the SCM leaves a Task-Manager kill dead.
        let restart = || ServiceAction { action_type: ServiceActionType::Restart, delay: Duration::from_secs(1) };
        let _ = service.update_failure_actions(ServiceFailureActions {
            reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86_400)),
            reboot_msg: None,
            command: None,
            actions: Some(vec![restart(), restart(), restart()]),
        });
        let _ = service.set_failure_actions_on_non_crash_failures(true);
        let empty: [&OsStr; 0] = [];
        let _ = service.start(&empty);
        println!("apiM guardian installed and started");
    }

    pub fn uninstall() {
        let manager = match ServiceManager::local_computer(None::<&OsStr>, ServiceManagerAccess::CONNECT) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("could not reach the service manager (run elevated): {e}");
                return;
            }
        };
        let service = match manager.open_service(guard::SERVICE, ServiceAccess::STOP | ServiceAccess::DELETE | ServiceAccess::QUERY_STATUS) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("the guardian is not installed: {e}");
                return;
            }
        };
        let _ = service.stop();
        let _ = std::process::Command::new("netsh").args(["advfirewall", "firewall", "delete", "rule", "name=apiM Guardian"]).status();
        // Give the stop a moment before deleting, or the service lingers as "marked for deletion".
        std::thread::sleep(Duration::from_millis(500));
        match service.delete() {
            Ok(()) => println!("apiM guardian uninstalled"),
            Err(e) => eprintln!("could not delete the service: {e}"),
        }
    }

    // ------------------------------------------------------------------ the service

    windows_service::define_windows_service!(ffi_service_main, service_main);

    pub fn service_dispatch() {
        let _ = windows_service::service_dispatcher::start(guard::SERVICE, ffi_service_main);
    }

    fn service_main(_args: Vec<OsString>) {
        let _ = run_service();
    }

    fn run_service() -> windows_service::Result<()> {
        let stop = Arc::new(Notify::new());
        let handler = {
            let stop = stop.clone();
            move |control| match control {
                ServiceControl::Stop | ServiceControl::Preshutdown => {
                    stop.notify_waiters();
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            }
        };
        let status = service_control_handler::register(guard::SERVICE, handler)?;
        let running = |state| ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::PRESHUTDOWN,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        };
        status.set_service_status(running(ServiceState::Running))?;
        if let Ok(rt) = tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            rt.block_on(guard_loop(stop, true));
        }
        status.set_service_status(ServiceStatus { controls_accepted: ServiceControlAccept::empty(), ..running(ServiceState::Stopped) })?;
        Ok(())
    }

    pub fn console() {
        let stop = Arc::new(Notify::new()); // never fired: Ctrl+C kills the process in console mode
        if let Ok(rt) = tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            println!("guardian running in the foreground on the guardian port; Ctrl+C to stop");
            rt.block_on(guard_loop(stop, false));
        }
    }

    // ------------------------------------------------------------------ the loop

    /// Waits until apiM has written the pointer (it may start before apiM has ever run), giving up only when asked to
    /// stop.
    async fn wait_for_pointer(stop: &Notify) -> Option<guard::Pointer> {
        loop {
            if let Some(pointer) = guard::read_pointer() {
                return Some(pointer);
            }
            tokio::select! {
                _ = stop.notified() => return None,
                _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            }
        }
    }

    /// Holds the guardian port for the phone, wakes apiM on request, and relaunches it while the lock is on. Driven
    /// by events (a phone command, apiM exiting, the stop signal) with a 3-second backstop, not a busy poll.
    async fn guard_loop(stop: Arc<Notify>, in_service: bool) {
        let Some(pointer) = wait_for_pointer(&stop).await else { return };
        let Some(secret) = guard::read_secret(&pointer.data_dir).and_then(|s| remote::decode_secret(&s)) else {
            // Nothing is paired yet, so there is no one to serve. Sit until stopped rather than spin.
            stop.notified().await;
            return;
        };
        let commanded = Arc::new(Notify::new());
        let link = {
            let commanded = commanded.clone();
            remote::Remote::start(&tokio::runtime::Handle::current(), pointer.guardian_port(), secret, move || commanded.notify_waiters())
        };
        let mut link = match link {
            Ok(link) => link,
            Err(_) => {
                // The guardian port is taken (a second guardian, say). Nothing to do but wait to be stopped.
                stop.notified().await;
                return;
            }
        };
        let exited = Arc::new(Notify::new());
        let mut watching = false;
        loop {
            for command in link.commands() {
                match command {
                    remote::Command::Wake => {
                        if find_apim().is_none() {
                            launch_apim(&pointer, !in_service);
                        }
                    }
                    remote::Command::Lock { on } => {
                        let _ = guard::write_lock(&guard::Lock { locked: on });
                        watching = false; // re-evaluate the watch under the new flag
                    }
                    _ => {}
                }
            }
            let locked = guard::read_lock().locked;
            let apim = find_apim();
            if guard::should_relaunch(locked, apim.is_some()) {
                launch_apim(&pointer, !in_service);
                watching = false;
            } else if locked {
                if let (Some(pid), false) = (apim, watching) {
                    watching = true;
                    watch_exit(pid, exited.clone());
                }
            } else {
                watching = false;
            }
            // Idle and unlocked, the loop sleeps on its events only — no periodic wakeup, so a guardian that is just
            // listening costs no CPU. While locked it also wakes every 3 s as a backstop, in case a relaunch could
            // not start (no user logged in yet) or a watch was missed.
            let backstop = async {
                if locked {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                } else {
                    std::future::pending::<()>().await;
                }
            };
            tokio::select! {
                _ = stop.notified() => break,
                _ = commanded.notified() => {}
                _ = exited.notified() => watching = false,
                _ = backstop => {}
            }
        }
    }

    // ------------------------------------------------------------------ Win32

    fn wide(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// The PID of a running `apim.exe`, if any. A name scan, done only when the loop re-evaluates, not in a tight
    /// poll.
    fn find_apim() -> Option<u32> {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS};
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return None;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut found = None;
            if Process32FirstW(snap, &mut entry) != 0 {
                loop {
                    let end = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                    if String::from_utf16_lossy(&entry.szExeFile[..end]).eq_ignore_ascii_case("apim.exe") {
                        found = Some(entry.th32ProcessID);
                        break;
                    }
                    if Process32NextW(snap, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snap);
            found
        }
    }

    /// Waits for a process to exit on a blocking thread, then wakes the loop so it can relaunch.
    fn watch_exit(pid: u32, exited: Arc<Notify>) {
        tokio::spawn(async move {
            let _ = tokio::task::spawn_blocking(move || {
                use windows_sys::Win32::Foundation::CloseHandle;
                use windows_sys::Win32::System::Threading::{INFINITE, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};
                unsafe {
                    let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
                    if !handle.is_null() {
                        WaitForSingleObject(handle, INFINITE);
                        CloseHandle(handle);
                    }
                }
            })
            .await;
            exited.notify_waiters();
        });
    }

    /// Launches apiM into the logged-in user's interactive session. From session 0 (where a service lives) a plain
    /// spawn would land invisibly in session 0, so the service path uses the user's token; the console/user path,
    /// where that token is out of reach, spawns normally in its own session. Returns whether a launch was started.
    fn launch_apim(pointer: &guard::Pointer, allow_plain: bool) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HANDLE};
        use windows_sys::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
        use windows_sys::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken};
        use windows_sys::Win32::System::Threading::{CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW, PROCESS_INFORMATION, STARTUPINFOW};

        let exe = &pointer.apim;
        if !exe.exists() {
            return false;
        }
        let parent = exe.parent().unwrap_or(Path::new("."));
        unsafe {
            let session = WTSGetActiveConsoleSessionId();
            let mut token: HANDLE = std::ptr::null_mut();
            let have_token = session != u32::MAX && WTSQueryUserToken(session, &mut token) != 0;
            if !have_token {
                // No one is logged in, or we are not SYSTEM. Fall back to a plain spawn only where that lands in the
                // right session (console/user mode), never from the service.
                if allow_plain {
                    return std::process::Command::new(exe).current_dir(parent).spawn().is_ok();
                }
                return false;
            }
            let mut env: *mut std::ffi::c_void = std::ptr::null_mut();
            let have_env = CreateEnvironmentBlock(&mut env, token, FALSE) != 0;
            let app = wide(exe.as_os_str());
            let desktop = wide(OsStr::new("winsta0\\default"));
            let cwd = wide(parent.as_os_str());
            let mut si: STARTUPINFOW = std::mem::zeroed();
            si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            si.lpDesktop = desktop.as_ptr() as *mut u16;
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
            let ok = CreateProcessAsUserW(
                token,
                app.as_ptr(),
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                FALSE,
                CREATE_UNICODE_ENVIRONMENT,
                if have_env { env } else { std::ptr::null() },
                cwd.as_ptr(),
                &si,
                &mut pi,
            ) != 0;
            if ok {
                CloseHandle(pi.hProcess);
                CloseHandle(pi.hThread);
            }
            if have_env {
                DestroyEnvironmentBlock(env);
            }
            CloseHandle(token);
            ok
        }
    }
}
