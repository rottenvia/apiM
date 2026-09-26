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

console.log("\n6. Agent git workflow (commit, branch, pull base, pull requests)");
const A = await load("src/lib/git-agent.ts");
const tool = (ws, name, args = {}, token) => A.runGitAgentTool(ws, name, args, token);
{
  const named = G.workingBranchName("Fix the Login bug!", "abcdef123456");
  check("new branches are apim/<slug>-<short id>", /^apim\/fix-the-login-bug-[a-z0-9]{6}$/.test(named), named);
  check("a branch with no task falls back to the workspace id", /^apim\/abcdef12-[a-z0-9]{6}$/.test(G.workingBranchName("", "abcdef123456")));
  check("slugs are capped and never end in a dash", G.branchSlug("x".repeat(39) + " yz").length <= 40 && !G.branchSlug("a ".repeat(30)).endsWith("-"));
}
const flowId = "githubflow";
const flowWs = path.join(DATA_ROOT, "workspaces", flowId);
await fs.rm(flowWs, { recursive: true, force: true });
const flow = await G.cloneGitHubRepoToWorkspace({
  workspaceId: flowId,
  repo: "owner/sample",
  cloneUrl: bare,
  baseBranch: "main",
  task: "Add a greeting",
});
check("the working branch is named after the task", flow.workingBranch.startsWith("apim/add-a-greeting-"), flow.workingBranch);

let r = await tool(flowId, "git_status");
check("git_status reports branch and base", r.ok && r.content.includes(flow.workingBranch) && /0 ahead, 0 behind/.test(r.content), r.content.split("\n")[1]);
r = await tool(flowId, "git_commit", { message: "nothing" });
check("an empty commit is refused with a clear message", !r.ok && /Nothing to commit/.test(r.content), r.content);
r = await tool(flowId, "git_commit", { message: "" });
check("a commit without a message is refused", !r.ok && /message is required/.test(r.content));

await fs.writeFile(path.join(flowWs, "hello.ts"), "export const hi = 1;\n", "utf8");
await fs.writeFile(path.join(flowWs, "other.ts"), "export const other = 1;\n", "utf8");
r = await tool(flowId, "git_status");
check("git_status lists untracked files", r.content.includes("Untracked (2)") && r.content.includes("hello.ts"), r.content);
r = await tool(flowId, "git_commit", { message: "Add hello", paths: ["hello.ts"] });
check("git_commit commits only the given paths", r.ok && /Committed [0-9a-f]+/.test(r.content), r.content);
check("the other file stays uncommitted", (await git(flowWs, ["status", "--porcelain"])).includes("other.ts"));
check("the commit landed on the working branch", (await git(flowWs, ["log", "-1", "--format=%s", flow.workingBranch])) === "Add hello");
r = await tool(flowId, "git_diff", { base: true });
check("git_diff base=true shows the branch's changes", r.ok && r.content.includes("hello.ts"));
r = await tool(flowId, "git_commit", { message: "Add other" });
check("git_commit with no paths commits everything", r.ok && (await git(flowWs, ["status", "--porcelain"])) === "");
r = await tool(flowId, "git_log", { count: 2 });
check("git_log lists recent commits newest first", r.ok && r.content.split("\n")[0].includes("Add other") && r.content.split("\n").length === 2);
r = await tool(flowId, "git_status");
check("git_status counts commits ahead of the base", /2 ahead, 0 behind/.test(r.content) && /not pushed yet/.test(r.content));

// Refuse on base: put HEAD on a local base branch by hand and try to commit.
await git(flowWs, ["checkout", "-q", "-b", "main", "origin/main"]);
await fs.writeFile(path.join(flowWs, "onbase.txt"), "x\n", "utf8");
r = await tool(flowId, "git_commit", { message: "sneaky" });
check("git_commit is refused on the base branch", !r.ok && /base branch/.test(r.content), r.content);
await fs.rm(path.join(flowWs, "onbase.txt"));
await git(flowWs, ["checkout", "-q", flow.workingBranch]);

r = await tool(flowId, "git_branch", { action: "switch", name: "main" });
check("switching to the base branch is refused", !r.ok && /base branch/.test(r.content));
r = await tool(flowId, "git_branch", { action: "create", name: "Second Feature" });
check("git_branch create makes an apim/ branch", r.ok && (await git(flowWs, ["branch", "--show-current"])) === "apim/second-feature", r.content);
check("create updates the stored working branch", (await G.readGitHubConnection(flowId)).workingBranch === "apim/second-feature");
r = await tool(flowId, "git_branch", { action: "list" });
check("git_branch list marks base and working", r.ok && /\* apim\/second-feature \(working\)/.test(r.content) && /origin\/main/.test(r.content), r.content);
r = await tool(flowId, "git_branch", { action: "switch", name: flow.workingBranch });
check("switch moves HEAD and the stored working branch", r.ok &&
  (await git(flowWs, ["branch", "--show-current"])) === flow.workingBranch &&
  (await G.readGitHubConnection(flowId)).workingBranch === flow.workingBranch);

console.log("\n6b. git_pull_base merges cleanly or aborts on conflict");
await fs.writeFile(path.join(seed, "BASE.md"), "new on main\n", "utf8");
await git(seed, ["add", "BASE.md"]);
await git(seed, ["commit", "-m", "base moves on"]);
await git(seed, ["push", "-q", "origin", "main"]);
await fs.writeFile(path.join(flowWs, "dirty.ts"), "x\n", "utf8");
await git(flowWs, ["add", "dirty.ts"]);
r = await tool(flowId, "git_pull_base");
check("git_pull_base refuses a dirty tree", !r.ok && /uncommitted/.test(r.content), r.content);
await git(flowWs, ["rm", "-q", "--cached", "dirty.ts"]);
await fs.rm(path.join(flowWs, "dirty.ts"));
r = await tool(flowId, "git_pull_base", {}, "dummy");
check("git_pull_base merges the moved base", r.ok && /Merged 1 commit/.test(r.content), r.content);
check("the base's new file is in the workspace", await fs.access(path.join(flowWs, "BASE.md")).then(() => true, () => false));
r = await tool(flowId, "git_pull_base");
check("a second pull is a no-op", r.ok && /Already up to date/.test(r.content));

await fs.writeFile(path.join(seed, "README.md"), "# base rewrote this line\n", "utf8");
await git(seed, ["commit", "-qam", "base edits README"]);
await git(seed, ["push", "-q", "origin", "main"]);
await fs.writeFile(path.join(flowWs, "README.md"), "# branch rewrote this line\n", "utf8");
r = await tool(flowId, "git_commit", { message: "Edit README on branch" });
const headBefore = await git(flowWs, ["rev-parse", "HEAD"]);
r = await tool(flowId, "git_pull_base");
check("a conflicting merge reports the conflicted files", !r.ok && /README\.md/.test(r.content) && /aborted/.test(r.content), r.content);
check("the merge was aborted (no MERGE_HEAD)", !(await fs.access(path.join(flowWs, ".git", "MERGE_HEAD")).then(() => true, () => false)));
check("the branch is unchanged after the abort", (await git(flowWs, ["rev-parse", "HEAD"])) === headBefore && (await git(flowWs, ["status", "--porcelain"])) === "");
check("the working file keeps the branch's version", (await fs.readFile(path.join(flowWs, "README.md"), "utf8")).includes("branch rewrote"));

console.log("\n6c. Pull requests (GitHub API mocked, no network)");
const calls = [];
let existingPr = null;
let failPostWith422 = false;
const mockApi = async (token, pathname, init = {}) => {
  calls.push({ token, pathname, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
  if (pathname.startsWith("/repos/owner/sample/pulls?")) return existingPr ? [existingPr] : [];
  if (pathname === "/repos/owner/sample/pulls" && init.method === "POST") {
    if (failPostWith422) {
      existingPr = { number: 9, html_url: "https://github.com/owner/sample/pull/9", state: "open", head: { ref: "x" }, base: { ref: "main" } };
      throw new Error("GitHub returned 422: A pull request already exists");
    }
    const b = JSON.parse(init.body);
    return { number: 7, html_url: "https://github.com/owner/sample/pull/7", state: "open", draft: b.draft, title: b.title, head: { ref: b.head, sha: "abc" }, base: { ref: b.base } };
  }
  if (pathname === "/repos/owner/sample/pulls/7") {
    return { number: 7, html_url: "https://github.com/owner/sample/pull/7", state: "open", mergeable: true, mergeable_state: "clean", review_comments: 3, comments: 1, head: { ref: flow.workingBranch, sha: "abc123" }, base: { ref: "main" } };
  }
  if (pathname.startsWith("/repos/owner/sample/commits/abc123/check-runs")) {
    return { total_count: 3, check_runs: [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "failure" },
      { name: "e2e", status: "in_progress", conclusion: null },
    ] };
  }
  throw new Error(`unexpected ${pathname}`);
};
const suggestion = await A.suggestPullRequest(flowId);
check("the PR form is prefilled from the branch's commits", suggestion.commits >= 3 && suggestion.body.includes("- Add hello"), suggestion.title);
const created = await A.createGitHubPullRequest(flowId, "tok", { title: "Add greeting", body: "Adds hello.", draft: true }, { api: mockApi });
const post = calls.find((c) => c.method === "POST");
check("create_pr pushed the branch first", created.pushed &&
  (await git(fixture, ["--git-dir", bare, "branch", "--format=%(refname:short)"])).split("\n").includes(flow.workingBranch));
check("create_pr POSTs head=working, base=base", post && post.pathname === "/repos/owner/sample/pulls" &&
  post.body.head === flow.workingBranch && post.body.base === "main" && post.body.title === "Add greeting" && post.body.draft === true && post.body.body === "Adds hello.");
check("create_pr looks for an existing PR by owner:head first", calls[0].pathname.includes(`head=${encodeURIComponent(`owner:${flow.workingBranch}`)}`));
check("the base branch was not pushed", (await git(fixture, ["--git-dir", bare, "log", "-1", "--format=%s", "main"])) === "base edits README");
const stored = await G.readGitHubConnection(flowId);
check("prUrl and prNumber are stored in the connection", stored.prNumber === 7 && stored.prUrl.endsWith("/pull/7") && stored.prBranch === flow.workingBranch);

calls.length = 0;
existingPr = { number: 7, html_url: "https://github.com/owner/sample/pull/7", state: "open", head: { ref: flow.workingBranch }, base: { ref: "main" } };
const again = await A.createGitHubPullRequest(flowId, "tok", { title: "Again", body: "" }, { api: mockApi });
check("an existing PR for the head is returned, not duplicated", again.pr.existing && again.pr.number === 7 && !calls.some((c) => c.method === "POST"));
check("an in-sync branch is not pushed again", again.pushed === false);
existingPr = null;
failPostWith422 = true;
const raced = await A.createGitHubPullRequest(flowId, "tok", { title: "Race", body: "" }, { api: mockApi });
check("a 422 'already exists' falls back to the existing PR", raced.pr.number === 9 && raced.pr.existing);
failPostWith422 = false;
await G.writeGitHubConnection({ ...(await G.readGitHubConnection(flowId)), prNumber: 7, prUrl: "https://github.com/owner/sample/pull/7", prBranch: flow.workingBranch });

const status = await A.gitHubPullRequestStatus(flowId, "tok", { api: mockApi });
check("pr_status summarises checks", status.checks.passed === 1 && status.checks.failed === 1 && status.checks.pending === 1 && status.checks.failing[0].startsWith("lint"));
check("pr_status reports mergeable and review comments", status.mergeable === true && status.reviewComments === 3);
check("pr_status text is readable", /Checks: 1 passed, 1 failed, 1 pending/.test(A.formatPrStatus(status)));

await git(flowWs, ["checkout", "-q", "apim/second-feature"]);
let prRefused = false;
try { await A.createGitHubPullRequest(flowId, "tok", { title: "x" }, { api: mockApi }); } catch (e) { prRefused = /expected/.test(String(e)); }
check("create_pr refuses when HEAD is not the working branch", prRefused);
await git(flowWs, ["checkout", "-q", flow.workingBranch]);
r = await tool(flowId, "github_pr_status", {}, null);
check("pr_status without a token fails clearly", !r.ok && /token/.test(r.content));
check("no token ever lands in the workspace git config",
  !/tok|extraheader|AUTHORIZATION/i.test(await fs.readFile(path.join(flowWs, ".git", "config"), "utf8")));

console.log("\n6d. Connecting can continue an existing remote branch");
const contId = "githubcont";
const contWs = path.join(DATA_ROOT, "workspaces", contId);
await fs.rm(contWs, { recursive: true, force: true });
const cont = await G.cloneGitHubRepoToWorkspace({
  workspaceId: contId, repo: "owner/sample", cloneUrl: bare, baseBranch: "main", continueBranch: flow.workingBranch,
});
check("continuing keeps the existing branch name", cont.workingBranch === flow.workingBranch);
check("the checkout is on that branch at the remote tip",
  (await git(contWs, ["branch", "--show-current"])) === flow.workingBranch &&
  (await git(contWs, ["rev-parse", "HEAD"])) === (await git(fixture, ["--git-dir", bare, "rev-parse", flow.workingBranch])));
check("the branch tracks origin", (await git(contWs, ["rev-parse", "--abbrev-ref", "@{upstream}"])) === `origin/${flow.workingBranch}`);
check("the branch's committed files are present", await fs.access(path.join(contWs, "hello.ts")).then(() => true, () => false));
let baseContinueRefused = false;
try {
  await G.cloneGitHubRepoToWorkspace({ workspaceId: "githubcont2", repo: "owner/sample", cloneUrl: bare, baseBranch: "main", continueBranch: "main" });
} catch (e) { baseContinueRefused = /base/.test(String(e)); }
check("continuing the base branch itself is refused", baseContinueRefused);
await fs.writeFile(path.join(contWs, "more.ts"), "export const more = 1;\n", "utf8");
r = await tool(contId, "git_commit", { message: "Continue work" });
await G.pushGitHubWorkspace(contId, "dummy");
check("continued work pushes fast-forward to the same branch",
  (await git(fixture, ["--git-dir", bare, "log", "-1", "--format=%s", flow.workingBranch])) === "Continue work");
await fs.rm(contWs, { recursive: true, force: true });
await fs.rm(flowWs, { recursive: true, force: true });

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
{
  const T = await load("src/lib/tools.ts");
  const gitNames = T.GITHUB_TOOLS.map((t) => t.function.name).sort().join(",");
  check("git/PR tools are defined", gitNames === "git_branch,git_commit,git_diff,git_log,git_pull_base,git_status,github_create_pr,github_pr_status", gitNames);
  check("git tools stay out of the default tool list", !T.WORKSPACE_TOOLS.some((t) => t.function.name.startsWith("git_")));
  check("git tools are offered only with a GitHub connection", /\.\.\.\(githubConnection \? GITHUB_TOOLS : \[\]\)/.test(route));
  check("PR creation uses the approval flow", /call\.function\.name === "github_create_pr"/.test(route) && /command: "github"/.test(route));
  check("the system prompt describes the git workflow", /git_commit/.test(route) && /git_pull_base/.test(route) && /github_create_pr/.test(route));
  check("connector can create a PR and continue a branch", /Create pull request/.test(connector) && /continueBranch/.test(connector));
}

await fs.rm(fixture, { recursive: true, force: true });
await fs.rm(path.join(DATA_ROOT, "workspaces", workspaceId), { recursive: true, force: true });
await fs.rm(path.join(DATA_ROOT, "github"), { recursive: true, force: true });
console.log(`\n${pass + fail} checks · ${pass} passed${fail ? ` · ${fail} failed` : ""}\n`);
await finishSuite(fail);
