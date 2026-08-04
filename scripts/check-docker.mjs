/**
 * Checks whether this machine can run the sandbox.
 *
 * Run:  npm run check:docker
 *
 * The agent loop (write code, run it, read the error, fix it) needs Docker to
 * run untrusted code safely. This reports whether Docker is present, running,
 * and actually able to start a locked-down container — before any of that
 * work gets built on an assumption.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const run = promisify(execFile);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (c) => (s) => (COLOR ? `\x1b[${c}m${s}\x1b[0m` : s);
const green = wrap(32);
const red = wrap(31);
const yellow = wrap(33);
const dim = wrap(2);
const bold = wrap(1);

let blocked = false;

const yes = (label, detail = "") =>
  console.log(`  ${green("YES")}  ${label}${detail ? dim("  " + detail) : ""}`);
const no = (label, detail = "") => {
  blocked = true;
  console.log(`  ${red("NO ")}  ${label}${detail ? "  " + detail : ""}`);
};

async function tryRun(cmd, args, timeout = 25_000) {
  try {
    const { stdout } = await run(cmd, args, { timeout, windowsHide: true });
    return { ok: true, out: stdout.trim() };
  } catch (err) {
    return {
      ok: false,
      out: String(err?.stderr || err?.stdout || err?.message || err).trim(),
    };
  }
}

async function main() {
  console.log(bold("\nCan this machine run the sandbox?\n"));

  const totalGb = os.totalmem() / 1024 ** 3;
  console.log(
    dim(
      `  ${os.platform()} ${os.arch()} · ${totalGb.toFixed(1)} GB RAM · ${os.cpus().length} cores\n`
    )
  );

  // 1. Is Docker installed?
  const version = await tryRun("docker", ["--version"]);
  if (!version.ok) {
    no("Docker is installed");
    console.log(
      dim("\n      Not found. Install Docker Desktop (free for personal use):")
    );
    console.log(dim("      https://www.docker.com/products/docker-desktop/\n"));
    console.log(
      dim("      On Windows it needs WSL2 and virtualisation enabled in BIOS.")
    );
    console.log(
      dim("      Check: Task Manager → Performance → CPU → 'Virtualization'.\n")
    );
    process.exit(1);
  }
  yes("Docker is installed", version.out);

  // 2. Is the daemon actually running? Installed but not started is the most
  //    common state, and gives a completely different error.
  const info = await tryRun("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (!info.ok) {
    no("Docker is running");
    console.log(
      dim("\n      Docker is installed but the engine isn't running.")
    );
    console.log(dim("      Start Docker Desktop and wait for it to say 'Running'.\n"));
    process.exit(1);
  }
  yes("Docker is running", `engine ${info.out}`);

  // 3. Can it actually pull and run a container?
  console.log(dim("\n  starting a test container (first run downloads ~5 MB)…\n"));
  const hello = await tryRun(
    "docker",
    ["run", "--rm", "alpine:3.20", "echo", "sandbox-ok"],
    120_000
  );
  if (!hello.ok || !hello.out.includes("sandbox-ok")) {
    no("A container can run", hello.out.split("\n").slice(-2).join(" "));
    process.exit(1);
  }
  yes("A container can run");

  // 4. The real question: do the isolation flags work here? These are the
  //    exact flags the sandbox will use, so a failure now is a failure later.
  const locked = await tryRun(
    "docker",
    [
      "run", "--rm",
      "--network", "none",
      "--memory", "512m",
      "--cpus", "0.5",
      "--pids-limit", "128",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--user", "1000:1000",
      "alpine:3.20",
      "echo", "locked-ok",
    ],
    120_000
  );
  if (!locked.ok || !locked.out.includes("locked-ok")) {
    no("The isolation flags work", locked.out.split("\n").slice(-2).join(" "));
  } else {
    yes("The isolation flags work", "network off, memory capped, read-only");
  }

  // 5. Confirm the network really is off — the flag silently mattering is the
  //    whole point, so verify rather than trust it.
  const netTest = await tryRun(
    "docker",
    [
      "run", "--rm", "--network", "none", "alpine:3.20",
      "sh", "-c", "wget -q -T 3 -O- http://example.com || echo no-network",
    ],
    60_000
  );
  if (netTest.ok && netTest.out.includes("no-network")) {
    yes("Network really is blocked inside the container");
  } else {
    no("Network is blocked inside the container", netTest.out.slice(0, 80));
  }

  // 6. Python image, since that is what most generated code will need.
  console.log(dim("\n  checking a Python image (downloads ~50 MB the first time)…\n"));
  const py = await tryRun(
    "docker",
    ["run", "--rm", "python:3.12-alpine", "python", "-c", "print('py-ok')"],
    240_000
  );
  if (py.ok && py.out.includes("py-ok")) {
    yes("Python can run in a container");
  } else {
    console.log(
      `  ${yellow("WARN")}  Python image didn't run` +
        dim("  (not fatal — it can be pulled later)")
    );
  }

  console.log("");
  if (blocked) {
    console.log(red(bold("  Something is blocking the sandbox — see above.\n")));
    process.exit(1);
  }

  console.log(green(bold("  This machine can run the sandbox.")));
  console.log(
    dim("  The agent loop can be built here — no server, no hosting needed.\n")
  );
}

main().catch((err) => {
  console.error(red("\n  Check crashed: " + (err?.message || err)));
  process.exit(1);
});
