/**
 * Git tools for the agent, Claude-Code style.
 *
 * The connected repository is a real clone in the chat's workspace. The
 * agent works on its own branch with ordinary git — status, diff, log,
 * commit, branch, merge from the base — pushes that branch, and opens a
 * pull request. Every function here reads the stored connection first and
 * refuses anything that would commit to, merge into, or push the base
 * branch. Nothing force-pushes. The token is only ever passed to runGit
 * (credential env) or githubApi (Authorization header).
 */
import path from "node:path";
import { workspaceDirectory } from "@/lib/workspace";
import {
  assertBranch,
  branchSlug,
  githubApi,
  pushGitHubWorkspace,
  readGitHubConnection,
  runGit,
  writeGitHubConnection,
  type GitHubConnection,
} from "@/lib/github";

/** Tools that run locally with no approval (github_pr_status only reads). */
export const GIT_AGENT_TOOLS = new Set([
  "git_status",
  "git_diff",
  "git_log",
  "git_commit",
  "git_branch",
  "git_pull_base",
  "github_pr_status",
]);

/** Offered only when a token is available as well as a connection. */
export const GITHUB_REMOTE_TOOLS = new Set([
  "github_push",
  "github_create_pr",
  "github_pr_status",
]);

const DIFF_CAP = 20_000;

export type GitHubApi = <T>(token: string, pathname: string, init?: RequestInit) => Promise<T>;

interface Ctx {
  connection: GitHubConnection;
  root: string;
}

async function context(workspaceId: string): Promise<Ctx> {
  const connection = await readGitHubConnection(workspaceId);
  if (!connection) throw new Error("No GitHub repository is connected to this workspace");
  return { connection, root: workspaceDirectory(workspaceId) };
}

async function git(root: string, args: string[], token?: string): Promise<string> {
  return (await runGit(root, args, token)).stdout;
}

async function gitOk(root: string, args: string[]): Promise<boolean> {
  return runGit(root, args).then(
    () => true,
    () => false
  );
}

async function currentBranch(root: string): Promise<string> {
  return (await git(root, ["branch", "--show-current"])).trim();
}

function refuseBase(branch: string, connection: GitHubConnection, what: string): void {
  if (!branch) throw new Error(`${what} refused: HEAD is detached — switch to a working branch first`);
  if (branch === connection.baseBranch) {
    throw new Error(
      `${what} refused: ${branch} is the base branch. Work on ${connection.workingBranch} ` +
        `(or git_branch create) instead.`
    );
  }
}

function cleanPath(p: string): string {
  const clean = p.trim().replace(/\\/g, "/");
  if (!clean || path.isAbsolute(clean) || clean.split("/").includes("..")) {
    throw new Error(`Invalid path: ${p}`);
  }
  return clean;
}

// ---------------------------------------------------------------- status

export interface GitStatus {
  branch: string;
  baseBranch: string;
  workingBranch: string;
  /** Commits on HEAD not on origin/<base>, and the reverse. */
  ahead: number;
  behind: number;
  /** Commits not yet pushed to origin/<branch>; null when never pushed. */
  unpushed: number | null;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
}

async function aheadBehind(root: string, left: string, right = "HEAD") {
  const out = await git(root, ["rev-list", "--left-right", "--count", `${left}...${right}`]).catch(
    () => ""
  );
  const [behind, ahead] = out.trim().split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
  return { ahead: ahead ?? 0, behind: behind ?? 0, known: out.trim() !== "" };
}

export async function gitStatus(workspaceId: string): Promise<GitStatus> {
  const { connection, root } = await context(workspaceId);
  const branch = await currentBranch(root);
  const base = await aheadBehind(root, `origin/${connection.baseBranch}`);
  let unpushed: number | null = null;
  if (branch && (await gitOk(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]))) {
    unpushed = (await aheadBehind(root, `origin/${branch}`)).ahead;
  }
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const conflicted: string[] = [];
  const porcelain = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = porcelain.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    // A rename/copy carries its source path as the next NUL field.
    if (x === "R" || x === "C") i++;
    if (x === "?" && y === "?") untracked.push(file);
    else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      conflicted.push(file);
    } else {
      if (x !== " ") staged.push(`${x} ${file}`);
      if (y !== " ") unstaged.push(`${y} ${file}`);
    }
  }
  return {
    branch,
    baseBranch: connection.baseBranch,
    workingBranch: connection.workingBranch,
    ahead: base.ahead,
    behind: base.behind,
    unpushed,
    staged,
    unstaged,
    untracked,
    conflicted,
  };
}

function listBlock(title: string, items: string[], cap = 60): string {
  if (items.length === 0) return "";
  const shown = items.slice(0, cap).map((i) => `  ${i}`).join("\n");
  const more = items.length > cap ? `\n  … ${items.length - cap} more` : "";
  return `\n${title} (${items.length}):\n${shown}${more}`;
}

export function formatGitStatus(s: GitStatus): string {
  const push =
    s.unpushed === null
      ? "not pushed yet"
      : s.unpushed === 0
        ? "in sync with origin"
        : `${s.unpushed} commit${s.unpushed === 1 ? "" : "s"} not pushed`;
  const clean =
    s.staged.length + s.unstaged.length + s.untracked.length + s.conflicted.length === 0;
  return (
    `On branch ${s.branch || "(detached)"}` +
    (s.branch && s.branch !== s.workingBranch ? ` (connected working branch: ${s.workingBranch})` : "") +
    `\nvs origin/${s.baseBranch}: ${s.ahead} ahead, ${s.behind} behind` +
    (s.behind > 0 ? " — git_pull_base to merge the latest base" : "") +
    `\nRemote branch: ${push}` +
    (clean
      ? "\nWorking tree clean."
      : listBlock("Conflicted", s.conflicted) +
        listBlock("Staged", s.staged) +
        listBlock("Unstaged", s.unstaged) +
        listBlock("Untracked", s.untracked))
  );
}

// ---------------------------------------------------------------- diff / log

export async function gitDiff(
  workspaceId: string,
  options: { path?: string; staged?: boolean; base?: boolean; maxChars?: number } = {}
): Promise<{ diff: string; truncated: boolean; stat: string }> {
  const { connection, root } = await context(workspaceId);
  const args = ["diff", "--no-color", "--no-ext-diff"];
  if (options.base) args.push(`origin/${connection.baseBranch}...HEAD`);
  else if (options.staged) args.push("--cached");
  const spec = options.path ? ["--", cleanPath(options.path)] : [];
  const stat = (await git(root, [...args, "--stat", ...spec])).trim();
  const full = await git(root, [...args, ...spec]);
  const cap = Math.max(1000, Math.min(options.maxChars ?? DIFF_CAP, 100_000));
  return { diff: full.slice(0, cap), truncated: full.length > cap, stat };
}

export async function gitLog(
  workspaceId: string,
  count = 10
): Promise<{ commits: { sha: string; date: string; author: string; subject: string }[] }> {
  const { root } = await context(workspaceId);
  const n = Math.max(1, Math.min(Math.floor(count) || 10, 50));
  const out = await git(root, [
    "log",
    `-n${n}`,
    "--date=short",
    "--pretty=format:%h%x1f%ad%x1f%an%x1f%s",
  ]).catch(() => "");
  const commits = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, date, author, subject] = line.split("\x1f");
      return { sha, date, author, subject };
    });
  return { commits };
}

// ---------------------------------------------------------------- commit

export async function gitCommit(
  workspaceId: string,
  options: { message: string; paths?: string[] }
): Promise<{ sha: string; branch: string; summary: string }> {
  const { connection, root } = await context(workspaceId);
  const message = (options.message ?? "").trim();
  if (!message) throw new Error("A commit message is required");
  const branch = await currentBranch(root);
  refuseBase(branch, connection, "Commit");
  const paths = (options.paths ?? []).filter((p) => typeof p === "string" && p.trim()).map(cleanPath);
  const spec = paths.length ? ["--", ...paths] : [];
  await git(root, ["add", "-A", ...spec]);
  // `diff --cached --quiet` exits 1 when something is staged.
  if (await gitOk(root, ["diff", "--cached", "--quiet", ...spec])) {
    throw new Error(
      paths.length
        ? `Nothing to commit in ${paths.join(", ")} — those paths have no changes.`
        : "Nothing to commit — the working tree has no changes."
    );
  }
  await git(root, ["commit", "--no-verify", "-q", "-m", message.slice(0, 5000), ...spec]);
  const sha = (await git(root, ["rev-parse", "--short", "HEAD"])).trim();
  const summary = (await git(root, ["show", "--stat", "--format=", "HEAD"])).trim();
  return { sha, branch, summary };
}

// ---------------------------------------------------------------- branch

export async function gitBranch(
  workspaceId: string,
  options: { action: "create" | "switch" | "list"; name?: string }
): Promise<{ branch?: string; text: string; connection: GitHubConnection }> {
  const { connection, root } = await context(workspaceId);
  const current = await currentBranch(root);

  if (options.action === "list") {
    const local = (await git(root, ["branch", "--format=%(refname:short)"]))
      .split("\n")
      .filter(Boolean);
    const remote = (await git(root, ["branch", "-r", "--format=%(refname:short)"]))
      .split("\n")
      .filter((b) => b && !b.endsWith("/HEAD") && b !== "origin");
    const mark = (b: string) =>
      `${b === current ? "* " : "  "}${b}` +
      (b === connection.baseBranch ? " (base)" : "") +
      (b === connection.workingBranch ? " (working)" : "");
    return {
      connection,
      text: `Local:\n${local.map(mark).join("\n")}\nRemote:\n${remote.map((b) => `  ${b}`).join("\n")}`,
    };
  }

  const raw = (options.name ?? "").trim();
  if (!raw) throw new Error(`git_branch ${options.action} needs a name`);

  let name: string;
  if (options.action === "create") {
    // New branches live under apim/ like the one made at connect time.
    name = raw.startsWith("apim/") ? assertBranch(raw) : assertBranch(`apim/${branchSlug(raw) || "work"}`);
    if (name === connection.baseBranch) throw new Error("Cannot create a branch named like the base branch");
    if (await gitOk(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) {
      throw new Error(`Branch ${name} already exists — use action "switch"`);
    }
    // From the current HEAD; uncommitted edits come along.
    await git(root, ["checkout", "-b", name]);
  } else if (options.action === "switch") {
    name = assertBranch(raw.replace(/^origin\//, ""));
    if (name === connection.baseBranch) {
      throw new Error(
        `Switching to the base branch ${name} is refused — work is committed on a working branch. ` +
          `Use git_diff/git_log (or read-only git show) to inspect the base.`
      );
    }
    if (name !== current) {
      if (await gitOk(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) {
        await git(root, ["checkout", name]);
      } else if (await gitOk(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`])) {
        await git(root, ["checkout", "-b", name, "--track", `origin/${name}`]);
      } else {
        throw new Error(`No branch named ${name} locally or on origin`);
      }
    }
  } else {
    throw new Error(`Unknown git_branch action: ${String(options.action)}`);
  }

  const updated: GitHubConnection = { ...connection, workingBranch: name };
  if (connection.prBranch && connection.prBranch !== name) {
    delete updated.prUrl;
    delete updated.prNumber;
    delete updated.prBranch;
  }
  await writeGitHubConnection(updated);
  return {
    branch: name,
    connection: updated,
    text: `${options.action === "create" ? "Created and switched to" : "Switched to"} ${name}. github_push and github_create_pr now target this branch.`,
  };
}

// ---------------------------------------------------------------- pull base

export type PullBaseResult =
  | { ok: true; merged: boolean; text: string }
  | { ok: false; conflicts: string[]; text: string };

export async function gitPullBase(workspaceId: string, token?: string): Promise<PullBaseResult> {
  const { connection, root } = await context(workspaceId);
  const branch = await currentBranch(root);
  refuseBase(branch, connection, "Merging the base");
  const dirty = (await git(root, ["status", "--porcelain", "--untracked-files=no"])).trim();
  if (dirty) {
    throw new Error("Commit (git_commit) or discard your uncommitted changes before git_pull_base");
  }
  await git(root, ["fetch", "--no-tags", "origin", connection.baseBranch], token);
  const baseRef = `origin/${connection.baseBranch}`;
  const { behind } = await aheadBehind(root, baseRef);
  if (behind === 0) {
    return { ok: true, merged: false, text: `Already up to date with ${baseRef}.` };
  }
  try {
    await git(root, ["merge", "--no-edit", "--no-verify", baseRef]);
  } catch (error) {
    const conflicts = (await git(root, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
      .split("\n")
      .filter(Boolean);
    // Never leave a half-merged tree behind.
    await git(root, ["merge", "--abort"]).catch(() => git(root, ["reset", "--merge"]));
    if (conflicts.length === 0) throw error;
    return {
      ok: false,
      conflicts,
      text:
        `Merging ${baseRef} into ${branch} conflicts in: ${conflicts.join(", ")}. ` +
        `The merge was aborted; the branch is unchanged. Resolve by editing those files to ` +
        `match the base, committing, then git_pull_base again — or tell the user.`,
    };
  }
  const head = (await git(root, ["rev-parse", "--short", "HEAD"])).trim();
  return {
    ok: true,
    merged: true,
    text: `Merged ${behind} commit${behind === 1 ? "" : "s"} from ${baseRef} into ${branch} (now ${head}).`,
  };
}

// ---------------------------------------------------------------- pull requests

export interface PullRequestInfo {
  number: number;
  url: string;
  state: string;
  draft: boolean;
  title: string;
  head: string;
  base: string;
  /** True when this call found an existing PR instead of opening one. */
  existing?: boolean;
}

function toPr(row: Record<string, unknown>): PullRequestInfo {
  const head = (row.head ?? {}) as Record<string, unknown>;
  const base = (row.base ?? {}) as Record<string, unknown>;
  return {
    number: Number(row.number ?? 0),
    url: String(row.html_url ?? ""),
    state: row.merged_at ? "merged" : String(row.state ?? "open"),
    draft: row.draft === true,
    title: String(row.title ?? ""),
    head: String(head.ref ?? ""),
    base: String(base.ref ?? ""),
  };
}

async function findPullRequest(
  api: GitHubApi,
  token: string,
  connection: GitHubConnection,
  state: "open" | "all" = "open"
): Promise<Record<string, unknown> | null> {
  const owner = connection.repo.split("/")[0];
  const rows = await api<Record<string, unknown>[]>(
    token,
    `/repos/${connection.repo}/pulls?head=${encodeURIComponent(`${owner}:${connection.workingBranch}`)}&state=${state}&per_page=5`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/** Does origin lack this branch, or lack commits HEAD has? */
export async function needsPush(workspaceId: string, token?: string): Promise<boolean> {
  const { connection, root } = await context(workspaceId);
  const remote = (
    await git(root, ["ls-remote", "--heads", "origin", `refs/heads/${connection.workingBranch}`], token)
  ).trim();
  if (!remote) return true;
  const remoteSha = remote.split(/\s+/)[0];
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  return remoteSha !== head;
}

async function rememberPr(connection: GitHubConnection, pr: PullRequestInfo) {
  const fresh = (await readGitHubConnection(connection.workspaceId)) ?? connection;
  await writeGitHubConnection({
    ...fresh,
    prUrl: pr.url,
    prNumber: pr.number,
    prBranch: connection.workingBranch,
  });
}

export async function createGitHubPullRequest(
  workspaceId: string,
  token: string,
  options: { title: string; body?: string; draft?: boolean },
  deps: { api?: GitHubApi; push?: typeof pushGitHubWorkspace } = {}
): Promise<{ pr: PullRequestInfo; pushed: boolean }> {
  const api = deps.api ?? githubApi;
  const push = deps.push ?? pushGitHubWorkspace;
  const { connection, root } = await context(workspaceId);
  const title = (options.title ?? "").trim();
  if (!title) throw new Error("A pull request title is required");
  if (connection.workingBranch === connection.baseBranch) {
    throw new Error("Pull request refused: the working branch is the base branch");
  }
  const branch = await currentBranch(root);
  if (branch !== connection.workingBranch) {
    throw new Error(`Current branch is ${branch || "detached"}, expected ${connection.workingBranch}`);
  }
  if ((await aheadBehind(root, `origin/${connection.baseBranch}`)).ahead === 0) {
    throw new Error(`No commits on ${branch} beyond ${connection.baseBranch} — commit work with git_commit first`);
  }

  // Push first when origin lacks the branch or is behind HEAD (never forced).
  let pushed = false;
  if (await needsPush(workspaceId, token)) {
    await push(workspaceId, token);
    pushed = true;
  }

  const existing = await findPullRequest(api, token, connection);
  if (existing) {
    const pr = { ...toPr(existing), existing: true };
    await rememberPr(connection, pr);
    return { pr, pushed };
  }
  let created: Record<string, unknown>;
  try {
    created = await api<Record<string, unknown>>(token, `/repos/${connection.repo}/pulls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.slice(0, 256),
        body: (options.body ?? "").slice(0, 60_000),
        head: connection.workingBranch,
        base: connection.baseBranch,
        draft: options.draft === true,
      }),
    });
  } catch (error) {
    // 422 "A pull request already exists" — a race or a closed search window.
    if (/\b422\b/.test(String(error))) {
      const again = await findPullRequest(api, token, connection);
      if (again) {
        const pr = { ...toPr(again), existing: true };
        await rememberPr(connection, pr);
        return { pr, pushed };
      }
    }
    throw error;
  }
  const pr = toPr(created);
  await rememberPr(connection, pr);
  return { pr, pushed };
}

export interface PullRequestStatus extends PullRequestInfo {
  mergeable: boolean | null;
  mergeableState: string;
  checks: { total: number; passed: number; failed: number; pending: number; failing: string[] };
  reviewComments: number;
  comments: number;
}

export async function gitHubPullRequestStatus(
  workspaceId: string,
  token: string,
  deps: { api?: GitHubApi } = {}
): Promise<PullRequestStatus | null> {
  const api = deps.api ?? githubApi;
  const { connection } = await context(workspaceId);
  let number =
    connection.prNumber && connection.prBranch === connection.workingBranch
      ? connection.prNumber
      : 0;
  if (!number) {
    const found = await findPullRequest(api, token, connection, "all");
    if (!found) return null;
    number = Number(found.number ?? 0);
  }
  const row = await api<Record<string, unknown>>(token, `/repos/${connection.repo}/pulls/${number}`);
  const pr = toPr(row);
  if (connection.prNumber !== pr.number) await rememberPr(connection, pr);
  const sha = String(((row.head ?? {}) as Record<string, unknown>).sha ?? "");
  const checks = { total: 0, passed: 0, failed: 0, pending: 0, failing: [] as string[] };
  if (sha) {
    const runs = await api<{ total_count?: number; check_runs?: Record<string, unknown>[] }>(
      token,
      `/repos/${connection.repo}/commits/${sha}/check-runs?per_page=100`
    ).catch(() => ({ total_count: 0, check_runs: [] }));
    for (const run of runs.check_runs ?? []) {
      checks.total++;
      const conclusion = String(run.conclusion ?? "");
      if (run.status !== "completed") checks.pending++;
      else if (["success", "neutral", "skipped"].includes(conclusion)) checks.passed++;
      else {
        checks.failed++;
        checks.failing.push(`${String(run.name ?? "check")} (${conclusion})`);
      }
    }
  }
  return {
    ...pr,
    mergeable: typeof row.mergeable === "boolean" ? row.mergeable : null,
    mergeableState: String(row.mergeable_state ?? "unknown"),
    checks,
    reviewComments: Number(row.review_comments ?? 0),
    comments: Number(row.comments ?? 0),
  };
}

export function formatPrStatus(s: PullRequestStatus): string {
  const c = s.checks;
  return (
    `PR #${s.number} ${s.url}\n` +
    `State: ${s.state}${s.draft ? " (draft)" : ""} · ${s.head} → ${s.base}\n` +
    `Mergeable: ${s.mergeable === null ? "unknown (GitHub is still computing)" : s.mergeable ? "yes" : "no"} (${s.mergeableState})\n` +
    `Checks: ${c.total === 0 ? "none reported" : `${c.passed} passed, ${c.failed} failed, ${c.pending} pending`}` +
    (c.failing.length ? `\nFailing: ${c.failing.slice(0, 10).join(", ")}` : "") +
    `\nReview comments: ${s.reviewComments} · conversation comments: ${s.comments}`
  );
}

/**
 * A title and body prefilled from the branch's commits since the base, for
 * the connector's "Create pull request" form. Local only.
 */
export async function suggestPullRequest(
  workspaceId: string
): Promise<{ title: string; body: string; commits: number }> {
  const { connection, root } = await context(workspaceId);
  const out = await git(root, [
    "log",
    "--reverse",
    "--pretty=format:%s",
    `origin/${connection.baseBranch}..HEAD`,
  ]).catch(() => "");
  const subjects = out.split("\n").map((s) => s.trim()).filter(Boolean);
  const fallback = connection.workingBranch
    .replace(/^apim\//, "")
    .replace(/-[a-z0-9]{6}$/, "")
    .replace(/[-_/]+/g, " ")
    .trim();
  const title =
    subjects.length === 1
      ? subjects[0]
      : subjects.length > 1
        ? subjects[subjects.length - 1]
        : fallback.charAt(0).toUpperCase() + fallback.slice(1);
  const body = subjects.length
    ? `## Changes\n\n${subjects.slice(-30).map((s) => `- ${s}`).join("\n")}\n`
    : "";
  return { title: title.slice(0, 256), body, commits: subjects.length };
}

// ---------------------------------------------------------------- dispatch

export interface GitToolResult {
  ok: boolean;
  content: string;
  summary: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * One entry point for the no-approval tools, so the chat route only has to
 * dispatch. Errors come back as a failed result the model can read.
 */
export async function runGitAgentTool(
  workspaceId: string,
  name: string,
  args: Record<string, unknown>,
  token?: string | null
): Promise<GitToolResult> {
  try {
    switch (name) {
      case "git_status": {
        const s = await gitStatus(workspaceId);
        return {
          ok: true,
          content: formatGitStatus(s),
          summary: `${s.branch}: ${s.ahead} ahead, ${s.behind} behind`,
        };
      }
      case "git_diff": {
        const d = await gitDiff(workspaceId, {
          path: str(args.path) || undefined,
          staged: args.staged === true,
          base: args.base === true,
        });
        const body = d.diff.trim()
          ? `${d.stat}\n\n${d.diff}${d.truncated ? "\n… diff truncated — pass path to narrow it" : ""}`
          : `No ${args.base === true ? "changes vs the base" : args.staged === true ? "staged changes" : "unstaged changes"}${args.staged === true || args.base === true ? "" : " (untracked files are listed by git_status)"}.`;
        return { ok: true, content: body, summary: d.stat.split("\n").pop()?.trim() || "No diff" };
      }
      case "git_log": {
        const { commits } = await gitLog(workspaceId, Number(args.count ?? 10));
        return {
          ok: true,
          content: commits.length
            ? commits.map((c) => `${c.sha} ${c.date} ${c.author}: ${c.subject}`).join("\n")
            : "No commits.",
          summary: `${commits.length} commit${commits.length === 1 ? "" : "s"}`,
        };
      }
      case "git_commit": {
        const paths = Array.isArray(args.paths) ? args.paths.map(String) : undefined;
        const c = await gitCommit(workspaceId, { message: str(args.message), paths });
        return {
          ok: true,
          content: `Committed ${c.sha} on ${c.branch} (local only — github_push or github_create_pr publishes it).\n${c.summary}`,
          summary: `Committed ${c.sha}`,
        };
      }
      case "git_branch": {
        const action = str(args.action) as "create" | "switch" | "list";
        const b = await gitBranch(workspaceId, { action: action || "list", name: str(args.name) });
        return { ok: true, content: b.text, summary: b.branch ? `On ${b.branch}` : "Branches listed" };
      }
      case "git_pull_base": {
        const r = await gitPullBase(workspaceId, token ?? undefined);
        return r.ok
          ? { ok: true, content: r.text, summary: r.merged ? "Merged base" : "Up to date" }
          : { ok: false, content: r.text, summary: `Merge conflicts (${r.conflicts.length})` };
      }
      case "github_pr_status": {
        if (!token) throw new Error("GitHub token missing — reconnect GitHub in the connector");
        const s = await gitHubPullRequestStatus(workspaceId, token);
        return s
          ? { ok: true, content: formatPrStatus(s), summary: `PR #${s.number} ${s.state}` }
          : { ok: true, content: "No pull request exists for this branch yet.", summary: "No PR" };
      }
      default:
        return { ok: false, content: `Unknown git tool ${name}`, summary: "Unknown tool" };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, content: `${name} failed: ${message}`, summary: `${name} failed` };
  }
}
