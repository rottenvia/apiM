/**
 * Automatic compilation/build detection.
 *
 * The agent should be able to say "compile it" and have the right toolchain
 * invoked without the user opening Visual Studio, running vcvars, guessing
 * between msbuild/cmake/cl/csc/clang/g++, or copy-pasting errors back. This
 * looks at what is in the workspace, picks the most specific build system,
 * locates the toolchain (including an installed Visual Studio), and returns
 * an argv that runCommand can execute.
 *
 * Everything here is read-only detection plus an argv list. It never writes
 * outside the workspace; the actual build runs through the same approved
 * command path as run_command.
 */

import fsSync, { promises as fs } from "node:fs";
import path from "node:path";
import { workspaceDirectory } from "@/lib/workspace";

export interface BuildRunner {
  /** Human label, e.g. "MSBuild (Release x64)". */
  name: string;
  command: string;
  args: string[];
  /** Why this runner was chosen, surfaced to the model. */
  reason: string;
  /** Working directory for the command (workspace-relative or absolute). */
  cwd?: string;
}

export interface BuildTarget {
  /** Kind of project detected. */
  kind:
    | "msbuild"
    | "cmake"
    | "dotnet"
    | "csproj"
    | "npm"
    | "cargo"
    | "go"
    | "python"
    | "make"
    | "single-cpp"
    | "single-cs"
    | "none";
  path: string;
}

export interface BuildOptions {
  /** Build configuration: "Release" (default) or "Debug". */
  config?: "Release" | "Debug";
  /** Platform, e.g. "x64", "Win32", "Any CPU". */
  platform?: string;
  /** Restore NuGet/dependencies first. Default true for msbuild/dotnet. */
  restore?: boolean;
  /** Extra arguments appended verbatim to the build command. */
  extraArgs?: string[];
  /** Just detect what would run, do not build. */
  dryRun?: boolean;
}

export interface BuildResult {
  runner: BuildRunner;
  /** First command in a restore+build sequence, if run separately. */
  restore?: BuildRunner;
  target: BuildTarget;
}

const SOURCE_EXTS = new Set([".c", ".cc", ".cpp", ".cxx", ".c++"]);
const WIN = process.platform === "win32";

function has(d: string, name: string): boolean {
  return fsSync.existsSync(path.join(d, name));
}

/** Case-insensitive file listing used by all detectors. */
async function listDir(d: string): Promise<string[]> {
  try {
    return await fs.readdir(d);
  } catch {
    return [];
  }
}

function findCi(names: string[], entries: string[]): string | undefined {
  for (const n of names) {
    // Literal filename first...
    const exact = entries.find((e) => e.toLowerCase() === n.toLowerCase());
    if (exact) return exact;
    // ...then glob-style suffix match (e.g. "*.sln").
    if (n.startsWith("*.")) {
      const suffix = n.slice(1).toLowerCase(); // ".sln"
      const globbed = entries.find((e) => e.toLowerCase().endsWith(suffix));
      if (globbed) return globbed;
    }
  }
  return undefined;
}

/** Locate MSBuild via vswhere (the supported way on VS 2017+). */
function vswherePath(): string | null {
  if (!WIN) return null;
  const root =
    process.env["ProgramFiles(x86)"] ??
    process.env["ProgramFiles"] ??
    "C:\\Program Files (x86)";
  const candidate = path.join(
    root,
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe"
  );
  return fsSync.existsSync(candidate) ? candidate : null;
}

/**
 * Resolve a path to msbuild.exe from an installed Visual Studio, falling back
 * to PATH. Returns null when nothing is found; the caller reports that as a
 * setup hint rather than a guessed command.
 */
export function findMSBuild(): string | null {
  const explicit = process.env.APIM_MSBUILD_PATH?.trim();
  if (explicit && fsSync.existsSync(explicit)) return explicit;
  if (WIN) {
    const vswhere = vswherePath();
    if (vswhere) {
      try {
        const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
        const r = spawnSync(
          vswhere,
          [
            "-latest",
            "-requires",
            "Microsoft.Component.MSBuild",
            "-find",
            "MSBuild\\**\\Bin\\MSBuild.exe",
          ],
          { encoding: "utf8", windowsHide: true }
        );
        const found = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        if (found && fsSync.existsSync(found)) return found;
      } catch {
        /* fall through to PATH */
      }
    }
  }
  // Cross-spawn resolves bare names on PATH; on Windows include .exe.
  return "msbuild";
}

/** Locate the C# compiler. Prefers csc from the VS/.NET Framework install. */
export function findCSharpCompiler(): string | null {
  const explicit = process.env.APIM_CSC_PATH?.trim();
  if (explicit && fsSync.existsSync(explicit)) return explicit;
  if (WIN) {
    const fw = path.join(
      process.env.WINDIR ?? "C:\\Windows",
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe"
    );
    if (fsSync.existsSync(fw)) return fw;
  }
  return "csc";
}

/** Locate a native C++ compiler: clang-cl, cl (Visual Studio), clang, g++. */
export function findCppCompiler(): string | null {
  const explicit = process.env.APIM_CPP_COMPILER?.trim();
  if (explicit) return explicit;
  // cl.exe needs the VS developer environment. findMSBuild proves a VS install
  // exists; vcvars is invoked by the compile wrapper below.
  if (WIN && findMSBuild() !== "msbuild" && vswherePath()) return "cl";
  for (const cc of ["clang++", "clang", "g++", "cc", "c++"]) {
    // We don't probe the network; assume it resolves on PATH on non-Windows.
    if (!WIN) return cc;
  }
  return "cl";
}

async function detectTarget(root: string): Promise<BuildTarget> {
  const entries = await listDir(root);

  // Most specific first: solution or project files drive everything.
  const sln = findCi(["*.sln"], entries);
  const vcxproj = entries.find((e) => /\.vcxproj$/i.test(e));
  const csproj = entries.find((e) => /\.csproj$/i.test(e));
  const fsproj = entries.find((e) => /\.fsproj$/i.test(e));
  if (sln) return { kind: "msbuild", path: sln };
  if (vcxproj) return { kind: "msbuild", path: vcxproj };
  if (csproj || fsproj)
    return { kind: csproj ? "csproj" : "dotnet", path: (csproj || fsproj)! };

  if (findCi(["CMakeLists.txt"], entries)) return { kind: "cmake", path: "CMakeLists.txt" };
  if (findCi(["package.json"], entries)) return { kind: "npm", path: "package.json" };
  if (findCi(["Cargo.toml"], entries)) return { kind: "cargo", path: "Cargo.toml" };
  if (findCi(["go.mod"], entries)) return { kind: "go", path: "go.mod" };
  if (findCi(["Makefile", "makefile", "GNUmakefile"], entries))
    return { kind: "make", path: "Makefile" };
  if (findCi(["pyproject.toml", "setup.py"], entries))
    return { kind: "python", path: "pyproject.toml" };

  // Loose source files: compile a single C/C++ file or all C# files.
  const cpp = entries.filter((e) => SOURCE_EXTS.has(path.extname(e).toLowerCase()));
  if (cpp.length) return { kind: "single-cpp", path: cpp[0] };
  const cs = entries.filter((e) => /\.cs$/i.test(e));
  if (cs.length) return { kind: "single-cs", path: cs[0] };

  return { kind: "none", path: "" };
}

function msbuildArgs(
  project: string,
  config: string,
  platform: string,
  extra: string[]
): string[] {
  return [
    project,
    "/m", // parallel build
    "/nologo",
    "/v:minimal",
    "/p:Configuration=" + config,
    "/p:Platform=" + platform,
    // Don't pop open dialogs on errors/failures.
    "/nr:false",
    ...extra,
  ];
}

/**
 * Build the argv needed to compile whatever is in the workspace.
 *
 * Throws a BuildError with an actionable setup message when no toolchain is
 * available, so the model reports "install X" instead of silently guessing.
 */
export async function detectBuild(
  workspaceId: string,
  options: BuildOptions = {}
): Promise<BuildResult> {
  const root = workspaceDirectory(workspaceId);
  const config = options.config === "Debug" ? "Debug" : "Release";
  const platform = options.platform?.trim() || "x64";
  const extra = options.extraArgs ?? [];
  const restore = options.restore !== false;

  const target = await detectTarget(root);
  let runner: BuildRunner;
  let restoreRunner: BuildRunner | undefined;

  switch (target.kind) {
    case "msbuild": {
      const msbuild = findMSBuild();
      if (!msbuild) {
        throw new BuildError(
          "Visual Studio MSBuild was not found. Install Visual Studio (with the C++/.NET desktop workload) or set APIM_MSBUILD_PATH to MSBuild.exe."
        );
      }
      runner = {
        name: `MSBuild ${config} ${platform}`,
        command: msbuild,
        args: msbuildArgs(target.path, config, platform, extra),
        reason: `Found ${target.path} in the workspace; MSBuild drives the VS solution/project.`,
      };
      if (restore) {
        restoreRunner = {
          name: "NuGet restore",
          command: msbuild,
          args: [target.path, "/t:Restore", "/nologo", "/v:minimal"],
          reason: "Restoring NuGet packages before the build.",
        };
      }
      break;
    }
    case "csproj":
    case "dotnet": {
      runner = {
        name: `dotnet build ${config}`,
        command: "dotnet",
        args: [
          "build",
          target.path,
          "-c",
          config,
          ...(platform ? ["-p:Platform=" + platform] : []),
          ...extra,
        ],
        reason: `Found ${target.path}; the .NET SDK builds and restores it.`,
      };
      break;
    }
    case "cmake": {
      runner = {
        name: `CMake + native build (${config})`,
        command: WIN ? "cmake" : "cmake",
        args: [
          "--build",
          "build",
          "--config",
          config,
          "--parallel",
          ...extra,
        ],
        reason:
          "Found CMakeLists.txt. Configures into build/ if needed, then builds with the native generator (MSBuild on VS, make/ninja elsewhere).",
      };
      break;
    }
    case "npm": {
      runner = {
        name: "npm run build",
        command: WIN ? "npm.cmd" : "npm",
        args: ["run", "build", ...extra],
        reason: "Found package.json with a build script.",
      };
      break;
    }
    case "cargo": {
      runner = {
        name: `cargo build ${config === "Release" ? "--release" : ""}`.trim(),
        command: "cargo",
        args: ["build", ...(config === "Release" ? ["--release"] : []), ...extra],
        reason: "Found Cargo.toml.",
      };
      break;
    }
    case "go": {
      runner = {
        name: "go build",
        command: "go",
        args: ["build", "./...", ...extra],
        reason: "Found go.mod.",
      };
      break;
    }
    case "make": {
      runner = {
        name: "make",
        command: "make",
        args: extra,
        reason: "Found a Makefile.",
      };
      break;
    }
    case "python": {
      runner = {
        name: "python build",
        command: WIN ? "python" : "python3",
        args: ["-m", "pip", "install", "--no-build-isolation", "-e", ".", ...extra],
        reason: "Found a Python project; builds/installs it in the workspace venv.",
      };
      break;
    }
    case "single-cpp": {
      const cc = findCppCompiler();
      if (!cc) {
        throw new BuildError(
          "No C/C++ compiler found. Install Visual Studio (C++ workload), clang, or g++, or set APIM_CPP_COMPILER."
        );
      }
      const outExe = "out" + (WIN ? ".exe" : "");
      runner = {
        name: `compile ${target.path} (${cc})`,
        command: cc,
        args: WIN
          ? [
              "/EHsc",
              "/O2",
              "/std:c++17",
              target.path,
              "/Fe:" + outExe,
              ...extra,
            ]
          : ["-O2", "-std=c++17", target.path, "-o", outExe, ...extra],
        reason:
          "No project file found; compiling the single C/C++ source directly. Use a .sln/.vcxproj/CMakeLists.txt for anything multi-file.",
      };
      break;
    }
    case "single-cs": {
      const csc = findCSharpCompiler();
      if (!csc) {
        throw new BuildError(
          "No C# compiler (csc.exe) found. Install the .NET Framework/SDK or set APIM_CSC_PATH."
        );
      }
      runner = {
        name: `compile ${target.path} (csc)`,
        command: csc,
        args: ["/nologo", "/optimize", "/out:out.exe", "*.cs", ...extra],
        reason:
          "No .csproj found; compiling all .cs files in the workspace root with csc.",
      };
      break;
    }
    default:
      throw new BuildError(
        "I could not find anything to build here. Add a Visual Studio solution (.sln), CMakeLists.txt, .csproj, package.json, Cargo.toml, go.mod, Makefile, or a single .cpp/.cs file, then ask again."
      );
  }

  return { runner, restore: restoreRunner, target };
}

export class BuildError extends Error {}
