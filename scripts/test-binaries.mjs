/**
 * Executable inspection regression suite.
 *
 * The fixtures are synthetic PE files built byte-for-byte here. Nothing is
 * downloaded and nothing is executed, so failures point at the parser rather
 * than a compiler/toolchain that may not exist on the machine running tests.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import { finishSuite } from "./lib/proc.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_ROOT = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.join(ROOT, "data");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const B = await load("src/lib/binaries.ts");
const BT = await load("src/lib/binary-types.ts");
const W = await load("src/lib/workspace.ts");
const T = await load("src/lib/tools.ts");
const AR = await load("src/lib/archive.ts");
const P = await load("src/lib/plan.ts");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);
let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const ascii = (bytes, at, value) => {
  for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
  bytes[at + value.length] = 0;
};
const utf16 = (view, at, value) => {
  for (let i = 0; i < value.length; i++) view.setUint16(at + i * 2, value.charCodeAt(i), true);
  view.setUint16(at + value.length * 2, 0, true);
};
const section = (bytes, view, at, name, va, vs, raw, rawSize, flags) => {
  ascii(bytes, at, name);
  view.setUint32(at + 8, vs, true);
  view.setUint32(at + 12, va, true);
  view.setUint32(at + 16, rawSize, true);
  view.setUint32(at + 20, raw, true);
  view.setUint32(at + 36, flags, true);
};

function makePe({ dll = false, managed = false, customImport = true } = {}) {
  const bytes = new Uint8Array(0x1400);
  const v = new DataView(bytes.buffer);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  v.setUint32(0x3c, 0x80, true);
  bytes.set([0x50, 0x45, 0, 0], 0x80);

  const coff = 0x84;
  v.setUint16(coff, 0x8664, true);
  v.setUint16(coff + 2, 2, true);
  v.setUint32(coff + 4, 0x65000000, true);
  v.setUint16(coff + 16, 0xf0, true);
  v.setUint16(coff + 18, 0x0022 | (dll ? 0x2000 : 0), true);

  const opt = 0x98;
  v.setUint16(opt, 0x20b, true);
  v.setUint32(opt + 16, 0x1000, true);
  v.setBigUint64(opt + 24, BigInt("0x140000000"), true);
  v.setUint32(opt + 32, 0x1000, true);
  v.setUint32(opt + 36, 0x200, true);
  v.setUint32(opt + 56, 0x3000, true);
  v.setUint32(opt + 60, 0x200, true);
  v.setUint16(opt + 68, 3, true);
  v.setUint16(opt + 70, 0x4140, true); // ASLR, DEP, CFG
  v.setUint32(opt + 108, 16, true);
  const dirs = opt + 112;
  v.setUint32(dirs + 0 * 8, 0x2380, true);
  v.setUint32(dirs + 0 * 8 + 4, 0x70, true);
  v.setUint32(dirs + 1 * 8, 0x2000, true);
  v.setUint32(dirs + 1 * 8 + 4, 0x50, true);
  v.setUint32(dirs + 4 * 8, 0x1200, true);
  v.setUint32(dirs + 4 * 8 + 4, 0x20, true);
  v.setUint32(dirs + 6 * 8, 0x2300, true);
  v.setUint32(dirs + 6 * 8 + 4, 28, true);
  v.setUint32(dirs + 13 * 8, 0x2100, true);
  v.setUint32(dirs + 13 * 8 + 4, 64, true);
  if (managed) {
    v.setUint32(dirs + 14 * 8, 0x2400, true);
    v.setUint32(dirs + 14 * 8 + 4, 0x48, true);
  }

  const table = opt + 0xf0;
  section(bytes, v, table, ".text", 0x1000, 0x180, 0x200, 0x200, 0x60000020);
  section(bytes, v, table + 40, ".rdata", 0x2000, 0x800, 0x400, 0x800, 0x40000040);
  bytes.fill(0x90, 0x200, 0x380);

  // IMAGE_IMPORT_DESCRIPTOR entries.
  v.setUint32(0x400, 0x2050, true);
  v.setUint32(0x400 + 12, 0x2080, true);
  v.setUint32(0x400 + 16, 0x2050, true);
  let descriptorEnd = 0x414;
  if (customImport) {
    v.setUint32(0x414, 0x20e0, true);
    v.setUint32(0x414 + 12, 0x2090, true);
    v.setUint32(0x414 + 16, 0x20e0, true);
    descriptorEnd = 0x428;
  }
  bytes.fill(0, descriptorEnd, descriptorEnd + 20);
  v.setBigUint64(0x450, BigInt(0x20a0), true);
  v.setBigUint64(0x458, BigInt(0x21a0), true);
  v.setBigUint64(0x460, BigInt(0x21c0), true);
  v.setBigUint64(0x468, BigInt(0), true);
  if (customImport) {
    v.setBigUint64(0x4e0, BigInt(0x20c0), true);
    v.setBigUint64(0x4e8, BigInt(0), true);
  }
  ascii(bytes, 0x480, "KERNEL32.dll");
  if (customImport) ascii(bytes, 0x490, "custom.dll");
  v.setUint16(0x4a0, 0, true);
  ascii(bytes, 0x4a2, "CreateRemoteThread");
  if (customImport) {
    v.setUint16(0x4c0, 0, true);
    ascii(bytes, 0x4c2, "WriteProcessMemory");
  }

  // IMAGE_DELAYLOAD_DESCRIPTOR and its import-name table.
  v.setUint32(0x500, 1, true); // fields are RVAs
  v.setUint32(0x504, 0x2150, true);
  v.setUint32(0x50c, 0x2160, true);
  v.setUint32(0x510, 0x2160, true);
  ascii(bytes, 0x550, "delay.dll");
  v.setBigUint64(0x560, BigInt(0x2180), true);
  v.setBigUint64(0x568, BigInt(0), true);
  v.setUint16(0x580, 0, true);
  ascii(bytes, 0x582, "luaL_loadfilex");
  v.setUint16(0x5a0, 0, true);
  ascii(bytes, 0x5a2, "CreateProcessW");
  v.setUint16(0x5c0, 0, true);
  ascii(bytes, 0x5c2, "LoadLibraryW");

  // One named export at RVA 0x1000.
  const exp = 0x780;
  v.setUint32(exp + 12, 0x23c0, true);
  v.setUint32(exp + 16, 1, true);
  v.setUint32(exp + 20, 1, true);
  v.setUint32(exp + 24, 1, true);
  v.setUint32(exp + 28, 0x23d0, true);
  v.setUint32(exp + 32, 0x23d8, true);
  v.setUint32(exp + 36, 0x23e0, true);
  ascii(bytes, 0x7c0, dll ? "fixture.dll" : "fixture.exe");
  v.setUint32(0x7d0, 0x1000, true);
  v.setUint32(0x7d8, 0x23e8, true);
  v.setUint16(0x7e0, 0, true);
  ascii(bytes, 0x7e8, "ExportedWork");

  // A VS_VERSION_INFO string block found through the resource-style layout.
  const block = 0x600;
  const key = "ProductName";
  const value = "Fixture Analyzer";
  v.setUint16(block + 2, value.length + 1, true);
  v.setUint16(block + 4, 1, true);
  utf16(v, block + 6, key);
  let valueAt = block + 6 + (key.length + 1) * 2;
  valueAt = (valueAt + 3) & ~3;
  utf16(v, valueAt, value);
  v.setUint16(block, valueAt + (value.length + 1) * 2 - block, true);
  ascii(bytes, 0x680, "plugin-runtime.dll");
  utf16(v, 0x6a0, "https://fixture.invalid/api");

  // IMAGE_DEBUG_DIRECTORY plus an RSDS/PDB record.
  v.setUint32(0x700 + 12, 2, true);
  v.setUint32(0x700 + 16, 80, true);
  v.setUint32(0x700 + 20, 0x2340, true);
  v.setUint32(0x700 + 24, 0x740, true);
  ascii(bytes, 0x740, "RSDS");
  ascii(bytes, 0x758, "C:\\build\\fixture.pdb");

  if (managed) {
    // IMAGE_COR20_HEADER.
    v.setUint32(0x800, 0x48, true);
    v.setUint16(0x804, 2, true);
    v.setUint16(0x806, 5, true);
    v.setUint32(0x808, 0x2500, true);
    v.setUint32(0x80c, 0x300, true);
    v.setUint32(0x810, 1, true); // COMIMAGE_FLAGS_ILONLY

    const meta = 0x900;
    v.setUint32(meta, 0x424a5342, true);
    v.setUint16(meta + 4, 1, true);
    v.setUint16(meta + 6, 1, true);
    v.setUint32(meta + 12, 12, true);
    ascii(bytes, meta + 16, "v4.0.30319");
    v.setUint16(meta + 28, 0, true);
    v.setUint16(meta + 30, 2, true);
    v.setUint32(meta + 32, 0x80, true);
    v.setUint32(meta + 36, 0x100, true);
    ascii(bytes, meta + 40, "#~");
    v.setUint32(meta + 44, 0x200, true);
    v.setUint32(meta + 48, 0x80, true);
    ascii(bytes, meta + 52, "#Strings");

    const tables = meta + 0x80;
    bytes[tables + 4] = 2;
    bytes[tables + 5] = 0;
    bytes[tables + 6] = 0;
    v.setBigUint64(tables + 8, (BigInt(1) << BigInt(32)) | (BigInt(1) << BigInt(35)), true);
    v.setBigUint64(tables + 16, BigInt(0), true);
    v.setUint32(tables + 24, 1, true);
    v.setUint32(tables + 28, 1, true);
    const assembly = tables + 32;
    v.setUint32(assembly, 0x8004, true);
    v.setUint16(assembly + 4, 1, true);
    v.setUint16(assembly + 6, 2, true);
    v.setUint16(assembly + 8, 3, true);
    v.setUint16(assembly + 10, 4, true);
    v.setUint16(assembly + 18, 1, true);
    const ref = assembly + 22;
    v.setUint16(ref, 8, true);
    v.setUint16(ref + 2, 0, true);
    v.setUint16(ref + 4, 0, true);
    v.setUint16(ref + 6, 0, true);
    v.setUint16(ref + 14, 7, true);
    ascii(bytes, meta + 0x200, "");
    ascii(bytes, meta + 0x201, "MyApp");
    ascii(bytes, meta + 0x207, "System.Runtime");
  }

  // A structurally present but unverified WIN_CERTIFICATE envelope.
  v.setUint32(0x1200, 0x20, true);
  v.setUint16(0x1204, 0x0200, true);
  v.setUint16(0x1206, 0x0002, true);
  return bytes;
}

console.log("\napiM executable inspection checks\n");

console.log("1. The built-in PE parser reads structure, not binary garbage");
const native = B.inspectPortableExecutable(makePe(), { includeStrings: true });
check("detects a 64-bit PE", native.format === "PE32+" && native.architecture === "x86-64");
check("detects console vs DLL", native.subsystem === "Windows console" && native.isDll === false);
check("reports ASLR, DEP and CFG", native.mitigations.aslr && native.mitigations.dep && native.mitigations.controlFlowGuard);
check("hashes exact bytes", /^[a-f0-9]{64}$/.test(native.hashes.sha256) && /^[a-f0-9]{32}$/.test(native.hashes.md5));
check("parses sections and permissions", native.sections.length === 2 && native.sections[0].executable && !native.sections[0].writable);
check("parses imported DLLs", native.imports.some((x) => x.dll === "KERNEL32.dll") && native.imports.some((x) => x.dll === "custom.dll"));
check("parses imported function names", native.imports.some((x) => x.functions.includes("CreateRemoteThread")) && native.imports.some((x) => x.functions.includes("WriteProcessMemory")));
check(
  "parses delay-loaded libraries and functions separately",
  native.imports.some(
    (x) =>
      x.dll === "delay.dll" &&
      x.delayLoaded &&
      x.functions.includes("luaL_loadfilex")
  )
);
check(
  "parses named exports and addresses",
  native.exports.some(
    (x) => x.name === "ExportedWork" && x.ordinal === 1 && x.rva === 0x1000
  )
);
check("computes an imphash", /^[a-f0-9]{32}$/.test(native.hashes.imphash ?? ""));
check(
  "reports an explicit packing assessment rather than only raw entropy",
  native.packing.status === "unlikely" && native.packing.score >= 0,
  JSON.stringify(native.packing)
);
const packedFixture = makePe();
ascii(packedFixture, 0x188, "UPX0");
const packed = B.inspectPortableExecutable(packedFixture, {
  includeStrings: false,
});
check(
  "known packer section markers produce a likely assessment",
  packed.packing.status === "likely" && packed.packing.knownPacker === "UPX",
  JSON.stringify(packed.packing)
);
check(
  "high-interest imports are grouped without calling them a malware verdict",
  native.highlightedImports.some(
    (item) =>
      item.function === "CreateRemoteThread" &&
      item.category === "process injection/memory"
  ) &&
    native.highlightedImports.some(
      (item) => item.function === "luaL_loadfilex" && item.category === "Lua API"
    ) &&
    native.highlightedImports.some(
      (item) =>
        item.function === "LoadLibraryW" &&
        item.category === "library loading/API resolution"
    ) &&
    native.highlightedImports.some(
      (item) =>
        item.function === "CreateProcessW" && item.category === "process creation"
    )
);
check("reads version resources", native.versionInfo.ProductName === "Fixture Analyzer", JSON.stringify(native.versionInfo));
check("recovers PDB paths", native.pdbPaths.some((x) => x.endsWith("fixture.pdb")), native.pdbPaths.join(", "));
check("names but does not verify the signing envelope", native.authenticode.present && native.authenticode.verified === false);
check("finds likely runtime-loaded DLL strings", native.possibleDynamicLibraries.includes("plugin-runtime.dll"));
check(
  "extracts ranked ASCII and UTF-16 strings",
  native.strings.some((x) => x.includes("fixture.invalid")),
  native.strings.filter((x) => /fixture|http/i.test(x)).join(" | ")
);
check("reports appended overlay bytes", native.overlayBytes > 0, String(native.overlayBytes));

console.log("\n2. Managed metadata is understood before any external decompiler exists");
const managed = B.inspectPortableExecutable(makePe({ managed: true }));
check("detects a CLR assembly", managed.managed !== null);
check("reads assembly identity", managed.managed?.name === "MyApp" && managed.managed?.version === "1.2.3.4", JSON.stringify(managed.managed));
check("reads managed assembly references", managed.managed?.references.some((x) => x.name === "System.Runtime" && x.version === "8.0.0.0"));

console.log("\n3. Malformed and legacy files fail honestly");
let bad = "";
try {
  B.inspectPortableExecutable(new Uint8Array([1, 2, 3, 4]));
} catch (error) {
  bad = String(error?.message ?? error);
}
check("non-executables are rejected", /MZ header/.test(bad), bad);
const legacyBytes = new Uint8Array(128);
legacyBytes[0] = 0x4d;
legacyBytes[1] = 0x5a;
new DataView(legacyBytes.buffer).setUint32(0x3c, 0x40, true);
legacyBytes.set([0x4e, 0x45], 0x40);
const legacy = B.inspectPortableExecutable(legacyBytes);
check("legacy NE executables are named, not misparsed as PE", legacy.format === "DOS/NE");

console.log("\n4. Workspace dependency graph follows supplied DLLs only");
const WS = "binary-test";
await fs.rm(path.join(DATA_ROOT, "workspaces"), { recursive: true, force: true });
await W.writeFileBytes(WS, "uploads/binaries/app.exe", Buffer.from(makePe()));
await W.writeFileBytes(
  WS,
  "uploads/binaries/custom.dll",
  Buffer.from(makePe({ dll: true, customImport: false }))
);
await W.writeFileBytes(
  WS,
  "uploads/binaries/managed.exe",
  Buffer.from(makePe({ managed: true }))
);
let result = await B.inspectWorkspaceBinary(WS, "uploads/binaries/app.exe", {
  deep: false,
  dependencies: true,
  includeStrings: false,
});
const local = result.dependencies.find((x) => x.name.toLowerCase() === "custom.dll");
const system = result.dependencies.find((x) => x.name.toLowerCase() === "kernel32.dll");
check("matching local DLLs are recursively parsed", local?.kind === "local" && local.path === "uploads/binaries/custom.dll", JSON.stringify(local));
check("Windows DLLs are labelled without escaping the workspace", system?.kind === "system" && !system.path);
check("the local child carries its own imports", local?.children?.some((x) => x.name.toLowerCase() === "kernel32.dll"));
check("dependency parsing is bounded and counted", result.localFilesInspected === 2);

console.log("\n5. Full static artifacts are exhaustive, mapped and carved");
const rootBytes = makePe();
const childBytes = makePe({ dll: true, customImport: false });
const artifactBytes = new Uint8Array(0x3600);
artifactBytes.set(rootBytes, 0);
artifactBytes.set(childBytes, 0x1400);
artifactBytes.set([0x1b, 0x4c, 0x75, 0x61, 0x54, 0x00, 0x19, 0x93], 0x2800);
ascii(artifactBytes, 0x2810, "embedded_lua_chunk_string");
ascii(artifactBytes, 0x2900, "%PDF-1.4\nembedded document\n%%EOF");
ascii(
  artifactBytes,
  0x2a00,
  "local value = require('game') function CreateMove(cmd) if IN_JUMP then return value end end"
);
await W.writeFileBytes(
  WS,
  "uploads/binaries/artifact.exe",
  Buffer.from(artifactBytes)
);
const artifactResult = await B.inspectWorkspaceBinary(
  WS,
  "uploads/binaries/artifact.exe",
  {
    deep: false,
    runCapa: false,
    dependencies: false,
    includeStrings: true,
    artifacts: true,
  }
);
check(
  "full strings are written with offsets and both encodings",
  artifactResult.artifacts.strings.count > 0 &&
    artifactResult.artifacts.strings.outputs.some((output) =>
      output.includes("full-strings-ascii")
    ) &&
    artifactResult.artifacts.strings.outputs.some((output) =>
      output.includes("full-strings-utf16le")
    )
);
const fullStringsText = (
  await Promise.all(
    artifactResult.artifacts.strings.outputs.map((output) =>
      fs.readFile(path.join(W.workspaceDirectory(WS), output), "utf8")
    )
  )
).join("\n");
check(
  "the full dump contains strings omitted from a bounded chat selection",
  /CreateMove/.test(fullStringsText) && /^offset\tencoding\tlength\tvalue/m.test(fullStringsText)
);
check(
  "entropy is mapped in 4KB windows with offsets and section names",
  artifactResult.artifacts.entropy.windowBytes === 4096 &&
    artifactResult.artifacts.entropy.windows === Math.ceil(artifactBytes.length / 4096) &&
    artifactResult.artifacts.entropy.outputs.some((output) =>
      /entropy-map-\d+\.tsv$/.test(output)
    )
);
check(
  "embedded PE, Lua bytecode, Lua source and PDF blobs are carved",
  ["PE", "Lua bytecode", "Lua source", "PDF"].every((kind) =>
    artifactResult.artifacts.carved.some((blob) => blob.kind === kind)
  ),
  artifactResult.artifacts.carved.map((blob) => blob.kind).join(", ")
);
check(
  "every carved blob gets its own strings artifacts",
  artifactResult.artifacts.carved.every(
    (blob) => blob.strings.length > 0 && blob.strings.every((output) => output.includes("carved/strings"))
  )
);
check(
  "the complete PE summary is persisted as JSON",
  artifactResult.artifacts.outputs.some((output) => /pe-summary\.json$/.test(output))
);
const artifactCached = await B.inspectWorkspaceBinary(
  WS,
  "uploads/binaries/artifact.exe",
  {
    deep: false,
    runCapa: false,
    dependencies: false,
    includeStrings: false,
    artifacts: true,
  }
);
check(
  "static chunks stay below search_files' per-file ceiling",
  (
    await Promise.all(
      artifactResult.artifacts.outputs
        .filter((output) => /strings|entropy-map/.test(output))
        .map((output) => fs.stat(path.join(W.workspaceDirectory(WS), output)))
    )
  ).every((stat) => stat.size < 512 * 1024)
);
check(
  "full static artifacts are hash-cached too",
  artifactCached.artifacts.cached &&
    artifactCached.artifacts.outputs.length === artifactResult.artifacts.outputs.length
);

console.log("\n6. Deep results are hash-cached instead of burning CPU twice");
const hash = result.inspection.hashes.sha256;
const cacheDir = path.join(W.workspaceDirectory(WS), "analysis", `app-${hash.slice(0, 12)}`, "ghidra");
await fs.mkdir(cacheDir, { recursive: true });
await fs.writeFile(path.join(cacheDir, "functions.tsv"), "address\tname\n1000\tmain\n");
await fs.writeFile(
  path.join(cacheDir, ".apim-analysis.json"),
  JSON.stringify({ hash, engine: "ghidra", profile: "full:", complete: true })
);
result = await B.inspectWorkspaceBinary(WS, "uploads/binaries/app.exe", {
  deep: true,
  dependencies: false,
  includeStrings: false,
});
check("a completed same-hash analysis is reused", result.deep.cached && result.deep.engine === "ghidra");
check("cached outputs remain addressable in the workspace", result.deep.outputs.some((x) => x.endsWith("functions.tsv")));

const fakeGhidra = path.join(DATA_ROOT, "fake-ghidra");
const support = path.join(fakeGhidra, "support");
await fs.mkdir(support, { recursive: true });
const fakeHeadless = path.join(
  support,
  process.platform === "win32" ? "analyzeHeadless.bat" : "analyzeHeadless"
);
await fs.writeFile(
  fakeHeadless,
  process.platform === "win32"
    ? "@echo off\r\nping 127.0.0.1 -n 20 > nul\r\n"
    : "#!/bin/sh\nsleep 20\n"
);
if (process.platform !== "win32") await fs.chmod(fakeHeadless, 0o755);
const previousGhidra = process.env.APIM_GHIDRA_HOME;
process.env.APIM_GHIDRA_HOME = fakeGhidra;
const controller = new AbortController();
setTimeout(() => controller.abort(), 100);
const stopStarted = Date.now();
const stopped = await B.inspectWorkspaceBinary(WS, "uploads/binaries/app.exe", {
  artifacts: false,
  runCapa: false,
  deep: true,
  forceDeep: true,
  dependencies: false,
  includeStrings: false,
  signal: controller.signal,
});
if (previousGhidra === undefined) delete process.env.APIM_GHIDRA_HOME;
else process.env.APIM_GHIDRA_HOME = previousGhidra;
check(
  "Stop kills an expensive decompiler process tree promptly",
  Date.now() - stopStarted < 5_000 && /stopped/i.test(stopped.deep.summary),
  `${Date.now() - stopStarted}ms — ${stopped.deep.summary}`
);

const fakeCapa = path.join(
  DATA_ROOT,
  process.platform === "win32" ? "fake-capa.bat" : "fake-capa"
);
const fakeCapaRules = path.join(DATA_ROOT, "capa-rules");
const fakeCapaSignatures = path.join(DATA_ROOT, "capa-sigs");
await fs.mkdir(fakeCapaRules, { recursive: true });
await fs.mkdir(fakeCapaSignatures, { recursive: true });
await fs.writeFile(
  fakeCapa,
  process.platform === "win32"
    ? "@echo off\r\necho args: %*\r\necho capability: process injection\r\necho api: CreateRemoteThread\r\n"
    : "#!/bin/sh\necho \"args: $*\"\necho 'capability: process injection'\necho 'api: CreateRemoteThread'\n"
);
if (process.platform !== "win32") await fs.chmod(fakeCapa, 0o755);
const previousCapa = process.env.APIM_CAPA_PATH;
const previousCapaRules = process.env.APIM_CAPA_RULES_PATH;
const previousCapaSignatures = process.env.APIM_CAPA_SIGNATURES_PATH;
process.env.APIM_CAPA_PATH = fakeCapa;
process.env.APIM_CAPA_RULES_PATH = fakeCapaRules;
process.env.APIM_CAPA_SIGNATURES_PATH = fakeCapaSignatures;
const capaRun = await B.inspectWorkspaceBinary(
  WS,
  "uploads/binaries/app.exe",
  {
    artifacts: false,
    runCapa: true,
    deep: false,
    forceDeep: true,
    dependencies: false,
    includeStrings: false,
  }
);
if (previousCapa === undefined) delete process.env.APIM_CAPA_PATH;
else process.env.APIM_CAPA_PATH = previousCapa;
if (previousCapaRules === undefined) delete process.env.APIM_CAPA_RULES_PATH;
else process.env.APIM_CAPA_RULES_PATH = previousCapaRules;
if (previousCapaSignatures === undefined) {
  delete process.env.APIM_CAPA_SIGNATURES_PATH;
} else process.env.APIM_CAPA_SIGNATURES_PATH = previousCapaSignatures;
const capaText = await fs.readFile(
  path.join(W.workspaceDirectory(WS), capaRun.capa.output),
  "utf8"
);
check(
  "capa output is captured as a persistent report",
  capaRun.capa.status === "complete" &&
    Boolean(capaRun.capa.output) &&
    /CreateRemoteThread/.test(capaText)
);
check(
  "pip-installed capa receives explicit rules and signatures paths",
  /args:.*-r .*capa-rules.*-s .*capa-sigs/i.test(capaText),
  capaText.split("\n")[0]
);

await fs.writeFile(
  fakeCapa,
  process.platform === "win32"
    ? "@echo off\r\necho ERROR capa: default embedded rules not found! 1>&2\r\necho ERROR capa: provide your own rule set via the `-r` option. 1>&2\r\nexit /b 10\r\n"
    : "#!/bin/sh\necho 'ERROR capa: default embedded rules not found!' >&2\necho 'ERROR capa: provide your own rule set via the `-r` option.' >&2\nexit 10\n"
);
if (process.platform !== "win32") await fs.chmod(fakeCapa, 0o755);
process.env.APIM_CAPA_PATH = fakeCapa;
delete process.env.APIM_CAPA_RULES_PATH;
delete process.env.APIM_CAPA_SIGNATURES_PATH;
const missingCapaResources = await B.inspectWorkspaceBinary(
  WS,
  "uploads/binaries/app.exe",
  {
    artifacts: false,
    runCapa: true,
    deep: false,
    forceDeep: true,
    dependencies: false,
    includeStrings: false,
  }
);
if (previousCapa === undefined) delete process.env.APIM_CAPA_PATH;
else process.env.APIM_CAPA_PATH = previousCapa;
if (previousCapaRules !== undefined) {
  process.env.APIM_CAPA_RULES_PATH = previousCapaRules;
}
if (previousCapaSignatures !== undefined) {
  process.env.APIM_CAPA_SIGNATURES_PATH = previousCapaSignatures;
}
check(
  "the exact pip-without-rules failure is diagnosed as unavailable setup",
  missingCapaResources.capa.status === "unavailable" &&
    /missing rules/.test(missingCapaResources.capa.summary) &&
    /APIM_CAPA_RULES_PATH/.test(missingCapaResources.capa.setup ?? ""),
  missingCapaResources.capa.summary
);

const fakeIlSpyScript = path.join(DATA_ROOT, "fake-ilspy.cjs");
const fakeIlSpyLauncher = path.join(
  DATA_ROOT,
  process.platform === "win32" ? "fake-ilspy.cmd" : "fake-ilspy"
);
await fs.writeFile(
  fakeIlSpyScript,
  `const fs=require('fs'); const path=require('path');\n` +
    `const at=process.argv.indexOf('--outputdir'); const out=process.argv[at+1];\n` +
    `fs.mkdirSync(out,{recursive:true});\n` +
    `fs.writeFileSync(path.join(out,'Game.cs'), ` +
    "`public class Game {\\n  public void CreateMove(int flags) {\\n    if ((flags & IN_JUMP) != 0) Jump();\\n  }\\n  private void Jump() {}\\n}\\n`);\n"
);
await fs.writeFile(
  fakeIlSpyLauncher,
  process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${fakeIlSpyScript}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fakeIlSpyScript}" "$@"\n`
);
if (process.platform !== "win32") await fs.chmod(fakeIlSpyLauncher, 0o755);
const previousIlSpy = process.env.APIM_ILSPYCMD_PATH;
process.env.APIM_ILSPYCMD_PATH = fakeIlSpyLauncher;
const focusedManaged = await B.inspectWorkspaceBinary(
  WS,
  "uploads/binaries/managed.exe",
  {
    artifacts: false,
    runCapa: false,
    deep: true,
    forceDeep: true,
    dependencies: false,
    includeStrings: false,
    focusTerms: ["CreateMove", "IN_JUMP"],
    focusedOnly: true,
  }
);
if (previousIlSpy === undefined) delete process.env.APIM_ILSPYCMD_PATH;
else process.env.APIM_ILSPYCMD_PATH = previousIlSpy;
const focusedCs = focusedManaged.deep.outputs.find((output) =>
  output.endsWith("focused-functions.cs")
);
check(
  "ILSpy focused-only mode keeps matching methods and drops the full project",
  focusedManaged.deep.status === "complete" &&
    Boolean(focusedCs) &&
    /CreateMove/.test(
      await fs.readFile(path.join(W.workspaceDirectory(WS), focusedCs), "utf8")
    ) &&
    !focusedManaged.deep.outputs.some((output) => output.includes("/project/"))
);

console.log("\n7. The agent tool and raw-byte upload are actually wired");
const tool = T.WORKSPACE_TOOLS.find((x) => x.function.name === "inspect_binary");
check("inspect_binary has a dedicated schema", Boolean(tool));
const toolResult = await T.runTool(WS, "inspect_binary", {
  path: "uploads/binaries/app.exe",
  deep: false,
  include_strings: false,
});
check("the dispatcher returns real PE evidence", toolResult.ok && /KERNEL32\.dll/.test(toolResult.content) && /WriteProcessMemory/.test(toolResult.content));
check("the summary names architecture and libraries", /x86-64/.test(toolResult.summary) && /3 libraries/.test(toolResult.summary), toolResult.summary);
check("supported executable extensions are explicit", BT.isPeFilename("APP.EXE") && BT.isPeFilename("driver.sys") && !BT.isPeFilename("notes.txt"));
check("binary upload paths cannot traverse", BT.binaryUploadPath("../../evil.exe") === "uploads/binaries/evil.exe");
check("folder paths preserve useful DLL layout without traversal", BT.binaryFolderUploadPath("My App", "../lib/x.dll") === "uploads/binaries/My App/lib/x.dll");
const folderPe = makePe({ dll: true });
const folderResult = await AR.readFolderTree([
  {
    name: "custom.dll",
    size: folderPe.length,
    webkitRelativePath: "program/bin/custom.dll",
    arrayBuffer: async () => folderPe.buffer,
    slice: () => ({ arrayBuffer: async () => folderPe.buffer }),
  },
]);
check(
  "folder/archive readers preserve PE bytes instead of skipping DLLs",
  folderResult.binaries?.length === 1 &&
    folderResult.binaries[0].path === "bin/custom.dll" &&
    folderResult.binaries[0].data[0] === 0x4d
);
const chatSource = await fs.readFile(path.join(ROOT, "src/components/ChatArea.tsx"), "utf8");
const routeSource = await fs.readFile(path.join(ROOT, "src/app/api/workspace/[id]/binary/route.ts"), "utf8");
check("composer sends executable bytes as multipart", /FormData/.test(chatSource) && /\/binary/.test(chatSource));
check("upload endpoint validates MZ and writes bytes", /assertPeUpload/.test(routeSource) && /writeFileBytes/.test(routeSource));
const Upload = await load("src/app/api/workspace/[id]/binary/route.ts");
const { NextRequest } = await import("next/server");
const uploadBytes = makePe();
const form = new FormData();
form.set("path", "uploads/binaries/through-route.exe");
form.set(
  "file",
  new File([uploadBytes], "through-route.exe", {
    type: "application/vnd.microsoft.portable-executable",
  })
);
const response = await Upload.POST(
  new NextRequest("http://localhost/api/workspace/test/binary", {
    method: "POST",
    body: form,
  }),
  { params: Promise.resolve({ id: WS }) }
);
const savedThroughRoute = await W.readFileBytes(
  WS,
  "uploads/binaries/through-route.exe"
);
check(
  "multipart upload preserves every byte end to end",
  response.status === 200 &&
    Buffer.from(savedThroughRoute).equals(Buffer.from(uploadBytes))
);
check("the target is never executed by the analysis path", !/spawn\([^\n]*targetPath/.test(await fs.readFile(path.join(ROOT, "src/lib/binary-decompiler.ts"), "utf8")));
const ghidraScript = await fs.readFile(
  path.join(ROOT, "scripts/ghidra/ApimDecompile.java"),
  "utf8"
);
check(
  "Ghidra output is chunked and capped",
  /CHUNK_CHARS/.test(ghidraScript) && /MAX_FUNCTIONS/.test(ghidraScript)
);
check(
  "Ghidra has a true focused-only reference path",
  /collectFocused/.test(ghidraScript) &&
    /getReferencesTo/.test(ghidraScript) &&
    /focused-functions\.c/.test(ghidraScript)
);
check(
  "the tool defaults to CreateMove and IN_JUMP focus",
  /\["CreateMove", "IN_JUMP"\]/.test(
    await fs.readFile(path.join(ROOT, "src/lib/tools.ts"), "utf8")
  )
);
check(
  "a fabricated decompilation claim is caught",
  P.checkAnswerClaims(
    "I used inspect_binary and it found three imported DLLs.",
    []
  ) !== null &&
    P.checkAnswerClaims(
      "I used inspect_binary and it found three imported DLLs.",
      ["inspect_binary"]
    ) === null
);

await fs.rm(path.join(DATA_ROOT, "workspaces"), { recursive: true, force: true });
await fs.rm(fakeGhidra, { recursive: true, force: true });
await fs.rm(fakeCapa, { force: true });
await fs.rm(fakeCapaRules, { recursive: true, force: true });
await fs.rm(fakeCapaSignatures, { recursive: true, force: true });
await fs.rm(fakeIlSpyScript, { force: true });
await fs.rm(fakeIlSpyLauncher, { force: true });
console.log(`\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`);
await finishSuite(fail);
