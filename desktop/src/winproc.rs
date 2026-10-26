//! Windows process primitives for the `winproc` tools. Win32 and NT calls declared here, no crate.
//! Each call opens the handles it needs and closes them before it returns: no handle is kept between tool calls.
//! 64-bit Windows only: the struct layouts below are the x64 ones, and the tests check their sizes and offsets.

use std::ffi::c_void;
use std::ptr::{null, null_mut};

pub type Handle = *mut c_void;
pub type Ntstatus = i32;

const STATUS_INFO_LENGTH_MISMATCH: Ntstatus = 0xC000_0004u32 as i32;
const SYSTEM_PROCESS_INFORMATION: u32 = 5;
/// THREADINFOCLASS ThreadSuspendCount.
const THREAD_SUSPEND_COUNT: u32 = 35;
pub const THREAD_SUSPEND_RESUME: u32 = 0x2;
pub const THREAD_GET_CONTEXT: u32 = 0x8;
pub const THREAD_SET_CONTEXT: u32 = 0x10;
pub const THREAD_QUERY_INFORMATION: u32 = 0x40;
pub const PROCESS_VM_OPERATION: u32 = 0x8;
pub const PROCESS_VM_READ: u32 = 0x10;
pub const PROCESS_VM_WRITE: u32 = 0x20;
pub const PROCESS_QUERY_INFORMATION: u32 = 0x400;
const CONTEXT_AMD64: u32 = 0x0010_0000;
/// CONTEXT_CONTROL | INTEGER | SEGMENTS | FLOATING_POINT | DEBUG_REGISTERS.
const CONTEXT_ALL: u32 = CONTEXT_AMD64 | 0x1F;
/// CONTEXT_CONTROL | INTEGER: what set_context writes. Segments and debug registers are left alone.
const CONTEXT_CONTROL_INTEGER: u32 = CONTEXT_AMD64 | 0x3;
pub const MEM_COMMIT: u32 = 0x1000;
pub const MEM_RESERVE: u32 = 0x2000;
pub const MEM_RELEASE: u32 = 0x8000;
pub const MEM_FREE: u32 = 0x10000;
pub const MEM_PRIVATE: u32 = 0x20000;
pub const MEM_MAPPED: u32 = 0x40000;
pub const MEM_IMAGE: u32 = 0x1000000;
#[cfg(test)]
pub const PAGE_READONLY: u32 = 0x02;
#[cfg(test)]
pub const PAGE_READWRITE: u32 = 0x04;

pub const PROCESS_RIGHTS: &[(&str, u32)] = &[
    ("PROCESS_TERMINATE", 0x1),
    ("PROCESS_CREATE_THREAD", 0x2),
    ("PROCESS_VM_OPERATION", 0x8),
    ("PROCESS_VM_READ", 0x10),
    ("PROCESS_VM_WRITE", 0x20),
    ("PROCESS_DUP_HANDLE", 0x40),
    ("PROCESS_SET_QUOTA", 0x100),
    ("PROCESS_SET_INFORMATION", 0x200),
    ("PROCESS_QUERY_INFORMATION", 0x400),
    ("PROCESS_SUSPEND_RESUME", 0x800),
    ("PROCESS_QUERY_LIMITED_INFORMATION", 0x1000),
];
const PROTECTIONS: &[(&str, u32)] = &[
    ("PAGE_NOACCESS", 0x01),
    ("PAGE_READONLY", 0x02),
    ("PAGE_READWRITE", 0x04),
    ("PAGE_WRITECOPY", 0x08),
    ("PAGE_EXECUTE", 0x10),
    ("PAGE_EXECUTE_READ", 0x20),
    ("PAGE_EXECUTE_READWRITE", 0x40),
    ("PAGE_EXECUTE_WRITECOPY", 0x80),
];
const WAIT_REASONS: &[&str] = &[
    "Executive", "FreePage", "PageIn", "PoolAllocation", "DelayExecution", "Suspended", "UserRequest", "WrExecutive", "WrFreePage", "WrPageIn", "WrPoolAllocation",
    "WrDelayExecution", "WrSuspended", "WrUserRequest", "WrEventPair", "WrQueue", "WrLpcReceive", "WrLpcReply", "WrVirtualMemory", "WrPageOut", "WrRendezvous",
    "WrKeyedEvent", "WrTerminated", "WrProcessInSwap", "WrCpuRateControl", "WrCalloutStack", "WrKernel", "WrResource", "WrPushLock", "WrMutex", "WrQuantumEnd",
    "WrDispatchInt", "WrPreempted", "WrYieldExecution", "WrFastMutex", "WrGuardedMutex", "WrRundown",
];
const THREAD_STATES: &[&str] = &[
    "Initialized", "Ready", "Running", "Standby", "Terminated", "Waiting", "Transition", "DeferredReady", "GateWaitObsolete", "WaitingForProcessInSwap",
];

#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root: Handle,
    name: *mut c_void,
    attributes: u32,
    security_descriptor: *mut c_void,
    security_qos: *mut c_void,
}

#[repr(C)]
struct ClientId {
    process: Handle,
    thread: Handle,
}

/// MEMORY_BASIC_INFORMATION, x64.
#[repr(C)]
struct MemoryBasicInformation {
    base: usize,
    alloc_base: usize,
    alloc_protect: u32,
    partition: u16,
    region_size: usize,
    state: u32,
    protect: u32,
    kind: u32,
}

/// MODULEENTRY32W, x64.
#[repr(C)]
struct ModuleEntry32W {
    dw_size: u32,
    module_id: u32,
    process_id: u32,
    glbl_usage: u32,
    proc_usage: u32,
    base: usize,
    base_size: u32,
    module: usize,
    name: [u16; 256],
    path: [u16; 260],
}

/// CONTEXT, x64. Only the fields that matter are named; the rest is kept so the struct has the kernel's size.
#[repr(C, align(16))]
#[derive(Clone, Copy)]
pub struct Context {
    home: [u64; 6],
    pub flags: u32,
    mxcsr: u32,
    pub seg_cs: u16,
    pub seg_ds: u16,
    pub seg_es: u16,
    pub seg_fs: u16,
    pub seg_gs: u16,
    pub seg_ss: u16,
    pub eflags: u32,
    pub dr0: u64,
    pub dr1: u64,
    pub dr2: u64,
    pub dr3: u64,
    pub dr6: u64,
    pub dr7: u64,
    pub rax: u64,
    pub rcx: u64,
    pub rdx: u64,
    pub rbx: u64,
    pub rsp: u64,
    pub rbp: u64,
    pub rsi: u64,
    pub rdi: u64,
    pub r8: u64,
    pub r9: u64,
    pub r10: u64,
    pub r11: u64,
    pub r12: u64,
    pub r13: u64,
    pub r14: u64,
    pub r15: u64,
    pub rip: u64,
    rest: [u8; 976],
}
const _: () = assert!(std::mem::size_of::<Context>() == 1232);

#[allow(non_snake_case)]
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtOpenProcess(process: *mut Handle, access: u32, attrs: *const ObjectAttributes, cid: *const ClientId) -> Ntstatus;
    fn NtOpenThread(thread: *mut Handle, access: u32, attrs: *const ObjectAttributes, cid: *const ClientId) -> Ntstatus;
    fn NtSuspendThread(thread: Handle, previous: *mut u32) -> Ntstatus;
    fn NtResumeThread(thread: Handle, previous: *mut u32) -> Ntstatus;
    fn NtQueryInformationThread(thread: Handle, class: u32, info: *mut c_void, len: u32, ret: *mut u32) -> Ntstatus;
    fn NtQuerySystemInformation(class: u32, info: *mut c_void, len: u32, ret: *mut u32) -> Ntstatus;
    fn NtReadVirtualMemory(process: Handle, base: *const c_void, buf: *mut c_void, size: usize, read: *mut usize) -> Ntstatus;
    fn NtWriteVirtualMemory(process: Handle, base: *const c_void, buf: *const c_void, size: usize, written: *mut usize) -> Ntstatus;
    fn RtlNtStatusToDosError(status: Ntstatus) -> u32;
}

#[allow(non_snake_case)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CloseHandle(h: isize) -> i32;
    fn GetLastError() -> u32;
    fn GetThreadContext(thread: Handle, ctx: *mut Context) -> i32;
    fn SetThreadContext(thread: Handle, ctx: *const Context) -> i32;
    fn VirtualQueryEx(process: Handle, addr: *const c_void, info: *mut MemoryBasicInformation, len: usize) -> usize;
    fn VirtualProtectEx(process: Handle, addr: *const c_void, size: usize, new: u32, old: *mut u32) -> i32;
    fn VirtualAllocEx(process: Handle, addr: *const c_void, size: usize, kind: u32, prot: u32) -> *mut c_void;
    fn VirtualFreeEx(process: Handle, addr: *mut c_void, size: usize, kind: u32) -> i32;
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
    fn Module32FirstW(snap: Handle, entry: *mut ModuleEntry32W) -> i32;
    fn Module32NextW(snap: Handle, entry: *mut ModuleEntry32W) -> i32;
    fn FormatMessageW(flags: u32, source: *const c_void, id: u32, lang: u32, out: *mut u16, size: u32, args: *const c_void) -> u32;
}

/// A handle, closed when it goes out of scope.
pub struct Obj(Handle);
impl Drop for Obj {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0 as isize) };
    }
}

fn no_attributes() -> ObjectAttributes {
    ObjectAttributes { length: std::mem::size_of::<ObjectAttributes>() as u32, root: null_mut(), name: null_mut(), attributes: 0, security_descriptor: null_mut(), security_qos: null_mut() }
}

/// The Windows text for a Win32 error code, with the code.
pub fn win_error(code: u32) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { FormatMessageW(0x1200, null(), code, 0, buf.as_mut_ptr(), buf.len() as u32, null()) } as usize;
    let text = String::from_utf16_lossy(&buf[..n.min(buf.len())]);
    let text = text.trim();
    if text.is_empty() { format!("error 0x{code:08X}") } else { format!("{text} (0x{code:08X})") }
}

/// The text for an NTSTATUS, with the status.
pub fn nt_error(status: Ntstatus) -> String {
    let code = unsafe { RtlNtStatusToDosError(status) };
    format!("NTSTATUS 0x{:08X}: {}", status as u32, win_error(code))
}

fn last_error() -> String {
    win_error(unsafe { GetLastError() })
}

pub fn open_process(pid: u32, access: u32) -> Result<Obj, String> {
    let (attrs, cid) = (no_attributes(), ClientId { process: pid as usize as Handle, thread: null_mut() });
    let mut h = null_mut();
    let st = unsafe { NtOpenProcess(&mut h, access, &attrs, &cid) };
    if st < 0 { Err(nt_error(st)) } else { Ok(Obj(h)) }
}

pub fn open_thread(tid: u32, access: u32) -> Result<Obj, String> {
    let (attrs, cid) = (no_attributes(), ClientId { process: null_mut(), thread: tid as usize as Handle });
    let mut h = null_mut();
    let st = unsafe { NtOpenThread(&mut h, access, &attrs, &cid) };
    if st < 0 { Err(nt_error(st)) } else { Ok(Obj(h)) }
}

/// Which rights one open is granted and which it is denied, each with the reason.
pub struct Probe {
    pub granted: Vec<&'static str>,
    pub denied: Vec<(&'static str, String)>,
}

pub fn probe_process(pid: u32) -> Probe {
    let mut p = Probe { granted: vec![], denied: vec![] };
    for &(name, bit) in PROCESS_RIGHTS {
        match open_process(pid, bit) {
            Ok(_) => p.granted.push(name),
            Err(why) => p.denied.push((name, why)),
        }
    }
    p
}

/// One thread from the system's process snapshot.
pub struct Thread {
    pub tid: u32,
    pub start: usize,
    pub state: u32,
    pub wait: u32,
    pub priority: i32,
    pub base_priority: i32,
}

pub struct Process {
    pub pid: u32,
    pub name: String,
    /// FILETIME: 100 ns ticks since 1601-01-01 UTC.
    pub create_time: u64,
    pub threads: Vec<Thread>,
}

/// Every process on the machine with every thread's wait reason. Works on any pid the user can see.
pub fn processes() -> Result<Vec<Process>, String> {
    let mut buf = vec![0u8; 1 << 19];
    let mut used = 0u32;
    loop {
        let st = unsafe { NtQuerySystemInformation(SYSTEM_PROCESS_INFORMATION, buf.as_mut_ptr().cast(), buf.len() as u32, &mut used) };
        if st == STATUS_INFO_LENGTH_MISMATCH {
            buf = vec![0u8; (used as usize).max(buf.len() * 2)];
            continue;
        }
        if st < 0 {
            return Err(nt_error(st));
        }
        break;
    }
    buf.truncate((used as usize).min(buf.len()));
    parse_processes(&buf).ok_or_else(|| "the system's process list came back truncated".to_string())
}

/// Reads one little-endian value at `at`; None when it does not fit.
fn rd<T: Copy>(buf: &[u8], at: usize) -> Option<T> {
    let end = at.checked_add(std::mem::size_of::<T>())?;
    (end <= buf.len()).then(|| unsafe { std::ptr::read_unaligned(buf.as_ptr().add(at).cast::<T>()) })
}

fn wide(units: &[u16]) -> String {
    let end = units.iter().position(|&c| c == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

/// Parses SYSTEM_PROCESS_INFORMATION records (x64): name at 56, create time at 32, pid at 80, threads from 256, 80 bytes each.
fn parse_processes(buf: &[u8]) -> Option<Vec<Process>> {
    let base = buf.as_ptr() as usize;
    let mut out = Vec::new();
    let mut at = 0usize;
    loop {
        let next: u32 = rd(buf, at)?;
        let count: u32 = rd(buf, at + 4)?;
        let create_time: i64 = rd(buf, at + 32)?;
        let name_len: u16 = rd(buf, at + 56)?;
        let name_ptr: usize = rd(buf, at + 64)?;
        let pid: usize = rd(buf, at + 80)?;
        let name_at = name_ptr.wrapping_sub(base);
        let name_fits = name_ptr >= base && name_at.checked_add(name_len as usize).is_some_and(|end| end <= buf.len());
        let name = if name_len == 0 || !name_fits {
            String::new()
        } else {
            let units: Vec<u16> = buf[name_at..name_at + name_len as usize].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            wide(&units)
        };
        let mut threads = Vec::new();
        for i in 0..count as usize {
            let t = at.checked_add(256 + i * 80)?;
            threads.push(Thread {
                tid: rd::<usize>(buf, t + 48)? as u32,
                start: rd(buf, t + 32)?,
                priority: rd(buf, t + 56)?,
                base_priority: rd(buf, t + 60)?,
                state: rd(buf, t + 68)?,
                wait: rd(buf, t + 72)?,
            });
        }
        out.push(Process { pid: pid as u32, name, create_time: create_time as u64, threads });
        if next == 0 {
            break;
        }
        at = at.checked_add(next as usize)?;
    }
    Some(out)
}

pub fn wait_reason(n: u32) -> &'static str {
    WAIT_REASONS.get(n as usize).copied().unwrap_or("Unknown")
}

pub fn thread_state(n: u32) -> &'static str {
    THREAD_STATES.get(n as usize).copied().unwrap_or("Unknown")
}

/// The suspend count of an open thread, as the kernel keeps it.
fn suspend_count(thread: Handle) -> Result<u32, String> {
    let mut count = 0u32;
    let mut ret = 0u32;
    let st = unsafe { NtQueryInformationThread(thread, THREAD_SUSPEND_COUNT, (&mut count as *mut u32).cast(), 4, &mut ret) };
    if st < 0 { Err(nt_error(st)) } else { Ok(count) }
}

pub fn thread_suspend_count(tid: u32) -> Result<u32, String> {
    let t = open_thread(tid, THREAD_QUERY_INFORMATION)?;
    suspend_count(t.0)
}

/// Suspends each thread. Each result is the count before this call (0 means it was running).
pub fn suspend_threads(tids: &[u32]) -> Vec<Result<u32, String>> {
    tids.iter().map(|&t| thread_op(t, THREAD_SUSPEND_RESUME, NtSuspendThread)).collect()
}

/// Resumes each thread. Each result is the count before this call.
pub fn resume_threads(tids: &[u32]) -> Vec<Result<u32, String>> {
    tids.iter().map(|&t| thread_op(t, THREAD_SUSPEND_RESUME, NtResumeThread)).collect()
}

fn thread_op(tid: u32, access: u32, op: unsafe extern "system" fn(Handle, *mut u32) -> Ntstatus) -> Result<u32, String> {
    let t = open_thread(tid, access)?;
    let mut previous = 0u32;
    let st = unsafe { op(t.0, &mut previous) };
    if st < 0 { Err(nt_error(st)) } else { Ok(previous) }
}

/// The thread's registers. The thread should be suspended: the context of a running thread is out of date by the time it is read.
pub fn get_context(tid: u32) -> Result<(Box<Context>, u32), String> {
    let t = open_thread(tid, THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION)?;
    let count = suspend_count(t.0)?;
    let mut ctx: Box<Context> = Box::new(unsafe { std::mem::zeroed() });
    ctx.flags = CONTEXT_ALL;
    if unsafe { GetThreadContext(t.0, &mut *ctx) } == 0 {
        return Err(last_error());
    }
    Ok((ctx, count))
}

/// Writes rip, rsp, the general registers and the flags. The thread must be suspended: the kernel refuses a running one.
pub fn set_context(tid: u32, ctx: &Context) -> Result<(), String> {
    let t = open_thread(tid, THREAD_SET_CONTEXT | THREAD_QUERY_INFORMATION)?;
    if suspend_count(t.0)? == 0 {
        return Err("the thread is not suspended; suspend it first, then set its context".into());
    }
    let mut out = *ctx;
    out.flags = CONTEXT_CONTROL_INTEGER;
    if unsafe { SetThreadContext(t.0, &out) } == 0 {
        return Err(last_error());
    }
    Ok(())
}

/// Every general register and the flags, in the order they are shown.
pub fn registers(c: &Context) -> Vec<(&'static str, u64)> {
    vec![
        ("rax", c.rax), ("rcx", c.rcx), ("rdx", c.rdx), ("rbx", c.rbx), ("rsp", c.rsp), ("rbp", c.rbp), ("rsi", c.rsi), ("rdi", c.rdi),
        ("r8", c.r8), ("r9", c.r9), ("r10", c.r10), ("r11", c.r11), ("r12", c.r12), ("r13", c.r13), ("r14", c.r14), ("r15", c.r15),
        ("rip", c.rip), ("eflags", c.eflags as u64),
    ]
}

pub fn set_register(c: &mut Context, name: &str, value: u64) -> Result<(), String> {
    let slot = match name {
        "rax" => &mut c.rax, "rcx" => &mut c.rcx, "rdx" => &mut c.rdx, "rbx" => &mut c.rbx, "rsp" => &mut c.rsp, "rbp" => &mut c.rbp,
        "rsi" => &mut c.rsi, "rdi" => &mut c.rdi, "r8" => &mut c.r8, "r9" => &mut c.r9, "r10" => &mut c.r10, "r11" => &mut c.r11,
        "r12" => &mut c.r12, "r13" => &mut c.r13, "r14" => &mut c.r14, "r15" => &mut c.r15, "rip" => &mut c.rip,
        "eflags" => {
            c.eflags = value as u32;
            return Ok(());
        }
        _ => return Err(format!("no register \"{name}\" that can be set here (rax..r15, rip, rsp, eflags)")),
    };
    *slot = value;
    Ok(())
}

/// Reads at most `size` bytes. `note` says why it stopped short (a page that is not readable, or an unmapped address).
pub struct Read {
    pub bytes: Vec<u8>,
    pub note: Option<String>,
}

pub fn read_mem(p: &Obj, addr: usize, size: usize) -> Read {
    let mut buf = vec![0u8; size];
    let mut n = 0usize;
    let st = unsafe { NtReadVirtualMemory(p.0, addr as *const c_void, buf.as_mut_ptr().cast(), size, &mut n) };
    buf.truncate(n.min(size));
    Read { bytes: buf, note: (st < 0).then(|| nt_error(st)) }
}

pub struct Written {
    pub written: usize,
    pub note: Option<String>,
}

/// Writes `data`. Pages that are read-only stay read-only: the write stops there and says so.
pub fn write_mem(p: &Obj, addr: usize, data: &[u8]) -> Written {
    let mut n = 0usize;
    let st = unsafe { NtWriteVirtualMemory(p.0, addr as *const c_void, data.as_ptr().cast(), data.len(), &mut n) };
    Written { written: n.min(data.len()), note: (st < 0).then(|| nt_error(st)) }
}

/// One region from VirtualQueryEx.
pub struct Region {
    pub base: usize,
    pub size: usize,
    pub alloc_base: usize,
    pub alloc_protect: u32,
    pub state: u32,
    pub protect: u32,
    pub kind: u32,
}

pub fn query_mem(p: &Obj, addr: usize) -> Result<Region, String> {
    let mut mbi: MemoryBasicInformation = unsafe { std::mem::zeroed() };
    let n = unsafe { VirtualQueryEx(p.0, addr as *const c_void, &mut mbi, std::mem::size_of::<MemoryBasicInformation>()) };
    if n == 0 {
        return Err(last_error());
    }
    Ok(Region { base: mbi.base, size: mbi.region_size, alloc_base: mbi.alloc_base, alloc_protect: mbi.alloc_protect, state: mbi.state, protect: mbi.protect, kind: mbi.kind })
}

/// Sets the protection of the pages in the range and returns the previous protection. Only what is asked changes.
pub fn protect_mem(p: &Obj, addr: usize, size: usize, new: u32) -> Result<u32, String> {
    let mut old = 0u32;
    if unsafe { VirtualProtectEx(p.0, addr as *const c_void, size, new, &mut old) } == 0 {
        return Err(last_error());
    }
    Ok(old)
}

pub fn alloc_mem(p: &Obj, size: usize, prot: u32) -> Result<usize, String> {
    let addr = unsafe { VirtualAllocEx(p.0, null(), size, MEM_COMMIT | MEM_RESERVE, prot) };
    if addr.is_null() { Err(last_error()) } else { Ok(addr as usize) }
}

/// Frees a block from `alloc_mem`. `addr` is the block's base address, as alloc_mem returned it.
pub fn free_mem(p: &Obj, addr: usize) -> Result<(), String> {
    if unsafe { VirtualFreeEx(p.0, addr as *mut c_void, 0, MEM_RELEASE) } == 0 {
        return Err(last_error());
    }
    Ok(())
}

/// The name of a page protection, with its modifier bits (PAGE_GUARD and the like) joined on.
pub fn protect_name(p: u32) -> String {
    let base = p & 0xFF;
    let mut parts = vec![PROTECTIONS.iter().find(|(_, v)| *v == base).map(|(n, _)| n.to_string()).unwrap_or(format!("0x{base:X}"))];
    for (bit, name) in [(0x100, "PAGE_GUARD"), (0x200, "PAGE_NOCACHE"), (0x400, "PAGE_WRITECOMBINE")] {
        if p & bit != 0 {
            parts.push(name.to_string());
        }
    }
    parts.join(" | ")
}

/// A protection given as a name (PAGE_READWRITE, any case) or a number (0x04, 4).
pub fn protect_value(s: &str) -> Result<u32, String> {
    let s = s.trim();
    let lower = s.to_ascii_lowercase();
    if let Some((_, v)) = PROTECTIONS.iter().find(|(n, _)| n.to_ascii_lowercase() == lower) {
        return Ok(*v);
    }
    let parsed = match lower.strip_prefix("0x") {
        Some(hex) => u32::from_str_radix(hex, 16).ok(),
        None => s.parse().ok(),
    };
    parsed.filter(|v| *v <= 0xFF).ok_or_else(|| format!("\"{s}\" is not a page protection: use a name such as PAGE_READWRITE or a number such as 0x04"))
}

pub fn state_name(s: u32) -> &'static str {
    match s {
        MEM_COMMIT => "MEM_COMMIT",
        MEM_RESERVE => "MEM_RESERVE",
        MEM_FREE => "MEM_FREE",
        _ => "unknown",
    }
}

pub fn kind_name(k: u32) -> &'static str {
    match k {
        MEM_PRIVATE => "MEM_PRIVATE",
        MEM_MAPPED => "MEM_MAPPED",
        MEM_IMAGE => "MEM_IMAGE",
        0 => "none",
        _ => "unknown",
    }
}

pub struct Module {
    pub base: usize,
    pub size: u32,
    pub path: String,
}

/// Every module loaded in a process, from a toolhelp snapshot. Retries while the process changes its module list.
fn modules_once(pid: u32) -> Result<Vec<Module>, String> {
    const TH32CS_SNAPMODULE: u32 = 0x8;
    const TH32CS_SNAPMODULE32: u32 = 0x10;
    const ERROR_BAD_LENGTH: u32 = 24;
    const ERROR_NO_MORE_FILES: u32 = 18;
    const ERROR_PARTIAL_COPY: u32 = 299;
    let mut tries = 0;
    let snap = loop {
        let h = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid) };
        if h as isize != -1 {
            break Obj(h);
        }
        let e = unsafe { GetLastError() };
        // A process still loading answers so until its loader is done. Asked again at once, twenty tries passed in
        // well under a millisecond, and a program just started failed now and then.
        if (e == ERROR_BAD_LENGTH || e == ERROR_PARTIAL_COPY) && tries < 20 {
            tries += 1;
            std::thread::sleep(std::time::Duration::from_millis(10));
            continue;
        }
        return Err(win_error(e));
    };
    let mut entry: ModuleEntry32W = unsafe { std::mem::zeroed() };
    entry.dw_size = std::mem::size_of::<ModuleEntry32W>() as u32;
    let mut out = Vec::new();
    if unsafe { Module32FirstW(snap.0, &mut entry) } == 0 {
        let e = unsafe { GetLastError() };
        return if e == ERROR_NO_MORE_FILES { Ok(out) } else { Err(win_error(e)) };
    }
    loop {
        out.push(Module { base: entry.base, size: entry.base_size, path: wide(&entry.path) });
        if unsafe { Module32NextW(snap.0, &mut entry) } == 0 {
            break;
        }
    }
    Ok(out)
}

/// Every module of a process. A process just started can have an empty list for a moment, so empty is retried.
// shortcut: retries an empty list for up to 1 s, then returns it empty; upgrade if a live process can keep an empty list.
pub fn modules(pid: u32) -> Result<Vec<Module>, String> {
    for _ in 0..40 {
        let mods = modules_once(pid)?;
        if !mods.is_empty() {
            return Ok(mods);
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command, Stdio};

    /// A child this test started, killed when the test ends.
    struct Kill(Child);
    impl Drop for Kill {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    fn spawn() -> Kill {
        Kill(Command::new("ping").args(["-n", "120", "127.0.0.1"]).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap())
    }

    /// Resumes the threads when the test ends, whatever happened in it.
    struct Resume(Vec<u32>);
    impl Drop for Resume {
        fn drop(&mut self) {
            resume_threads(&self.0);
        }
    }

    #[test]
    fn layouts_match_the_x64_headers() {
        assert_eq!(std::mem::size_of::<MemoryBasicInformation>(), 48);
        assert_eq!(std::mem::size_of::<ModuleEntry32W>(), 1080);
        assert_eq!(std::mem::size_of::<ObjectAttributes>(), 48);
        assert_eq!(std::mem::align_of::<Context>(), 16);
    }

    #[test]
    fn protection_names_and_numbers_go_both_ways() {
        assert_eq!(protect_name(0x40), "PAGE_EXECUTE_READWRITE");
        assert_eq!(protect_name(0x104), "PAGE_READWRITE | PAGE_GUARD");
        assert_eq!(protect_value("page_readwrite"), Ok(0x04));
        assert_eq!(protect_value("0x20"), Ok(0x20));
        assert_eq!(protect_value("64"), Ok(64));
        assert!(protect_value("nope").is_err() && protect_value("0x1FF").is_err());
    }

    #[test]
    fn a_truncated_process_list_is_refused_not_read_past() {
        assert!(parse_processes(&[1, 2, 3]).is_none());
        assert!(parse_processes(&[0u8; 40]).is_none());
    }

    #[test]
    fn the_live_list_has_the_child_with_wait_reasons() {
        let child = spawn();
        let pid = child.0.id();
        let procs = processes().unwrap();
        let me = procs.iter().find(|p| p.pid == pid).expect("child is listed");
        assert!(me.name.eq_ignore_ascii_case("ping.exe"), "{}", me.name);
        assert!(!me.threads.is_empty() && me.create_time > 0);
        assert!(me.threads.iter().all(|t| t.tid != 0 && wait_reason(t.wait) != "Unknown" && thread_state(t.state) != "Unknown"));
    }

    #[test]
    fn open_reports_granted_and_denied_rights() {
        let child = spawn();
        let p = probe_process(child.0.id());
        assert!(p.granted.contains(&"PROCESS_VM_READ") && p.granted.contains(&"PROCESS_QUERY_INFORMATION"), "{:?}", p.granted);
        let none = probe_process(0x7FFF_FFF0);
        assert!(none.granted.is_empty() && none.denied.len() == PROCESS_RIGHTS.len());
    }

    #[test]
    fn suspend_context_and_resume_round_trip() {
        let child = spawn();
        let pid = child.0.id();
        let tids: Vec<u32> = processes().unwrap().into_iter().find(|p| p.pid == pid).unwrap().threads.iter().map(|t| t.tid).collect();
        let _resume = Resume(tids.clone());
        for r in suspend_threads(&tids) {
            assert_eq!(r.unwrap(), 0);
        }
        for &t in &tids {
            assert_eq!(thread_suspend_count(t).unwrap(), 1);
        }
        let (mut ctx, count) = get_context(tids[0]).unwrap();
        assert_eq!(count, 1);
        assert!(ctx.rip != 0 && ctx.rsp != 0, "rip {:#x} rsp {:#x}", ctx.rip, ctx.rsp);
        let rip = ctx.rip;
        set_register(&mut ctx, "rax", 0x1234).unwrap();
        set_context(tids[0], &ctx).unwrap();
        let (again, _) = get_context(tids[0]).unwrap();
        assert_eq!((again.rip, again.rax), (rip, 0x1234));
        assert!(set_register(&mut ctx, "xmm0", 1).is_err());
        assert_eq!(resume_threads(&tids).iter().filter(|r| matches!(r, Ok(1))).count(), tids.len());
        assert_eq!(thread_suspend_count(tids[0]).unwrap(), 0);
    }

    #[test]
    fn a_running_thread_is_not_set() {
        let child = spawn();
        let tid = processes().unwrap().into_iter().find(|p| p.pid == child.0.id()).unwrap().threads[0].tid;
        let (ctx, count) = get_context(tid).unwrap();
        assert_eq!(count, 0);
        assert!(set_context(tid, &ctx).unwrap_err().contains("not suspended"));
    }

    #[test]
    fn modules_read_pages_across_a_boundary_and_report_partial() {
        let child = spawn();
        let pid = child.0.id();
        let mods = modules(pid).unwrap();
        let exe = mods.iter().find(|m| m.path.to_ascii_lowercase().ends_with("ping.exe")).unwrap_or_else(|| panic!("ping.exe not in modules: {:?}", mods.iter().map(|m| m.path.as_str()).collect::<Vec<_>>()));
        assert!(exe.size > 0);
        let p = open_process(pid, PROCESS_VM_READ | PROCESS_QUERY_INFORMATION).unwrap();
        assert_eq!(read_mem(&p, exe.base, 2).bytes, b"MZ");
        let across = read_mem(&p, exe.base + 4000, 300);
        assert_eq!((across.bytes.len(), across.note.is_none()), (300, true));
        let nothing = read_mem(&p, 0x10, 64);
        assert!(nothing.bytes.is_empty() && nothing.note.is_some());
        let region = query_mem(&p, exe.base).unwrap();
        assert_eq!((region.state, region.kind), (MEM_COMMIT, MEM_IMAGE));
    }

    #[test]
    fn alloc_write_protect_free_and_the_refusals_in_between() {
        let child = spawn();
        let p = open_process(child.0.id(), PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_QUERY_INFORMATION).unwrap();
        let a = alloc_mem(&p, 8192, PAGE_READWRITE).unwrap();
        let w = write_mem(&p, a, b"apim-test");
        assert_eq!((w.written, w.note.is_none()), (9, true));
        assert_eq!(read_mem(&p, a, 9).bytes, b"apim-test");
        let q = query_mem(&p, a).unwrap();
        assert_eq!((q.state, q.protect, q.size), (MEM_COMMIT, PAGE_READWRITE, 8192));
        assert_eq!(protect_mem(&p, a, 4096, PAGE_READONLY).unwrap(), PAGE_READWRITE);
        let refused = write_mem(&p, a, b"x");
        assert!(refused.written == 0 && refused.note.is_some(), "a read-only page took a write");
        assert_eq!(query_mem(&p, a + 4096).unwrap().protect, PAGE_READWRITE, "the second page was not asked for");
        protect_mem(&p, a, 4096, PAGE_READWRITE).unwrap();
        assert_eq!(write_mem(&p, a, b"ok").written, 2);
        free_mem(&p, a).unwrap();
        assert!(free_mem(&p, a).unwrap_err().contains("0x"));
    }
}
