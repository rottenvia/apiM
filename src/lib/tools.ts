import { diffLines, diffStats, diffHunks } from "@/lib/diff";
import { describeImage } from "@/lib/vision";
import {
  startProcess,
  stopProcess,
  stopAll,
  getProcess,
  listProcesses,
  describeProcess,
  isRunning,
} from "@/lib/processes";
import { smartSearch } from "@/lib/smart-search";
import { listSnapshots, restoreSnapshot } from "@/lib/snapshots";
import { documentKind, readDocument } from "@/lib/documents";
import {
  fetchPage,
  extractSelectors,
  MAX_FETCH_CHARS,
  WebError,
} from "@/lib/web";
import {
  deleteFile,
  editFile,
  listFiles,
  readFile,
  readImageAsDataUrl,
  readFileBytes,
  moveFile,
  previousVersion,
  searchFiles,
  writeFile,
  WorkspaceError,
} from "@/lib/workspace";

/**
 * Tool definitions exposed to the model, and the dispatcher that runs them.
 *
 * Descriptions are deliberately specific. DeepSeek's docs note that V4 is
 * "more agentic, not more forgiving" — a vague description like "gets data"
 * measurably increases wrong-tool calls, so each one states when to use it
 * and what it returns.
 */

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * How many files one read_files call may return.
 *
 * Sized against the model's context, not against a guess: 60 files of a few
 * thousand characters is a small fraction of a 1M-token window, and it is
 * roughly the size of the projects people actually drop in as a zip.
 */
export const MAX_READ_FILES = 60;

/**
 * How many files one write_files call may create.
 *
 * Lower than the read limit on purpose: writing is destructive, and a single
 * call that rewrites thirty files is already at the edge of what a user can
 * reasonably review in the activity list.
 */
export const MAX_WRITE_FILES = 30;

/**
 * How many replacements one edit_files call may make.
 *
 * Higher than the write limit because an edit is surgical — it changes a
 * named snippet rather than replacing a whole file — so forty of them is
 * still a reviewable change.
 */
export const MAX_BATCH_EDITS = 40;

export const WORKSPACE_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List every file in the workspace with its size. Call this first when you need to know what already exists before creating or editing anything.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Optional subdirectory to list, relative to the workspace root. Omit to list everything.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the full contents of one file in the workspace. Always read a file before editing it, so the text you replace matches exactly.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "File path relative to the workspace root, e.g. 'src/app.py'.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a new file, or completely replace an existing one. Parent directories are created automatically. Use edit_file instead when changing part of a large existing file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "File path relative to the workspace root, e.g. 'src/app.py'.",
          },
          content: {
            type: "string",
            description: "The complete file contents.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace one exact snippet inside an existing file, leaving the rest untouched. Cheaper than rewriting a large file. The snippet must appear exactly once — include surrounding lines if needed to make it unique.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit." },
          old_text: {
            type: "string",
            description:
              "Exact text to replace, copied verbatim from the file including indentation.",
          },
          new_text: {
            type: "string",
            description: "Replacement text. Use an empty string to delete.",
          },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Find text across every file in the workspace at once, with the file " +
        "and line number of each match. Use this to locate where something is " +
        "defined or used, instead of reading files one by one — it is far " +
        "cheaper than guessing which file to open.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text to find, or a regular expression if regex is true.",
          },
          regex: {
            type: "boolean",
            description: "Treat query as a regular expression. Defaults to false.",
          },
          case_sensitive: {
            type: "boolean",
            description: "Match case exactly. Defaults to false.",
          },
          glob: {
            type: "string",
            description: 'Only search matching paths, e.g. "*.py" or "src/*".',
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_files",
      description:
        "Read several files in one step. Prefer this over calling read_file " +
        "repeatedly — each separate call costs a full round trip, and you " +
        "usually know up front which files you need.",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: `File paths to read, up to ${MAX_READ_FILES}.`,
          },
        },
        required: ["paths"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_image",
      description:
        "Look at an image file in the workspace — a screenshot, a mockup, a " +
        "diagram. Returns a detailed description including any text in it. " +
        "Use this when the user refers to an image they saved, or when you " +
        "have generated or downloaded one and need to check it.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the image, e.g. \"mockup.png\".",
          },
          question: {
            type: "string",
            description:
              "Optional: what you specifically need to know about it, so the " +
              "description focuses there.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a program in the workspace and get its output back, so you can " +
        "check whether your code actually works. Use this after writing code: " +
        "run it, read any error, fix the file, run it again. The user has to " +
        "approve each command before it runs. Only real interpreters are " +
        "available (python, node, npm, pip and similar) — there is no shell, " +
        "so pass arguments as a list rather than one string. Commands are " +
        "stopped after 30 seconds, so never start a server or anything that " +
        "waits for input.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "Program to run, e.g. \"python3\", \"node\", \"npm\". Not a shell.",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description:
              'Arguments as separate items, e.g. ["app.py"] or ["install", "requests"].',
          },
          reason: {
            type: "string",
            description:
              "One short line telling the user why this needs to run. Shown " +
              "on the approval prompt.",
          },
        },
        required: ["command", "args"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a question and wait for their answer. Use this when a " +
        "decision genuinely changes what you build — which database, which " +
        "framework, whether to overwrite something — rather than guessing " +
        "and possibly doing the wrong work. Do not use it for things you can " +
        "decide yourself or find out by reading a file; every question " +
        "interrupts the user.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question, in one clear sentence.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description:
              "Up to 4 choices to offer as buttons. Omit for an open question.",
          },
          context: {
            type: "string",
            description:
              "Optional: one line on why this matters, so the user can answer " +
              "without reading back through the conversation.",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_process",
      description:
        "Start something that keeps running — a dev server, a watcher, a bot. " +
        "Use this instead of run_command for anything that does not exit on " +
        "its own, because run_command waits for the process to finish and " +
        "will kill it. Returns immediately with an id and the first few " +
        "seconds of output, so you can tell whether it actually started. " +
        "Read its output later with read_process, and stop it with " +
        "stop_process.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: 'Program to run, e.g. "npm", "python3", "node".',
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: 'Arguments as separate items, e.g. ["run", "dev"].',
          },
          reason: {
            type: "string",
            description: "One short line explaining why, shown to the user.",
          },
        },
        required: ["command", "args"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_process",
      description:
        "Read the output a background process has produced so far, and " +
        "whether it is still running. Use this after start_process to check " +
        "for startup errors, and after making a change to see what a watcher " +
        "reported.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "Process id from start_process. Omit to list every process " +
              "in this workspace.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_process",
      description:
        "Stop a background process. Always stop anything you started once " +
        "you are finished with it, so it does not keep running and holding " +
        "a port.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: 'Process id, or "all" to stop everything.',
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description:
        "Delete a file from the workspace. Only use when the user explicitly asks for it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to delete." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Open a web page and read it. Use this whenever the answer depends " +
        "on what is actually on a site — its wording, its data, or its " +
        "markup — rather than on what articles say about it. Set raw to true " +
        "to get the HTML, which is what you need before writing anything " +
        "that targets a page, such as a userscript or an extension content " +
        "script. Never guess a selector you have not seen.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Full URL, including https://",
          },
          raw: {
            type: "boolean",
            description:
              "Return the HTML source instead of readable text. Use for " +
              "anything that inspects or modifies a page's structure.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_page",
      description:
        "List the ids, classes and data-attributes on a page, so you can " +
        "target it precisely. Far cheaper than reading the whole HTML and " +
        "usually the only thing you need before writing a content script, " +
        "a userscript, or a scraper. Prefer this over fetch_url with raw " +
        "when you only need selectors.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL, including https://" },
          contains: {
            type: "string",
            description:
              "Optional filter — only return selectors containing this text, " +
              'e.g. "score" or "match".',
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_file",
      description:
        "Rename or move a file in one step. Use this instead of reading, " +
        "rewriting and deleting — that is three round trips for one " +
        "operation. Refuses if the destination already exists.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Current path." },
          to: { type: "string", description: "New path." },
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_files",
      description:
        "Make several exact replacements in one step, across one file or " +
        "many. Prefer this over repeated edit_file whenever a change touches " +
        "more than one place — each separate call costs a whole round. Every " +
        "snippet must appear exactly once in its file.",
      parameters: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            description: "Replacements to apply, up to 40.",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                old_text: {
                  type: "string",
                  description: "Exact text to replace, copied verbatim.",
                },
                new_text: { type: "string" },
              },
              required: ["path", "old_text", "new_text"],
            },
          },
        },
        required: ["edits"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_in_files",
      description:
        "Replace the same text everywhere it appears across the workspace — " +
        "renaming a function, changing an import path, updating a constant. " +
        "Doing this by hand costs one search plus one edit per file, so a " +
        "rename touching a dozen files is a dozen rounds. Reports every file " +
        "it changed. Set preview to true first if you are unsure how many " +
        "matches there are.",
      parameters: {
        type: "object",
        properties: {
          find: {
            type: "string",
            description: "Exact text to find. Not a regular expression.",
          },
          replace: { type: "string", description: "What to put in its place." },
          glob: {
            type: "string",
            description: 'Optional filter, e.g. "*.ts" or "src/*".',
          },
          preview: {
            type: "boolean",
            description:
              "Report what would change without writing anything. Use when " +
              "the text might appear somewhere you did not intend.",
          },
        },
        required: ["find", "replace"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web from inside the task. Use this the moment you hit " +
        "something you do not know — an unfamiliar error, a library's current " +
        "API, whether a service still works the way you remember. Do not " +
        "guess and carry on: a wrong assumption compounds over the rounds " +
        "that follow. Returns titles, URLs and extracts; follow up with " +
        "fetch_url when you need the full page.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What to look up, phrased as you would type it into a search " +
              "engine. Be specific — include the error text or version.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "undo_file",
      description:
        "Put one file back the way it was before your last write. Use this " +
        "when an edit turns out to be wrong: reverting is exact, whereas " +
        "patching your own mistake by hand tends to make it worse. Only the " +
        "most recent version is kept.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File to revert." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_snapshots",
      description:
        "List the restore points taken before each of the user's messages. " +
        "Use before restore_snapshot so you pick the right one.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "restore_snapshot",
      description:
        "Put the whole workspace back to a restore point. This is a large " +
        "step: it reverts every file and deletes anything created since, so " +
        "prefer undo_file for a single mistake. Say what you are about to " +
        "undo before calling it.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Snapshot id, from list_snapshots.",
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description:
        "Read a Word, Excel, PowerPoint, EPUB or ODT file in the workspace " +
        "as text. read_file cannot open these — they are zipped XML, not " +
        "plain text — so use this for any .docx, .xlsx, .pptx, .epub or .odt.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the document." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_processes",
      description:
        "List the background processes you started, with their state and " +
        "how they were launched. Use it to check what is still running " +
        "before starting another, and to find an id you have lost.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_files",
      description:
        "Create several files in one step. Prefer this when scaffolding — " +
        "each separate write_file costs a whole round trip, so a ten-file " +
        "skeleton written one call at a time is ten times slower and dearer.",
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            description: "Files to write, up to 30.",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
            },
          },
        },
        required: ["files"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "download_file",
      description:
        "Save a file from a URL straight into the workspace — a dataset, an " +
        "icon, a reference document. Use this instead of asking the user to " +
        "download something and attach it.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL, including https://" },
          path: {
            type: "string",
            description: "Where to save it, relative to the workspace root.",
          },
        },
        required: ["url", "path"],
      },
    },
  },
];

export interface ToolResult {
  /** Text handed back to the model as the tool message. */
  content: string;
  /** Structured summary for the UI. */
  summary: string;
  ok: boolean;
  /** Files touched, so the UI can refresh its tree. */
  changedPath?: string;
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new WorkspaceError(`"${key}" must be a string`);
  }
  return value;
}

/**
 * Execute one tool call.
 *
 * Errors are returned as tool results rather than thrown: the model needs to
 * see "that path doesn't exist" so it can correct itself, and a thrown error
 * would abandon the whole turn instead.
 */
export interface ToolContext {
  /** Vision provider key. Absent means view_image is unavailable. */
  visionKey?: string;
  visionModel?: string;
  /** Tavily key. Absent means web_search is withheld from the model. */
  searchKey?: string;
  /** Needed by the search planner, which uses a cheap model to pick queries. */
  deepseekKey?: string;
  searchProfile?: string;
}

export async function runTool(
  workspaceId: string,
  name: string,
  args: Record<string, unknown>,
  context: ToolContext = {}
): Promise<ToolResult> {
  try {
    switch (name) {
      case "list_files": {
        const sub = typeof args.path === "string" ? args.path : ".";
        const files = await listFiles(workspaceId, sub);
        if (files.length === 0) {
          return {
            ok: true,
            content: "The workspace is empty.",
            summary: "Listed files — workspace is empty",
          };
        }
        const listing = files
          .map((f) => `${f.path} (${f.size} bytes)`)
          .join("\n");
        return {
          ok: true,
          content: `${files.length} file(s):\n${listing}`,
          summary: `Listed ${files.length} file${files.length === 1 ? "" : "s"}`,
        };
      }

      case "read_file": {
        const result = await readFile(workspaceId, str(args, "path"));
        const note = result.truncated
          ? "\n\n[truncated — file is larger than the read limit]"
          : "";
        return {
          ok: true,
          content: `${result.path}:\n\n${result.content}${note}`,
          summary: `Read ${result.path}`,
        };
      }

      case "read_files": {
        const raw = Array.isArray(args.paths) ? args.paths : [];
        if (raw.length === 0) {
          return {
            ok: false,
            content: "Error: paths must be a non-empty list of file paths.",
            summary: "No paths given",
          };
        }

        // Capped so one call can't pull the whole workspace into context.
        //
        // Was 10, which is fewer files than a small project has. Asked to
        // describe a whole codebase the model would request thirty paths in
        // one call, twenty were dropped with a note it did not always act
        // on, and the answer covered a third of the project. The cap exists
        // to stop a runaway call, not to ration ordinary reading, so it is
        // set where a real request will not hit it.
        const paths = raw.slice(0, MAX_READ_FILES).map((p) => String(p));
        const parts: string[] = [];
        let read = 0;

        // Read together, reported in the order asked for. Sixty local files
        // is only a few milliseconds either way, but the ordering guarantee
        // matters: the model refers to them by position in its own request.
        const results = await Promise.all(
          paths.map((filePath) =>
            readFile(workspaceId, filePath)
              .then((result) => ({ filePath, result, error: null as unknown }))
              .catch((error: unknown) => ({ filePath, result: null, error }))
          )
        );

        for (const entry of results) {
          if (entry.result) {
            read++;
            const note = entry.result.truncated
              ? "\n\n[truncated — file is larger than the read limit]"
              : "";
            parts.push(
              `--- ${entry.result.path} ---\n${entry.result.content}${note}`
            );
          } else {
            // One missing file must not lose the others: report it inline and
            // keep going, so the model still gets what does exist.
            parts.push(
              `--- ${entry.filePath} ---\n[could not read: ${
                entry.error instanceof WorkspaceError
                  ? entry.error.message
                  : "unreadable"
              }]`
            );
          }
        }

        if (raw.length > paths.length) {
          // Named explicitly, with an instruction. A bare "ignored" note was
          // treated as commentary: the model carried on and answered as if it
          // had read everything, so files silently missing from the answer
          // looked like the agent giving up early.
          const dropped = raw.slice(paths.length).map((p) => String(p));
          parts.push(
            `[NOT READ — ${dropped.length} path(s) exceeded the ${MAX_READ_FILES}-per-call limit: ` +
              `${dropped.join(", ")}. ` +
              `Call read_files again with these before you answer. Do not ` +
              `describe them as if you had read them.]`
          );
        }

        return {
          ok: read > 0,
          content: parts.join("\n\n"),
          summary:
            read === paths.length
              ? `Read ${read} file${read === 1 ? "" : "s"}`
              : `Read ${read} of ${paths.length} files`,
        };
      }

      case "search_files": {
        const result = await searchFiles(workspaceId, str(args, "query"), {
          regex: args.regex === true,
          caseSensitive: args.case_sensitive === true,
          glob: typeof args.glob === "string" ? args.glob : undefined,
        });

        if (result.hits.length === 0) {
          return {
            ok: true,
            content:
              `No matches in ${result.filesSearched} file` +
              `${result.filesSearched === 1 ? "" : "s"}.`,
            summary: "No matches",
          };
        }

        const lines = result.hits.map(
          (h) => `${h.path}:${h.line}: ${h.text}`
        );
        if (result.truncated) {
          lines.push("… more matches exist; narrow the search to see them.");
        }

        return {
          ok: true,
          content: lines.join("\n"),
          summary: `${result.hits.length} match${
            result.hits.length === 1 ? "" : "es"
          }`,
        };
      }

      case "start_process": {
        const result = await startProcess(
          workspaceId,
          str(args, "command"),
          Array.isArray(args.args) ? args.args.map((a) => String(a)) : []
        );

        if (!result.ok) {
          return {
            ok: false,
            content: `Error: ${result.reason}`,
            summary: "Could not start process",
          };
        }

        const { process: proc, diedImmediately } = result;
        const log = proc.log.trim();

        if (diedImmediately) {
          // Reported as a failure on purpose: "started successfully" for
          // something already dead would send the model off building on a
          // false premise.
          return {
            ok: false,
            content:
              `${proc.display} exited immediately (code ${proc.exitCode ?? "unknown"}).\n\n` +
              `${log || "(no output)"}\n\n` +
              `Fix the cause before trying again.`,
            summary: `Failed to start: ${proc.display}`,
          };
        }

        return {
          ok: true,
          content:
            `Started ${proc.display} — id ${proc.id}, still running.\n\n` +
            `${log || "(no output yet)"}\n\n` +
            `Read more with read_process, and stop it with stop_process when done.`,
          summary: `Started ${proc.display}`,
        };
      }

      case "read_process": {
        const id = typeof args.id === "string" ? args.id.trim() : "";

        if (!id) {
          const all = listProcesses(workspaceId);
          if (all.length === 0) {
            return {
              ok: true,
              content: "No background processes in this workspace.",
              summary: "No processes",
            };
          }
          return {
            ok: true,
            content: all.map(describeProcess).join("\n"),
            summary: `${all.length} process${all.length === 1 ? "" : "es"}`,
          };
        }

        const proc = getProcess(id);
        // Scoped to the workspace, so one chat cannot read another's output.
        if (!proc || proc.workspaceId !== workspaceId) {
          return {
            ok: false,
            content: `No process with id "${id}" in this workspace.`,
            summary: "Unknown process",
          };
        }

        const note = proc.truncated
          ? "\n\n[earlier output dropped — only the most recent is kept]"
          : "";

        return {
          ok: true,
          content:
            `${describeProcess(proc)}\n\n${proc.log.trim() || "(no output)"}${note}`,
          summary: isRunning(proc)
            ? `Read ${proc.display}`
            : `${proc.display} has stopped`,
        };
      }

      case "stop_process": {
        const id = str(args, "id").trim();

        if (id === "all") {
          const stopped = stopAll(workspaceId);
          return {
            ok: true,
            content:
              stopped === 0
                ? "Nothing was running."
                : `Stopped ${stopped} process${stopped === 1 ? "" : "es"}.`,
            summary: `Stopped ${stopped}`,
          };
        }

        const proc = getProcess(id);
        if (!proc || proc.workspaceId !== workspaceId) {
          return {
            ok: false,
            content: `No process with id "${id}" in this workspace.`,
            summary: "Unknown process",
          };
        }

        stopProcess(id);
        return {
          ok: true,
          content: `Stopped ${proc.display}.`,
          summary: `Stopped ${proc.display}`,
        };
      }

      case "view_image": {
        if (!context.visionKey) {
          // Reported as a tool result rather than an error, so the model can
          // tell the user what to do instead of retrying forever.
          return {
            ok: false,
            content:
              "No vision key is configured, so images cannot be viewed. " +
              "Tell the user to add one in Settings.",
            summary: "Vision not configured",
          };
        }

        const imagePath = str(args, "path");
        const image = await readImageAsDataUrl(workspaceId, imagePath);

        const result = await describeImage(
          image.dataUrl,
          context.visionKey,
          context.visionModel,
          typeof args.question === "string" ? args.question : undefined
        );

        if (result.error) {
          return {
            ok: false,
            content: `Could not read ${imagePath}: ${result.error}`,
            summary: `Couldn't view ${imagePath}`,
          };
        }

        return {
          ok: true,
          content: `${imagePath}:\n\n${result.description ?? "(no description)"}`,
          summary: `Viewed ${imagePath}`,
        };
      }

      case "write_file": {
        const result = await writeFile(
          workspaceId,
          str(args, "path"),
          str(args, "content")
        );
        return {
          ok: true,
          content: `${result.created ? "Created" : "Updated"} ${result.path} (${result.bytes} bytes).`,
          summary: `${result.created ? "Created" : "Updated"} ${result.path}`,
          changedPath: result.path,
        };
      }

      case "edit_file": {
        const filePath = str(args, "path");

        // Captured before the edit so the result can show what actually
        // changed. Without it the model is told only "Edited main.py" and
        // cannot tell a correct edit from one that landed in the wrong place.
        let before: string | null = null;
        try {
          before = (await readFile(workspaceId, filePath)).content;
        } catch {
          before = null;
        }

        const result = await editFile(
          workspaceId,
          filePath,
          str(args, "old_text"),
          str(args, "new_text")
        );

        let confirmation = `Edited ${result.path}.`;
        if (before !== null) {
          try {
            const after = (await readFile(workspaceId, filePath)).content;
            const changed = diffLines(before, after);
            const stats = diffStats(changed);
            const hunks = diffHunks(changed, 2);

            // Show the surrounding lines, so the model can see whether the
            // replacement sits where it intended rather than assuming it does.
            const preview = hunks
              .flatMap((h) => h.lines)
              .slice(0, 40)
              .map((l) =>
                `${l.kind === "added" ? "+" : l.kind === "removed" ? "-" : " "} ${l.text}`
              )
              .join("\n");

            confirmation =
              `Edited ${result.path} (+${stats.added} -${stats.removed}).\n\n` +
              `${preview}\n\n` +
              `Check this is the change you intended before moving on.`;
          } catch {
            /* fall back to the plain confirmation */
          }
        }

        return {
          ok: true,
          content: confirmation,
          summary: `Edited ${result.path}`,
          changedPath: result.path,
        };
      }

      case "delete_file": {
        const result = await deleteFile(workspaceId, str(args, "path"));
        return {
          ok: true,
          content: `Deleted ${result.path}.`,
          summary: `Deleted ${result.path}`,
          changedPath: result.path,
        };
      }

      case "fetch_url": {
        const wantsRaw = args.raw === true;
        const page = await fetchPage(str(args, "url"), { raw: wantsRaw });

        const header = [
          `${page.url}`,
          page.title ? `Title: ${page.title}` : null,
          `HTTP ${page.status} · ${page.contentType} · ${(page.bytes / 1024).toFixed(0)}KB`,
          page.truncated
            ? `[truncated at ${MAX_FETCH_CHARS.toLocaleString()} characters]`
            : null,
        ]
          .filter(Boolean)
          .join("\n");

        const body = wantsRaw && page.html ? page.html : page.text;

        return {
          ok: true,
          content: `${header}\n\n${body}`,
          summary: `Read ${new URL(page.url).hostname}${
            page.title ? ` — ${page.title.slice(0, 50)}` : ""
          }`,
        };
      }

      case "inspect_page": {
        const page = await fetchPage(str(args, "url"), { raw: true });
        if (!page.html) {
          return {
            ok: false,
            content:
              `${page.url} returned ${page.contentType}, not HTML, so it has ` +
              `no selectors to inspect.`,
            summary: "Not an HTML page",
          };
        }

        const found = extractSelectors(page.html);
        const filter =
          typeof args.contains === "string" ? args.contains.toLowerCase() : "";
        const keep = (list: string[]) =>
          filter ? list.filter((v) => v.toLowerCase().includes(filter)) : list;

        const ids = keep(found.ids);
        const classes = keep(found.classes);
        const attrs = keep(found.dataAttrs);

        if (ids.length === 0 && classes.length === 0 && attrs.length === 0) {
          return {
            ok: true,
            content: filter
              ? `No ids, classes or data-attributes on ${page.url} contain "${filter}". ` +
                `The page has ${found.ids.length} ids and ${found.classes.length} ` +
                `classes in total — try a different word, or call again without a filter.`
              : `${page.url} has no usable ids or classes. It is probably rendered ` +
                `by JavaScript after load, so the served HTML is nearly empty. ` +
                `Ask the user to paste the element from their browser's inspector.`,
            summary: "No selectors found",
          };
        }

        const section = (label: string, list: string[]) =>
          list.length ? `${label} (${list.length}):\n${list.join("\n")}` : null;

        return {
          ok: true,
          content: [
            `Selectors on ${page.url}${filter ? ` matching "${filter}"` : ""}:`,
            "",
            section("IDs", ids),
            section("Classes", classes),
            section("Data attributes", attrs),
            "",
            "These are the real names on the page. Target these exactly rather " +
              "than inventing selectors.",
          ]
            .filter(Boolean)
            .join("\n"),
          summary: `Inspected ${new URL(page.url).hostname} — ${
            ids.length + classes.length
          } selectors`,
        };
      }

      case "download_file": {
        const target = str(args, "path");
        const page = await fetchPage(str(args, "url"), { raw: true });
        // Raw body when it is a document, decoded text otherwise, so a saved
        // page is the actual page rather than a stripped rendering of it.
        const body = page.html ?? page.text;
        const written = await writeFile(workspaceId, target, body);

        return {
          ok: true,
          content:
            `Saved ${page.url} to ${written.path} (${written.bytes} bytes).` +
            (page.truncated
              ? " The response was truncated at the size limit."
              : ""),
          summary: `Downloaded ${written.path}`,
          changedPath: written.path,
        };
      }

      case "move_file": {
        const result = await moveFile(
          workspaceId,
          str(args, "from"),
          str(args, "to")
        );
        return {
          ok: true,
          content: `Moved ${result.from} to ${result.to} (${result.bytes} bytes).`,
          summary: `Moved ${result.from} → ${result.to}`,
          changedPath: result.to,
        };
      }

      case "edit_files": {
        const raw = Array.isArray(args.edits) ? args.edits : [];
        if (raw.length === 0) {
          return {
            ok: false,
            content: "Error: edits must be a non-empty list.",
            summary: "No edits given",
          };
        }

        const batch = raw.slice(0, MAX_BATCH_EDITS);
        const done: string[] = [];
        const failed: string[] = [];

        for (const entry of batch) {
          const edit = entry as {
            path?: unknown;
            old_text?: unknown;
            new_text?: unknown;
          };
          if (
            typeof edit.path !== "string" ||
            typeof edit.old_text !== "string" ||
            typeof edit.new_text !== "string"
          ) {
            failed.push(`${String(edit.path ?? "?")} — malformed edit`);
            continue;
          }
          try {
            const result = await editFile(
              workspaceId,
              edit.path,
              edit.old_text,
              edit.new_text
            );
            done.push(result.path);
          } catch (error) {
            /*
             * One failure does not abandon the rest.
             *
             * Half-applying a refactor sounds worse than applying none of it,
             * but the alternative is silently reverting edits that were
             * correct — and the model cannot tell which those were. Naming
             * exactly what failed lets it fix that one and move on.
             */
            failed.push(
              `${edit.path} — ${
                error instanceof WorkspaceError ? error.message : "could not be edited"
              }`
            );
          }
        }

        const notes: string[] = [];
        if (done.length) notes.push(`Edited ${done.length}:\n${done.join("\n")}`);
        if (failed.length) {
          notes.push(
            `Failed ${failed.length} — these were NOT applied, fix and retry ` +
              `just these:\n${failed.join("\n")}`
          );
        }
        if (raw.length > batch.length) {
          notes.push(
            `[${raw.length - batch.length} more ignored — limit is ` +
              `${MAX_BATCH_EDITS} per call.]`
          );
        }

        return {
          ok: done.length > 0,
          content: notes.join("\n\n"),
          summary:
            failed.length === 0
              ? `Edited ${done.length} file(s)`
              : `Edited ${done.length}, ${failed.length} failed`,
          changedPath: done[0],
        };
      }

      case "replace_in_files": {
        const find = str(args, "find");
        const replace = str(args, "replace");
        if (!find) {
          return {
            ok: false,
            content: "Error: find must not be empty.",
            summary: "Empty search",
          };
        }

        const preview = args.preview === true;
        const glob = typeof args.glob === "string" ? args.glob : undefined;

        // Reuses the same matcher the search tool uses, so a preview and the
        // real thing can never disagree about which files are in scope.
        const hits = await searchFiles(workspaceId, find, { glob });
        const paths = [...new Set(hits.hits.map((h) => h.path))];

        if (paths.length === 0) {
          return {
            ok: false,
            content:
              `"${find}" does not appear in any file${glob ? ` matching ${glob}` : ""}. ` +
              `Check the exact text, or search first.`,
            summary: "No matches",
          };
        }

        const changed: string[] = [];
        const failed: string[] = [];
        let occurrences = 0;

        for (const filePath of paths) {
          try {
            const file = await readFile(workspaceId, filePath);
            const count = file.content.split(find).length - 1;
            if (count === 0) continue;

            occurrences += count;
            if (!preview) {
              await writeFile(
                workspaceId,
                filePath,
                file.content.split(find).join(replace)
              );
            }
            changed.push(`${filePath} (${count})`);
          } catch (error) {
            failed.push(
              `${filePath} — ${
                error instanceof WorkspaceError ? error.message : "could not be updated"
              }`
            );
          }
        }

        const heading = preview
          ? `Would replace ${occurrences} occurrence(s) of "${find}" across ${changed.length} file(s). Nothing was written.`
          : `Replaced ${occurrences} occurrence(s) of "${find}" across ${changed.length} file(s).`;

        return {
          ok: changed.length > 0,
          content: [
            heading,
            changed.join("\n"),
            failed.length ? `Failed:\n${failed.join("\n")}` : null,
          ]
            .filter(Boolean)
            .join("\n\n"),
          summary: preview
            ? `Previewed ${occurrences} replacement(s)`
            : `Replaced ${occurrences} in ${changed.length} file(s)`,
          changedPath: preview ? undefined : changed[0]?.split(" (")[0],
        };
      }

      case "web_search": {
        const query = str(args, "query").trim();
        if (!query) {
          return { ok: false, content: "Error: a query is required.", summary: "Empty query" };
        }
        if (!context.searchKey || !context.deepseekKey) {
          return {
            ok: false,
            content:
              "Web search is not configured — no Tavily key is set in " +
              "Settings. Say plainly that you could not look this up rather " +
              "than guessing, or use fetch_url if you already know the URL.",
            summary: "Search unavailable",
          };
        }

        const found = await smartSearch(
          query,
          "",
          context.deepseekKey,
          context.searchKey,
          undefined,
          context.searchProfile
        );

        if (found.results.length === 0) {
          return {
            ok: true,
            content: `No results for "${query}". Try different wording, or say you could not find it.`,
            summary: `No results — ${query.slice(0, 40)}`,
          };
        }

        const body = found.results
          .slice(0, 8)
          .map(
            (hit, i) =>
              `[${i + 1}] ${hit.title}\n${hit.url}\n${(hit.content ?? "").slice(0, 700)}`
          )
          .join("\n\n");

        return {
          ok: true,
          content:
            `${found.results.length} result(s) for "${query}":\n\n${body}\n\n` +
            `Cite the URLs you use. Call fetch_url on one for the full page.`,
          summary: `Searched: ${query.slice(0, 45)}`,
        };
      }

      case "undo_file": {
        const target = str(args, "path");
        const previous = await previousVersion(workspaceId, target);
        if (previous === null) {
          return {
            ok: false,
            content:
              `No previous version of ${target} is kept. Only the last write ` +
              `is recoverable, and this file has not been overwritten since ` +
              `it was created. Fix it forward with edit_file instead.`,
            summary: `No history for ${target}`,
          };
        }
        const written = await writeFile(workspaceId, target, previous);
        return {
          ok: true,
          content: `Reverted ${written.path} to its previous contents (${written.bytes} bytes).`,
          summary: `Reverted ${written.path}`,
          changedPath: written.path,
        };
      }

      case "list_snapshots": {
        const snapshots = await listSnapshots(workspaceId);
        if (snapshots.length === 0) {
          return {
            ok: true,
            content: "There are no restore points for this workspace yet.",
            summary: "No snapshots",
          };
        }
        const listing = snapshots
          .map(
            (snap) =>
              `${snap.id} — ${snap.label} (${snap.fileCount} files, ${new Date(
                snap.createdAt
              ).toLocaleString()})`
          )
          .join("\n");
        return {
          ok: true,
          content: `${snapshots.length} restore point(s), newest first:\n${listing}`,
          summary: `Listed ${snapshots.length} snapshot(s)`,
        };
      }

      case "restore_snapshot": {
        const id = str(args, "id");
        const result = await restoreSnapshot(workspaceId, id);
        return {
          ok: true,
          content:
            `Restored the workspace to ${id}: ${result.restored} file(s) put ` +
            `back, ${result.removed} created since then removed. A snapshot ` +
            `of the state before this restore was taken first, so it is ` +
            `itself reversible.`,
          summary: `Restored ${result.restored} file(s)`,
          changedPath: "",
        };
      }

      case "read_document": {
        const target = str(args, "path");
        const kind = documentKind(target);
        if (!kind) {
          return {
            ok: false,
            content:
              `${target} is not a document this can open. It handles .docx, ` +
              `.xlsx, .pptx, .epub and .odt — for anything text-based use ` +
              `read_file.`,
            summary: "Not a document",
          };
        }

        const bytes = await readFileBytes(workspaceId, target);
        const doc = await readDocument(kind, bytes);
        if (!doc.text.trim()) {
          return {
            ok: false,
            content: `${target} opened but contained no readable text.`,
            summary: `Empty document: ${target}`,
          };
        }

        return {
          ok: true,
          content:
            `${target} (${kind}${doc.truncated ? ", truncated" : ""}):\n\n${doc.text}`,
          summary: `Read ${target}`,
        };
      }

      case "list_processes": {
        const running = listProcesses(workspaceId);
        if (running.length === 0) {
          return {
            ok: true,
            content: "No background processes are running in this workspace.",
            summary: "No processes",
          };
        }
        const listing = running
          .map(
            (proc) =>
              `${proc.id} — ${describeProcess(proc)} — ${
                isRunning(proc) ? "running" : `exited (${proc.exitCode})`
              }`
          )
          .join("\n");
        return {
          ok: true,
          content: `${running.length} process(es):\n${listing}`,
          summary: `Listed ${running.length} process(es)`,
        };
      }

      case "write_files": {
        const raw = Array.isArray(args.files) ? args.files : [];
        if (raw.length === 0) {
          return {
            ok: false,
            content: "Error: files must be a non-empty list.",
            summary: "No files given",
          };
        }

        // Capped for the same reason as read_files: one call should not be
        // able to rewrite an entire project unreviewed.
        const batch = raw.slice(0, MAX_WRITE_FILES);
        const written: string[] = [];
        const failed: string[] = [];

        for (const entry of batch) {
          const file = entry as { path?: unknown; content?: unknown };
          if (typeof file.path !== "string" || typeof file.content !== "string") {
            failed.push(`${String(file.path ?? "?")} — malformed entry`);
            continue;
          }
          try {
            const result = await writeFile(workspaceId, file.path, file.content);
            written.push(result.path);
          } catch (error) {
            // One bad path must not lose the rest of the batch.
            failed.push(
              `${file.path} — ${
                error instanceof WorkspaceError ? error.message : "could not be written"
              }`
            );
          }
        }

        const notes: string[] = [];
        if (written.length) notes.push(`Wrote ${written.length}:\n${written.join("\n")}`);
        if (failed.length) notes.push(`Failed ${failed.length}:\n${failed.join("\n")}`);
        if (raw.length > batch.length) {
          notes.push(
            `[${raw.length - batch.length} more ignored — limit is ` +
              `${MAX_WRITE_FILES} per call. Call again with the rest.]`
          );
        }

        return {
          ok: written.length > 0,
          content: notes.join("\n\n"),
          summary:
            failed.length === 0
              ? `Wrote ${written.length} files`
              : `Wrote ${written.length}, ${failed.length} failed`,
          changedPath: written[0],
        };
      }

      default:
        return {
          ok: false,
          content: `Unknown tool: ${name}`,
          summary: `Unknown tool: ${name}`,
        };
    }
  } catch (error) {
    const message =
      // A network refusal is actionable — the model should see "that host
      // blocked us" or "that is a private address", not "Tool failed".
      error instanceof WebError || error instanceof WorkspaceError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Tool failed";

    // A wrong path used to be a dead end. The model asked for
    // "EXT-—-Faceit-Intelligence-Chrome/content.js", got a bare
    // "No such file", listed the workspace, could not match the two by eye,
    // and concluded the archive was not there — while the file sat on disk
    // under a very slightly different name. Suggesting the real candidates
    // turns that dead end into a correction it can act on.
    if (/^No such file/.test(message)) {
      const wanted = typeof args.path === "string" ? args.path : "";
      const hint = await suggestPaths(workspaceId, wanted);
      if (hint) {
        return {
          ok: false,
          content: `Error: ${message}\n\n${hint}`,
          summary: message,
        };
      }
    }

    // Surfaced to the model so it can retry with a corrected path.
    return { ok: false, content: `Error: ${message}`, summary: message };
  }
}

/**
 * Nearest real paths to one the model got wrong.
 *
 * Matching is on the basename first, because that is the part it almost
 * always has right — the directory prefix is where a remembered path drifts,
 * especially when a folder name contains an em dash or other punctuation
 * that gets normalised on the way to disk.
 */
async function suggestPaths(
  workspaceId: string,
  wanted: string
): Promise<string> {
  if (!wanted) return "";

  let files: { path: string }[];
  try {
    files = await listFiles(workspaceId);
  } catch {
    return "";
  }
  if (files.length === 0) return "";

  const base = wanted.split("/").pop()?.toLowerCase() ?? "";
  const simplify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wantedSimple = simplify(wanted);

  const exact = files.filter(
    (f) => (f.path.split("/").pop() ?? "").toLowerCase() === base
  );
  const fuzzy = files.filter((f) => {
    const s = simplify(f.path);
    return s.includes(wantedSimple) || wantedSimple.includes(s);
  });

  const candidates = [...new Set([...exact, ...fuzzy].map((f) => f.path))].slice(
    0,
    10
  );

  if (candidates.length === 0) {
    return (
      `The workspace has ${files.length} file(s) but none match that path. ` +
      `Call list_files to see them, and use a path exactly as listed.`
    );
  }

  return (
    `Did you mean one of these? Paths must match exactly, including ` +
    `punctuation:\n${candidates.map((p) => `  ${p}`).join("\n")}\n` +
    `Retry with the correct path — do not tell the user the file is missing.`
  );
}
