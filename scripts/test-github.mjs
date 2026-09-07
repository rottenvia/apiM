/** GitHub OAuth connector, working-branch and push safety checks. */
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { finishSuite } from "./lib/proc.mjs";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_ROOT = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.join(ROOT, "data");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const G = await load("src/lib/github.ts");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const git = async (cwd, args) => (await exec("git", args, { cwd })).stdout.trim();

console.log("\napiM GitHub connector checks\n");

console.log("1. OAuth tokens never become browser-readable plaintext");
console.log("\n1b. Personal Access Tokens work with no OAuth app");
check("a classic PAT shape is accepted", G.looksLikeGitHubToken("ghp_" + "a".repeat(36)));
check("an OAuth PAT shape is accepted", G.looksLikeGitHubToken("gho_" + "a".repeat(36)));
check("a fine-grained PAT shape is accepted", G.looksLikeGitHubToken("github_pat_" + "A".repeat(82)));
check("a legacy bare token is accepted", G.looksLikeGitHubToken("a".repeat(40)));
check("whitespace junk is refused", !G.looksLikeGitHubToken("   "));
check("too-short junk is refused", !G.looksLikeGitHubToken("abc"));
{
  const r1 = await G.resolveGitHubToken({ requestToken: "ghp_" + "b".repeat(36) });
  check("request PAT wins", r1.via === "pat" && r1.token.startsWith("ghp_"));
  let threw = false;
  try {
    await G.resolveGitHubToken({ requestToken: "not a token!!" });
  } catch { threw = true; }
  check("malformed request token is rejected loudly", threw);
  // With no env token set, resolution degrades to null (no OAuth cookie passed).
  const savedEnv = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GITHUB_PAT: process.env.GITHUB_PAT };
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_PAT;
  const r3 = await G.resolveGitHubToken({});
  if (savedEnv.GITHUB_TOKEN !== undefined) process.env.GITHUB_TOKEN = savedEnv.GITHUB_TOKEN;
  if (savedEnv.GITHUB_PAT !== undefined) process.env.GITHUB_PAT = savedEnv.GITHUB_PAT;
  check("no token yields null without throwing", r3.token === null && r3.via === null);
}
const sealed = await G.sealGitHubToken("gho_super_secret_token", "test-encryption-secret");
check("sealed cookie does not contain the token", !sealed.includes("gho_super_secret_token"));
check(
  "the correct server secret opens it",
  (await G.openGitHubToken(sealed, "test-encryption-secret")) === "gho_super_secret_token"
);
check("a different secret cannot open it", (await G.openGitHubToken(sealed, "wrong")) === null);

console.log("\n2. Repository and branch inputs are constrained");
check("owner/repo is accepted", G.assertRepoName("octocat/hello-world") === "octocat/hello-world");
let rejected = 0;
for (const bad of ["../repo", "owner", "owner/repo/extra", "owner repo/x"]) {
  try { G.assertRepoName(bad); } catch { rejected++; }
}
check("malformed repository names are refused", rejected === 4, `${rejected}/4`);
rejected = 0;
for (const bad of ["../main", "bad branch", "-danger", "x.lock", "a..b"]) {
  try { G.assertBranch(bad); } catch { rejected++; }
}
check("dangerous branch names are refused", rejected === 5, `${rejected}/5`);

console.log("\n3. A selected base gets a separate writable branch");
const fixture = path.join(DATA_ROOT, "github-fixture");
const bare = path.join(fixture, "origin.git");
const seed = path.join(fixture, "seed");
await fs.rm(fixture, { recursive: true, force: true });
await fs.mkdir(fixture, { recursive: true });
await git(fixture, ["init", "--bare", bare]);
await fs.mkdir(seed, { recursive: true });
await git(seed, ["init", "-b", "main"]);
await git(seed, ["config", "user.name", "Fixture"]);
await git(seed, ["config", "user.email", "fixture@example.com"]);
await fs.writeFile(path.join(seed, "README.md"), "# connected repo\n", "utf8");
await fs.mkdir(path.join(seed, "src"), { recursive: true });
await fs.writeFile(path.join(seed, "src", "index.ts"), "export const repoFile = true;\n", "utf8");
await git(seed, ["add", "README.md", "src/index.ts"]);
await git(seed, ["commit", "-m", "seed"]);
const mainBefore = await git(seed, ["rev-parse", "HEAD"]);
await git(seed, ["remote", "add", "origin", bare]);
await git(seed, ["push", "-u", "origin", "main"]);

const workspaceId = "githubtest";
await fs.rm(path.join(DATA_ROOT, "workspaces", workspaceId), { recursive: true, force: true });
const connection = await G.cloneGitHubRepoToWorkspace({
  workspaceId,
  repo: "owner/sample",
  cloneUrl: bare,
  baseBranch: "main",
});
const workspace = path.join(DATA_ROOT, "workspaces", workspaceId);
check("repository files become ordinary workspace files", (await fs.readFile(path.join(workspace, "README.md"), "utf8")).includes("connected repo"));
check("working branch is dedicated", connection.workingBranch.startsWith("apim/"));
check("selected base is remembered", connection.baseBranch === "main");
check("checkout is on the working branch", (await git(workspace, ["branch", "--show-current"])) === connection.workingBranch);
check("other branches remain inspectable", (await git(workspace, ["branch", "-r"])).includes("origin/main"));
check("OAuth token is not written into git config", !(await fs.readFile(path.join(workspace, ".git", "config"), "utf8")).includes("token"));

console.log("\n4. Publishing can only target the dedicated branch");
await fs.appendFile(path.join(workspace, "README.md"), "changed by agent\n");
await git(workspace, ["add", "README.md"]);
await git(workspace, ["commit", "-m", "agent change"]);
await G.pushGitHubWorkspace(workspaceId, "dummy-token-not-used-for-local-remote");
const branches = await git(fixture, ["--git-dir", bare, "branch", "--format=%(refname:short)"]);
check("working branch was pushed", branches.split("\n").includes(connection.workingBranch));
check("base branch was not modified", (await git(fixture, ["--git-dir", bare, "rev-parse", "main"])) === mainBefore);
await git(workspace, ["checkout", "-b", "wrong-branch", "origin/main"]);
let wrongBranchRefused = false;
try { await G.pushGitHubWorkspace(workspaceId, "dummy"); } catch (error) {
  wrongBranchRefused = /expected/.test(String(error));
}
check("push is refused from any other branch", wrongBranchRefused);

console.log("\n4b. Changes review and the on/off toggle");
await git(workspace, ["checkout", connection.workingBranch]);
// A committed change and an uncommitted one, both vs the base branch.
await fs.appendFile(path.join(workspace, "README.md"), "more committed work\n");
await git(workspace, ["add", "README.md"]);
await git(workspace, ["commit", "-m", "second change"]);
await fs.writeFile(path.join(workspace, "NEW.md"), "# brand new file\n", "utf8");
const changes = await G.gitHubWorkspaceChanges(workspaceId);
check("changes report the connection", changes.connection?.repo === "owner/sample");
check("changes list the edited file", changes.files.some((f) => f.path === "README.md"));
check("changes list the added file", changes.files.some((f) => f.path === "NEW.md" && f.status === "A"));
check("uncommitted edits are counted", changes.uncommitted >= 1);
check("ahead count reflects the working commits", changes.ahead >= 2);
check("unified diff is produced and mentions the new file", changes.diff.includes("brand new file"));
// Turn OFF: metadata is forgotten but the workspace files remain in place.
await G.clearGitHubConnection(workspaceId);
check("turning off forgets the connection", (await G.readGitHubConnection(workspaceId)) === null);
check("turning off keeps the workspace files", await fs.readFile(path.join(workspace, "README.md"), "utf8").then(() => true).catch(() => false));
check("changes with no connection are empty", (await G.gitHubWorkspaceChanges(workspaceId)).files.length === 0);

console.log("\n4c. Connecting works even when the workspace already has files");
const preWs = path.join(DATA_ROOT, "workspaces", "githubpre");
await fs.rm(preWs, { recursive: true, force: true });
await fs.mkdir(preWs, { recursive: true });
// The user's pre-existing work: a file that collides with a repo file
// (README.md) and a brand-new file the repo does not have.
await fs.writeFile(path.join(preWs, "README.md"), "# USER VERSION — must win\n", "utf8");
await fs.mkdir(path.join(preWs, "src"), { recursive: true });
await fs.writeFile(path.join(preWs, "src", "user-app.ts"), "export const mine = true;\n", "utf8");

const preConnection = await G.cloneGitHubRepoToWorkspace({
  workspaceId: "githubpre",
  repo: "owner/sample",
  cloneUrl: bare,
  baseBranch: "main",
});
check("connection into a non-empty workspace succeeds", Boolean(preConnection));
check("the user's colliding file is never overwritten",
  (await fs.readFile(path.join(preWs, "README.md"), "utf8")).includes("USER VERSION"));
check("the user's own new file is kept",
  (await fs.readFile(path.join(preWs, "src", "user-app.ts"), "utf8")).includes("mine"));
check("the workspace became a git repository",
  await fs.access(path.join(preWs, ".git")).then(() => true, () => false));
check("repo files missing from the workspace are filled in",
  (await fs.readFile(path.join(preWs, "src", "index.ts"), "utf8")).includes("repoFile"));
const preStatus = await git(preWs, ["status", "--porcelain"]);
check("git status works after merging into existing files", typeof preStatus === "string");
check("reconnected workspace is on a dedicated branch",
  (await git(preWs, ["branch", "--show-current"])) === preConnection.workingBranch);
// Reconnect after a disconnect: files + .git stay, rebinding must not throw.
await G.clearGitHubConnection("githubpre");
await fs.writeFile(path.join(preWs, "after-disconnect.txt"), "still here\n", "utf8");
const reConnection = await G.cloneGitHubRepoToWorkspace({
  workspaceId: "githubpre",
  repo: "owner/sample",
  cloneUrl: bare,
  baseBranch: "main",
});
check("reconnecting a workspace that is already a git repo works", Boolean(reConnection));
check("reconnect keeps the post-disconnect file",
  (await fs.readFile(path.join(preWs, "after-disconnect.txt"), "utf8")).includes("still here"));
check("reconnect keeps user content",
  (await fs.readFile(path.join(preWs, "README.md"), "utf8")).includes("USER VERSION"));

console.log("\n5. UI and agent wiring");
const connector = await fs.readFile(path.join(ROOT, "src/components/GitHubConnector.tsx"), "utf8");
const callbackRoute = await fs.readFile(
  path.join(ROOT, "src/app/api/github/oauth/callback/route.ts"),
  "utf8"
);
const sidePanel = await fs.readFile(path.join(ROOT, "src/components/WorkspaceSidePanel.tsx"), "utf8");
const route = await fs.readFile(path.join(ROOT, "src/app/api/chat/route.ts"), "utf8");
const tools = await fs.readFile(path.join(ROOT, "src/lib/tools.ts"), "utf8");
check("workspace has a GitHub connector button", /Connect a GitHub repository/.test(sidePanel));
check("repository and branch pickers exist", /Find a repository/.test(connector) && /Base branch/.test(connector));
check(
  "OAuth uses a popup so the current chat workspace id survives",
  /apim-github-oauth/.test(connector) && /postMessage/.test(callbackRoute)
);
check(
  "OAuth token cookie is HttpOnly",
  /httpOnly: true/.test(callbackRoute)
);
check(
  "connector offers a Personal Access Token path that needs no OAuth app",
  /Personal Access Token/.test(connector) && /x-github-token/.test(connector)
);
check("github_push is registered", /name: "github_push"/.test(tools));
check("remote push uses the approval flow", /call\.function\.name === "github_push"/.test(route) && /requestApproval/.test(route));
check("push is withheld without OAuth plus workspace metadata", /githubConnection && githubToken/.test(route));

await fs.rm(fixture, { recursive: true, force: true });
await fs.rm(path.join(DATA_ROOT, "workspaces", workspaceId), { recursive: true, force: true });
await fs.rm(path.join(DATA_ROOT, "github"), { recursive: true, force: true });
console.log(`\n${pass + fail} checks · ${pass} passed${fail ? ` · ${fail} failed` : ""}\n`);
await finishSuite(fail);
