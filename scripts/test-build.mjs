/**
 * Automatic build detection.
 *
 * Run: npm run test:build
 *
 * The point of build_project is that the agent should never have to type
 * msbuild/cmake/dotnet flags or set up vcvars: dropping a Visual Studio
 * solution, CMakeLists.txt or a single .cpp in the workspace is enough.
 * These tests cover detection and argv construction without requiring the
 * actual toolchains to be installed.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile, mkdir, rm } from "node:fs/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_ROOT = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.join(ROOT, "data");
const WS = "build-test-" + Math.random().toString(36).slice(2, 8);
const wsRoot = path.join(DATA_ROOT, "workspaces", WS);

const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { detectBuild, BuildError } = await load("src/lib/build.ts");
const { writeFile: wsWrite, listFiles } = await load("src/lib/workspace.ts");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

await mkdir(wsRoot, { recursive: true });

async function write(rel, body = "") {
  await wsWrite(WS, rel, body);
}

// 1. A Visual Studio solution drives MSBuild with Release/x64 and /m.
await write("Game.sln");
let plan = await detectBuild(WS, {});
check(
  "sln selects msbuild",
  plan.target.kind === "msbuild" && plan.runner.command.toLowerCase().includes("msbuild"),
  plan.runner.command
);
check(
  "msbuild gets parallel, config, platform",
  plan.runner.args.includes("/m") &&
    plan.runner.args.includes("/p:Configuration=Release") &&
    plan.runner.args.includes("/p:Platform=x64"),
  plan.runner.args.join(" ")
);
check(
  "msbuild restores NuGet first",
  Boolean(plan.restore) &&
    plan.restore.args.some((a) => a.includes("Restore")),
  JSON.stringify(plan.restore?.args)
);

// 2. CMake uses cmake --build build --config Release.
await rm(path.join(wsRoot, "Game.sln"));
await write("CMakeLists.txt");
plan = await detectBuild(WS, {});
check(
  "cmake is detected and uses build/ + Release",
  plan.target.kind === "cmake" &&
    plan.runner.command === "cmake" &&
    plan.runner.args.includes("--build") &&
    plan.runner.args.includes("build") &&
    plan.runner.args.includes("Release"),
  plan.runner.args.join(" ")
);

// 3. A single .cpp file compiles directly.
await rm(path.join(wsRoot, "CMakeLists.txt"));
await write("main.cpp", "int main(){return 0;}");
plan = await detectBuild(WS, { config: "Debug" });
check(
  "single cpp is compiled directly",
  plan.target.kind === "single-cpp" &&
    plan.runner.args.includes("main.cpp") &&
    plan.runner.name.toLowerCase().includes("compile"),
  plan.runner.name
);

// 4. Nothing buildable gives an actionable error, not a guessed command.
await rm(path.join(wsRoot, "main.cpp"));
await write("notes.txt", "just notes");
let threw = false;
try {
  await detectBuild(WS, {});
} catch (e) {
  threw = e instanceof BuildError;
}
check("empty workspace throws a BuildError", threw);

// 5. dry_run is just detection (covered by not passing dry_run here) and
//    extra_args are appended verbatim.
await rm(path.join(wsRoot, "notes.txt"));
await write("Game.sln");
plan = await detectBuild(WS, {
  config: "Debug",
  platform: "Win32",
  extraArgs: ["/t:Rebuild"],
});
check(
  "config/platform/extra_args flow through",
  plan.runner.args.includes("/p:Configuration=Debug") &&
    plan.runner.args.includes("/p:Platform=Win32") &&
    plan.runner.args.includes("/t:Rebuild"),
  plan.runner.args.join(" ")
);

await rm(wsRoot, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll build-detection checks passed.");
