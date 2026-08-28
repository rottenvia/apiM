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
import { registerToolchainPath } from "@/lib/runner";

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
  /** Where discovery looked, so "nothing found" can be argued with. */
  searched?: string;
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
  /**
   * Explicit project/solution to build, workspace-relative. Skips discovery
   * entirely — the escape hatch for a workspace with several projects in it.
   */
  project?: string;
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
  // Registered at the SOURCE rather than by each caller: anything this
  // function hands back is a path apiM resolved for itself, and it must
  // survive validateCommand's normalisation no matter who asked for it.
  return remember(findMSBuildUncached());
}

/**
 * Register a discovered absolute path with the runner and return it unchanged,
 * so discovery reads as one expression instead of a temp variable per branch.
 */
function remember(found: string | null): string | null {
  if (found && path.isAbsolute(found)) registerToolchainPath(found);
  return found;
}

function findMSBuildUncached(): string | null {
  const explicit = process.env.APIM_MSBUILD_PATH?.trim();
  if (explicit && fsSync.existsSync(explicit)) return explicit;
  if (WIN) {
    const vswhere = vswherePath();
    if (vswhere) {
      /*
       * -prerelease, and no -requires.
       *
       * Both were failure modes on a real machine: a Preview/next-major
       * install (VS 18) is invisible without -prerelease, and
       * `-requires Microsoft.Component.MSBuild` excludes installs whose
       * component set is spelled differently — including Build Tools. The
       * find pattern already guarantees we only accept a real MSBuild.exe,
       * so the requires clause was buying nothing and costing installs.
       */
      for (const extra of [
        ["-latest", "-prerelease"],
        ["-latest"],
        ["-prerelease"],
      ]) {
        try {
          const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
          const r = spawnSync(
            vswhere,
            [...extra, "-find", "MSBuild\\**\\Bin\\MSBuild.exe"],
            { encoding: "utf8", windowsHide: true }
          );
          const found = (r.stdout || "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            // Prefer the 64-bit host when the install ships both.
            .sort((a, b) => Number(b.includes("amd64")) - Number(a.includes("amd64")))
            .find((line) => fsSync.existsSync(line));
          if (found) return found;
        } catch {
          /* try the next vswhere shape */
        }
      }
    }

    /*
     * vswhere itself can be missing (Build Tools installed by a zip, an
     * offline layout, a machine where the Installer directory was cleaned).
     * Walking the standard install roots costs a few stats and finds the
     * MSBuild that is plainly there — including next-major versions this
     * code has never heard of, because the year folder is enumerated rather
     * than hard-coded.
     */
    const roots = [
      process.env["ProgramFiles"],
      process.env["ProgramFiles(x86)"],
    ].filter(Boolean) as string[];
    for (const root of roots) {
      const vsRoot = path.join(root, "Microsoft Visual Studio");
      let years: string[] = [];
      try {
        years = fsSync.readdirSync(vsRoot).sort().reverse();
      } catch {
        continue;
      }
      for (const year of years) {
        let editions: string[] = [];
        try {
          editions = fsSync.readdirSync(path.join(vsRoot, year));
        } catch {
          continue;
        }
        for (const edition of editions) {
          for (const bin of [
            path.join(vsRoot, year, edition, "MSBuild", "Current", "Bin", "amd64", "MSBuild.exe"),
            path.join(vsRoot, year, edition, "MSBuild", "Current", "Bin", "MSBuild.exe"),
          ]) {
            if (fsSync.existsSync(bin)) return bin;
          }
        }
      }
    }
  }
  // Cross-spawn resolves bare names on PATH; on Windows include .exe.
  return "msbuild";
}

/**
 * The absolute path to cl.exe, when Visual Studio has one.
 *
 * Bare `cl` only works inside a Developer Command Prompt, and the model is
 * never in one — reported exactly that way: "it fell back to raw cl and never
 * walked vswhere". Resolving the real path means the compiler at least
 * STARTS; if the developer environment is missing it then fails with its own
 * clear message about headers rather than "cl is not recognised", which is
 * the difference between a fixable error and a dead end.
 */
export function findClPath(): string | null {
  return remember(findClPathUncached());
}

function findClPathUncached(): string | null {
  if (!WIN) return null;
  const vswhere = vswherePath();
  if (!vswhere) return null;
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const r = spawnSync(
      vswhere,
      [
        "-latest",
        "-prerelease",
        "-find",
        "VC\\Tools\\MSVC\\**\\bin\\Hostx64\\x64\\cl.exe",
      ],
      { encoding: "utf8", windowsHide: true }
    );
    const found = (r.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort()
      .reverse()
      .find((line) => fsSync.existsSync(line));
    return found ?? null;
  } catch {
    return null;
  }
}

/** Is this program resolvable on PATH right now? */
function onPath(command: string): boolean {
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const probe = spawnSync(WIN ? "where" : "which", [command], {
      encoding: "utf8",
      windowsHide: true,
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

/** Locate the C# compiler. Prefers csc from the VS/.NET Framework install. */
export function findCSharpCompiler(): string | null {
  return remember(findCSharpCompilerUncached());
}

function findCSharpCompilerUncached(): string | null {
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
  return remember(findCppCompilerUncached());
}

function findCppCompilerUncached(): string | null {
  const explicit = process.env.APIM_CPP_COMPILER?.trim();
  if (explicit) return explicit;

  if (WIN) {
    // The full path first: `cl` alone is only on PATH inside a Developer
    // Command Prompt, which nothing here is running in.
    const cl = findClPath();
    if (cl) return cl;
    if (onPath("cl")) return "cl";
    if (onPath("clang-cl")) return "clang-cl";
    if (onPath("clang++")) return "clang++";
    if (onPath("g++")) return "g++";
    // Nothing found: say so, rather than handing back a command that cannot
    // start and reporting its ENOENT as a build failure.
    return null;
  }

  for (const cc of ["clang++", "clang", "g++", "cc", "c++"]) {
    if (onPath(cc)) return cc;
  }
  // On a POSIX box the toolchain is nearly always there; keep the old
  // optimistic default rather than refusing to try.
  return "c++";
}

/** Directories that never contain the project you meant. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".packages",
  "obj",
  "bin",
  "build",
  "out",
  "dist",
  "x64",
  "x86",
  "win32",
  "debug",
  "release",
  ".vs",
  ".vscode",
  "packages",
  "target",
  "venv",
  "__pycache__",
]);

/**
 * Find the project file, wherever the human actually put it.
 *
 * Discovery used to look in the workspace ROOT only. A real tree does not
 * look like that: the reported case was `uploads/injector/x64/Release/...`
 * with the solution one or two directories down, so the root held nothing but
 * loose sources — and the detector fell through to "compile a single .cpp
 * with cl", which on a six-translation-unit project is not the build anyone
 * asked for and never touches MSBuild at all.
 *
 * Breadth-first so the SHALLOWEST project wins, which is the one a human
 * would name, and a .sln outranks a .vcxproj at the same depth because it is
 * the thing that knows about the other projects.
 */
async function findProjectFile(
  root: string,
  maxDepth = 4
): Promise<{ relative: string; kind: BuildTarget["kind"]; visited: number } | null> {
  const RANK: [RegExp, BuildTarget["kind"], number][ ] = [
    [/\.sln$/i, "msbuild", 0],
    [/\.slnx$/i, "msbuild", 0],
    [/\.vcxproj$/i, "msbuild", 1],
    [/\.csproj$/i, "csproj", 2],
    [/\.fsproj$/i, "dotnet", 2],
    [/^CMakeLists\.txt$/i, "cmake", 3],
  ];

  let best: { relative: string; kind: BuildTarget["kind"]; score: number } | null =
    null;
  let visited = 0;

  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    visited++;
    const entries = await listDir(dir);

    for (const entry of entries) {
      for (const [pattern, kind, rank] of RANK) {
        if (!pattern.test(entry)) continue;
        // Depth dominates rank: a solution three levels down loses to a
        // vcxproj beside it, because proximity is what the human meant.
        const score = depth * 10 + rank;
        if (!best || score < best.score) {
          best = {
            relative: path.relative(root, path.join(dir, entry)) || entry,
            kind,
            score,
          };
        }
      }
    }

    if (depth >= maxDepth) continue;
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.toLowerCase())) continue;
      const child = path.join(dir, entry);
      try {
        if (fsSync.statSync(child).isDirectory()) {
          queue.push({ dir: child, depth: depth + 1 });
        }
      } catch {
        /* unreadable directory is not a project */
      }
    }
  }

  return best ? { relative: best.relative, kind: best.kind, visited } : null;
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

  /*
   * Nothing at the root — look deeper before giving up on a real project.
   *
   * This runs BEFORE the loose-source fallback on purpose: a tree with both a
   * solution in a subdirectory and a stray .cpp at the root should build the
   * solution, not the stray.
   */
  const deep = await findProjectFile(root);
  if (deep) {
    return {
      kind: deep.kind,
      path: deep.relative,
      searched: `${deep.visited} directories`,
    };
  }

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
  return detectBuildIn(workspaceDirectory(workspaceId), options);
}

/**
 * The same detection against a plain directory.
 *
 * Split out so discovery can be tested against a real tree without inventing
 * a workspace — the recursive search is the part that was wrong, and a bug in
 * it is invisible from the outside until a six-file project builds as one
 * stray .cpp.
 */
export async function detectBuildIn(
  root: string,
  options: BuildOptions = {}
): Promise<BuildResult> {
  const config = options.config === "Debug" ? "Debug" : "Release";
  const platform = options.platform?.trim() || "x64";
  const extra = options.extraArgs ?? [];
  const restore = options.restore !== false;

  /*
   * An explicit project beats any amount of cleverness.
   *
   * Discovery is a guess, however good; when the model already knows the
   * answer — because it just read the tree, or because discovery got it
   * wrong once — it must be able to say so instead of arguing with a
   * heuristic.
   */
  const named = options.project?.trim();
  const target = named
    ? ({
        kind: /\.sln$|\.slnx$|\.vcxproj$/i.test(named)
          ? "msbuild"
          : /\.csproj$/i.test(named)
            ? "csproj"
            : /\.fsproj$/i.test(named)
              ? "dotnet"
              : /CMakeLists\.txt$/i.test(named)
                ? "cmake"
                : /\.(c|cc|cpp|cxx)$/i.test(named)
                  ? "single-cpp"
                  : /\.cs$/i.test(named)
                    ? "single-cs"
                    : "none",
        path: named,
        searched: "named explicitly",
      } as BuildTarget)
    : await detectTarget(root);

  if (named && target.kind === "none") {
    throw new BuildError(
      `"${named}" is not something this can build. Pass a .sln, .vcxproj, ` +
        `.csproj, CMakeLists.txt, or a single .cpp/.cs file — or omit project ` +
        `and let discovery find it.`
    );
  }

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
      // The discovered path is registered so the runner keeps it instead of
      // reducing it to the bare name and asking PATH, which is what produced
      // "spawn msbuild ENOENT" from a build that had just printed the full
      // path to MSBuild.exe.
      if (path.isAbsolute(msbuild)) registerToolchainPath(msbuild);

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
          "No C/C++ compiler found. On Windows this means vswhere reported " +
            "no VC++ toolset and cl/clang/g++ are not on PATH — install the " +
            "\"Desktop development with C++\" workload, or set " +
            "APIM_CPP_COMPILER to a compiler executable. If Visual Studio IS " +
            "installed, build a .sln/.vcxproj instead: MSBuild sets up the " +
            "compiler environment itself, which a bare cl.exe cannot."
        );
      }
      if (path.isAbsolute(cc)) registerToolchainPath(cc);
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
      if (path.isAbsolute(csc)) registerToolchainPath(csc);
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
