import { promises as fs } from "node:fs";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { workspaceDirectory, listFiles } from "@/lib/workspace";

export const GITHUB_TOKEN_COOKIE = "apim_github";
export const GITHUB_STATE_COOKIE = "apim_github_state";
export const GITHUB_POPUP_COOKIE = "apim_github_popup";
export const GITHUB_COOKIE_DAYS = 30;

const DATA_ROOT = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.resolve(process.cwd(), "data");
const GITHUB_DATA = path.join(DATA_ROOT, "github");

export interface GitHubConfig {
  /** Present when a GitHub OAuth app is registered. Optional. */
  clientId: string;
  clientSecret: string;
  tokenSecret: string;
}

/**
 * Resolve the credentials used to talk to GitHub.
 *
 * OAuth requires registering a whole GitHub App — fine in a hosted product,
 * a non-starter for someone running this at home. A Personal Access Token
 * works with nothing to configure server-side, so auth accepts, in order:
 *
 *   1. a token supplied on the request (PAT typed in the connector)
 *   2. a GITHUB_TOKEN / GITHUB_PAT environment variable
 *   3. an OAuth token sealed in the HttpOnly cookie (when an app exists)
 *
 * `oauthConfig` is reported separately so the UI can still offer the
 * "Connect with GitHub" button when an app IS configured.
 */
export function githubConfig(): GitHubConfig | null {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim() ?? "";
  const tokenSecret =
    process.env.GITHUB_TOKEN_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim() ||
    clientSecret ||
    "github-token-seal";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, tokenSecret };
}

/** A Personal Access Token supplied via env, used with no OAuth app. */
export function envGitHubToken(): string {
  return (
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_PAT?.trim() ||
    ""
  );
}

/** Validate that a string looks like a GitHub personal access token. */
export function looksLikeGitHubToken(value: string): boolean {
  const t = value.trim();
  if (t.length < 8) return false;
  // Classic: gho_/ghp_/ghu_/ghr_/ghs_ prefixes, fine-grained (github_pat_),
  // or a bare hex/alnum legacy token. Whitespace inside means it is a paste
  // of something else (a sentence), which must not be sent as a header.
  return /^(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{40,}|[A-Za-z0-9_]{20,})$/.test(
    t
  ) && !/\s/.test(t);
}

/**
 * The token to use for GitHub calls for one request, trying every source.
 * OAuth cookies are only read when an OAuth app is configured; a PAT works
 * regardless.
 */
export async function resolveGitHubToken(options: {
  cookieValue?: string;
  requestToken?: string;
}): Promise<{ token: string | null; via: "pat" | "env" | "oauth" | null }> {
  const provided = options.requestToken?.trim() ?? "";
  if (provided) {
    if (looksLikeGitHubToken(provided)) return { token: provided, via: "pat" };
    throw new Error("That does not look like a GitHub access token.");
  }

  const env = envGitHubToken();
  if (env) return { token: env, via: "env" };

  const config = githubConfig();
  if (config) {
    const sealed = await openGitHubToken(
      options.cookieValue,
      config.tokenSecret
    );
    if (sealed) return { token: sealed, via: "oauth" };
  }
  return { token: null, via: null };
}

export interface GitHubRepo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  updatedAt: string;
}

export interface GitHubConnection {
  workspaceId: string;
  repo: string;
  cloneUrl: string;
  baseBranch: string;
  workingBranch: string;
  connectedAt: string;
  /** Pull request opened for `prBranch` (the working branch at the time). */
  prUrl?: string;
  prNumber?: number;
  prBranch?: string;
}

function bytes(input: string): ArrayBuffer {
  const view = new TextEncoder().encode(input);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function exactBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function b64url(input: Uint8Array): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64url(input: string): Uint8Array {
  const pad = (4 - (input.length % 4)) % 4;
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", bytes(`apiM github:${secret}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** OAuth tokens stay in an encrypted HttpOnly cookie, never localStorage/workspace. */
export async function sealGitHubToken(token: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: exactBuffer(iv) },
    await encryptionKey(secret),
    bytes(token)
  );
  return `${b64url(iv)}.${b64url(new Uint8Array(encrypted))}`;
}

export async function openGitHubToken(
  sealed: string | undefined,
  secret: string
): Promise<string | null> {
  if (!sealed) return null;
  const [ivRaw, bodyRaw] = sealed.split(".");
  if (!ivRaw || !bodyRaw) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: exactBuffer(fromB64url(ivRaw)) },
      await encryptionKey(secret),
      exactBuffer(fromB64url(bodyRaw))
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export function assertRepoName(repo: string): string {
  const clean = repo.trim();
  const [owner, name, extra] = clean.split("/");
  if (
    extra !== undefined ||
    !owner ||
    !name ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new Error("Invalid GitHub repository name");
  }
  return clean;
}

export function assertBranch(branch: string): string {
  const clean = branch.trim();
  if (
    !clean ||
    clean.length > 180 ||
    clean.startsWith("-") ||
    clean.includes("..") ||
    /[~^:?*\[\\\s]/.test(clean) ||
    clean.endsWith("/") ||
    clean.endsWith(".lock")
  ) {
    throw new Error("Invalid Git branch name");
  }
  return clean;
}

export async function githubApi<T>(
  token: string,
  pathname: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "apiM-github-connector",
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub returned ${response.status}${body ? `: ${body.slice(0, 180)}` : ""}`);
  }
  return (await response.json()) as T;
}

export async function listGitHubRepos(token: string): Promise<GitHubRepo[]> {
  const rows = await githubApi<Record<string, unknown>[]>(
    token,
    "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member"
  );
  return rows.map((row) => {
    const owner = (row.owner ?? {}) as Record<string, unknown>;
    return {
      fullName: String(row.full_name ?? ""),
      name: String(row.name ?? ""),
      owner: String(owner.login ?? ""),
      private: row.private === true,
      defaultBranch: String(row.default_branch ?? "main"),
      cloneUrl: String(row.clone_url ?? ""),
      updatedAt: String(row.updated_at ?? ""),
    };
  }).filter((repo) => repo.fullName && repo.cloneUrl.startsWith("https://github.com/"));
}

export async function listGitHubBranches(
  token: string,
  repo: string
): Promise<string[]> {
  const fullName = assertRepoName(repo);
  const rows = await githubApi<{ name?: string }[]>(
    token,
    `/repos/${fullName}/branches?per_page=100`
  );
  return rows.map((row) => row.name ?? "").filter(Boolean);
}

function metadataPath(workspaceId: string): string {
  if (!/^[\w-]{1,128}$/.test(workspaceId)) throw new Error("Invalid workspace id");
  return path.join(GITHUB_DATA, "workspaces", `${workspaceId}.json`);
}

export async function readGitHubConnection(
  workspaceId: string
): Promise<GitHubConnection | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(metadataPath(workspaceId), "utf8"));
    if (!parsed?.repo || !parsed?.workingBranch) return null;
    return parsed as GitHubConnection;
  } catch {
    return null;
  }
}

export async function writeGitHubConnection(connection: GitHubConnection): Promise<void> {
  const target = metadataPath(connection.workspaceId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(connection, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
}

function gitAuthEnv(token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    // Merges and commits never open an editor on the server.
    GIT_EDITOR: "true",
    GIT_MERGE_AUTOEDIT: "no",
  };
  // Repository hooks never run: a commit or merge the agent makes without
  // approval must not execute code the cloned repository ships.
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "core.hooksPath";
  env.GIT_CONFIG_VALUE_0 = path.join(GITHUB_DATA, "no-hooks");
  if (!token) return env;
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  env.GIT_CONFIG_COUNT = "3";
  env.GIT_CONFIG_KEY_1 = "credential.helper";
  env.GIT_CONFIG_VALUE_1 = "";
  env.GIT_CONFIG_KEY_2 = "http.https://github.com/.extraheader";
  env.GIT_CONFIG_VALUE_2 = `AUTHORIZATION: basic ${auth}`;
  return env;
}

/** Run git with no shell; a token only ever travels in the process env. */
export async function runGit(
  cwd: string,
  args: string[],
  token?: string,
  timeoutMs = 180_000
): Promise<{ stdout: string; stderr: string }> {
  await fs.mkdir(path.join(GITHUB_DATA, "no-hooks"), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = crossSpawn("git", args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: gitAuthEnv(token),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`git ${args[0]} timed out`));
    }, timeoutMs);
    child.stdout?.on("data", (data) => (stdout += data.toString()));
    child.stderr?.on("data", (data) => (stderr += data.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `git exited ${code}`).trim().slice(-2000)));
    });
  });
}

/** Lowercase, dash-separated, at most 40 chars — safe inside a branch name. */
export function branchSlug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/**
 * A fresh working branch: `apim/<slug-of-task>-<short id>`. Falls back to
 * the workspace id when there is no task text to name it after.
 */
export function workingBranchName(task: string | undefined, workspaceId: string): string {
  const slug = branchSlug(task ?? "") || branchSlug(workspaceId.slice(0, 8)) || "work";
  const shortId = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return assertBranch(`apim/${slug}-${shortId}`);
}

export async function connectGitHubRepo(options: {
  workspaceId: string;
  token: string;
  repo: string;
  baseBranch: string;
  /** Names the new working branch (e.g. the chat title). */
  task?: string;
  /** An existing remote branch to continue instead of creating a new one. */
  continueBranch?: string;
}): Promise<GitHubConnection> {
  const repo = assertRepoName(options.repo);
  const info = await githubApi<Record<string, unknown>>(options.token, `/repos/${repo}`);
  const cloneUrl = String(info.clone_url ?? "");
  if (!cloneUrl.startsWith("https://github.com/")) throw new Error("GitHub did not return a valid clone URL");
  return cloneGitHubRepoToWorkspace({ ...options, repo, cloneUrl });
}

/**
 * Copy a directory tree without overwriting anything that already exists.
 * Used to lay a freshly cloned repo OVER a workspace that already has
 * files: anything already present (the user's work) wins, anything only in
 * the clone (the rest of the project) is filled in. Dotfiles/dotdirs like
 * .gitignore are copied too. Returns how many entries were added.
 */
async function mergeTreeWithoutOverwriting(
  from: string,
  to: string
): Promise<number> {
  let added = 0;
  await fs.mkdir(to, { recursive: true });
  for (const name of await fs.readdir(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    const stat = await fs.lstat(src);
    if (stat.isDirectory()) {
      added += await mergeTreeWithoutOverwriting(src, dst);
    } else if (!await fs.access(dst).then(() => true, () => false)) {
      await fs.copyFile(src, dst);
      added++;
    }
  }
  return added;
}

/** Exported for an offline local-bare-repository integration test. */
export async function cloneGitHubRepoToWorkspace(options: {
  workspaceId: string;
  token?: string;
  repo: string;
  cloneUrl: string;
  baseBranch: string;
  task?: string;
  continueBranch?: string;
}): Promise<GitHubConnection> {
  const repo = assertRepoName(options.repo);
  const baseBranch = assertBranch(options.baseBranch);
  const cloneUrl = options.cloneUrl;
  const continueBranch = options.continueBranch?.trim()
    ? assertBranch(options.continueBranch)
    : "";
  if (continueBranch && continueBranch === baseBranch) {
    throw new Error(
      "Pick a branch other than the base to continue — the base branch is never committed to"
    );
  }

  const root = workspaceDirectory(options.workspaceId);
  const existingFiles = await listFiles(options.workspaceId).catch(() => []);
  const hasWorkspaceFiles = existingFiles.length > 0;
  const rootExists = await fs
    .access(root)
    .then(() => true)
    .catch(() => false);
  // A leftover .git in the workspace (e.g. after a disconnect, or files the
  // user imported from a git checkout) must never be shadowed by the clone's
  // one — if the same path is already a repo we attach to what is there.
  const rootHasGit =
    rootExists &&
    (await fs
      .access(path.join(root, ".git"))
      .then(() => true)
      .catch(() => false));

  const temp = `${root}.github-${Date.now().toString(36)}`;
  const workingBranch =
    continueBranch || workingBranchName(options.task, options.workspaceId);
  await fs.rm(temp, { recursive: true, force: true });
  await fs.mkdir(path.dirname(root), { recursive: true });

  try {
    // Full clone (with the working tree) into a temp dir. The token is
    // passed only via credential env, so it never lands in git config.
    await runGit(
      path.dirname(root),
      ["clone", "--no-hardlinks", cloneUrl, temp],
      options.token,
      600_000
    );
    // Create and switch to the dedicated writable branch IN THE CLONE, so
    // checkout can never touch or conflict with workspace files.
    // Continuing an existing branch checks it out tracking origin; a new
    // one starts from the selected base.
    await runGit(
      temp,
      continueBranch
        ? ["checkout", "-B", workingBranch, "--track", `origin/${workingBranch}`]
        : ["checkout", "-b", workingBranch, `origin/${baseBranch}`],
      options.token
    );
    await runGit(temp, ["config", "user.name", "apiM Agent"], undefined);
    await runGit(temp, ["config", "user.email", "apim-agent@users.noreply.github.com"], undefined);

    if (rootHasGit) {
      // The workspace is already a git repo (typically a reconnect after a
      // "turn off", or an imported git checkout). Keep its history and files
      // exactly as they are; only make sure origin points at the connected
      // repository.
      const remotes = (await runGit(root, ["remote"]).catch(() => ({ stdout: "" }))).stdout;
      if (!remotes.split("\n").includes("origin")) {
        await runGit(root, ["remote", "add", "origin", cloneUrl]);
      } else {
        await runGit(root, ["remote", "set-url", "origin", cloneUrl]);
      }
      await runGit(root, ["fetch", "origin"], options.token, 300_000).catch(() => {});
      await runGit(root, ["config", "user.name", "apiM Agent"]).catch(() => {});
      await runGit(root, ["config", "user.email", "apim-agent@users.noreply.github.com"]).catch(() => {});
      // Put the repo on the (new) dedicated working branch, anchored at the
      // CURRENT commit so no file is touched — all existing work is preserved
      // and will be pushed to this fresh apim/ branch.
      if (continueBranch) {
        // Git refuses (and the error surfaces) if local edits would be lost.
        await runGit(root, [
          "checkout", "-B", workingBranch, "--track", `origin/${workingBranch}`,
        ]);
      } else {
        await runGit(root, ["checkout", "-B", workingBranch], undefined);
      }
    } else {
      if (!rootExists) await fs.mkdir(root, { recursive: true });
      // Attach the clone's history by moving ONLY .git into the workspace.
      // Doing it first means the repo files we are about to fill in are
      // tracked by index/HEAD, while the user's existing files simply show
      // up as working-tree changes.
      await fs.rename(path.join(temp, ".git"), path.join(root, ".git"));
      // Local git identity for agent commits.
      await runGit(root, ["config", "user.name", "apiM Agent"]).catch(() => {});
      await runGit(root, ["config", "user.email", "apim-agent@users.noreply.github.com"]).catch(() => {});
      // Point the working branch at the clone's tip WITHOUT checking out, so
      // the workspace tree is never modified by git.
      await runGit(root, ["checkout", "-B", workingBranch], undefined).catch(() => {});
      // Lay the cloned project files in. Files already in the workspace are
      // never overwritten — the user's copy wins; missing project files are
      // added. Empty workspace -> this is effectively a full clone.
      await mergeTreeWithoutOverwriting(temp, root);
      // Refresh the index so `git status` reflects the merged tree: files
      // copied from the repo that match HEAD are clean; anything that was
      // already in the workspace and differs shows as a real change. Never
      // committing here — the agent stages/commits its own work; this only
      // makes the status report correct.
      await runGit(root, ["add", "-A", "--"], undefined).catch(() => {});
    }

    await fs.rm(temp, { recursive: true, force: true });

    const connection: GitHubConnection = {
      workspaceId: options.workspaceId,
      repo,
      cloneUrl,
      baseBranch,
      workingBranch,
      connectedAt: new Date().toISOString(),
    };
    await writeGitHubConnection(connection);
    return connection;
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true });
    // If we created .git in what was a non-repo workspace and failed, leave
    // the files but remove the half-attached repo so a retry starts clean.
    if (!hasWorkspaceFiles && !rootHasGit) {
      await fs.rm(path.join(root, ".git"), { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

export async function pushGitHubWorkspace(
  workspaceId: string,
  token: string
): Promise<{ connection: GitHubConnection; output: string }> {
  const connection = await readGitHubConnection(workspaceId);
  if (!connection) throw new Error("No GitHub repository is connected to this workspace");
  if (connection.workingBranch === connection.baseBranch) {
    throw new Error("Push refused: the working branch is the base branch");
  }
  const root = workspaceDirectory(workspaceId);
  const branch = (await runGit(root, ["branch", "--show-current"])).stdout.trim();
  if (branch !== connection.workingBranch) {
    throw new Error(`Push refused: current branch is ${branch || "detached"}, expected ${connection.workingBranch}`);
  }
  const remote = (await runGit(root, ["remote", "get-url", "origin"])).stdout.trim();
  if (remote !== connection.cloneUrl) throw new Error("Push refused: origin no longer matches the connected repository");
  const pushed = await runGit(
    root,
    ["push", "--set-upstream", "origin", `HEAD:refs/heads/${connection.workingBranch}`],
    token,
    300_000
  );
  return { connection, output: (pushed.stderr || pushed.stdout).trim() };
}

/**
 * Forget the GitHub connection for a workspace ("turn off" the project
 * link). The cloned files stay exactly where they are in the workspace —
 * only the metadata that binds the workspace to the repository is removed,
 * so the agent stops pushing and the connector offers a fresh connect.
 */
export async function clearGitHubConnection(workspaceId: string): Promise<void> {
  await fs.rm(metadataPath(workspaceId), { force: true });
}

export interface GitHubFileChange {
  path: string;
  /** M modified · A added · D deleted · R renamed · C copied. */
  status: "M" | "A" | "D" | "R" | "C";
  additions: number;
  deletions: number;
}

export interface GitHubChanges {
  connection: GitHubConnection | null;
  /** Commits on the working branch that are not on the base yet. */
  ahead: number;
  /** Files changed vs the base branch, each with line counts. */
  files: GitHubFileChange[];
  totalAdditions: number;
  totalDeletions: number;
  /** A unified diff, capped, for the expandable review pane. */
  diff: string;
  uncommitted: number;
}

/**
 * What this workspace would change on GitHub relative to the base branch.
 *
 * Runs entirely against the local clone — no token, no network — comparing
 * the working branch (committed work plus uncommitted edits) with the point
 * it diverged from the base.
 */
export async function gitHubWorkspaceChanges(
  workspaceId: string
): Promise<GitHubChanges> {
  const connection = await readGitHubConnection(workspaceId);
  if (!connection) {
    return {
      connection: null,
      ahead: 0,
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      diff: "",
      uncommitted: 0,
    };
  }
  const root = workspaceDirectory(workspaceId);

  // Uncommitted work (agent edits not yet committed) — "uncommitted" count.
  const statusOut = (await runGit(root, ["status", "--porcelain"])).stdout;
  const uncommitted = statusOut
    .split("\n")
    .filter((line) => line.trim().length > 0).length;

  // Base ref: prefer the local remote-tracking ref from the clone.
  const baseRef = `origin/${connection.baseBranch}`;

  // Commits ahead of base.
  const aheadOut = (
    await runGit(root, [
      "rev-list",
      "--count",
      `${baseRef}..HEAD`,
    ]).catch(() => ({ stdout: "0", stderr: "" }))
  ).stdout.trim();
  const ahead = Number.parseInt(aheadOut, 10) || 0;

  // Per-file change summary: status letter + numstat line counts, including
  // uncommitted changes by diffing the working tree against the merge-base.
  const numstat = (
    await runGit(root, [
      "diff",
      "--numstat",
      `${baseRef}...HEAD`,
    ]).catch(() => ({ stdout: "", stderr: "" }))
  ).stdout;
  // Also fold in uncommitted edits so the review shows live work too.
  const numstatWork = (
    await runGit(root, ["diff", "--numstat", baseRef]).catch(() => ({
      stdout: "",
      stderr: "",
    }))
  ).stdout;

  const files = new Map<string, GitHubFileChange>();
  const merge = (out: string) => {
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\t/);
      if (parts.length < 3) continue;
      const [add, del, p] = parts;
      const additions = add === "-" ? 0 : Number.parseInt(add, 10) || 0;
      const deletions = del === "-" ? 0 : Number.parseInt(del, 10) || 0;
      const path = p.split(/ -> /).pop() ?? p;
      const prev = files.get(path);
      files.set(path, {
        path,
        status: prev?.status ?? (deletions === 0 ? "A" : "M"),
        additions: Math.max(prev?.additions ?? 0, additions),
        deletions: Math.max(prev?.deletions ?? 0, deletions),
      });
    }
  };
  merge(numstat);
  merge(numstatWork);

  // Status letters for added/deleted.
  const nameStatus = (
    await runGit(root, ["diff", "--name-status", baseRef]).catch(() => ({
      stdout: "",
      stderr: "",
    }))
  ).stdout;
  for (const line of nameStatus.split("\n")) {
    const parts = line.trim().split(/\t/);
    if (parts.length < 2) continue;
    const letter = parts[0][0] as GitHubFileChange["status"];
    const p = parts[parts.length - 1];
    const entry = files.get(p);
    if (entry) entry.status = letter;
    else files.set(p, { path: p, status: letter, additions: 0, deletions: 0 });
  }

  // Untracked files (brand-new, not yet added) do not appear in `git diff`,
  // so fold them in from porcelain status as additions with no line counts.
  for (const line of statusOut.split("\n")) {
    if (line.length < 3) continue;
    const code = line.slice(0, 2);
    const p = line.slice(3).split(" -> ").pop()?.trim() ?? "";
    if (!p) continue;
    if (code === "??" && !files.has(p)) {
      files.set(p, { path: p, status: "A", additions: 0, deletions: 0 });
    }
  }

  const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));

  // Unified diff, capped so a huge change cannot flood the UI.
  let diff = (
    await runGit(root, [
      "diff",
      "--no-color",
      "--unified=3",
      baseRef,
    ]).catch(() => ({ stdout: "", stderr: "" }))
  ).stdout;
  // Untracked files are absent from `git diff`; render each as a pure
  // addition against /dev/null (text files only — binaries are skipped).
  for (const line of statusOut.split("\n")) {
    if (line.slice(0, 2) !== "??") continue;
    const p = line.slice(3).trim();
    if (!p) continue;
    const content = await fs
      .readFile(path.join(root, p), "utf8")
      .catch(() => null);
    if (content === null) continue; // binary or unreadable — listed, not diffed
    const body = content
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n");
    diff += `\ndiff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n${body}\n`;
  }
  diff = diff.slice(0, 200_000);

  return {
    connection,
    ahead,
    files: list,
    totalAdditions: list.reduce((s, f) => s + f.additions, 0),
    totalDeletions: list.reduce((s, f) => s + f.deletions, 0),
    diff,
    uncommitted,
  };
}
