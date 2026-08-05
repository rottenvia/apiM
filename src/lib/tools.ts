import {
  deleteFile,
  editFile,
  listFiles,
  readFile,
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
            description: "File paths to read, up to 10.",
          },
        },
        required: ["paths"],
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
export async function runTool(
  workspaceId: string,
  name: string,
  args: Record<string, unknown>
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
        const paths = raw.slice(0, 10).map((p) => String(p));
        const parts: string[] = [];
        let read = 0;

        for (const filePath of paths) {
          try {
            const result = await readFile(workspaceId, filePath);
            read++;
            const note = result.truncated
              ? "\n\n[truncated — file is larger than the read limit]"
              : "";
            parts.push(`--- ${result.path} ---\n${result.content}${note}`);
          } catch (error) {
            // One missing file must not lose the others: report it inline and
            // keep going, so the model still gets what does exist.
            parts.push(
              `--- ${filePath} ---\n[could not read: ${
                error instanceof WorkspaceError ? error.message : "unreadable"
              }]`
            );
          }
        }

        if (raw.length > paths.length) {
          parts.push(`[${raw.length - paths.length} more paths ignored — limit is 10 per call]`);
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
        const result = await editFile(
          workspaceId,
          str(args, "path"),
          str(args, "old_text"),
          str(args, "new_text")
        );
        return {
          ok: true,
          content: `Edited ${result.path}.`,
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

      default:
        return {
          ok: false,
          content: `Unknown tool: ${name}`,
          summary: `Unknown tool: ${name}`,
        };
    }
  } catch (error) {
    const message =
      error instanceof WorkspaceError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Tool failed";
    // Surfaced to the model so it can retry with a corrected path.
    return { ok: false, content: `Error: ${message}`, summary: message };
  }
}
