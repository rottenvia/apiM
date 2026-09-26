/**
 * How a tool call reads in the transcript: an icon family, a verb for while
 * it runs and once it is done, and the one detail that identifies it.
 *
 * Only six tools had labels. Everything else printed its raw name with the
 * pencil ("write") icon, so `read_files` looked like an edit and `web_search`
 * like a file write — the reported "tools look strange". Kept pure so the
 * mapping is tested without rendering anything.
 */

export type ToolKind =
  | "read"
  | "write"
  | "delete"
  | "search"
  | "run"
  | "web"
  | "plan"
  | "git"
  | "note"
  | "ask"
  | "image"
  | "done"
  | "other";

export interface ToolDisplay {
  kind: ToolKind;
  running: string;
  done: string;
  /** Path, query, command or count — the part that identifies the call. */
  target: string | null;
  /** Monospace target (paths, commands), or prose (queries). */
  mono: boolean;
}

const TABLE: Record<string, [ToolKind, string, string]> = {
  read_file: ["read", "Reading", "Read"],
  read_files: ["read", "Reading", "Read"],
  read_symbol: ["read", "Reading", "Read"],
  read_document: ["read", "Reading", "Read"],
  list_files: ["read", "Listing files", "Listed files"],
  verify_file: ["read", "Checking", "Checked"],
  inspect_binary: ["read", "Inspecting", "Inspected"],
  analyze_log: ["read", "Analyzing", "Analyzed"],
  write_file: ["write", "Writing", "Created"],
  write_files: ["write", "Writing", "Created"],
  edit_file: ["write", "Editing", "Edited"],
  edit_files: ["write", "Editing", "Edited"],
  apply_patch: ["write", "Patching", "Patched"],
  replace_in_files: ["write", "Replacing in", "Replaced in"],
  move_file: ["write", "Moving", "Moved"],
  undo_file: ["write", "Undoing", "Undid"],
  restore_snapshot: ["write", "Restoring", "Restored"],
  delete_file: ["delete", "Deleting", "Deleted"],
  search_files: ["search", "Searching", "Searched"],
  search_conversation: ["search", "Recalling", "Recalled"],
  list_snapshots: ["search", "Listing snapshots", "Listed snapshots"],
  run_command: ["run", "Running", "Ran"],
  run_tests: ["run", "Running tests", "Ran tests"],
  build_project: ["run", "Building", "Built"],
  start_process: ["run", "Starting", "Started"],
  stop_process: ["run", "Stopping", "Stopped"],
  read_process: ["run", "Reading output", "Read output"],
  write_process: ["run", "Sending input", "Sent input"],
  wait_for_output: ["run", "Waiting for output", "Got output"],
  list_processes: ["run", "Listing processes", "Listed processes"],
  web_search: ["web", "Searching the web", "Searched the web"],
  fetch_url: ["web", "Fetching", "Fetched"],
  browse: ["web", "Opening", "Opened"],
  inspect_page: ["web", "Inspecting", "Inspected"],
  http_request: ["web", "Requesting", "Requested"],
  download_file: ["web", "Downloading", "Downloaded"],
  make_plan: ["plan", "Planning", "Planned"],
  update_plan: ["plan", "Updating plan", "Updated plan"],
  note_finding: ["note", "Noting", "Noted"],
  note_binary: ["note", "Noting", "Noted"],
  ask_user: ["ask", "Asking", "Asked"],
  view_image: ["image", "Viewing", "Viewed"],
  screenshot_window: ["image", "Capturing", "Captured"],
  finish: ["done", "Finishing", "Finished"],
  github_push: ["git", "Pushing", "Pushed"],
  github_create_pr: ["git", "Opening pull request", "Opened pull request"],
  github_pr_status: ["git", "Checking pull request", "Checked pull request"],
  git_status: ["git", "Checking status", "Checked status"],
  git_diff: ["git", "Diffing", "Diffed"],
  git_log: ["git", "Reading history", "Read history"],
  git_commit: ["git", "Committing", "Committed"],
  git_branch: ["git", "Branching", "Branched"],
  git_pull_base: ["git", "Syncing with base", "Synced with base"],
};

function parse(args: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(args) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Loose extraction while the arguments are still streaming in. */
function partial(args: string, key: string): string | null {
  const m = args.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)`));
  return m ? m[1] : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function targetFor(name: string, args: string): { target: string | null; mono: boolean } {
  const a = parse(args);
  if (!a) {
    const p =
      partial(args, "path") ??
      partial(args, "command") ??
      partial(args, "query") ??
      partial(args, "url");
    return { target: p, mono: Boolean(partial(args, "path") ?? partial(args, "command")) };
  }
  const path = str(a.path) ?? str(a.file);
  if (Array.isArray(a.paths)) {
    const paths = a.paths.filter((p): p is string => typeof p === "string");
    return paths.length === 1
      ? { target: paths[0], mono: true }
      : { target: plural(paths.length, "file"), mono: false };
  }
  if (Array.isArray(a.files)) return { target: plural(a.files.length, "file"), mono: false };
  if (Array.isArray(a.edits)) return { target: plural(a.edits.length, "edit"), mono: false };
  if (name === "make_plan" && Array.isArray(a.steps)) {
    return { target: plural(a.steps.length, "step"), mono: false };
  }
  if (name === "update_plan" && Array.isArray(a.updates)) {
    return { target: plural(a.updates.length, "step"), mono: false };
  }
  if (typeof a.command === "string") {
    const list = Array.isArray(a.args) ? a.args.map(String) : [];
    return { target: [a.command, ...list].join(" "), mono: true };
  }
  if (name === "read_symbol" && str(a.name)) {
    return { target: `${a.name}${path ? ` in ${path}` : ""}`, mono: true };
  }
  if (path) return { target: path, mono: true };
  const query = str(a.query) ?? str(a.pattern) ?? str(a.question);
  if (query) return { target: query, mono: name === "search_files" };
  const url = str(a.url);
  if (url) return { target: url.replace(/^https?:\/\//, ""), mono: true };
  const msg = str(a.message) ?? str(a.title) ?? str(a.claim) ?? str(a.reason);
  if (msg) return { target: msg, mono: false };
  return { target: null, mono: false };
}

/** Title-case an unknown tool name: "my_tool" -> "My tool". */
function humanise(name: string): string {
  const t = name.replace(/[_-]+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : name;
}

export function describeTool(
  name: string,
  args: string,
  displayName?: string
): ToolDisplay {
  const row = TABLE[name];
  const { target, mono } = targetFor(name, args);
  if (row) return { kind: row[0], running: row[1], done: row[2], target, mono };
  const label = displayName ?? humanise(name);
  return { kind: "other", running: label, done: label, target, mono };
}
