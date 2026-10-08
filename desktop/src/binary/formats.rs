//! binaries.ts, the format-independent half: which kind of binary a file is (ELF, Mach-O, Java, DEX, WebAssembly...
//! by magic bytes, exactly as far as the web goes), the recursive DLL dependency graph, the workspace-level driver
//! that ties parsing, artifacts, the decompilers and the ledger together, and the report text the model reads.

use super::artifacts::*;
use super::decompiler::*;
use super::ledger::{InspectionRecord, record_binary_inspection};
use super::pe::*;
use super::types::*;
use crate::tools::files::{resolve, walk};
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub const MAX_DEPENDENCY_FILES: usize = 128;
pub const MAX_DEPENDENCY_DEPTH: usize = 8;
/// readFileBytes refuses anything larger than this.
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// Magic-byte detection for the formats Ghidra can still take apart. Everything else is "unknown binary" rather than refused.
pub fn detect_binary_format(bytes: &[u8], name: &str) -> (String, String) {
    let at = |i: usize| bytes.get(i).copied();
    if bytes.len() >= 5 && bytes[..4] == [0x7f, 0x45, 0x4c, 0x46] {
        let bits = if bytes[4] == 2 { "64-bit" } else { "32-bit" };
        let endian = if at(5) == Some(1) { "little-endian" } else { "big-endian" };
        return ("ELF".into(), format!("ELF {bits}, {endian}"));
    }
    let word = |i: usize, little: bool| -> u32 {
        match bytes.get(i..i + 4) {
            Some(s) if little => u32::from_le_bytes([s[0], s[1], s[2], s[3]]),
            Some(s) => u32::from_be_bytes([s[0], s[1], s[2], s[3]]),
            None => 0,
        }
    };
    let (u32le, u32be) = (word(0, true), word(0, false));
    let is_macho = |w: u32| w == 0xfeedface || w == 0xfeedfacf;
    if is_macho(u32le) || is_macho(u32be) {
        let cputype = if bytes.len() >= 8 { word(4, is_macho(u32le)) } else { 0 };
        // CPU_TYPE_ARM 12, ARM64 0x0100000C, X86 7, X86_64 0x01000007 (the high word marks the 64-bit variants).
        let arch = match cputype {
            0x0100000c => "arm64".to_string(),
            12 => "arm".to_string(),
            0x01000007 => "x86_64".to_string(),
            7 => "x86".to_string(),
            other => format!("cputype 0x{other:x}"),
        };
        return ("Mach-O".into(), format!("Mach-O {arch}"));
    }
    // 0xCAFEBABE is both a Mach-O fat header and a Java class file; the next word (slice count vs class version) tells them apart.
    if u32be == 0xcafebabe {
        let next = if bytes.len() >= 8 { word(4, false) } else { 0 };
        if (45..0x10000).contains(&next) {
            let major = next & 0xffff;
            let java = if major >= 49 { format!("Java {}", major - 44) } else { format!("JDK 1.{}", major - 44) };
            return ("Java class".into(), format!("JVM bytecode (class version {major}, {java})"));
        }
        return ("Mach-O universal".into(), "Mach-O universal (multi-arch)".into());
    }
    if u32le == 0xcafebabe {
        return ("Mach-O universal".into(), "Mach-O universal (multi-arch)".into());
    }
    if at(0) == Some(0x64) && at(1) == Some(0x65) && at(2) == Some(0x78) && at(3) == Some(0x0a) {
        let version: String = (4..7).map(|i| at(i).unwrap_or(0) as char).collect();
        return ("Android DEX".into(), format!("Dalvik bytecode (dex {version})"));
    }
    if at(0) == Some(0) && at(1) == Some(0x61) && at(2) == Some(0x73) && at(3) == Some(0x6d) {
        return ("WebAssembly".into(), format!("WebAssembly module (version {})", at(4).unwrap_or(0)));
    }
    if name.to_lowercase().ends_with(".pyc") && at(2) == Some(0x0d) && at(3) == Some(0x0a) {
        let magic = at(0).unwrap_or(0) as u32 | (at(1).unwrap_or(0) as u32) << 8;
        return ("Python bytecode".into(), format!("CPython bytecode (magic {magic})"));
    }
    // ZIP-based packages are identified by name, since every zip starts "PK".
    if at(0) == Some(0x50) && at(1) == Some(0x4b) {
        let lower = name.to_lowercase();
        if [".apk", ".aab", ".aar"].iter().any(|e| lower.ends_with(e)) {
            return ("Android package".into(), "ZIP package (classes*.dex, resources, native libs)".into());
        }
        if [".jar", ".war", ".ear"].iter().any(|e| lower.ends_with(e)) {
            return ("Java archive".into(), "ZIP package of JVM classes".into());
        }
    }
    ("unknown binary".into(), "unknown".into())
}

/// The inspection of a real binary that is not a Windows executable: format, size, hashes and strings, with the PE-only layers empty.
// ponytail: like the web, ELF and Mach-O get magic-byte detection only (no sections, symbols or imports); Ghidra, when installed, does the rest.
pub fn inspect_generic_binary(bytes: &[u8], opts: &StringOptions, name: &str) -> PeInspection {
    let (format, architecture) = detect_binary_format(bytes, name);
    non_pe_inspection(bytes, &format, &architecture, "n/a", opts, "PE-only packing heuristics do not apply; the entropy layer below still shows high-entropy regions.", vec![], "unknown", false)
}

#[derive(Clone, Debug)]
pub struct DependencyNode {
    pub name: String,
    pub requested_by: String,
    /// local | system | external | managed | cycle | limit
    pub kind: &'static str,
    pub path: Option<String>,
    pub architecture: Option<String>,
    pub imports: Option<usize>,
    pub children: Vec<DependencyNode>,
    pub note: Option<String>,
}

/// Everything `inspect_binary` can be asked for.
#[derive(Clone, Debug, Default)]
pub struct InspectBinaryOptions {
    pub strings: StringOptions,
    pub dependencies: Option<bool>,
    pub max_depth: Option<f64>,
    pub artifacts: Option<bool>,
    pub artifact_layers: Option<StaticArtifactLayers>,
    pub run_capa: Option<bool>,
    pub deep: Option<bool>,
    pub force_deep: bool,
    pub focus_terms: Vec<String>,
    pub focused_only: Option<bool>,
    pub analyzers: AnalyzerOverrides,
    pub allow_full_fallback: bool,
}

pub struct WorkspaceBinaryInspection {
    pub path: String,
    pub inspection: PeInspection,
    pub dependencies: Vec<DependencyNode>,
    pub local_files_inspected: usize,
    pub unresolved_libraries: Vec<String>,
    pub artifacts: StaticBinaryArtifacts,
    pub capa: CapaAnalysisResult,
    pub deep: DeepDecompilationResult,
}

/// The parsed file and its static layers, before the optional external tools run.
pub struct StaticPart {
    pub inspection: PeInspection,
    pub dependencies: Vec<DependencyNode>,
    pub local_files_inspected: usize,
    pub unresolved_libraries: Vec<String>,
    pub artifacts: StaticBinaryArtifacts,
}

/// `assertBinaryUpload`: a PE-named file must start with an MZ header; any other name is kept as opaque bytes.
pub fn assert_binary_upload(bytes: &[u8], name: &str) -> Result<(), String> {
    if is_pe_filename(name) && (bytes.len() < 64 || bytes[0] != 0x4d || bytes[1] != 0x5a) {
        return Err(format!("{name} does not have a Windows MZ executable header."));
    }
    Ok(())
}

/// `assertPeUpload`: the stricter check for places that only take Windows executables.
pub fn assert_pe_upload(bytes: &[u8], name: &str) -> Result<(), String> {
    if !is_pe_filename(name) {
        return Err(format!("{name} is not a supported Windows executable/library filename."));
    }
    assert_binary_upload(bytes, name)
}

fn basename(value: &str) -> String {
    base_name(value)
}

fn dirname(value: &str) -> String {
    let normal = value.replace('\\', "/");
    normal.rfind('/').map_or(String::new(), |at| normal[..at].to_string())
}

/// `path.posix.join(dir, name)` for the relative paths used here.
fn posix_join(dir: &str, name: &str) -> String {
    let joined = format!("{dir}/{name}");
    let absolute = joined.starts_with('/');
    let mut stack: Vec<&str> = Vec::new();
    for seg in joined.split('/').filter(|s| !s.is_empty() && *s != ".") {
        if seg == ".." {
            if stack.last().is_some_and(|l| *l != "..") {
                stack.pop();
            } else if !absolute {
                stack.push("..");
            }
        } else {
            stack.push(seg);
        }
    }
    let body = stack.join("/");
    match (absolute, body.is_empty()) {
        (true, true) => "/".into(),
        (true, false) => format!("/{body}"),
        (false, true) => ".".into(),
        (false, false) => body,
    }
}

fn join_relative(dir: &str, name: &str) -> String {
    if dir.is_empty() { name.to_string() } else { posix_join(dir, name) }
}

struct DependencyContext<'a> {
    root: &'a Path,
    files_by_base: HashMap<String, Vec<String>>,
    max_depth: usize,
    inspected: HashMap<String, PeInspection>,
    visiting: HashSet<String>,
    unresolved: HashSet<String>,
    count: usize,
}

fn resolve_local_library(requested: &str, parent_path: &str, files_by_base: &HashMap<String, Vec<String>>) -> Option<String> {
    let candidates = files_by_base.get(&basename(requested).to_lowercase())?;
    if candidates.is_empty() {
        return None;
    }
    let wanted_same = join_relative(&dirname(parent_path), &basename(requested)).to_lowercase();
    if let Some(same) = candidates.iter().find(|c| c.to_lowercase() == wanted_same) {
        return Some(same.clone());
    }
    let mut sorted = candidates.clone();
    sorted.sort_by(|a, b| a.chars().count().cmp(&b.chars().count()).then_with(|| locale_cmp(a, b)));
    sorted.into_iter().next()
}

/// `readFileBytes`: the file's bytes, with the web's wording when it cannot be read.
pub fn read_file_bytes(root: &Path, relative: &str) -> Result<Vec<u8>, String> {
    if relative.trim().is_empty() {
        return Err("Path is required".into());
    }
    let target = resolve(root, relative)?;
    let meta = std::fs::metadata(&target).map_err(|_| format!("No such file: {relative}"))?;
    if !meta.is_file() {
        return Err(format!("{relative} is not a file"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("{relative} is too large to read"));
    }
    if meta.len() > MAX_BINARY_ANALYSIS_BYTES {
        return Err(format!("Executable is {}MB; static analysis is capped at {}MB.", to_fixed(meta.len() as f64 / 1024.0 / 1024.0, 1), MAX_BINARY_ANALYSIS_BYTES / 1024 / 1024));
    }
    std::fs::read(&target).map_err(|e| e.to_string())
}

fn dependency_children(source_path: &str, inspection: &PeInspection, depth: usize, ctx: &mut DependencyContext) -> Vec<DependencyNode> {
    let mut nodes = Vec::new();
    let mut requests: Vec<(String, bool)> = inspection.imports.iter().map(|x| (x.dll.clone(), false)).collect();
    if let Some(m) = &inspection.managed {
        requests.extend(m.references.iter().map(|x| (format!("{}.dll", x.name), true)));
    }
    let mut seen = HashSet::new();
    let node = |name: &str, kind: &'static str, path: Option<String>, note: Option<String>| DependencyNode { name: name.into(), requested_by: source_path.into(), kind, path, architecture: None, imports: None, children: vec![], note };

    for (name, managed) in requests {
        if !seen.insert(format!("{}{}", if managed { "managed:" } else { "native:" }, name.to_lowercase())) {
            continue;
        }
        let Some(local) = resolve_local_library(&name, source_path, &ctx.files_by_base) else {
            let kind = if managed { "managed" } else if is_system_library(&name) { "system" } else { "external" };
            if kind == "external" || kind == "managed" {
                ctx.unresolved.insert(name.clone());
            }
            let note = if kind == "system" {
                "Windows/system runtime; API names are listed in the import table."
            } else if managed {
                "Managed assembly reference; no matching DLL was supplied in this workspace."
            } else {
                "Not present in this workspace. It may be installed beside the app or loaded from Windows/PATH at runtime."
            };
            nodes.push(node(&name, kind, None, Some(note.into())));
            continue;
        };
        let local_key = local.to_lowercase();
        if ctx.visiting.contains(&local_key) {
            nodes.push(node(&name, "cycle", Some(local), Some("Dependency cycle; already on this branch.".into())));
            continue;
        }
        if depth >= ctx.max_depth || ctx.count >= MAX_DEPENDENCY_FILES {
            let note = if depth >= ctx.max_depth { format!("Depth limit {} reached.", ctx.max_depth) } else { format!("File limit {MAX_DEPENDENCY_FILES} reached.") };
            nodes.push(node(&name, "limit", Some(local), Some(note)));
            continue;
        }
        let child = match ctx.inspected.get(&local_key) {
            Some(c) => c.clone(),
            None => {
                let parsed = read_file_bytes(ctx.root, &local).and_then(|bytes| inspect_portable_executable(&bytes, &StringOptions { include_strings: Some(false), ..Default::default() }));
                match parsed {
                    Ok(c) => {
                        ctx.inspected.insert(local_key.clone(), c.clone());
                        ctx.count += 1;
                        c
                    }
                    Err(e) => {
                        nodes.push(node(&name, "local", Some(local), Some(format!("Found locally but could not parse: {e}"))));
                        continue;
                    }
                }
            }
        };
        ctx.visiting.insert(local_key.clone());
        let children = dependency_children(&local, &child, depth + 1, ctx);
        ctx.visiting.remove(&local_key);
        let mut n = node(&name, "local", Some(local), if child.architecture != inspection.architecture { Some(format!("Architecture differs from parent ({}).", inspection.architecture)) } else { None });
        n.architecture = Some(child.architecture.clone());
        n.imports = Some(child.imports.iter().map(|x| x.functions.len() + x.ordinals.len()).sum());
        n.children = children;
        nodes.push(n);
    }
    nodes
}

/// Reads, parses and (for PE) walks the DLLs supplied beside it, then writes the requested static artifacts.
pub fn inspect_static(root: &Path, target: &str, opts: &InspectBinaryOptions) -> Result<StaticPart, String> {
    let bytes = read_file_bytes(root, target)?;
    let inspection = match inspect_portable_executable(&bytes, &opts.strings) {
        Ok(i) => i,
        // A missing MZ header is no longer a hard refusal: ELF/Mach-O/unknown files still get hashes, strings, entropy and carves.
        Err(e) if e.to_lowercase().contains("mz header") => inspect_generic_binary(&bytes, &opts.strings, target),
        Err(e) => return Err(e),
    };
    let mut dependencies = Vec::new();
    let mut unresolved: HashSet<String> = HashSet::new();
    let mut local_files_inspected = 1;
    if opts.dependencies != Some(false) && inspection.format.starts_with("PE") {
        let mut files_by_base: HashMap<String, Vec<String>> = HashMap::new();
        for (path, _) in walk(root, root) {
            files_by_base.entry(basename(&path).to_lowercase()).or_default().push(path);
        }
        let mut ctx = DependencyContext {
            root,
            files_by_base,
            max_depth: clamp_number(opts.max_depth, 4.0, 0.0, MAX_DEPENDENCY_DEPTH as f64) as usize,
            inspected: HashMap::from([(target.to_lowercase(), inspection.clone())]),
            visiting: HashSet::from([target.to_lowercase()]),
            unresolved: HashSet::new(),
            count: 1,
        };
        dependencies = dependency_children(target, &inspection, 0, &mut ctx);
        local_files_inspected = ctx.count;
        unresolved = ctx.unresolved;
    }
    let static_requested = opts.artifacts != Some(false) && opts.artifact_layers.is_none_or(|l| l.summary || l.strings || l.entropy || l.carve);
    // force_decompile means what it says: a failed rerun must not regenerate already complete strings/entropy/carves.
    let artifacts = if static_requested { generate_static_binary_artifacts(root, target, &bytes, &inspection, false, opts.artifact_layers)? } else { StaticBinaryArtifacts::none() };
    let mut unresolved_libraries: Vec<String> = unresolved.into_iter().collect();
    unresolved_libraries.sort_by(|a, b| locale_cmp(a, b));
    Ok(StaticPart { inspection, dependencies, local_files_inspected, unresolved_libraries, artifacts })
}

/// Runs capa and a decompiler one after the other (both are CPU-heavy), then records the result in the ledger.
pub async fn finish_inspection(root: &Path, target: &str, part: StaticPart, opts: &InspectBinaryOptions) -> WorkspaceBinaryInspection {
    finish_inspection_with(&Tools::from_env(), root, target, part, opts).await
}

pub async fn finish_inspection_with(tools: &Tools, root: &Path, target: &str, part: StaticPart, opts: &InspectBinaryOptions) -> WorkspaceBinaryInspection {
    let capa = run_capa_analysis_with(tools, root, target, &part.inspection, false, opts.run_capa != Some(false)).await;
    let deep = if opts.deep == Some(false) {
        DeepDecompilationResult::disabled()
    } else {
        let o = DeepOptions { force: opts.force_deep, focus_terms: opts.focus_terms.clone(), focused_only: opts.focused_only, analyzers: opts.analyzers.clone(), allow_full_fallback: opts.allow_full_fallback };
        run_deep_decompilation_with(tools, root, target, &part.inspection, &o).await
    };
    // deepRan tells a real CPU run from a cache hit, which is what makes "already decompiled" trustworthy.
    let deep_ran = deep.attempted && !deep.cached && matches!(deep.status, "complete" | "partial" | "failed");
    let p = &part.inspection;
    record_binary_inspection(
        root,
        InspectionRecord {
            path: target.into(),
            sha256: p.hashes.sha256.clone(),
            size: p.bytes as u64,
            architecture: Some(p.architecture.clone()),
            is_dll: Some(p.is_dll),
            managed: Some(p.managed.is_some()),
            static_status: Some("ok".into()),
            deep_status: Some(deep.status.into()),
            deep_engine: Some(deep.engine.into()),
            deep_cached: Some(deep.cached),
            deep_focus_terms: Some(opts.focus_terms.clone()),
            capa_status: Some(capa.status.into()),
            outputs: part.artifacts.outputs.iter().chain(&deep.outputs).chain(capa.output.iter()).cloned().collect(),
            analysis_root: Some(binary_analysis_root(target, &p.hashes.sha256)),
            deep_ran,
        },
    );
    WorkspaceBinaryInspection { path: target.into(), inspection: part.inspection, dependencies: part.dependencies, local_files_inspected: part.local_files_inspected, unresolved_libraries: part.unresolved_libraries, artifacts: part.artifacts, capa, deep }
}

fn hex(value: i64) -> String {
    format!("0x{value:08x}")
}

fn dependency_lines(nodes: &[DependencyNode], prefix: &str) -> Vec<String> {
    let mut lines = Vec::new();
    for (index, node) in nodes.iter().enumerate() {
        let last = index == nodes.len() - 1;
        let branch = if last { "└─" } else { "├─" };
        let detail = match &node.path {
            Some(p) => format!(" → {p}{}", node.architecture.as_ref().map_or(String::new(), |a| format!(" [{a}]"))),
            None => format!(" [{}]", node.kind),
        };
        lines.push(format!("{prefix}{branch} {}{detail}{}", node.name, node.note.as_ref().map_or(String::new(), |n| format!(" — {n}"))));
        if !node.children.is_empty() {
            lines.extend(dependency_lines(&node.children, &format!("{prefix}{}", if last { "   " } else { "│  " })));
        }
    }
    lines
}

/// What to do with a format that is not a native executable, so the agent does not "decompile" a zip.
fn format_next_step(format: &str) -> Option<&'static str> {
    Some(match format {
        "Java archive" => "this is a ZIP package — extract_archive it (force:true) to get the .class files, then inspect the classes you need; Ghidra imports JVM class files.",
        "Android package" => "this is a ZIP package — extract_archive it (force:true) to get classes*.dex, lib/<abi>/*.so and resources; inspect the .dex (Ghidra imports Dalvik) or the native .so files.",
        "Java class" => "JVM bytecode — the strings layer shows class, method and constant names; Ghidra (when installed) imports class files for a decompile.",
        "Android DEX" => "Dalvik bytecode — the strings layer shows class and method names; Ghidra (when installed) imports DEX for a decompile.",
        "WebAssembly" => "a WebAssembly module — strings show import/export names; stock Ghidra has no WebAssembly importer, so rely on strings, or a wasm2wat/wasm-decompile install via run_command.",
        "Python bytecode" => "compiled Python — strings show names and constants; the version magic says which Python made it.",
        _ => return None,
    })
}

fn yes_no(b: bool) -> &'static str {
    if b { "yes" } else { "no" }
}

/// Stable, bounded text for the model.
pub fn format_binary_inspection(result: &WorkspaceBinaryInspection) -> String {
    let p = &result.inspection;
    let is_pe = p.format.starts_with("PE");
    let mut lines: Vec<String> = vec![
        format!("Binary: {}", result.path),
        format!("Format: {} · {} · {}", p.format, p.architecture, if p.is_dll { "DLL/library".to_string() } else if is_pe { p.subsystem.clone() } else { "native binary".to_string() }),
        format!("Size: {} bytes · SHA-256: {}", group(p.bytes), p.hashes.sha256),
        format!("MD5: {} · SHA-1: {}{}", p.hashes.md5, p.hashes.sha1, p.hashes.imphash.as_ref().map_or(String::new(), |h| format!(" · imphash: {h}"))),
    ];
    if let Some(next) = format_next_step(&p.format) {
        lines.push(format!("Next step: {next}"));
    }

    if is_pe {
        lines.push(format!("Entry point: {} · image base {} · mapped size {} bytes", hex(p.entry_point_rva), p.image_base, group(p.size_of_image)));
        lines.push(format!("Build timestamp: {}", p.timestamp_iso.clone().unwrap_or_else(|| format!("unreliable/raw {}", p.timestamp))));
        let m = &p.mitigations;
        lines.push(format!("Mitigations: ASLR {}, DEP {}, CFG {}, high-entropy VA {}", yes_no(m.aslr), yes_no(m.dep), yes_no(m.control_flow_guard), yes_no(m.high_entropy_va)));
        lines.push(format!("Authenticode envelope: {}", if p.authenticode.present { format!("present ({} bytes; trust NOT verified)", p.authenticode.size) } else { "not present".into() }));
        lines.push(format!("Packed assessment: {} ({}/100 heuristic){}", p.packing.status, p.packing.score, p.packing.known_packer.as_ref().map_or(String::new(), |k| format!(" · marker {k}"))));
        lines.extend(p.packing.reasons.iter().map(|r| format!("  - {r}")));
    }

    if !p.version_info.0.is_empty() {
        lines.push(String::new());
        lines.push("Version information:".into());
        lines.extend(p.version_info.0.iter().map(|(k, v)| format!("  {k}: {v}")));
    }
    if let Some(m) = &p.managed {
        lines.push(String::new());
        lines.push(format!(".NET managed assembly: {}{}", m.name.as_deref().unwrap_or("name unavailable"), m.version.as_ref().map_or(String::new(), |v| format!(" {v}"))));
        lines.push(format!("CLR metadata version: {}", m.runtime_version.as_deref().unwrap_or("unknown")));
        if !m.references.is_empty() {
            lines.push(format!("Managed references ({}):", m.references.len()));
            lines.extend(m.references.iter().take(300).map(|r| format!("  {}, Version={}", r.name, r.version)));
        }
    }

    if !p.sections.is_empty() {
        lines.push(String::new());
        lines.push(format!("Sections ({}):", p.sections.len()));
        lines.push("  name       RVA       virtual   raw       entropy  permissions".into());
        for s in &p.sections {
            let perms = format!("{}{}{}", if s.readable { "R" } else { "-" }, if s.writable { "W" } else { "-" }, if s.executable { "X" } else { "-" });
            let name: String = format!("{:<10}", s.name).chars().take(10).collect();
            lines.push(format!("  {name} {} {:>9} {:>9} {:>8}  {perms}", hex(s.virtual_address), s.virtual_size, s.raw_size, to_fixed(s.entropy, 3)));
        }
    }

    if !p.imports.is_empty() {
        lines.push(String::new());
        lines.push(format!("Imported libraries ({}):", p.imports.len()));
        for item in &p.imports {
            let functions: Vec<String> = item.functions.iter().take(300).cloned().chain(item.ordinals.iter().take(100).map(|n| format!("#{n}"))).collect();
            let cut = item.truncated || item.functions.len() > 300 || item.ordinals.len() > 100;
            lines.push(format!("  {}{} — {}{}", item.dll, if item.delay_loaded { " (delay-loaded)" } else { "" }, if functions.is_empty() { "no named imports recovered".to_string() } else { functions.join(", ") }, if cut { " … [truncated]" } else { "" }));
        }
    }

    if !p.highlighted_imports.is_empty() {
        lines.push(String::new());
        lines.push("High-interest imported APIs (capability evidence, not a malware verdict):".into());
        for item in &p.highlighted_imports {
            lines.push(format!("  {}: {}!{}{}", item.category, item.dll, item.function, if item.delay_loaded { " (delay-loaded)" } else { "" }));
        }
    }

    if !p.exports.is_empty() {
        lines.push(String::new());
        lines.push(format!("Exports ({}{}):", p.exports.len(), if p.truncated.exports { ", truncated" } else { "" }));
        for item in p.exports.iter().take(1000) {
            lines.push(format!("  {} @ {}{}", item.name.clone().unwrap_or_else(|| format!("#{}", item.ordinal)), hex(item.rva), item.forwarder.as_ref().map_or(String::new(), |f| format!(" → {f}"))));
        }
        if p.exports.len() > 1000 {
            lines.push(format!("  … {} more not printed", p.exports.len() - 1000));
        }
    }

    if !p.pdb_paths.is_empty() {
        lines.push(String::new());
        lines.push("Debug/PDB paths:".into());
        lines.extend(p.pdb_paths.iter().map(|x| format!("  {x}")));
    }
    if p.overlay_bytes != 0 {
        lines.push(String::new());
        lines.push(format!("Overlay/appended data: {} bytes", group(p.overlay_bytes)));
    }
    if !p.indicators.is_empty() {
        lines.push(String::new());
        lines.push("Structural observations (not malware verdicts):".into());
        lines.extend(p.indicators.iter().map(|x| format!("  - {x}")));
    }

    if !result.dependencies.is_empty() {
        lines.push(String::new());
        lines.push(format!("Dependency graph ({} local PE file(s) parsed):", result.local_files_inspected));
        lines.push(result.path.clone());
        lines.extend(dependency_lines(&result.dependencies, ""));
    }
    if !p.possible_dynamic_libraries.is_empty() {
        lines.push(String::new());
        lines.push("Possible runtime-loaded libraries found in strings (not proven imports):".into());
        lines.extend(p.possible_dynamic_libraries.iter().map(|x| format!("  {x}")));
    }

    if !p.strings.is_empty() {
        lines.push(String::new());
        lines.push(format!("Selected strings ({}{}):", p.strings.len(), if p.truncated.strings { ", more exist" } else { "" }));
        lines.extend(p.strings.iter().map(|v| format!("  {}", json_units(v))));
    }

    let layers = &result.artifacts.layers;
    if layers.summary || layers.strings || layers.entropy || layers.carve {
        lines.push(String::new());
        lines.push(format!("Static artifacts{}: {}", if result.artifacts.cached { " (cached)" } else { "" }, result.artifacts.summary));
        if layers.strings {
            lines.push(format!("  Full strings: {} record(s){}", group(result.artifacts.strings.count as i64), if result.artifacts.strings.truncated { " (output cap reached)" } else { "" }));
        }
        if layers.entropy {
            let e = &result.artifacts.entropy;
            lines.push(format!("  Entropy map: {} × {}-byte windows; min {}, average {}, max {}", group(e.windows as i64), e.window_bytes, js_num(e.min), js_num(e.average), js_num(e.max)));
        }
        if layers.carve {
            lines.push(format!("  Carved blobs: {}", result.artifacts.carved.len()));
        }
    }
    if !result.artifacts.outputs.is_empty() {
        lines.push("Static artifact files:".into());
        lines.extend(result.artifacts.outputs.iter().take(200).map(|o| format!("  {o}")));
    }

    if result.capa.status != "disabled" {
        lines.push(String::new());
        lines.push(format!("capa: {}{}", result.capa.status, if result.capa.cached { " (cached)" } else { "" }));
        lines.push(result.capa.summary.clone());
        if let Some(o) = &result.capa.output {
            lines.push(format!("  {o}"));
        }
        if let Some(s) = &result.capa.setup {
            lines.push(format!("capa setup needed: {s}"));
        }
    }

    if result.deep.status != "disabled" || result.deep.summary.contains("was not started") {
        lines.push(String::new());
        lines.push(format!("Deep decompilation: {} via {}{}", result.deep.status, result.deep.engine, if result.deep.cached { " (cached)" } else { "" }));
        lines.push(result.deep.summary.clone());
    }
    if !result.deep.outputs.is_empty() {
        lines.push("Decompiler artifact files:".into());
        lines.extend(result.deep.outputs.iter().take(200).map(|o| format!("  {o}")));
    }
    if let Some(s) = &result.deep.setup {
        lines.push(format!("Setup needed for deeper output: {s}"));
    }
    if let Some(tail) = result.deep.log_tail.as_ref().filter(|t| !t.is_empty())
        && result.deep.status != "complete"
    {
        lines.push("Decompiler log tail (actual captured stdout/stderr):".into());
        lines.push(tail.clone());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binary::pe::samples;

    fn elf() -> Vec<u8> {
        let mut b = vec![0u8; 64];
        b[..4].copy_from_slice(b"\x7fELF");
        b[4] = 2;
        b[5] = 1;
        b[16] = 3; // ET_DYN
        b[18] = 0x3e;
        b.extend_from_slice(b"libc.so.6\0GLIBC_2.2.5\0/lib64/ld-linux-x86-64.so.2\0");
        b
    }

    #[test]
    fn detects_formats_by_magic() {
        assert_eq!(detect_binary_format(&elf(), "a.out"), ("ELF".to_string(), "ELF 64-bit, little-endian".to_string()));
        assert_eq!(detect_binary_format(b"\x7fELF\x01", "x").1, "ELF 32-bit, big-endian");
        let macho = [0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0, 0, 0, 0];
        assert_eq!(detect_binary_format(&macho, "m").1, "Mach-O arm64");
        let macho_be = [0xfe, 0xed, 0xfa, 0xce, 0x00, 0x00, 0x00, 0x07];
        assert_eq!(detect_binary_format(&macho_be, "m").1, "Mach-O x86");
        assert_eq!(detect_binary_format(&[0xfe, 0xed, 0xfa, 0xcf, 0x12, 0x34, 0x56, 0x78], "m").1, "Mach-O cputype 0x12345678");
        let class = [0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52];
        assert_eq!(detect_binary_format(&class, "A.class"), ("Java class".to_string(), "JVM bytecode (class version 52, Java 8)".to_string()));
        assert_eq!(detect_binary_format(&[0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2], "fat").0, "Mach-O universal");
        assert_eq!(detect_binary_format(b"dex\n035\0", "classes.dex").1, "Dalvik bytecode (dex 035)");
        assert_eq!(detect_binary_format(b"\0asm\x01\0\0\0", "m.wasm").1, "WebAssembly module (version 1)");
        assert_eq!(detect_binary_format(&[0x55, 0x0d, 0x0d, 0x0a], "x.PYC").1, "CPython bytecode (magic 3413)");
        assert_eq!(detect_binary_format(b"PK\x03\x04", "app.apk").0, "Android package");
        assert_eq!(detect_binary_format(b"PK\x03\x04", "lib.JAR").0, "Java archive");
        assert_eq!(detect_binary_format(b"PK\x03\x04", "a.zip").0, "unknown binary");
        assert_eq!(detect_binary_format(b"", "").1, "unknown");
    }

    #[test]
    fn upload_checks_use_the_web_wording() {
        assert_eq!(assert_binary_upload(b"MZ", "a.exe").unwrap_err(), "a.exe does not have a Windows MZ executable header.");
        assert!(assert_binary_upload(b"not a pe at all", "lib.so").is_ok());
        let mut ok = vec![0u8; 64];
        ok[..2].copy_from_slice(b"MZ");
        assert!(assert_pe_upload(&ok, "a.dll").is_ok());
        assert_eq!(assert_pe_upload(&ok, "a.so").unwrap_err(), "a.so is not a supported Windows executable/library filename.");
    }

    #[test]
    fn posix_paths_and_local_library_choice() {
        assert_eq!(posix_join("a/./b", "../c.dll"), "a/c.dll");
        assert_eq!(posix_join("..", "x"), "../x");
        assert_eq!(dirname("a\\b\\c.exe"), "a/b");
        let mut by_base: HashMap<String, Vec<String>> = HashMap::new();
        by_base.insert("x.dll".into(), vec!["deep/er/x.dll".into(), "libs/x.dll".into(), "App/X.dll".into()]);
        assert_eq!(resolve_local_library("X.DLL", "App\\main.exe", &by_base).as_deref(), Some("App/X.dll"));
        assert_eq!(resolve_local_library("x.dll", "other/main.exe", &by_base).as_deref(), Some("App/X.dll"));
        assert_eq!(resolve_local_library("nothing.dll", "a.exe", &by_base), None);
    }

    #[tokio::test]
    async fn inspects_an_elf_and_reports_like_the_web() {
        let root = test_dir("formats-elf");
        std::fs::create_dir_all(root.join("uploads")).unwrap();
        std::fs::write(root.join("uploads/prog"), elf()).unwrap();
        let opts = InspectBinaryOptions { artifacts: Some(false), deep: Some(false), run_capa: Some(false), ..Default::default() };
        let part = inspect_static(&root, "uploads/prog", &opts).unwrap();
        assert_eq!((part.inspection.format.as_str(), part.dependencies.len(), part.local_files_inspected), ("ELF", 0, 1));
        let tools = Tools { ilspy: "x/y".into(), ghidra: "x/y".into(), capa: "x/y".into() };
        let result = finish_inspection_with(&tools, &root, "uploads/prog", part, &opts).await;
        let text = format_binary_inspection(&result);
        assert!(text.starts_with("Binary: uploads/prog\nFormat: ELF · ELF 64-bit, little-endian · native binary\nSize: 114 bytes · SHA-256: "), "{text}");
        assert!(text.contains("\nSelected strings (") && text.contains("):\n  \"/lib64/ld-linux-x86-64.so.2\"\n  \"GLIBC_2.2.5\"\n  \"libc.so.6\"\n"), "{text}");
        assert!(!text.contains("Entry point") && !text.contains("Static artifacts"));
        let ledger = crate::binary::ledger::read_binary_ledger(&root);
        assert_eq!(ledger.entries.len(), 1);
        assert_eq!(ledger.entries[0].1.deep_status.as_deref(), Some("disabled"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn walks_local_dependencies() {
        let root = test_dir("formats-deps");
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(root.join("app/main.exe"), samples::pe64()).unwrap();
        // KERNEL32.dll resolves to a local copy; user32/SHELL32 stay system libraries.
        std::fs::write(root.join("app/kernel32.dll"), samples::pe32_managed()).unwrap();
        let opts = InspectBinaryOptions { artifacts: Some(false), ..Default::default() };
        let part = inspect_static(&root, "app/main.exe", &opts).unwrap();
        let names: Vec<(&str, &str)> = part.dependencies.iter().map(|d| (d.name.as_str(), d.kind)).collect();
        assert_eq!(names, [("KERNEL32.dll", "local"), ("SHELL32.dll", "system"), ("user32.dll", "system")]);
        assert_eq!(part.dependencies[0].note.as_deref(), Some("Architecture differs from parent (x86-64)."));
        assert_eq!(part.local_files_inspected, 2);
        let managed_children: Vec<&str> = part.dependencies[0].children.iter().map(|d| d.kind).collect();
        assert_eq!(managed_children, ["managed", "managed"]);
        assert_eq!(part.unresolved_libraries, ["mscorlib.dll", "System.Core.dll"]);
        let tools = Tools { ilspy: "x/y".into(), ghidra: "x/y".into(), capa: "x/y".into() };
        let result = finish_inspection_with(&tools, &root, "app/main.exe", part, &opts).await;
        let text = format_binary_inspection(&result);
        assert!(text.contains("Dependency graph (2 local PE file(s) parsed):\napp/main.exe\n├─ KERNEL32.dll → app/kernel32.dll [x86] — Architecture differs from parent (x86-64).\n│  ├─ mscorlib.dll [managed] — Managed assembly reference; no matching DLL was supplied in this workspace.\n│  └─ System.Core.dll [managed]"), "{text}");
        assert!(text.contains("└─ user32.dll [system] — Windows/system runtime; API names are listed in the import table."));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn errors_use_the_web_wording() {
        let root = test_dir("formats-errors");
        let opts = InspectBinaryOptions::default();
        let err = |t: &str| inspect_static(&root, t, &opts).err().unwrap();
        assert_eq!(err(""), "Path is required");
        assert_eq!(err("nope.exe"), "No such file: nope.exe");
        std::fs::create_dir_all(root.join("dir")).unwrap();
        assert_eq!(err("dir"), "dir is not a file");
        std::fs::write(root.join("bad.exe"), b"MZ").unwrap();
        // too short for a PE: falls back to the generic path rather than failing
        let part = inspect_static(&root, "bad.exe", &InspectBinaryOptions { artifacts: Some(false), ..Default::default() }).unwrap();
        assert_eq!(part.inspection.format, "unknown binary");
        std::fs::remove_dir_all(&root).ok();
    }
}
