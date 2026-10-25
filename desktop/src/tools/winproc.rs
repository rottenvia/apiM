//! The `winproc` tools: Windows processes the user did not start, through `crate::winproc`.
//! Each call opens its own handles and closes them. Batched calls answer item by item.
//! Windows only: elsewhere every call is refused.

use serde_json::{Value, json};

/// Every tool here, by name. The schemas and the dispatch are built from this list.
pub const NAMES: &[&str] = &[
    "os_processes", "open", "threads", "suspend", "resume", "get_context", "set_context",
    "read_mem", "write_mem", "query_mem", "protect_mem", "alloc_mem", "free_mem", "modules",
];

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({ "type": "function", "function": { "name": name, "description": description,
        "parameters": { "type": "object", "properties": properties, "required": required } } })
}

fn pid_prop() -> Value {
    json!({ "type": "number", "description": "Process id of any process on this computer." })
}
fn tid_prop() -> Value {
    json!({ "type": "number", "description": "Thread id." })
}
fn addr_prop() -> Value {
    json!({ "type": "string", "description": "Address: hex such as 0x7FF6A0001000, or decimal." })
}
fn size_prop() -> Value {
    json!({ "type": "number", "description": "Size in bytes." })
}
fn tids_prop() -> Value {
    json!({ "type": "array", "items": { "type": "number" }, "description": "Thread ids; one call handles them all." })
}

pub fn schemas() -> Vec<Value> {
    vec![
        tool("os_processes", "Every process on this computer: pid, exe name, thread count, start time, and the wait reason of its threads. Give pid for one process with each thread listed (tid, state, wait); without pid each process shows a count of its threads' wait reasons.", json!({ "pid": pid_prop() }), &[]),
        tool("open", "Open a process with each right in turn: which rights were granted and which denied, with the Windows reason for each denial.", json!({ "pid": pid_prop() }), &["pid"]),
        tool("threads", "The threads of a process: tid, start address, suspend count, priority, state and wait reason.", json!({ "pid": pid_prop() }), &["pid"]),
        tool("suspend", "Suspend many threads in one call. Each result is the suspend count before the call (0 means it was running).", json!({ "tids": tids_prop() }), &["tids"]),
        tool("resume", "Resume many threads in one call. Each result is the suspend count before the call.", json!({ "tids": tids_prop() }), &["tids"]),
        tool("get_context", "A thread's registers: rip, rsp, the general registers, eflags, and its suspend count. Suspend the thread first for a reliable read.", json!({ "tid": tid_prop() }), &["tid"]),
        tool("set_context", "Change registers of a suspended thread. values is an object of register name to value, e.g. {\"rip\": \"0x7FF6A0001000\", \"rax\": 1}. Names: rax..r15, rip, rsp, eflags. The thread must be suspended.", json!({ "tid": tid_prop(), "values": { "type": "object", "description": "Register name to value." } }), &["tid", "values"]),
        tool("read_mem", "Read memory of a process: a list of reads, each {addr, size}, in one call. A page that cannot be read stops that read early; each result says how many bytes it got. Output shows up to 4096 bytes of each read, in hex.", json!({ "pid": pid_prop(), "reads": { "type": "array", "items": { "type": "object", "properties": { "addr": addr_prop(), "size": size_prop() }, "required": ["addr", "size"] } } }), &["pid", "reads"]),
        tool("write_mem", "Write memory of a process: a list of writes, each {addr, hex}, in one call. hex is the bytes in hex, spaces allowed. Each result says how many bytes were written; a read-only page stops that write.", json!({ "pid": pid_prop(), "writes": { "type": "array", "items": { "type": "object", "properties": { "addr": addr_prop(), "hex": { "type": "string" } }, "required": ["addr", "hex"] } } }), &["pid", "writes"]),
        tool("query_mem", "The memory region at an address (VirtualQueryEx): base, size, state, protect, type.", json!({ "pid": pid_prop(), "addr": addr_prop() }), &["pid", "addr"]),
        tool("protect_mem", "Change the protection of the pages in a range (VirtualProtectEx). Returns the previous protection and says when write access is removed. Only the range given changes. new is a name such as PAGE_READWRITE or a number such as 0x04.", json!({ "pid": pid_prop(), "addr": addr_prop(), "size": size_prop(), "new": { "type": "string", "description": "Protection name or number." } }), &["pid", "addr", "size", "new"]),
        tool("alloc_mem", "Allocate and commit memory in a process (VirtualAllocEx). Returns the address, or the Windows error with its code.", json!({ "pid": pid_prop(), "size": size_prop(), "prot": { "type": "string", "description": "Protection, default PAGE_READWRITE." } }), &["pid", "size"]),
        tool("free_mem", "Free a block that alloc_mem returned (VirtualFreeEx, MEM_RELEASE).", json!({ "pid": pid_prop(), "addr": addr_prop() }), &["pid", "addr"]),
        tool("modules", "The modules loaded in a process: base, size, path.", json!({ "pid": pid_prop() }), &["pid"]),
    ]
}

#[cfg(windows)]
pub use imp::run;

#[cfg(not(windows))]
pub fn run(_name: &str, _args: &Value) -> crate::tools::Output {
    crate::tools::Output::fail("The winproc tools work on Windows only.")
}

#[cfg(windows)]
mod imp {
    use crate::tools::Output;
    use crate::winproc as wp;
    use crate::winproc::{PROCESS_QUERY_INFORMATION, PROCESS_VM_OPERATION, PROCESS_VM_READ, PROCESS_VM_WRITE};
    use serde_json::{Value, json};
    use std::collections::BTreeMap;

    /// Most bytes one read may ask for, and most of one read shown in the reply.
    const READ_MAX: usize = 16 << 20;
    const SHOWN: usize = 4096;
    /// PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY.
    const WRITABLE: u32 = 0xCC;

    pub fn run(name: &str, args: &Value) -> Output {
        let result = match name {
            "os_processes" => os_processes(args),
            "open" => open(args),
            "threads" => threads(args),
            "suspend" => batch(args, wp::suspend_threads, "Suspended"),
            "resume" => batch(args, wp::resume_threads, "Resumed"),
            "get_context" => get_context(args),
            "set_context" => set_context(args),
            "read_mem" => read_mem(args),
            "write_mem" => write_mem(args),
            "query_mem" => query_mem(args),
            "protect_mem" => protect_mem(args),
            "alloc_mem" => alloc_mem(args),
            "free_mem" => free_mem(args),
            "modules" => modules(args),
            _ => Err(format!("No winproc tool named {name}.")),
        };
        result.unwrap_or_else(|why| Output::fail(why))
    }

    /// A number, given as a JSON number or as text.
    fn uint(v: &Value) -> Option<u64> {
        v.as_u64().or_else(|| v.as_str()?.trim().parse().ok())
    }

    /// An address: a JSON number, decimal text, or hex text with 0x.
    fn addr_of(v: &Value) -> Option<usize> {
        match v {
            Value::String(s) => {
                let s = s.trim();
                match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
                    Some(h) => usize::from_str_radix(h, 16).ok(),
                    None => s.parse().ok(),
                }
            }
            _ => uint(v).map(|n| n as usize),
        }
    }

    fn hex<T: std::fmt::UpperHex>(a: T) -> String {
        format!("0x{a:X}")
    }

    fn pid(args: &Value) -> Result<u32, String> {
        uint(&args["pid"]).filter(|p| (1..=u32::MAX as u64).contains(p)).map(|p| p as u32).ok_or_else(|| "Give pid: the number of a process on this computer.".to_string())
    }

    fn tid_of(v: &Value) -> Result<u32, String> {
        uint(v).filter(|t| *t <= u32::MAX as u64).map(|t| t as u32).ok_or_else(|| format!("{v} is not a thread id"))
    }

    fn tid_arg(args: &Value, key: &str) -> Result<u32, String> {
        tid_of(&args[key]).map_err(|_| format!("Give {key} as a thread id."))
    }

    fn list<'a>(args: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
        args[key].as_array().ok_or_else(|| format!("Give {key} as a list."))
    }

    fn to_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn from_hex(text: &str) -> Result<Vec<u8>, String> {
        let digits: Vec<u8> = text.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
        if digits.len() % 2 != 0 {
            return Err("hex needs an even number of digits".into());
        }
        digits
            .chunks(2)
            .map(|pair| {
                if !pair.iter().all(u8::is_ascii_hexdigit) {
                    return Err(format!("\"{}\" is not a hex byte", String::from_utf8_lossy(pair)));
                }
                Ok(u8::from_str_radix(std::str::from_utf8(pair).unwrap_or("0"), 16).unwrap_or(0))
            })
            .collect()
    }

    /// FILETIME (100 ns ticks since 1601 UTC) as a UTC date and time.
    fn started(filetime: u64) -> String {
        let secs = (filetime / 10_000_000) as i64 - 11_644_473_600;
        chrono::DateTime::from_timestamp(secs, 0).map(|t| t.format("%Y-%m-%d %H:%M:%S UTC").to_string()).unwrap_or_default()
    }

    fn os_processes(args: &Value) -> Result<Output, String> {
        let want = uint(&args["pid"]);
        let procs = wp::processes()?;
        if want.is_some_and(|w| !procs.iter().any(|p| p.pid as u64 == w)) {
            return Err(format!("No process {} on this computer right now.", want.unwrap_or(0)));
        }
        let rows: Vec<Value> = procs
            .iter()
            .filter(|p| want.is_none_or(|w| p.pid as u64 == w))
            .map(|p| {
                let mut row = json!({ "pid": p.pid, "name": p.name, "threads": p.threads.len(), "started": started(p.create_time) });
                if want.is_some() {
                    row["thread_list"] = json!(p.threads.iter().map(|t| json!({ "tid": t.tid, "state": wp::thread_state(t.state), "wait": wp::wait_reason(t.wait) })).collect::<Vec<_>>());
                } else {
                    let mut waits: BTreeMap<&str, usize> = BTreeMap::new();
                    for t in &p.threads {
                        *waits.entry(wp::wait_reason(t.wait)).or_default() += 1;
                    }
                    row["waits"] = json!(waits);
                }
                row
            })
            .collect();
        let n = rows.len();
        Ok(Output::ok(Value::Array(rows).to_string(), format!("Listed {n} processes")))
    }

    fn open(args: &Value) -> Result<Output, String> {
        let id = pid(args)?;
        let p = wp::probe_process(id);
        let denied: Vec<Value> = p.denied.iter().map(|(right, why)| json!({ "right": right, "why": why })).collect();
        let text = json!({ "pid": id, "granted": p.granted, "denied": denied });
        Ok(Output::ok(text.to_string(), format!("{} rights granted, {} denied on {id}", p.granted.len(), p.denied.len())))
    }

    fn threads(args: &Value) -> Result<Output, String> {
        let id = pid(args)?;
        let procs = wp::processes()?;
        let process = procs.iter().find(|p| p.pid == id).ok_or_else(|| format!("No process {id} on this computer right now."))?;
        let rows: Vec<Value> = process
            .threads
            .iter()
            .map(|t| {
                let suspend = match wp::thread_suspend_count(t.tid) {
                    Ok(c) => json!(c),
                    Err(why) => json!(format!("unknown: {why}")),
                };
                json!({ "tid": t.tid, "start": hex(t.start), "suspend_count": suspend, "priority": t.priority, "base_priority": t.base_priority, "state": wp::thread_state(t.state), "wait": wp::wait_reason(t.wait) })
            })
            .collect();
        let n = rows.len();
        Ok(Output::ok(Value::Array(rows).to_string(), format!("{n} threads in {id}")))
    }

    /// Runs one thread operation over every tid in the list; each result is kept by its tid.
    fn batch(args: &Value, op: fn(&[u32]) -> Vec<Result<u32, String>>, verb: &str) -> Result<Output, String> {
        let tids: Vec<u32> = list(args, "tids")?.iter().map(tid_of).collect::<Result<_, _>>()?;
        let rows: Vec<Value> = tids
            .iter()
            .zip(op(&tids))
            .map(|(t, r)| match r {
                Ok(before) => json!({ "tid": t, "before": before }),
                Err(why) => json!({ "tid": t, "error": why }),
            })
            .collect();
        let failed = rows.iter().filter(|r| r.get("error").is_some()).count();
        Ok(Output { ok: failed == 0, text: Value::Array(rows).to_string(), summary: format!("{verb} {} threads, {failed} failed", tids.len()), ..Default::default() })
    }

    fn get_context(args: &Value) -> Result<Output, String> {
        let tid = tid_arg(args, "tid")?;
        let (ctx, count) = wp::get_context(tid)?;
        let mut regs = serde_json::Map::new();
        for (name, value) in wp::registers(&ctx) {
            regs.insert(name.to_string(), json!(hex(value)));
        }
        let text = json!({ "tid": tid, "suspend_count": count, "registers": regs });
        Ok(Output::ok(text.to_string(), format!("Registers of thread {tid}, rip {}", hex(ctx.rip))))
    }

    fn set_context(args: &Value) -> Result<Output, String> {
        let tid = tid_arg(args, "tid")?;
        let changes = args["values"].as_object().ok_or("Give values as an object of register names to values, such as {\"rip\": \"0x...\"}.")?;
        let (mut ctx, _) = wp::get_context(tid)?;
        for (name, value) in changes {
            let v = addr_of(value).ok_or_else(|| format!("{name} needs a number or a hex value"))?;
            wp::set_register(&mut ctx, name, v as u64)?;
        }
        wp::set_context(tid, &ctx)?;
        let text = json!({ "tid": tid, "rip": hex(ctx.rip), "rsp": hex(ctx.rsp), "changed": changes.len() });
        Ok(Output::ok(text.to_string(), format!("Set {} registers of thread {tid}", changes.len())))
    }

    fn read_mem(args: &Value) -> Result<Output, String> {
        let p = wp::open_process(pid(args)?, PROCESS_VM_READ | PROCESS_QUERY_INFORMATION)?;
        let mut rows = Vec::new();
        let mut total = 0usize;
        for item in list(args, "reads")? {
            let addr = addr_of(&item["addr"]).ok_or("Each read needs addr.")?;
            let size = uint(&item["size"]).ok_or("Each read needs size.")? as usize;
            if size > READ_MAX {
                rows.push(json!({ "addr": hex(addr), "error": format!("{size} bytes is more than one read may ask for ({READ_MAX})") }));
                continue;
            }
            let r = wp::read_mem(&p, addr, size);
            total += r.bytes.len();
            let shown = r.bytes.len().min(SHOWN);
            rows.push(json!({ "addr": hex(addr), "asked": size, "read": r.bytes.len(), "shown": shown, "hex": to_hex(&r.bytes[..shown]), "note": r.note }));
        }
        Ok(Output::ok(Value::Array(rows).to_string(), format!("Read {total} bytes")))
    }

    fn write_mem(args: &Value) -> Result<Output, String> {
        let p = wp::open_process(pid(args)?, PROCESS_VM_WRITE | PROCESS_VM_OPERATION | PROCESS_QUERY_INFORMATION)?;
        let mut rows = Vec::new();
        let mut total = 0usize;
        for item in list(args, "writes")? {
            let addr = addr_of(&item["addr"]).ok_or("Each write needs addr.")?;
            let data = from_hex(item["hex"].as_str().unwrap_or(""))?;
            let w = wp::write_mem(&p, addr, &data);
            total += w.written;
            rows.push(json!({ "addr": hex(addr), "asked": data.len(), "written": w.written, "note": w.note }));
        }
        Ok(Output::ok(Value::Array(rows).to_string(), format!("Wrote {total} bytes")))
    }

    fn query_mem(args: &Value) -> Result<Output, String> {
        let p = wp::open_process(pid(args)?, PROCESS_QUERY_INFORMATION)?;
        let addr = addr_of(&args["addr"]).ok_or("Give addr: hex such as 0x7FF6A0001000.")?;
        let r = wp::query_mem(&p, addr)?;
        let text = json!({ "base": hex(r.base), "size": r.size, "alloc_base": hex(r.alloc_base), "alloc_protect": wp::protect_name(r.alloc_protect), "state": wp::state_name(r.state), "protect": wp::protect_name(r.protect), "type": wp::kind_name(r.kind) });
        Ok(Output::ok(text.to_string(), format!("{} at {}", wp::state_name(r.state), hex(r.base))))
    }

    fn protect_mem(args: &Value) -> Result<Output, String> {
        let p = wp::open_process(pid(args)?, PROCESS_VM_OPERATION | PROCESS_QUERY_INFORMATION)?;
        let addr = addr_of(&args["addr"]).ok_or("Give addr: hex such as 0x7FF6A0001000.")?;
        let size = uint(&args["size"]).ok_or("Give size in bytes.")? as usize;
        let spelled = match &args["new"] {
            Value::Number(n) => n.to_string(),
            v => v.as_str().unwrap_or("").to_string(),
        };
        let new = wp::protect_value(&spelled)?;
        let old = wp::protect_mem(&p, addr, size, new)?;
        // The first page's previous protection is returned; pages of other protections in the range all change to `new`.
        // shortcut: the previous value is the first page's only, upgrade by querying each region when a range spans several.
        let note = (old & WRITABLE != 0 && new & WRITABLE == 0).then(|| "write access was removed from these pages; ask for it back with protect_mem if that was not intended".to_string());
        let text = json!({ "addr": hex(addr), "size": size, "previous": wp::protect_name(old), "new": wp::protect_name(new), "note": note });
        Ok(Output::ok(text.to_string(), format!("{} -> {}", wp::protect_name(old), wp::protect_name(new))))
    }

    fn alloc_mem(args: &Value) -> Result<Output, String> {
        let p = wp::open_process(pid(args)?, PROCESS_VM_OPERATION | PROCESS_QUERY_INFORMATION)?;
        let size = uint(&args["size"]).filter(|s| *s > 0).ok_or("Give size in bytes, more than 0.")? as usize;
        let prot = wp::protect_value(args["prot"].as_str().unwrap_or("PAGE_READWRITE"))?;
        let addr = wp::alloc_mem(&p, size, prot)?;
        Ok(Output::ok(json!({ "addr": hex(addr), "size": size, "prot": wp::protect_name(prot) }).to_string(), format!("Allocated {size} bytes at {}", hex(addr))))
    }

    fn free_mem(args: &Value) -> Result<Output, String> {
        let p = wp::open_process(pid(args)?, PROCESS_VM_OPERATION | PROCESS_QUERY_INFORMATION)?;
        let addr = addr_of(&args["addr"]).ok_or("Give addr: the address alloc_mem returned.")?;
        wp::free_mem(&p, addr)?;
        Ok(Output::ok(json!({ "freed": hex(addr) }).to_string(), format!("Freed {}", hex(addr))))
    }

    fn modules(args: &Value) -> Result<Output, String> {
        let id = pid(args)?;
        let mods = wp::modules(id)?;
        let rows: Vec<Value> = mods.iter().map(|m| json!({ "base": hex(m.base), "size": m.size, "path": m.path })).collect();
        let n = rows.len();
        Ok(Output::ok(Value::Array(rows).to_string(), format!("{n} modules in {id}")))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn hex_round_trips_and_refuses_junk() {
            assert_eq!(from_hex("de ad 00").unwrap(), vec![0xde, 0xad, 0]);
            assert!(from_hex("abc").is_err() && from_hex("+f").is_err() && from_hex("zz").is_err());
            assert_eq!(to_hex(&[0xde, 0x0a]), "de0a");
        }

        #[test]
        fn addresses_take_hex_or_decimal() {
            assert_eq!(addr_of(&json!("0x7FF0")), Some(0x7FF0));
            assert_eq!(addr_of(&json!(4096)), Some(4096));
            assert_eq!(addr_of(&json!("nope")), None);
        }

        #[test]
        fn every_tool_has_a_schema_and_a_handler() {
            let schemas = crate::tools::winproc::schemas();
            assert_eq!(schemas.len(), crate::tools::winproc::NAMES.len());
            for name in crate::tools::winproc::NAMES {
                assert!(schemas.iter().any(|t| t["function"]["name"] == *name), "{name} has no schema");
                assert!(!run(name, &json!({})).text.starts_with("No winproc tool"), "{name} has no handler");
            }
        }
    }
}
