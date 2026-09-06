/**
 * A short-lived memory of what THIS run just wrote.
 *
 * The agent writes a file and then, in the next round, asks read_file for the
 * exact file it just produced — a whole tool round and a flood of tokens to
 * "see" text it already holds verbatim in its own context. Routing that read
 * back to the bytes it wrote is both faster and cheaper: the content is
 * already in the transcript (the write tool's arguments), so no file needs to
 * be read and no file content needs to be re-billed.
 *
 * Correctness comes first:
 *
 * - Only whole-file reads of a path the agent wrote ITSELF are answered from
 *   memory. A file created by a shell command, an install or a build may have
 *   changed on disk, so those are never served from here.
 * - Any tool that can mutate files outside of our writers (run_command,
 *   run_tests, build_project, start_process, …) clears the memory, because a
 *   command can rewrite or format anything — after that the disk is the truth.
 * - A region read (start_line/end_line) is answered from memory only when the
 *   whole stored content is available, which it is after a write.
 *
 * The memory lives for one runTool "session": the route creates one per reply
 * and passes it through context. It never touches disk and is discarded at
 * the end of the reply, so it cannot serve stale content across conversations.
 */

export class RunFileMemory {
  /** Path (normalised) -> exact content the agent wrote. */
  private written = new Map<string, string>();

  /** Normalise a path the way the rest of the workspace tools compare them. */
  private key(path: string): string {
    return path.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  }

  /** Record that the agent wrote `content` to `path`. */
  recordWrite(path: string, content: string): void {
    if (typeof path === "string" && typeof content === "string") {
      this.written.set(this.key(path), content);
    }
  }

  /**
   * Forget everything that could have been changed on disk by a tool that
   * bypasses the writers (a shell command, a test run, a build).
   */
  invalidateAll(): void {
    this.written.clear();
  }

  /** Forget one file (e.g. it was renamed or deleted). */
  invalidate(path: string): void {
    this.written.delete(this.key(path));
  }

  /** Exact content the agent wrote to `path`, or null if it is not known. */
  get(path: string): string | null {
    return this.written.get(this.key(path)) ?? null;
  }
}
