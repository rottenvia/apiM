/**
 * Tests for the WSL2 sandbox bridge — the pure, host-independent logic.
 *
 * The live probes (probeWsl, ensureWslSandbox) only mean anything on Windows,
 * so they are not exercised here; what IS tested is every function that has
 * ever produced a wrong invocation: path translation, the UTF-16 status
 * decode, distro-table parsing, argv assembly, and the environment wiring.
 *
 * Run with: node --experimental-strip-types scripts/test-wsl.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { wslCannotStart, WINDOWS_FALLBACK } from "../src/lib/sandbox-run.ts";
import {
  decodeWslOutput,
  parseWslDistros,
  winPathToWsl,
  shQuote,
  buildWslInvocation,
  pickDisplay,
  xvfbLaunchArgs,
  captureArgs,
  chooseDistro,
  wrapForSandbox,
  sandboxCaptureInvocation,
  wslSetupScript,
  SANDBOX_DISTRO,
  ROOTFS_FILE,
  expectedSha256,
  importArgs,
  sandboxWslConf,
  sandboxMountPoint,
  mountAndRunScript,
  sandboxBaseDir,
  formatExitCode,
  explainWslError,
  assessInstallDir,
  installDirProbeScript,
  parseScQc,
  parseScQuery,
  diagnoseVhdStack,
  formatVhdFindings,
  diagnoseWsl1,
  parseDismExit,
  explainDismExit,
  windowsRepairAdvice,
  enableWslElevatedScript,
  enableWslLauncherScript,
  wsl2CannotRunHere,
} from "../src/lib/wsl.ts";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(`      ${err instanceof Error ? err.message : err}`);
  }
}

// --- winPathToWsl -----------------------------------------------------------

test("drive path → /mnt with lowercase drive", () => {
  assert.equal(winPathToWsl("C:\\Users\\me\\ws"), "/mnt/c/Users/me/ws");
});

test("forward-slash drive path works too", () => {
  assert.equal(winPathToWsl("D:/data/set"), "/mnt/d/data/set");
});

test("trailing separators are trimmed", () => {
  assert.equal(winPathToWsl("C:\\ws\\"), "/mnt/c/ws");
});

test("already-POSIX path is returned unchanged", () => {
  assert.equal(winPathToWsl("/home/me/x"), "/home/me/x");
});

test("UNC \\\\wsl$ path collapses to its Linux view", () => {
  assert.equal(winPathToWsl("\\\\wsl$\\Ubuntu\\home\\me"), "/home/me");
});

test("bare wsl$ root becomes /", () => {
  assert.equal(winPathToWsl("\\\\wsl$\\Ubuntu"), "/");
});

test("spaces in a path survive translation", () => {
  assert.equal(
    winPathToWsl("C:\\Users\\A B\\My Ws"),
    "/mnt/c/Users/A B/My Ws"
  );
});

test("empty path → empty string", () => {
  assert.equal(winPathToWsl(""), "");
});

// --- decodeWslOutput --------------------------------------------------------

test("UTF-16LE with BOM decodes to readable text", () => {
  const buf = Buffer.from("\ufeffUbuntu", "utf16le");
  assert.equal(decodeWslOutput(buf), "Ubuntu");
});

test("UTF-16LE without BOM is detected by NUL density", () => {
  const buf = Buffer.from("  NAME            STATE           VERSION", "utf16le");
  const out = decodeWslOutput(buf);
  assert.ok(out.includes("NAME"));
  assert.ok(!out.includes("\u0000"));
});

test("plain UTF-8 passes through", () => {
  assert.equal(decodeWslOutput(Buffer.from("hello", "utf8")), "hello");
});

// --- parseWslDistros --------------------------------------------------------

const SAMPLE = [
  "  NAME            STATE           VERSION",
  "* Ubuntu          Running         2",
  "  Debian          Stopped         2",
  "  legacy          Stopped         1",
].join("\r\n");

test("parses the standard verbose table", () => {
  const rows = parseWslDistros(SAMPLE);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    name: "Ubuntu",
    state: "Running",
    version: 2,
    isDefault: true,
  });
  assert.equal(rows[1].isDefault, false);
  assert.equal(rows[2].version, 1);
});

test("distro name containing a space is kept whole", () => {
  const table = [
    "  NAME            STATE    VERSION",
    "* Ubuntu 22.04    Running  2",
  ].join("\n");
  const rows = parseWslDistros(table);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Ubuntu 22.04");
  assert.equal(rows[0].version, 2);
});

test("empty / header-only output yields no rows", () => {
  assert.deepEqual(parseWslDistros(""), []);
  assert.deepEqual(parseWslDistros("NAME STATE VERSION"), []);
});

test("stray NULs in the table are tolerated", () => {
  const dirty = "N\u0000A\u0000M\u0000E\n* Ubuntu Running 2";
  const rows = parseWslDistros(dirty);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Ubuntu");
});

// --- shQuote ----------------------------------------------------------------

test("safe tokens are left bare", () => {
  assert.equal(shQuote("app.py"), "app.py");
  assert.equal(shQuote("DISPLAY=:99"), "DISPLAY=:99");
});

test("spaces and quotes are single-quoted safely", () => {
  assert.equal(shQuote("a b"), "'a b'");
  assert.equal(shQuote("it's"), `'it'\\''s'`);
});

test("empty token quotes to ''", () => {
  assert.equal(shQuote(""), "''");
});

// --- buildWslInvocation -----------------------------------------------------

test("assembles -d, --cd, env and the inner argv in order", () => {
  const inv = buildWslInvocation({
    distro: "Ubuntu",
    cwdWsl: "/mnt/c/ws",
    env: { DISPLAY: ":99", HOME: "/mnt/c/ws" },
    command: "python3",
    args: ["app.py", "--flag"],
  });
  assert.equal(inv.command, "wsl.exe");
  assert.deepEqual(inv.args, [
    "-d",
    "Ubuntu",
    "--cd",
    "/mnt/c/ws",
    "--exec",
    "env",
    "DISPLAY=:99",
    "HOME=/mnt/c/ws",
    "python3",
    "app.py",
    "--flag",
  ]);
});

test("no distro / no cwd / no env degrades to a bare inner call", () => {
  const inv = buildWslInvocation({ command: "ls", args: ["-la"] });
  assert.deepEqual(inv.args, ["--exec", "ls", "-la"]);
});

test("the inner command after --exec is never re-split by us", () => {
  const inv = buildWslInvocation({
    command: "bash",
    args: ["-c", "echo hi && sleep 1"],
  });
  // "-c" and the whole script are separate argv entries, preserved verbatim.
  assert.equal(inv.args[inv.args.length - 2], "-c");
  assert.equal(inv.args[inv.args.length - 1], "echo hi && sleep 1");
});

// --- display / xvfb / capture args -----------------------------------------

test("pickDisplay avoids used numbers", () => {
  assert.equal(pickDisplay([]), ":99");
  assert.equal(pickDisplay([99]), ":100");
  assert.equal(pickDisplay([99, 100, 101]), ":102");
});

test("xvfb args request an in-memory 24-bit screen, no tcp", () => {
  assert.deepEqual(xvfbLaunchArgs(":99"), [
    ":99",
    "-screen",
    "0",
    "1600x1000x24",
    "-nolisten",
    "tcp",
  ]);
});

test("capture args grab the root window of the display", () => {
  assert.deepEqual(captureArgs(":99", "/mnt/c/ws/shot.png"), [
    "-display",
    ":99",
    "-window",
    "root",
    "/mnt/c/ws/shot.png",
  ]);
});

// --- chooseDistro -----------------------------------------------------------

test("uses only the sandbox's own distro", () => {
  const r = chooseDistro({
    installed: true,
    defaultDistro: "Ubuntu",
    distros: [
      { name: "Ubuntu", state: "Running", version: 2, isDefault: true },
      { name: SANDBOX_DISTRO, state: "Stopped", version: 2, isDefault: false },
    ],
  });
  assert.ok(r.ok && r.distro === SANDBOX_DISTRO);
});

test("never falls back to the user's own distro", () => {
  const r = chooseDistro({
    installed: true,
    defaultDistro: "Ubuntu",
    distros: [{ name: "Ubuntu", state: "Running", version: 2, isDefault: true }],
  });
  assert.ok(!r.ok && r.needsSetup === true);
});

test("accepts a WSL 1 sandbox distro (the no-virtual-disk fallback)", () => {
  const r = chooseDistro({
    installed: true,
    defaultDistro: null,
    distros: [{ name: SANDBOX_DISTRO, state: "Stopped", version: 1, isDefault: false }],
  });
  assert.ok(r.ok && r.distro === SANDBOX_DISTRO);
});

test("refuses when WSL is not installed", () => {
  const r = chooseDistro({
    installed: false,
    defaultDistro: null,
    distros: [],
    reason: "not installed",
  });
  assert.ok(!r.ok && /not installed/.test(r.reason));
});

// --- wrapForSandbox / capture invocation -----------------------------------

const SB = { distro: SANDBOX_DISTRO, display: ":99", xvfb: null };

test("wrapForSandbox runs bash in the per-chat mount with DISPLAY set", () => {
  const inv = wrapForSandbox({
    sandbox: SB,
    workspaceId: "abc-123",
    workspaceWinDir: "C:\\Users\\me\\ws",
    script: "node server.js",
  });
  assert.equal(inv.command, "wsl.exe");
  assert.deepEqual(inv.args.slice(0, 7), ["-d", SANDBOX_DISTRO, "-u", "root", "--cd", "/root", "--exec"]);
  assert.ok(inv.args.includes("DISPLAY=:99"));
  const i = inv.args.indexOf("bash");
  assert.equal(inv.args[i + 1], "-lc");
  const script = inv.args[i + 2];
  assert.ok(script.includes("mount -t drvfs 'C:\\Users\\me\\ws' /ws/abc-123"));
  assert.ok(script.includes("mountpoint -q /ws/abc-123 ||"));
  assert.ok(script.endsWith("cd /ws/abc-123 && node server.js"));
});

test("mount point sanitises odd workspace ids", () => {
  assert.equal(sandboxMountPoint("a/../b c"), "/ws/a____b_c");
});

test("mountAndRunScript quotes a path with spaces and quotes", () => {
  const s = mountAndRunScript("C:\\A B\\it's", "/ws/x", "ls");
  assert.ok(s.includes(`'C:\\A B\\it'\\''s'`));
});

test("extraEnv is merged and can override defaults", () => {
  const inv = wrapForSandbox({
    sandbox: SB,
    workspaceId: "w",
    workspaceWinDir: "C:\\ws",
    script: "true",
    extraEnv: { NO_COLOR: "0", CUSTOM: "1" },
  });
  assert.ok(inv.args.includes("NO_COLOR=0"));
  assert.ok(inv.args.includes("CUSTOM=1"));
});

test("capture writes the PNG into the workspace mount", () => {
  const { invocation, hostPath } = sandboxCaptureInvocation({
    sandbox: SB,
    workspaceId: "w1",
    workspaceWinDir: "C:\\ws",
    outFileName: "sandbox-1.png",
  });
  assert.ok(hostPath.endsWith("sandbox-1.png"));
  const script = invocation.args[invocation.args.length - 1];
  assert.ok(script.endsWith("cd /ws/w1 && import -display :99 -window root sandbox-1.png"));
});

// --- setup helpers -----------------------------------------------------------

test("expectedSha256 finds the right line", () => {
  const sums =
    "aa".repeat(32) + "  other.tar.gz\n" + "bb".repeat(32) + " *" + ROOTFS_FILE + "\n";
  assert.equal(expectedSha256(sums, ROOTFS_FILE), "bb".repeat(32));
  assert.equal(expectedSha256(sums, "missing"), null);
});

test("import argv targets the sandbox distro on WSL 2", () => {
  assert.deepEqual(importArgs("D:\\d", "D:\\r.tar.gz"), [
    "--import", SANDBOX_DISTRO, "D:\\d", "D:\\r.tar.gz", "--version", "2",
  ]);
});

test("wsl.conf keeps the sandbox off other drives and Windows programs", () => {
  const c = sandboxWslConf();
  assert.ok(/\[automount\]\nenabled = false/.test(c));
  assert.ok(/\[interop\]\nenabled = false/.test(c));
  assert.ok(/default = root/.test(c));
});

// --- setup script -----------------------------------------------------------

test("setup script installs xvfb and a capture tool, without sudo", () => {
  const s = wslSetupScript();
  assert.ok(/apt-get install .* xvfb/.test(s));
  assert.ok(!/sudo/.test(s));
  assert.ok(/imagemagick/.test(s));
  assert.ok(/apim-wsl-setup-ok/.test(s));
  assert.ok(/set -e/.test(s));
});


// --- where the disk goes, and what WSL errors mean --------------------------

const REPORTED =
  "A virtual disk support provider for the specified file was not found. \r\n" +
  "Error code: Wsl/Service/RegisterDistro/0xc03a0014";

test("the reported import error is explained, not just echoed", () => {
  const why = explainWslError(REPORTED);
  assert.ok(why && /compressed or encrypted/.test(why) && /OneDrive/.test(why));
  // The second cause, seen on the reporting PC once the folder was ruled out.
  assert.ok(/FsDepends/.test(why) && /vhdmp/.test(why) && /Docker/.test(why));
});

test("the hex code alone is enough (localised Windows)", () => {
  assert.ok(explainWslError("Fehlercode: Wsl/Service/RegisterDistro/0xc03a0014"));
});

test("the reported CreateVm socket error points at a Winsock reset", () => {
  const why = explainWslError(
    "An address incompatible with the requested protocol was used.\r\n" +
      "Error code: Wsl/InstallDistro/Service/RegisterDistro/CreateVm/0x8007273f"
  );
  assert.ok(why && /netsh winsock reset/.test(why) && /Docker/.test(why));
});

test("virtualization-off and feature-off errors get their own fixes", () => {
  assert.ok(/BIOS/.test(explainWslError("Error code: 0x80370102") ?? ""));
  assert.ok(/Turn on WSL/.test(explainWslError("Error code: 0x8007019e") ?? ""));
  assert.equal(explainWslError("something new"), null);
});

test("WSL's -1 is shown as -1, not 4294967295", () => {
  assert.equal(formatExitCode(4294967295), "-1");
  assert.equal(formatExitCode(0), "0");
  assert.equal(formatExitCode(null), "no exit code");
  assert.equal(formatExitCode(0xc03a0014), "-1069940716 (0xc03a0014)");
});

test("disk defaults to LOCALAPPDATA on Windows, not the project folder", () => {
  assert.equal(
    sandboxBaseDir({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "win32", "D:\\proj\\data"),
    "C:\\Users\\me\\AppData\\Local\\apiM\\sandbox"
  );
});

test("APIM_SANDBOX_DIR overrides the default", () => {
  assert.equal(
    sandboxBaseDir({ APIM_SANDBOX_DIR: "E:\\wsl", LOCALAPPDATA: "C:\\x" }, "win32", "/d"),
    "E:\\wsl"
  );
});

const GOOD = { fs: "NTFS", driveType: "Fixed", freeGB: 120, compressed: false, encrypted: false };

test("a plain NTFS folder passes with nothing to fix", () => {
  const v = assessInstallDir("C:\\x", GOOD, []);
  assert.deepEqual(v, { fixCompression: false, fixEncryption: false, problems: [] });
});

test("compression and encryption are fixable, not fatal", () => {
  const v = assessInstallDir("C:\\x", { ...GOOD, compressed: true, encrypted: true }, []);
  assert.ok(v.fixCompression && v.fixEncryption && v.problems.length === 0);
});

test("exFAT, removable, low space and OneDrive are reported", () => {
  assert.ok(/NTFS/.test(assessInstallDir("F:\\x", { ...GOOD, fs: "exFAT" }, []).problems[0]));
  assert.ok(/removable/.test(assessInstallDir("F:\\x", { ...GOOD, driveType: "Removable" }, []).problems[0]));
  assert.ok(/4 GB/.test(assessInstallDir("C:\\x", { ...GOOD, freeGB: 2 }, []).problems[0]));
  const od = assessInstallDir("C:\\Users\\me\\OneDrive\\Desktop\\apiM\\data\\sandbox", GOOD, ["C:\\Users\\me\\OneDrive"]);
  assert.ok(/OneDrive/.test(od.problems[0]));
});

test("a folder merely named like OneDrive is not flagged", () => {
  const v = assessInstallDir("C:\\Users\\me\\OneDriveBackup\\x", GOOD, ["C:\\Users\\me\\OneDrive"]);
  assert.equal(v.problems.length, 0);
});

test("the folder probe script is pure ASCII and emits JSON", () => {
  const ps = installDirProbeScript();
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(ps));
  assert.ok(/ConvertTo-Json -Compress/.test(ps) && /Compressed/.test(ps) && /Encrypted/.test(ps));
});


// --- the virtual-disk drivers (the real cause on the reporting PC) ----------

const QC = (name, start, label) =>
  `[SC] QueryServiceConfig SUCCESS\r\n\r\nSERVICE_NAME: ${name}\r\n` +
  `        TYPE               : 1  KERNEL_DRIVER\r\n` +
  `        START_TYPE         : ${start}   ${label}\r\n` +
  `        ERROR_CONTROL      : 1   NORMAL\r\n`;
const MISSING =
  "[SC] OpenService FAILED 1060:\r\n\r\nThe specified service does not exist as an installed service.\r\n";
const QUERY = (state) => `SERVICE_NAME: x\r\n        STATE              : ${state}  STOPPED\r\n`;

test("sc.exe qc: start type and a missing service are read by number", () => {
  assert.deepEqual(parseScQc(QC("vhdmp", 3, "DEMAND_START")), { exists: true, startType: 3 });
  assert.deepEqual(parseScQc(MISSING), { exists: false, startType: null });
  // German Windows: the words change, the numbers do not.
  assert.deepEqual(parseScQc("[SC] OpenService FEHLER 1060:\r\n"), { exists: false, startType: null });
  assert.deepEqual(parseScQc("[SC] OpenService ÉCHEC 1060 :\r\n".replace(" :", ":")), { exists: false, startType: null });
  assert.deepEqual(parseScQuery(QUERY(4)), { state: 4 });
});

const HEALTHY = {
  services: {
    FsDepends: { qc: QC("FsDepends", 3, "DEMAND_START"), query: QUERY(1) },
    vhdmp: { qc: QC("vhdmp", 3, "DEMAND_START"), query: QUERY(1) },
    vdrvroot: { qc: QC("vdrvroot", 0, "BOOT_START"), query: QUERY(4) },
    vmcompute: { qc: QC("vmcompute", 3, "DEMAND_START"), query: QUERY(1) },
  },
  files: { "FsDepends.sys": true, "vhdmp.sys": true, "vdrvroot.sys": true },
};

test("a healthy driver stack has no findings (stopped on-demand is normal)", () => {
  assert.deepEqual(diagnoseVhdStack(HEALTHY), []);
  assert.ok(/deeper/.test(formatVhdFindings([])));
});

test("a missing FsDepends registration points at the restore guide", () => {
  const f = diagnoseVhdStack({
    ...HEALTHY,
    services: { ...HEALTHY.services, FsDepends: { qc: MISSING, query: MISSING } },
  });
  assert.equal(f.length, 1);
  assert.ok(/not registered/.test(f[0].problem) && /restore-fsdepends\.md, Steps 1-4/.test(f[0].fix));
});

test("a DISABLED vhdmp gets the exact command to restore its default", () => {
  const f = diagnoseVhdStack({
    ...HEALTHY,
    services: { ...HEALTHY.services, vhdmp: { qc: QC("vhdmp", 4, "DISABLED"), query: QUERY(1) } },
  });
  assert.ok(/DISABLED/.test(f[0].problem) && /sc\.exe config vhdmp start= demand/.test(f[0].fix));
});

test("vdrvroot must start at boot", () => {
  const f = diagnoseVhdStack({
    ...HEALTHY,
    services: { ...HEALTHY.services, vdrvroot: { qc: QC("vdrvroot", 3, "DEMAND_START"), query: QUERY(1) } },
  });
  assert.ok(/instead of at boot/.test(f[0].problem) && /\/d 0/.test(f[0].fix));
});

test("a missing driver file is reported as such, not as a setting", () => {
  const f = diagnoseVhdStack({ ...HEALTHY, files: { ...HEALTHY.files, "FsDepends.sys": false } });
  assert.ok(/FsDepends\.sys is missing/.test(f[0].problem) && /ISO/.test(f[0].fix));
});

test("findings render as one line each", () => {
  const text = formatVhdFindings([{ component: "x", problem: "p", fix: "f" }]);
  assert.equal(text, "- p. Fix: f.");
});

test("import can target WSL 1 for the fallback", () => {
  assert.deepEqual(importArgs("D:\\d", "D:\\r.tgz", 1).slice(-2), ["--version", "1"]);
  assert.deepEqual(importArgs("D:\\d", "D:\\r.tgz").slice(-2), ["--version", "2"]);
});

test("WSL 1 switched off is explained with the one-click fix", () => {
  const why = explainWslError(
    "WSL1 is not supported with your current machine configuration.\r\n" +
      "Error code: Wsl/Service/RegisterDistro/WSL_E_WSL1_NOT_SUPPORTED"
  );
  assert.ok(why && /Turn on WSL 1 support/.test(why));
});


// --- WSL 1: why "not supported" can survive clicking Turn on ------------------

const LX_OK = QC("lxcore", 3, "DEMAND_START");

test("the reported PC: vdrvroot unregistered -> Windows repair install advised", () => {
  const f = diagnoseVhdStack({
    ...HEALTHY,
    services: { ...HEALTHY.services, vdrvroot: { qc: MISSING, query: MISSING } },
  });
  assert.equal(f.length, 1);
  assert.ok(/vdrvroot is not registered/.test(f[0].problem));
  assert.ok(/Fix problems using Windows Update/.test(f[0].fix));
  const text = formatVhdFindings(f);
  assert.ok(/keeps your files and apps/.test(text) && /Docker/.test(text));
});

test("a disabled-only fault does not push a reinstall", () => {
  const f = diagnoseVhdStack({
    ...HEALTHY,
    services: { ...HEALTHY.services, vhdmp: { qc: QC("vhdmp", 4, "DISABLED"), query: QUERY(1) } },
  });
  assert.ok(!/Reinstall now/.test(formatVhdFindings(f)));
});

test("a pending restart wins: the fix is to restart, not to click again", () => {
  const r = diagnoseWsl1({ rebootPending: true, files: { "lxcore.sys": false }, services: {} });
  assert.equal(r.state, "reboot-pending");
  assert.ok(/Restart/.test(r.message) && /Shut down does not finish it/.test(r.message));
});

test("no lxcore.sys means the feature really is off", () => {
  const r = diagnoseWsl1({ rebootPending: false, files: { "lxcore.sys": false }, services: {} });
  assert.equal(r.state, "feature-off");
  assert.ok(/Turn on WSL 1 support/.test(r.message));
});

test("lxcore.sys present but unregistered is driver damage, not a toggle", () => {
  const r = diagnoseWsl1({
    rebootPending: false,
    files: { "lxcore.sys": true },
    services: { lxcore: MISSING },
  });
  assert.equal(r.state, "driver-unregistered");
  assert.ok(/cannot fix it/.test(r.message) && /Reinstall now/.test(r.message));
});

test("everything present still refused -> restart, then repair", () => {
  const r = diagnoseWsl1({ rebootPending: false, files: { "lxcore.sys": true }, services: { lxcore: LX_OK } });
  assert.equal(r.state, "unknown");
  assert.ok(/restart first/.test(r.message));
});

test("DISM results: 0 and 3010 succeed, the restart is called out", () => {
  assert.equal(parseDismExit("apim-enable-wsl\r\n...\r\ndism-exit=3010\r\nwsl-exit=0"), 3010);
  assert.equal(parseDismExit("nothing"), null);
  assert.deepEqual(explainDismExit(0).ok, true);
  const r = explainDismExit(3010);
  assert.ok(r.ok && r.restart && /Restart Windows/.test(r.message));
});

test("DISM: a declined prompt is not reported as success", () => {
  const r = explainDismExit(null);
  assert.ok(!r.ok && /declined/.test(r.message));
});

test("DISM: a damaged component store points at the repair install", () => {
  const r = explainDismExit(0x800f081f);
  assert.ok(!r.ok && /0x800f081f/.test(r.message) && /Reinstall now/.test(r.message));
  assert.ok(/exit -1/.test(explainDismExit(-1).message));
});

test("repair advice names the safe, built-in route", () => {
  const a = windowsRepairAdvice();
  assert.ok(/Settings -> System -> Recovery/.test(a) && /Media Creation Tool/.test(a));
});

test("elevated scripts are ASCII, reset the exit code, and quote paths", () => {
  const inner = enableWslElevatedScript();
  const launch = enableWslLauncherScript();
  for (const ps of [inner, launch]) assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(ps));
  assert.ok(/\$global:LASTEXITCODE = -1\r\n\$out = & dism\.exe/.test(inner));
  assert.ok(/dism-exit=/.test(inner) && /Microsoft-Windows-Subsystem-Linux/.test(inner));
  assert.ok(/-Verb RunAs -Wait/.test(launch) && /apim-uac-declined/.test(launch));
  assert.ok(launch.includes(`('"' + $Inner + '"')`));
});


test("WSL 2 VM failures fall back to WSL 1; ordinary errors do not", () => {
  assert.equal(wsl2CannotRunHere(REPORTED), "virtual-disk");
  assert.equal(
    wsl2CannotRunHere("An address incompatible with the requested protocol was used.\r\nError code: Wsl/Service/RegisterDistro/CreateVm/0x8007273f"),
    "vm"
  );
  assert.equal(wsl2CannotRunHere("Error code: Wsl/Service/CreateInstance/0x80370102"), "vm");
  // Reported third: Virtual Machine Platform not installed.
  assert.equal(
    wsl2CannotRunHere("The operation could not be started because a required feature is not installed.\r\nError code: Wsl/Service/RegisterDistro/CreateVm/HCS/HCS_E_SERVICE_NOT_AVAILABLE"),
    "vm"
  );
  assert.ok(/WSL 1/.test(explainWslError("Error code: Wsl/Service/RegisterDistro/CreateVm/HCS/HCS_E_SERVICE_NOT_AVAILABLE") ?? ""));
  assert.equal(wsl2CannotRunHere("The distribution name already exists"), null);
  assert.equal(wsl2CannotRunHere("Error code: 0x80070070 not enough space"), null);
});


test("setup tries WSL 1 after any WSL 2 failure, not only listed codes", () => {
  const src = readFileSync(new URL("../src/lib/sandbox-setup.ts", import.meta.url), "utf8");
  assert.ok(!/if \(!cause\) throw failure\("wsl --import"/.test(src));
  assert.ok(/WSL 2 cannot run on this PC; using WSL 1/.test(src));
});


test("no sandbox command inherits the Windows working directory", () => {
  // Reported: run from C:\\Windows\\System32, WSL 1 failed with 0xd0000034
  // because the sandbox does not mount Windows drives.
  const src = readFileSync(new URL("../src/lib/wsl.ts", import.meta.url), "utf8");
  const calls = src.match(/buildWslInvocation\(\{[\s\S]*?\}\)/g) ?? [];
  const sandboxCalls = calls.filter((c) => /user: "root"/.test(c));
  assert.ok(sandboxCalls.length >= 3);
  for (const c of sandboxCalls) assert.ok(/cwdWsl: LINUX_CWD/.test(c), c.slice(0, 80));
  const setup = readFileSync(new URL("../src/lib/sandbox-setup.ts", import.meta.url), "utf8");
  for (const line of setup.split("\n").filter((l) => /SANDBOX_DISTRO, "-u", "root"/.test(l))) {
    assert.ok(/"--cd", "\/"/.test(line), line.trim());
  }
});


test("0xd0000034 (Linux cannot start) is explained as WSL 1's driver / pending restart", () => {
  const why = explainWslError("Error: 0xd0000034\r\nError code: Wsl/Service/CreateInstance/0xd0000034");
  assert.ok(why && /lxcore/.test(why) && /Restart/.test(why));
});


test("a sandbox that cannot start sends the agent to the hidden Windows desktop", () => {
  assert.ok(wslCannotStart("Error: 0xd0000034\r\nError code: Wsl/Service/CreateInstance/0xd0000034"));
  assert.ok(wslCannotStart("Error code: Wsl/Service/RegisterDistro/CreateVm/HCS/HCS_E_SERVICE_NOT_AVAILABLE"));
  assert.ok(!wslCannotStart("python3: can't open file 'x.py': [Errno 2] No such file or directory"));
  assert.ok(/start_process \(hidden=true/.test(WINDOWS_FALLBACK) && /screenshot_window/.test(WINDOWS_FALLBACK));
  assert.ok(/do not ask the user to repair Windows/i.test(WINDOWS_FALLBACK));
});

// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} checks · ${passed} passed${failed ? ` · ${failed} failed` : ""}`);
process.exit(failed === 0 ? 0 : 1);
