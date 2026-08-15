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
  clientId: string;
  clientSecret: string;
  tokenSecret: string;
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
}

export function githubConfig(): GitHubConfig | null {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim() ?? "";
  const tokenSecret =
    process.env.GITHUB_TOKEN_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim() ||
    clientSecret;
  if (!clientId || !clientSecret || !tokenSecret) return null;
  return { clientId, clientSecret, tokenSecret };
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

async function writeGitHubConnection(connection: GitHubConnection): Promise<void> {
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
  };
  if (!token) return env;
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  env.GIT_CONFIG_COUNT = "3";
  env.GIT_CONFIG_KEY_0 = "credential.helper";
  env.GIT_CONFIG_VALUE_0 = "";
  env.GIT_CONFIG_KEY_1 = "core.hooksPath";
  env.GIT_CONFIG_VALUE_1 = path.join(GITHUB_DATA, "no-hooks");
  env.GIT_CONFIG_KEY_2 = "http.https://github.com/.extraheader";
  env.GIT_CONFIG_VALUE_2 = `AUTHORIZATION: basic ${auth}`;
  return env;
}

async function runGit(
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

export async function connectGitHubRepo(options: {
  workspaceId: string;
  token: string;
  repo: string;
  baseBranch: string;
}): Promise<GitHubConnection> {
  const repo = assertRepoName(options.repo);
  const info = await githubApi<Record<string, unknown>>(options.token, `/repos/${repo}`);
  const cloneUrl = String(info.clone_url ?? "");
  if (!cloneUrl.startsWith("https://github.com/")) throw new Error("GitHub did not return a valid clone URL");
  return cloneGitHubRepoToWorkspace({ ...options, repo, cloneUrl });
}

/** Exported for an offline local-bare-repository integration test. */
export async function cloneGitHubRepoToWorkspace(options: {
  workspaceId: string;
  token?: string;
  repo: string;
  cloneUrl: string;
  baseBranch: string;
}): Promise<GitHubConnection> {
  const repo = assertRepoName(options.repo);
  const baseBranch = assertBranch(options.baseBranch);
  const cloneUrl = options.cloneUrl;
  const visible = await listFiles(options.workspaceId);
  if (visible.length > 0) {
    throw new Error("This workspace already has files. Connect GitHub from a new empty chat so nothing is overwritten.");
  }

  const root = workspaceDirectory(options.workspaceId);
  const temp = `${root}.github-${Date.now().toString(36)}`;
  const workingBranch = assertBranch(
    `apim/${options.workspaceId.slice(0, 8)}-${Date.now().toString(36)}`
  );
  await fs.rm(temp, { recursive: true, force: true });
  await fs.mkdir(path.dirname(root), { recursive: true });

  try {
    await runGit(path.dirname(root), ["clone", "--no-checkout", cloneUrl, temp], options.token, 300_000);
    await runGit(temp, ["checkout", "-b", workingBranch, `origin/${baseBranch}`], undefined);
    await runGit(temp, ["config", "user.name", "apiM Agent"]);
    await runGit(temp, ["config", "user.email", "apim-agent@users.noreply.github.com"]);

    await fs.mkdir(root, { recursive: true });
    for (const name of await fs.readdir(temp)) {
      const destination = path.join(root, name);
      try {
        await fs.access(destination);
        throw new Error(`Workspace path already exists: ${name}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Workspace path")) throw error;
      }
      await fs.rename(path.join(temp, name), destination);
    }

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
    throw error;
  }
}

export async function pushGitHubWorkspace(
  workspaceId: string,
  token: string
): Promise<{ connection: GitHubConnection; output: string }> {
  const connection = await readGitHubConnection(workspaceId);
  if (!connection) throw new Error("No GitHub repository is connected to this workspace");
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
