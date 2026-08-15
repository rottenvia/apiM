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
await git(seed, ["add", "README.md"]);
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
  "token storage is HttpOnly and never localStorage",
  /httpOnly: true/.test(callbackRoute) && !/localStorage/.test(connector)
);
check("github_push is registered", /name: "github_push"/.test(tools));
check("remote push uses the approval flow", /call\.function\.name === "github_push"/.test(route) && /requestApproval/.test(route));
check("push is withheld without OAuth plus workspace metadata", /githubConnection && githubToken/.test(route));

await fs.rm(fixture, { recursive: true, force: true });
await fs.rm(path.join(DATA_ROOT, "workspaces", workspaceId), { recursive: true, force: true });
await fs.rm(path.join(DATA_ROOT, "github"), { recursive: true, force: true });
console.log(`\n${pass + fail} checks · ${pass} passed${fail ? ` · ${fail} failed` : ""}\n`);
await finishSuite(fail);
