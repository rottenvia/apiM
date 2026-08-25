import { diffLines, diffStats, diffHunks } from "@/lib/diff";
import { describeImageWithFallback } from "@/lib/ocr";
import {
  startProcess,
  stopProcess,
  writeToProcess,
  stopAll,
  getProcess,
  listProcesses,
  describeProcess,
  isRunning,
  waitForOutput,
  listLeftoverDecompilers,
  stopLeftoverDecompilers,
  stopLeftoverById,
} from "@/lib/processes";
import { smartSearch } from "@/lib/smart-search";
import type { SearchPlanner } from "@/lib/smart-search";
import { listSnapshots, restoreSnapshot } from "@/lib/snapshots";
import { documentKind, readDocument } from "@/lib/documents";
import {
  formatBinaryInspection,
  inspectWorkspaceBinary,
} from "@/lib/binaries";
import { noteBinaryInspection } from "@/lib/binary-ledger";
import {
  addFinding,
  reviseFinding,
} from "@/lib/findings";
import {
  fetchPage,
  downloadResource,
  extractSelectors,
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
  historyDepth,
  searchFiles,
  writeFile,
  writeFileBytes,
  workspaceDirectory,
  WorkspaceError,
  MAX_FILE_BYTES,
} from "@/lib/workspace";
import { applyPatch } from "@/lib/patch";
import { httpRequest, formatHttpResult } from "@/lib/http";
import {
  validateActions,
  runSession,
  formatSession,
  SCREENSHOT_DIR,
} from "@/lib/browser";
import { launch as launchBrowser } from "@/lib/browser-playwright";
import {
  detectRunner,
  parseTestOutput,
  formatTestSummary,
} from "@/lib/testing";
import { runCommand } from "@/lib/runner";
import { detectBuild, BuildError } from "@/lib/build";
import {
  DEFAULT_BATCH_EDITS,
  DEFAULT_READ_FILES,
  DEFAULT_WRITE_FILES,
  modelHasOpenToolLimits,
  toolLimitsFor,
  type ToolLimits,
} from "@/lib/tool-limits";

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
export const MAX_READ_FILES = DEFAULT_READ_FILES;

/**
 * How many files one write_files call may create.
 *
 * Lower than the read limit on purpose: writing is destructive, and a single
 * call that rewrites thirty files is already at the edge of what a user can
 * reasonably review in the activity list.
 */
export const MAX_WRITE_FILES = DEFAULT_WRITE_FILES;

/**
 * How many replacements one edit_files call may make.
 *
 * Higher than the write limit because an edit is surgical — it changes a
 * named snippet rather than replacing a whole file — so forty of them is
 * still a reviewable change.
 */
export const MAX_BATCH_EDITS = DEFAULT_BATCH_EDITS;

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
        "Read one file in the workspace. Always read a file before editing it, so the text you replace matches exactly. For a large file, use start_line and end_line to read just the part you need instead of pulling the whole thing into context.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "File path relative to the workspace root, e.g. 'src/app.py'.",
          },
          start_line: {
            type: "number",
            description:
              "First line to read, 1-based. Omit to start at the beginning.",
          },
          end_line: {
            type: "number",
            description:
              "Last line to read, inclusive. Omit to read to the end.",
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
        "cheaper than guessing which file to open. Query is PLAIN TEXT by " +
        "default. Only set regex:true when you intentionally want a pattern; " +
        "an ordinary word or a symbol like '.', '(', '+' or '?' is NOT a " +
        "regex and will error if you mark it one - leave regex off for normal " +
        "searches.",
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
          context: {
            type: "number",
            description:
              "Lines of surrounding code to show around each match, up to 10. Use 2 or 3 when you need to see what a match is part of — it usually saves a whole round of reading the file.",
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
        "diagram. Uses the OpenAI vision key when one is set; otherwise " +
        "scrapes visible text with free local OCR (no funds needed). Use " +
        "this when the user refers to an image they saved, or when you " +
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
        "stopped after 60 seconds by default (5 minutes for installs and " +
        "builds); pass timeout_ms if you know a job is slower. Never start a " +
        "server or anything that waits for input — use start_process for " +
        "those, then wait_for_output. For tests, prefer run_tests.",
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
          timeout_ms: {
            type: "number",
            description:
              "How long to allow, in ms, when you know the job is slow. Capped at 5 minutes.",
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
      name: "make_plan",
      description:
        "Write down the goal and the steps before starting anything that will take more than two or three actions. This is not paperwork: on a long task your own reasoning from twenty rounds ago is gone, and without a plan you will forget requirements from the first message and stop early because the work so far looks finished. Include verification steps — 'run the tests', 'open the page and check it renders' — not just the building. steps MUST be an array of sentences (not one numbered string, not labels like 'Search'). Replaces any existing plan.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "What finished looks like, in one sentence.",
          },
          steps: {
            type: "array",
            items: { type: "string" },
            description:
              "The steps, in order, each a full sentence. Include how you will check the work, not only how you will do it. Do not send one string.",
          },
        },
        required: ["goal", "steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_plan",
      description:
        "Mark steps as doing, done or blocked as you go. A step can only be marked done if you say how you checked it — the test you ran, the output you saw, the page you opened. If you have not checked it, it is not done.",
      parameters: {
        type: "object",
        properties: {
          updates: {
            type: "array",
            description: "One entry per step you are changing.",
            items: {
              type: "object",
              properties: {
                id: { type: "number", description: "Step number." },
                state: {
                  type: "string",
                  description: '"todo", "doing", "done" or "blocked".',
                },
                verified: {
                  type: "string",
                  description:
                    "Required for done: how you know it works.",
                },
                blocker: {
                  type: "string",
                  description: "Required for blocked: what is in the way.",
                },
              },
              required: ["id", "state"],
            },
          },
        },
        required: ["updates"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a question and wait for their answer. Use it whenever a " +
        "choice would change what you build and you cannot settle it yourself " +
        "— which framework, which data source, what 'done' looks like, " +
        "whether to overwrite something. Asking costs one round; guessing " +
        "wrong costs the whole task, so ask EARLY rather than after you have " +
        "committed to an approach. Always offer options when you can: a " +
        "question with buttons is one click, an open question is homework. " +
        "Do not ask what you could find out by reading a file or searching.",
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
        "reported. If you only need to know what just happened, pass tail — " +
        "re-reading a long log costs you those tokens on every later round. " +
        "To WAIT for something specific rather than polling, use " +
        "wait_for_output.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "Process id from start_process. Omit to list every process " +
              "in this workspace.",
          },
          tail: {
            type: "number",
            description:
              "Show only the last N lines. Use it when polling a server or a watcher.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_process",
      description:
        "Type a line into a running background process, as if at its " +
        "keyboard. Use it when read_process shows something waiting for " +
        "input: an installer asking to confirm, `npm init` asking for a " +
        "package name, a migration asking [y/N], a REPL. A newline is added " +
        "for you. Read the output again afterwards to see what it did with " +
        "the answer — the prompt is not always the last line.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Process id from start_process.",
          },
          input: {
            type: "string",
            description:
              "The line to send. Just the answer — 'y', a name, a path — " +
              "not the whole question.",
          },
        },
        required: ["id", "input"],
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
        "a port. Use id leftover or ghidra to kill leftover Ghidra/ILSpy " +
        "from a closed or refreshed tab — those have no chat UI.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              'Process id, "all" for this workspace, or "leftover"/"ghidra" for orphaned decompilers.',
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
          find: {
            type: "string",
            description:
              "Return only the lines matching this text or regular " +
              "expression, with a little surrounding context. Use it when " +
              "you want one fact out of a large page or JSON API — asking " +
              'for "\"version\"" beats pulling a 477KB document to read one ' +
              "line. The header always reports the full size, so you can " +
              "tell whether you narrowed a big page or a small one.",
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
            description:
              "Text to find. Exact by default; set regex to true to treat it " +
              "as a regular expression.",
          },
          regex: {
            type: "boolean",
            description:
              "Treat find as a JavaScript regular expression, and allow $1, " +
              "$2 in replace for captured groups. Use this when the text " +
              "varies — whitespace, a changing identifier, an optional " +
              "argument — which is where an exact match fails and costs you " +
              "a round. Run with preview first: a loose pattern matches more " +
              "than you meant.",
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
        "patching your own mistake by hand tends to make it worse. Up to 10 " +
        "previous versions are kept, so you can step further back with " +
        "`steps` if the version before this one was also wrong.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File to revert." },
          steps: {
            type: "number",
            description:
              "How many writes to go back. 1 is the last write (the default), 2 the one before it.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http_request",
      description:
        "Call an HTTP API directly and see the status code, headers and body. Use this to test an endpoint you or someone else built — it is the API equivalent of run_tests. Prefer it over run_command with curl: no approval prompt, no shell quoting to get wrong, and JSON comes back parsed. Public URLs are the default; set allow_local only for a development server on this machine.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL, including https://" },
          method: {
            type: "string",
            description: "GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS. Defaults to GET.",
          },
          headers: {
            type: "object",
            description:
              'Request headers, e.g. {"authorization": "Bearer ..."}. Content-Type becomes application/json when the body looks like JSON.',
          },
          body: {
            type: "string",
            description: "Request body, for POST/PUT/PATCH.",
          },
          allow_local: {
            type: "boolean",
            description:
              "Set true only to test a development server on localhost, " +
              "127.0.0.0/8 or [::1]. Private LAN addresses and cloud metadata " +
              "remain blocked. Leave false for public APIs.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_for_output",
      description:
        "Wait until a background process prints something, or exits. Use this straight after start_process instead of guessing how long a server takes to boot — 'wait until it prints Ready' returns the moment it does. It also returns immediately if the process dies, so a crash during startup does not cost you the full wait.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Process id from start_process." },
          pattern: {
            type: "string",
            description:
              "Text or regex to wait for, e.g. 'Ready in' or 'listening on'; omit to wait for exit.",
          },
          timeout_ms: {
            type: "number",
            description: "How long to wait before giving up. Default 30000, max 120000.",
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse",
      description:
        "Open a page in a real browser, run its JavaScript, and see what actually renders — the DOM, the visible text, the console, failed requests, and screenshots. Use this instead of fetch_url or inspect_page whenever the site is an app rather than static HTML: those only see the empty shell a server sends before scripts run, so any selector you write from them will not exist. Also use it to check your own work: open a page you built, screenshot it, and read the console for errors. Before scraping a site you do not control, check whether it has an official API — a documented endpoint returns clean JSON, survives redesigns, and is usually quicker to find than the right selector. If a page answers with an anti-bot challenge, the result names what it is and the raw page data is still returned; proceed with the task however you judge best.",
      parameters: {
        type: "object",
        properties: {
          actions: {
            type: "array",
            description:
              'Steps to perform in one shared live page; the first must be goto. Examples: {"action":"goto","url":"https://..."}, {"action":"html","selector":".game"}, {"action":"wait_for","selector":".match-score"}, {"action":"click","selector":"#accept","force":false}, {"action":"type","selector":"#q","text":"hello","press_enter":true}, {"action":"screenshot","name":"after-load","full_page":true}, {"action":"evaluate","script":"document.querySelectorAll(\'.row\').length"}.',
            items: { type: "object" },
          },
        },
        required: ["actions"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_tests",
      description:
        "Run this project's test suite and get back only the verdict and the failures, instead of hundreds of lines of runner output. Works out the right command itself (pytest, npm test, vitest, jest, cargo, go). Prefer this over run_command for tests: it is shorter, it cannot be misread, and it does not need you to guess the command.",
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            description:
              "Only run tests matching this name or path, e.g. 'test_login' or 'tests/test_auth.py'. Use it to re-run just a broken test.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "build_project",
      description:
        "Build the workspace with the installed toolchain: Visual Studio solutions/projects (.sln/.vcxproj/.csproj), CMake, dotnet, npm, cargo, go, make, Python, or a single .cpp/.cs file. Finds the compiler itself (no vcvars, no flag guessing), restores packages, builds Release x64 by default, and returns compiler errors so you can fix them without the user running anything. Prefer this over run_command for building.",
      parameters: {
        type: "object",
        properties: {
          config: {
            type: "string",
            enum: ["Release", "Debug"],
            description: "Build configuration. Defaults to Release.",
          },
          platform: {
            type: "string",
            description:
              "Target platform, e.g. x64 (default), Win32, Any CPU, ARM64.",
          },
          restore: {
            type: "boolean",
            description:
              "Restore NuGet/packages before building. Defaults to true for MSBuild/dotnet.",
          },
          extra_args: {
            type: "array",
            items: { type: "string" },
            description:
              "Additional raw arguments appended to the build command (e.g. ['/t:Rebuild', '/p:WarningLevel=0']).",
          },
          dry_run: {
            type: "boolean",
            description:
              "If true, only report which command would run without executing it.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description:
        "Apply a unified diff to one file — the same format as `git diff`. Use this instead of edit_file when you are changing several separate places in one file: a patch carries its own line context, so it applies cleanly where a series of edits can drift as each one shifts the lines below it.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File to patch, relative to the workspace root.",
          },
          patch: {
            type: "string",
            description:
              "A unified diff body: lines starting with ' ' for context, '-' to remove and '+' to add, in @@ hunks. File headers are optional.",
          },
        },
        required: ["path", "patch"],
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
        "Read a PDF, Word, Excel, PowerPoint, EPUB or ODT file in the " +
        "workspace as text. read_file cannot open any of these — they are " +
        "binary or zipped XML, not plain text — so use this for any .pdf, " +
        ".docx, .xlsx, .pptx, .epub or .odt.",
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
      name: "inspect_binary",
      description:
        "Statically inspect and decompile executables and libraries without " +
        "running them. Works on Windows PE files (.exe, .dll, .sys, .ocx, " +
        ".scr, .cpl, .drv, .efi) and other native binaries: Linux ELF " +
        "(.so, stripped executables, kernel modules) and macOS Mach-O. PE " +
        "files return architecture, headers, sections/entropy, hashes, " +
        "Authenticode envelope, imports with function names, exports, PDB " +
        "paths, selected strings, .NET metadata and a recursive graph of " +
        "DLLs supplied in the workspace. ELF/Mach-O return the detected " +
        "format, hashes, selected strings, the entropy map and carved " +
        "embedded blobs (no imports, exports or DLL graph). " +
        "It writes a full offset-labelled ASCII/UTF-16 strings dump, a " +
        "4KB-window entropy map, explicit packing assessment, carved embedded " +
        "PE/Lua/ZIP/PNG/PDF blobs plus opaque high-entropy sections/overlays " +
        "with their own strings, highlighted Lua/" +
        "process-memory/library-loading/process-creation imports, and an " +
        "optional FLARE capa report (PE files only). Managed code uses ILSpy " +
        "when installed; native code and all non-PE formats use headless " +
        "Ghidra, which auto-detects the file format. Decompile ONLY the " +
        "functions/strings you name in focus_terms — there is no default " +
        "hook list and no automatic full-binary decompile. Pick the " +
        "analyzer set yourself: the default 'fast' preset already turns " +
        "OFF the expensive analyzers the decompiled output does not " +
        "surface (Decompiler Parameter ID, Decompiler Switch Analysis, " +
        "Stack), so keep it for quick checks and pay for an analyzer only " +
        "when you need its output — e.g. enable_analyzers: [\"Decompiler " +
        "Parameter ID\"] when you need real parameter names instead of " +
        "param_1 placeholders, or analyzer_preset: \"full\" when switch-" +
        "case analysis matters. The exact available analyzer names are " +
        "listed in analyzers.txt in the output folder. Leftover Ghidra " +
        "after a closed tab is listed by list_processes and killed with " +
        "stop_process id=leftover. " +
        "Availability is resolved by the apiM server; do not use " +
        "run_command/where/environment probes to second-guess it because agent " +
        "commands intentionally receive a scrubbed environment. Outputs are " +
        "cached under analysis/. Packed, encrypted or obfuscated files may " +
        "only be partially recoverable, and the result says so.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Executable/library path relative to the workspace.",
          },
          analyses: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "summary",
                "strings",
                "entropy",
                "carve",
                "dependencies",
                "capa",
                "decompile",
                "all",
              ],
            },
            description:
              "Only the layers the request needs; omitted = cheap summary. " +
              "Examples: test Ghidra = [\"decompile\"]; dump strings = " +
              "[\"strings\"]; dependencies + capa = " +
              "[\"dependencies\",\"capa\"]; everything = [\"all\"].",
          },
          deep: {
            type: "boolean",
            description: "Legacy override; prefer analyses:[\"decompile\"].",
          },
          force_decompile: {
            type: "boolean",
            description:
              "Rerun decompilation, ignoring only its hash cache — completed " +
              "strings, entropy, carving and capa artifacts stay cached.",
          },
          artifacts: {
            type: "boolean",
            description:
              "Legacy override: true = all static artifact layers, false = " +
              "none. Prefer analyses.",
          },
          run_capa: {
            type: "boolean",
            description: "Legacy override; prefer analyses:[\"capa\"].",
          },
          focus_terms: {
            type: "array",
            items: { type: "string" },
            description:
              "Functions/strings to decompile on THIS binary. Required " +
              "before Ghidra starts. Pick them from a summary/strings pass " +
              "or from exports — do not invent game-specific names.",
          },
          focused_only: {
            type: "boolean",
            description:
              "Decompile only functions that reference focus_terms. " +
              "Defaults to true. Set false only to dump the whole binary.",
          },
          allow_full_fallback: {
            type: "boolean",
            description:
              "If focus_terms miss, also try loader/process-memory APIs " +
              "and then a bounded full dump. Defaults to false. Do not " +
              "enable on a huge downloaded DLL unless the user asked.",
          },
          analyzer_preset: {
            type: "string",
            enum: ["fast", "full"],
            description:
              "Ghidra auto-analyzers to run: 'fast' (default) turns OFF " +
              "the expensive analyzers the decompiled output does not " +
              "surface (Decompiler Parameter ID, Decompiler Switch " +
              "Analysis, Stack) — much faster, no loss of reported " +
              "information; 'full' keeps every analyzer on (much slower — " +
              "only when parameter names or switch-case analysis are " +
              "actually needed).",
          },
          disable_analyzers: {
            type: "array",
            items: { type: "string" },
            description:
              "Exact Ghidra analyzer names to turn OFF in addition to the " +
              "preset; analyzers.txt in the output folder lists the " +
              "available names.",
          },
          enable_analyzers: {
            type: "array",
            items: { type: "string" },
            description:
              "Exact Ghidra analyzer names to turn ON, overriding the " +
              "preset. 'Decompiler Parameter ID' recovers real parameter " +
              "names (otherwise param_1… placeholders); 'Decompiler " +
              "Switch Analysis' resolves switch tables. analyzers.txt in " +
              "the output folder lists the available names.",
          },
          dependencies: {
            type: "boolean",
            description: "Legacy override; prefer analyses:[\"dependencies\"].",
          },
          max_depth: {
            type: "number",
            description:
              "Local DLL recursion depth, 0-8 (default 4). System DLLs are " +
              "named but not read from outside the workspace.",
          },
          include_strings: {
            type: "boolean",
            description: "Extract and rank readable ASCII/UTF-16 strings. Defaults to true.",
          },
          string_filter: {
            type: "string",
            description:
              "Only return strings containing this text. Useful for URLs, " +
              "errors, paths, product names or a suspected runtime-loaded DLL.",
          },
          min_string_length: {
            type: "number",
            description: "Minimum string length, 4-64 (default 6).",
          },
          max_strings: {
            type: "number",
            description: "Maximum selected strings to return, 1-300 (default 160).",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "note_binary",
      description:
        "Record your verdict about an executable you inspected - works, " +
        "flawed, where the good build is, what a hook does. Persists across " +
        "messages and after Stop, shown every later turn, so you do " +
        "not re-decompile the same DLL. Call it the moment you conclude: one " +
        "short specific sentence.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace path of the executable/DLL." },
          note: {
            type: "string",
            description:
              "The verdict, e.g. 'Works but CreateMove reads a stale cmd pointer; fixed build is cleanroom_bhop.dll.' Max 500 chars.",
          },
          sha256: {
            type: "string",
            description: "Optional hash (or 12-char prefix) pinning the note to one build.",
          },
        },
        required: ["path", "note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "note_finding",
      description:
        "Record a conclusion you reached so you do not re-derive or forget it after context is compacted. Use it for anything established by reading files, running commands or decompiling: a dead approach, what a function actually does, which option works and why, what an error meant. One specific, factual line with the evidence. Shown to you every later turn; if it turns out wrong, call note_finding again with status 'disproved'. Record findings as you go, not only at the end.",
      parameters: {
        type: "object",
        properties: {
          claim: {
            type: "string",
            description:
              "The conclusion, one sentence. e.g. 'bar.dll is the correct build: its CreateMove reads the live cmd pointer, unlike foo.dll which reads a stale copy.'",
          },
          refs: {
            type: "array",
            items: { type: "string" },
            description:
              "Files, functions, symbols or addresses this is about, e.g. ['bar.dll', 'CreateMove'] or ['src/hook.cpp:42'].",
          },
          evidence: {
            type: "string",
            description:
              "What established it - a command, a file/line read, a decompiled function. Short.",
          },
          id: {
            type: "string",
            description:
              "Id [f...] of an existing finding to correct; with status, marks it wrong instead of adding a new one.",
          },
          status: {
            type: "string",
            enum: ["active", "disproved"],
            description:
              "Use 'disproved' with an id to retire a prior finding; give the corrected claim in claim.",
          },
        },
        required: ["claim"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_processes",
      description:
        "List the background processes you started, plus leftover " +
        "Ghidra/ILSpy from a closed or refreshed tab (those have no " +
        "inspect UI). Use leftover ids with stop_process, or id leftover " +
        "to kill every orphaned decompiler.",
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
      name: "github_push",
      description:
        "Push committed work from this workspace's dedicated GitHub branch. " +
        "Use git status/diff/log first, commit with run_command, then call this. " +
        "Never pushes the selected base branch and never force-pushes. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "One short line explaining what is ready to publish.",
          },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "download_file",
      description:
        "Save the exact bytes from a URL straight into the workspace - up " +
        "to 200MB by default (PDFs, images, archives, installers, DLLs, " +
        "datasets). A downloaded PDF can be passed to read_document and an " +
        "image to view_image. Use this instead of curl in run_command, and " +
        "instead of asking the user to download and attach the file.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL, including https://" },
          path: {
            type: "string",
            description: "Where to save it, relative to the workspace root.",
          },
          allow_local: {
            type: "boolean",
            description:
              "Set true only when downloading from a development server on " +
              "localhost/127.0.0.1/[::1]. Private LAN and metadata addresses remain blocked.",
          },
        },
        required: ["url", "path"],
      },
    },
  },
];

/**
 * Tool list for this model. Ox Alpha gets the same tools with the
 * per-call ceilings removed from the descriptions, so it does not
 * self-limit to 60 files.
 */
export function workspaceToolsFor(
  modelId?: string | null
): ToolDefinition[] {
  if (!modelHasOpenToolLimits(modelId)) return WORKSPACE_TOOLS;
  return WORKSPACE_TOOLS.map((tool) => {
    const name = tool.function.name;
    if (name === "read_file") {
      return {
        ...tool,
        function: {
          ...tool.function,
          description:
            "Read one file in the workspace. Always read a file before editing it, so the text you replace matches exactly. The whole file is returned — it is not truncated. For a huge file, use start_line and end_line if you only need one part.",
        },
      };
    }
    if (name === "read_files") {
      return {
        ...tool,
        function: {
          ...tool.function,
          description:
            "Read several files in one step. Prefer this over calling read_file repeatedly. No per-call cap — read as many paths as you need.",
          parameters: {
            ...tool.function.parameters,
            properties: {
              paths: {
                type: "array",
                items: { type: "string" },
                description: "File paths to read. No per-call cap.",
              },
            },
          },
        },
      };
    }
    if (name === "write_files") {
      return {
        ...tool,
        function: {
          ...tool.function,
          description:
            "Create several files in one step. Prefer this when scaffolding. No per-call cap.",
          parameters: {
            ...tool.function.parameters,
            properties: {
              files: {
                type: "array",
                description: "Files to write. No per-call cap.",
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
          },
        },
      };
    }
    if (name === "edit_files") {
      return {
        ...tool,
        function: {
          ...tool.function,
          description:
            "Make several exact replacements in one step, across one file or many. Prefer this over repeated edit_file. No per-call cap. Every snippet must appear exactly once in its file.",
          parameters: {
            ...tool.function.parameters,
            properties: {
              edits: {
                type: "array",
                description: "Replacements to apply. No per-call cap.",
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
          },
        },
      };
    }
    if (name === "search_files") {
      return {
        ...tool,
        function: {
          ...tool.function,
          description:
            "Find text across every file in the workspace at once, with the file " +
            "and line number of each match. Returns every match — not a short sample. " +
            "Query is PLAIN TEXT by default. Only set regex:true when you intentionally want a pattern.",
        },
      };
    }
    if (name === "fetch_url") {
      return {
        ...tool,
        function: {
          ...tool.function,
          description:
            "Open a web page and read it. The full page text is returned rather than a short extract. " +
            "Set raw to true to get the HTML. Never guess a selector you have not seen.",
        },
      };
    }
    if (name === "download_file") {
      return {
        ...tool,
        function: {
          ...tool.function,
          description:
            "Save the exact bytes from a URL straight into the workspace. " +
            "Sized against the workspace file ceiling, not a small download cap. " +
            "A downloaded PDF can be passed to read_document and an image to view_image.",
        },
      };
    }
    return tool;
  });
}

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
  // An absent optional argument is "not given", not an error. Only a present
  // value of a non-coercible type is a malformed call worth rejecting —
  // otherwise every optional field (note_finding's id, note_binary's sha256)
  // throws "must be a string" the first time the model omits it, costing a
  // round.
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return String(value);
  return value;
}

/**
 * An optional numeric argument.
 *
 * Returns null when absent, so "not given" and "given as zero" stay
 * distinguishable. Models sometimes send numbers as strings, and rejecting
 * "12" when 12 was meant costs a whole round to correct.
 */
function num(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

/**
 * Execute one tool call.
 *
 * Errors are returned as tool results rather than thrown: the model needs to
 * see "that path doesn't exist" so it can correct itself, and a thrown error
 * would abandon the whole turn instead.
 */
export interface ToolContext {
  /**
   * Catalog model id. Ox Alpha lifts per-call tool ceilings; everyone
   * else keeps the defaults. Absent means the default (capped) set.
   */
  modelId?: string | null;
  /** Vision provider key. Absent means view_image uses free local OCR. */
  visionKey?: string;
  visionModel?: string;
  /** Tavily key. Absent means web_search is withheld from the model. */
  searchKey?: string;
  /** Optional Exa key, used when Tavily refuses. Either one enables search. */
  exaKey?: string;
  /** Needed by the search planner, which uses a cheap model to pick queries. */
  deepseekKey?: string;
  /** Overrides DeepSeek Flash when the user is on OpenCode / Ox Alpha. */
  planner?: SearchPlanner;
  searchProfile?: string;
  /** Explicit Stop signal; expensive static/decompiler work must release promptly. */
  signal?: AbortSignal;
}

export async function runTool(
  workspaceId: string,
  name: string,
  args: Record<string, unknown>,
  context: ToolContext = {}
): Promise<ToolResult> {
  const limits: ToolLimits = toolLimitsFor(context.modelId);
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
        const result = await readFile(workspaceId, str(args, "path"), {
          maxChars: limits.readChars,
        });
        const note = result.truncated
          ? "\n\n[truncated — file is larger than the read limit]"
          : "";

        /*
         * Optional line range.
         *
         * The parameters were accepted by callers and silently ignored: asking
         * for lines 1-2 of an eight-line file returned all eight. Harmless on
         * a small file, expensive on a large one — reading a 3000-line module
         * to change one function is most of a round's budget spent on context
         * that is never used.
         */
        const total = result.content.split("\n").length;
        const start = num(args, "start_line");
        const end = num(args, "end_line");

        if (start === null && end === null) {
          return {
            ok: true,
            content: `${result.path}:\n\n${result.content}${note}`,
            summary: `Read ${result.path}`,
          };
        }

        const from = Math.max(1, start ?? 1);
        const to = Math.min(total, end ?? total);
        if (from > total) {
          return {
            ok: false,
            content:
              `Error: ${result.path} has ${total} lines, so line ${from} ` +
              `does not exist.`,
            summary: `Line ${from} is past the end of ${result.path}`,
          };
        }

        const slice = result.content.split("\n").slice(from - 1, to);
        /*
         * Numbered, because a slice without them is a trap.
         *
         * Handed lines 400-460 as bare text, a model reasons about them as if
         * they were the file — reporting "the bug is on line 12" when it means
         * line 411. The numbers cost a few tokens and make the offset
         * impossible to lose.
         */
        const width = String(to).length;
        const numbered = slice
          .map((line, i) => `${String(from + i).padStart(width)} | ${line}`)
          .join("\n");

        return {
          ok: true,
          content:
            `${result.path} (lines ${from}-${to} of ${total}):\n\n` +
            `${numbered}${note}`,
          summary: `Read ${result.path} lines ${from}-${to}`,
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
        const paths = raw.slice(0, limits.readFiles).map((p) => String(p));
        const parts: string[] = [];
        let read = 0;

        // Read together, reported in the order asked for. Sixty local files
        // is only a few milliseconds either way, but the ordering guarantee
        // matters: the model refers to them by position in its own request.
        const results = await Promise.all(
          paths.map((filePath) =>
            readFile(workspaceId, filePath, { maxChars: limits.readChars })
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
            `[NOT READ — ${dropped.length} path(s) exceeded the ${limits.readFiles}-per-call limit: ` +
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
          context: num(args, "context") ?? 0,
          maxHits: limits.searchHits,
          maxFileBytes: limits.searchableBytes,
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

        const lines = result.hits.map((h) => {
          if (!h.before?.length && !h.after?.length) {
            return `${h.path}:${h.line}: ${h.text}`;
          }
          // With context, the hit is marked so the model can tell which line
          // actually matched — otherwise it reasons about a neighbour.
          const out: string[] = [`${h.path}:${h.line}:`];
          const first = h.line - (h.before?.length ?? 0);
          h.before?.forEach((l, i) =>
            out.push(`  ${String(first + i).padStart(5)}   ${l}`)
          );
          out.push(`> ${String(h.line).padStart(5)}   ${h.text}`);
          h.after?.forEach((l, i) =>
            out.push(`  ${String(h.line + 1 + i).padStart(5)}   ${l}`)
          );
          return out.join("\n");
        });
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

        /*
         * Only the last N lines, when asked for.
         *
         * Polling a dev server meant re-reading its entire log every time,
         * and that whole log then rode along in the transcript on every later
         * round. On a watcher that prints a line a second, the interesting
         * part is always the end — and `tail` makes checking twice cost
         * almost nothing instead of doubling the context.
         */
        const tailLines = num(args, "tail");
        let body = proc.log.trim() || "(no output)";
        let trimmedNote = "";
        if (tailLines && tailLines > 0) {
          const lines = body.split("\n");
          if (lines.length > tailLines) {
            trimmedNote =
              `\n\n[showing the last ${tailLines} of ${lines.length} lines]`;
            body = lines.slice(-tailLines).join("\n");
          }
        }

        return {
          ok: true,
          content:
            `${describeProcess(proc)}\n\n${body}${trimmedNote}${note}`,
          summary: isRunning(proc)
            ? `Read ${proc.display}`
            : `${proc.display} has stopped`,
        };
      }

      case "write_process": {
        const id = str(args, "id").trim();
        const input = typeof args.input === "string" ? args.input : "";

        const proc = getProcess(id);
        // Workspace-scoped like every other process call: one chat must not
        // be able to type into another chat's process.
        if (!proc || proc.workspaceId !== workspaceId) {
          return {
            ok: false,
            content: `No process with id "${id}" in this workspace. Use read_process with no id to list them.`,
            summary: "Unknown process",
          };
        }

        const res = writeToProcess(id, input);
        if (!res.ok) {
          return {
            ok: false,
            content: `Could not send that: ${res.reason}`,
            summary: "Write failed",
          };
        }

        /*
         * A short pause, then the new output.
         *
         * Sending input and returning immediately shows the log as it was
         * BEFORE the process reacted, which reads as "nothing happened" and
         * invites the model to send it again. 250ms is enough for a prompt
         * to advance without being a wait the user notices.
         */
        await new Promise((resolve) => setTimeout(resolve, 250));
        const after = getProcess(id);
        const tail = (after?.log ?? "").split("\n").slice(-15).join("\n");

        return {
          ok: true,
          content:
            `Sent to ${proc.display}: ${input.trim()}\n\n` +
            `Output since (last 15 lines):\n${tail || "(nothing yet)"}\n\n` +
            `Read it again with read_process if it needed longer to respond.`,
          summary: `Sent "${input.trim().slice(0, 20)}"`,
        };
      }

      case "stop_process": {
        const id = str(args, "id").trim();

        if (id === "leftover" || id === "ghidra") {
          const stopped = stopLeftoverDecompilers();
          return {
            ok: true,
            content:
              stopped === 0
                ? "No leftover Ghidra/ILSpy was running."
                : `Stopped ${stopped} leftover decompiler${stopped === 1 ? "" : "s"}.`,
            summary: `Stopped ${stopped} leftover`,
          };
        }

        if (id === "all") {
          const stopped = stopAll(workspaceId) + stopLeftoverDecompilers();
          return {
            ok: true,
            content:
              stopped === 0
                ? "Nothing was running."
                : `Stopped ${stopped} process${stopped === 1 ? "" : "es"}.`,
            summary: `Stopped ${stopped}`,
          };
        }

        if (id.startsWith("orphan-") || getProcess(id)?.kind === "decompiler") {
          const leftover = listLeftoverDecompilers().find((item) => item.id === id);
          const ok = stopLeftoverById(id);
          return {
            ok,
            content: ok
              ? `Stopped ${leftover?.display ?? id}.`
              : `No leftover decompiler with id "${id}".`,
            summary: ok ? `Stopped ${leftover?.display ?? id}` : "Unknown process",
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
        const imagePath = str(args, "path");
        const image = await readImageAsDataUrl(workspaceId, imagePath);

        const result = await describeImageWithFallback(
          image.dataUrl,
          context.visionKey,
          context.visionModel,
          typeof args.question === "string" ? args.question : undefined
        );

        if (result.error && !result.description) {
          return {
            ok: false,
            content: `Could not read ${imagePath}: ${result.error}`,
            summary: `Couldn't view ${imagePath}`,
          };
        }

        const via = result.source === "ocr" ? " (OCR)" : "";
        return {
          ok: true,
          content: `${imagePath}${via}:\n\n${result.description ?? "(no description)"}`,
          summary:
            result.source === "ocr"
              ? `OCR ${imagePath}`
              : `Viewed ${imagePath}`,
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
          before = (await readFile(workspaceId, filePath, {
            maxChars: limits.readChars,
          })).content;
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
            const after = (
              await readFile(workspaceId, filePath, {
                maxChars: limits.readChars,
              })
            ).content;
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
        const page = await fetchPage(str(args, "url"), {
          raw: wantsRaw,
          maxBytes: limits.fetchBytes,
          maxChars: limits.fetchChars,
        });

        const header = [
          `${page.url}`,
          page.title ? `Title: ${page.title}` : null,
          `HTTP ${page.status} · ${page.contentType} · ${(page.bytes / 1024).toFixed(0)}KB`,
          page.truncated
            ? `[truncated at ${limits.fetchChars.toLocaleString()} characters]`
            : null,
        ]
          .filter(Boolean)
          .join("\n");

        let body = wantsRaw && page.html ? page.html : page.text;

        /*
         * Narrowing, because the whole page is often the wrong amount.
         *
         * Reported from a real test: fetching PyPI's JSON to read one version
         * string returned 477KB, truncated at 200,000 characters — the answer
         * was in there, but so was the release history of every version since
         * 2021, and a truncated body can cut off the very line that was
         * wanted.
         *
         * A literal substring is tried as a regex first, so both work. An
         * invalid pattern falls back to a literal search rather than failing:
         * a model writing `info.version` means the text, not a character
         * class.
         */
        const find = typeof args.find === "string" ? args.find.trim() : "";
        let findNote = "";
        if (find) {
          /*
           * Match on CHARACTER OFFSETS, not on lines.
           *
           * The first version split the body into lines and kept the matching
           * ones with two either side. That works on pretty-printed text and
           * does nothing at all on minified JSON — which is most API
           * responses. Reported from a real test against PyPI: the whole
           * 477KB document is ONE line, so "the matching line" was the entire
           * file and `find` filtered one line down to one line.
           *
           * Windowing around each match instead works on both shapes: a line
           * in pretty-printed JSON is well under the window, and a minified
           * blob gets a slice around the needle rather than the ocean.
           */
          const WINDOW = 300;
          const MAX_MATCHES = limits.fetchFindMatches;

          let re: RegExp;
          try {
            re = new RegExp(find, "gi");
          } catch {
            // A model writing "info.version[" means the text, not a broken
            // character class.
            re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
          }

          const spans: [number, number][] = [];
          for (const m of body.matchAll(re)) {
            if (m.index === undefined) continue;
            spans.push([
              Math.max(0, m.index - WINDOW),
              Math.min(body.length, m.index + m[0].length + WINDOW),
            ]);
            if (spans.length >= MAX_MATCHES) break;
          }

          if (spans.length === 0) {
            findNote =
              `\n\n[Nothing matched "${find}". The page is ` +
              `${body.length.toLocaleString()} characters — fetch it again ` +
              `without find, or try a different pattern.]`;
            body = "";
          } else {
            // Overlapping windows are merged so a dense cluster of matches
            // reads as one passage rather than the same text repeated.
            const merged: [number, number][] = [];
            for (const [from, to] of spans) {
              const last = merged[merged.length - 1];
              if (last && from <= last[1]) last[1] = Math.max(last[1], to);
              else merged.push([from, to]);
            }

            const pieces = merged.map(([from, to]) => {
              const lead = from > 0 ? "…" : "";
              const trail = to < body.length ? "…" : "";
              return `${lead}${body.slice(from, to)}${trail}`;
            });

            const shown = pieces.join("\n\n");
            findNote =
              `\n[Showing ${merged.length} match${merged.length === 1 ? "" : "es"} ` +
              `for "${find}" with ${WINDOW} characters of context each, out of ` +
              `${body.length.toLocaleString()} characters.` +
              `${spans.length >= MAX_MATCHES ? ` Stopped at ${MAX_MATCHES} matches.` : ""}]`;
            body = shown.slice(0, limits.fetchChars);
          }
        }

        /*
         * Say so when this tool is the wrong one.
         *
         * An app shell fetches successfully and contains nothing. Reporting
         * that as a normal result is how the model ends up writing selectors
         * for a DOM that was never sent — it had no way to tell the page was
         * empty rather than simply short.
         */
        const warning = page.needsBrowser
          ? `\n\n[This page is an app shell — its content is built by ` +
            `JavaScript, which has not run here, so the text and markup above ` +
            `are nearly empty. Use browse for this URL instead: it runs the ` +
            `scripts and returns the real DOM. Do not write selectors from ` +
            `what you see above.]`
          : "";

        return {
          ok: true,
          content: `${header}${warning}${findNote}\n\n${body}`,
          summary: page.needsBrowser
            ? `${new URL(page.url).hostname} needs a browser`
            : `Read ${new URL(page.url).hostname}${
                page.title ? ` — ${page.title.slice(0, 50)}` : ""
              }`,
        };
      }

      case "inspect_page": {
        const page = await fetchPage(str(args, "url"), {
          raw: true,
          maxBytes: limits.fetchBytes,
          maxChars: limits.fetchChars,
        });
        if (!page.html) {
          return {
            ok: false,
            content:
              `${page.url} returned ${page.contentType}, not HTML, so it has ` +
              `no selectors to inspect.`,
            summary: "Not an HTML page",
          };
        }

        if (page.needsBrowser) {
          // Refused rather than answered. inspect_page exists to hand back
          // selectors, and returning `id=root` as though it were the page's
          // structure is precisely the failure this whole area was fixed for.
          return {
            ok: false,
            content:
              `${page.url} is an app shell: the markup the server sent ` +
              `contains no real content, because the page is built by ` +
              `JavaScript that has not run. Any selector taken from it would ` +
              `not exist in the live page.\n\nUse browse on this URL — it ` +
              `runs the scripts and returns the rendered DOM.`,
            summary: "Needs a browser, not a fetch",
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
              : `${page.url} has no ids, classes or data attributes to list. ` +
                `That is valid for a simple static page built from plain tags; ` +
                `there is no evidence here that JavaScript is involved. Read ` +
                `the raw HTML with fetch_url if tag structure is enough, or ` +
                `inspect a more specific page.`,
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
        const resource = await downloadResource(str(args, "url"), {
          allowLocal: args.allow_local === true,
          maxBytes: limits.open ? MAX_FILE_BYTES : undefined,
        });
        // Bytes, never decoded text. This is what lets a downloaded PDF flow
        // directly into read_document and an image into view_image without
        // being corrupted or refused as "not a page".
        const written = await writeFileBytes(
          workspaceId,
          target,
          Buffer.from(resource.data)
        );

        const looksPe =
          /\.(exe|dll|sys|ocx|scr|cpl|drv|efi)$/i.test(written.path) ||
          (resource.data.length >= 2 &&
            resource.data[0] === 0x4d &&
            resource.data[1] === 0x5a);
        const peHint = looksPe
          ? `\n\nThis is a Windows executable/library. Do not decompile the whole file. ` +
            `Call inspect_binary with analyses:["summary"] or ["strings"] first, then ` +
            `decompile only the functions/strings you need via focus_terms. Enable a ` +
            `specific Ghidra analyzer such as "Decompiler Parameter ID" with ` +
            `enable_analyzers if you need it. Leftover Ghidra is stop_process id=leftover.`
          : "";

        return {
          ok: true,
          content:
            `Saved ${resource.url} to ${written.path} (${written.bytes} bytes, ` +
            `${resource.contentType}).${peHint}`,
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

        const batch = raw.slice(0, limits.batchEdits);
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

        /*
         * Count files, not edits.
         *
         * `done` holds one entry per successful EDIT, and several edits to the
         * same file is the normal case — two bugs in one file is two entries.
         * Reporting that as "Edited 2 file(s)" is wrong in the one direction
         * that matters: it tells the model it touched more of the workspace
         * than it did.
         *
         * Seen in a real run: the model fixed both bugs in counter.py with one
         * edit_files call and was told it had edited two files. The work was
         * correct; the receipt was not.
         */
        const distinct = [...new Set(done)];
        const fileWord = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

        const notes: string[] = [];
        if (done.length) {
          notes.push(
            `Applied ${done.length} edit${done.length === 1 ? "" : "s"} to ` +
              `${fileWord(distinct.length)}:\n${distinct.join("\n")}`
          );
        }
        if (failed.length) {
          notes.push(
            `Failed ${failed.length} — these were NOT applied, fix and retry ` +
              `just these:\n${failed.join("\n")}`
          );
        }
        if (raw.length > batch.length) {
          notes.push(
            `[${raw.length - batch.length} more ignored — limit is ` +
              `${limits.batchEdits} per call.]`
          );
        }

        return {
          ok: done.length > 0,
          content: notes.join("\n\n"),
          summary:
            failed.length === 0
              ? `Edited ${fileWord(distinct.length)}`
              : `Edited ${fileWord(distinct.length)}, ${failed.length} failed`,
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
        const useRegex = args.regex === true;

        /*
         * Regex, because exact-match is the most common self-inflicted
         * failure.
         *
         * Reported: "one drifted space or shifted line and the edit dies".
         * edit_file already tolerates whitespace across three passes, but
         * replace_in_files was strictly literal — so a rename where the
         * surrounding text varies had no tool at all, and the fallback was
         * one edit per file.
         *
         * searchFiles already understood regex; this simply stopped throwing
         * that away. Validated here rather than at match time so a bad
         * pattern is a clear error instead of a silent zero-match.
         */
        let pattern: RegExp | null = null;
        if (useRegex) {
          try {
            pattern = new RegExp(find, "g");
          } catch (error) {
            return {
              ok: false,
              content:
                `Error: "${find}" is not a valid regular expression — ` +
                `${error instanceof Error ? error.message : "could not be parsed"}. ` +
                `Fix the pattern, or drop regex to search for it literally.`,
              summary: "Bad pattern",
            };
          }
        }

        // Reuses the same matcher the search tool uses, so a preview and the
        // real thing can never disagree about which files are in scope.
        const hits = await searchFiles(workspaceId, find, {
          glob,
          regex: useRegex,
          maxHits: limits.searchHits,
          maxFileBytes: limits.searchableBytes,
        });
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
            const file = await readFile(workspaceId, filePath, {
              maxChars: limits.readChars,
            });

            let count: number;
            let updated: string;
            if (pattern) {
              // A fresh lastIndex per file: a /g regex is stateful, and
              // reusing one across files silently skips matches.
              const re = new RegExp(pattern.source, pattern.flags);
              count = [...file.content.matchAll(re)].length;
              updated = file.content.replace(
                new RegExp(pattern.source, pattern.flags),
                replace
              );
            } else {
              count = file.content.split(find).length - 1;
              updated = file.content.split(find).join(replace);
            }
            if (count === 0) continue;

            occurrences += count;
            if (!preview) {
              await writeFile(workspaceId, filePath, updated);
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
        if (
          (!context.searchKey && !context.exaKey) ||
          !(context.planner?.apiKey || context.deepseekKey)
        ) {
          return {
            ok: false,
            content:
              "Web search is not configured — no Tavily or Exa key is set in " +
              "Settings. Say plainly that you could not look this up rather " +
              "than guessing, or use fetch_url if you already know the URL.",
            summary: "Search unavailable",
          };
        }

        let found;
        try {
          found = await smartSearch(
            query,
            "",
            context.planner?.apiKey || context.deepseekKey || "",
            context.searchKey ?? "",
            undefined,
            context.searchProfile,
            context.exaKey,
            context.planner
          );
        } catch (error) {
          /*
           * Say WHY, so the model stops instead of rephrasing.
           *
           * A provider failure used to arrive as "No results — try different
           * wording", which is advice that cannot work: no rewording fixes a
           * rejected key. Reported from a real run — five searches, five
           * empty answers, including for the query "cat", each one billed.
           */
          const { SearchProviderError } = await import("@/lib/smart-search");
          if (error instanceof SearchProviderError) {
            const why =
              error.status === 401 || error.status === 403
                ? "the Tavily key was rejected. Check it in Settings."
                : error.status === 429 || error.status === 432
                  ? "the Tavily quota or rate limit is spent."
                  : error.status
                    ? `the search service returned HTTP ${error.status}.`
                    : "the search service could not be reached.";
            return {
              ok: false,
              content:
                `Search FAILED — ${why}${error.detail ? ` (${error.detail})` : ""}\n\n` +
                `This is not "no results": the query never ran. Do not retry ` +
                `it or rephrase — nothing about the wording is the problem. ` +
                `Tell the user plainly, and use fetch_url if you already know ` +
                `a URL that would answer this.`,
              summary: `Search failed (${error.status || "unreachable"})`,
            };
          }
          throw error;
        }

        /*
         * Always say which providers ran, especially when nothing came back.
         *
         * Asked for after three rounds of debugging a black box: an empty
         * result was indistinguishable from a provider that was never called,
         * and the only way to tell was the server console. One line here
         * replaces all of that guessing.
         */
        const ran = found.providersUsed.length
          ? found.providersUsed.join(", ")
          : "none";
        const errs = found.providerErrors.length
          ? `\nProvider errors: ${found.providerErrors.join("; ")}`
          : "";

        if (found.results.length === 0) {
          return {
            ok: true,
            content:
              `No results for "${query}".\n` +
              `Providers that answered: ${ran}.${errs}\n\n` +
              (found.providerErrors.length
                ? `At least one provider errored — that is not the same as ` +
                  `finding nothing. Tell the user what failed rather than ` +
                  `rephrasing.`
                : `Every configured provider ran and genuinely found nothing. ` +
                  `Try different wording, or say you could not find it.`),
            summary: `No results — ${query.slice(0, 40)} (via ${ran})`,
          };
        }

        const body = found.results
          .slice(0, limits.searchResults)
          .map(
            (hit, i) =>
              `[${i + 1}] ${hit.title}\n${hit.url}\n${(hit.content ?? "").slice(0, limits.searchSnippet)}`
          )
          .join("\n\n");

        return {
          ok: true,
          content:
            `${found.results.length} result(s) for "${query}":\n\n${body}\n\n` +
            `Cite the URLs you use. Call fetch_url on one for the full page.` +
            `\n[via ${ran}${errs}]`,
          summary: `Searched via ${ran}: ${query.slice(0, 35)}`,
        };
      }

      case "undo_file": {
        const target = str(args, "path");
        const steps = Math.max(1, num(args, "steps") ?? 1);
        const previous = await previousVersion(workspaceId, target, steps);

        if (previous === null) {
          const depth = await historyDepth(workspaceId, target);
          return {
            ok: false,
            content: depth
              ? `Cannot go back ${steps} writes: only ${depth} previous ` +
                `version${depth === 1 ? " is" : "s are"} kept for ${target}. ` +
                `Try a smaller number, or restore_snapshot for a bigger step ` +
                `back.`
              : `No previous version of ${target} is kept — it has not been ` +
                `overwritten since it was created. Fix it forward with ` +
                `edit_file instead.`,
            summary: `No history for ${target}`,
          };
        }

        /*
         * Reverting is itself a write, so it goes into history too. That is
         * deliberate: undoing an undo is a real thing to want, and it falls
         * out for free rather than needing a redo stack.
         */
        const written = await writeFile(workspaceId, target, previous);
        return {
          ok: true,
          content:
            `Reverted ${written.path} to how it was ${steps} write` +
            `${steps === 1 ? "" : "s"} ago (${written.bytes} bytes).`,
          summary: `Reverted ${written.path}`,
          changedPath: written.path,
        };
      }

      case "http_request": {
        const headers: Record<string, string> = {};
        if (args.headers && typeof args.headers === "object") {
          for (const [k, v] of Object.entries(
            args.headers as Record<string, unknown>
          )) {
            headers[k] = String(v);
          }
        }

        try {
          const result = await httpRequest({
            url: str(args, "url"),
            method: typeof args.method === "string" ? args.method : "GET",
            headers,
            body: typeof args.body === "string" ? args.body : undefined,
            allowLocal: args.allow_local === true,
          });
          return {
            // A 404 or a 500 is a true answer to the question asked, not a
            // tool failure. Marking it failed would send the model down the
            // retry path for a response it should be reading.
            ok: true,
            content: formatHttpResult(result),
            summary: `${result.status} ${result.statusText} in ${result.ms}ms`,
          };
        } catch (error) {
          return {
            ok: false,
            content: `Error: ${
              error instanceof Error ? error.message : "request failed"
            }`,
            summary: "Request failed",
          };
        }
      }

      case "wait_for_output": {
        const id = str(args, "id");
        const pattern = typeof args.pattern === "string" ? args.pattern : "";
        const timeout = num(args, "timeout_ms") ?? 30_000;

        const result = await waitForOutput(id, pattern, timeout);
        if (!result) {
          return {
            ok: false,
            content: `Error: no process with id "${id}". Use list_processes.`,
            summary: "No such process",
          };
        }

        const tail = result.newOutput.trim()
          ? `\n\nOutput since waiting:\n${result.newOutput.slice(-4000)}`
          : "\n\nIt printed nothing while waiting.";

        if (result.outcome === "matched") {
          return {
            ok: true,
            content:
              `Matched after ${result.waitedMs}ms: ${result.matchedLine}${tail}`,
            summary: `Ready after ${(result.waitedMs / 1000).toFixed(1)}s`,
          };
        }
        if (result.outcome === "exited") {
          return {
            // Not an error: finding out it died IS the answer, and it is
            // usually the thing worth knowing.
            ok: true,
            content:
              `The process exited after ${result.waitedMs}ms without ` +
              `printing that.${tail}`,
            summary: "Process exited while waiting",
          };
        }
        return {
          ok: false,
          content:
            `Timed out after ${result.waitedMs}ms. The process is still ` +
            `running but has not printed that yet.${tail}`,
          summary: "Timed out waiting",
        };
      }

      case "browse": {
        let actions;
        try {
          actions = validateActions(args.actions);
        } catch (error) {
          return {
            ok: false,
            content: `Error: ${
              error instanceof Error ? error.message : "invalid actions"
            }`,
            summary: "Invalid browser actions",
          };
        }

        const dir = workspaceDirectory(workspaceId);
        let session;
        try {
          session = await launchBrowser(dir);
        } catch (error) {
          return {
            ok: false,
            content: `Error: ${
              error instanceof Error ? error.message : "browser unavailable"
            }`,
            summary: "Browser not available",
          };
        }

        const result = await runSession(
          session.driver,
          actions,
          async (name, data) => {
            const rel = `${SCREENSHOT_DIR}/${name}`;
            await writeFileBytes(workspaceId, rel, data);
            return rel;
          },
          { console: session.console, failedRequests: session.failedRequests }
        );

        const failed = result.results.filter((r) => !r.ok).length;
        return {
          // A step that failed is still a useful answer: the model asked what
          // the page does and found out. Only an unusable session is an error.
          ok: result.results.some((r) => r.ok),
          content: formatSession(result),
          summary: failed
            ? `Browsed with ${failed} step(s) failing`
            : `Browsed ${result.title || "page"}`,
        };
      }

      case "run_tests": {
        const dir = workspaceDirectory(workspaceId);
        const runner = await detectRunner(dir);
        if (!runner) {
          return {
            ok: false,
            content:
              "Error: no test suite found. Looked for a package.json test " +
              "script, pytest config, a tests/ directory, Cargo.toml and " +
              "go.mod. If tests live somewhere unusual, run them with " +
              "run_command instead.",
            summary: "No test suite found",
          };
        }

        const filter = typeof args.filter === "string" ? args.filter.trim() : "";
        const runArgs = filter ? [...runner.args, filter] : runner.args;

        const run = await runCommand(workspaceId, runner.command, runArgs);
        const summary = parseTestOutput(
          runner.name,
          run.stdout,
          run.stderr,
          run.exitCode ?? 1
        );
        const raw = `${run.stdout}\n${run.stderr}`;

        return {
          // A failing suite is a successful TOOL call: the agent asked what
          // the state was and got a true answer. Marking it failed would put
          // it in the error path and invite a retry of the same command.
          ok: true,
          content: formatTestSummary(summary, raw),
          summary: summary.unparsed
            ? `Ran ${runner.name} — output not recognised`
            : summary.ok
              ? `All ${summary.passed} tests passed`
              : `${summary.failed} failed, ${summary.passed} passed`,
        };
      }

      case "build_project": {
        let plan;
        try {
          plan = await detectBuild(workspaceId, {
            config: args.config === "Debug" ? "Debug" : "Release",
            platform: typeof args.platform === "string" ? args.platform : undefined,
            restore: typeof args.restore === "boolean" ? args.restore : undefined,
            extraArgs: Array.isArray(args.extra_args)
              ? args.extra_args.map((a) => String(a))
              : undefined,
            dryRun: args.dry_run === true,
          });
        } catch (error) {
          return {
            ok: false,
            content:
              error instanceof BuildError
                ? error.message
                : `Could not determine how to build: ${
                    error instanceof Error ? error.message : "unknown error"
                  }`,
            summary: "No buildable project found",
          };
        }

        const { runner, restore, target } = plan;
        const argv = [runner.command, ...runner.args].join(" ");

        if (args.dry_run === true) {
          return {
            ok: true,
            content:
              `Would build ${target.path || "the workspace"} using ` +
              `${runner.name}.\n\nCommand: ${argv}\n\nReason: ${runner.reason}` +
              (restore
                ? `\n\nRestore first: ${[restore.command, ...restore.args].join(" ")}`
                : ""),
            summary: `Build plan: ${runner.name}`,
          };
        }

        // Run restore first when separate (NuGet restore for MSBuild).
        const logs: string[] = [];
        if (restore) {
          const r = await runCommand(
            workspaceId,
            restore.command,
            restore.args,
            context.signal,
            // Restore can take a while on first run.
            10 * 60 * 1000
          );
          logs.push(
            `$ ${[restore.command, ...restore.args].join(" ")}` +
              `\n[exit ${r.exitCode ?? "?"}${r.timedOut ? ", timed out" : ""}]\n` +
              `${r.stdout}\n${r.stderr}`
          );
          if (r.exitCode !== 0) {
            return {
              ok: false,
              content:
                `Dependency restore failed (exit ${r.exitCode ?? "?"}) ` +
                `before the build:\n\n${logs[0]}\n\nFix the error above and rebuild.`,
              summary: "Restore failed",
            };
          }
        }

        const run = await runCommand(
          workspaceId,
          runner.command,
          runner.args,
          context.signal,
          // Compiles can run long; no artificial cap here — the signal
          // (Stop) is the only abort.
          null
        );

        const combined =
          (restore ? logs.join("\n\n") + "\n\n" : "") +
          `$ ${argv}\n[exit ${run.exitCode ?? "?"}${
            run.timedOut ? ", timed out" : ""
          }]\n${run.stdout}\n${run.stderr}`;

        return {
          // A failed compile is a successful tool CALL (we asked to build
          // and got the true result), same as run_tests: marking ok:false
          // would route it through the error path and invite a blind retry.
          ok: true,
          content:
            (run.exitCode === 0
              ? `Build succeeded: ${runner.name}.\n\n`
              : `Build FAILED (exit ${run.exitCode ?? "?"}). ` +
                `Read the compiler errors below, fix them in the source, ` +
                `and call build_project again.\n\n`) +
            `Target: ${target.path || "(workspace)"}\n` +
            `Command: ${argv}\n\n${combined}`.slice(0, 60_000),
          summary:
            run.exitCode === 0
              ? `Built ${target.path || "workspace"} (${runner.name})`
              : `Build failed: ${runner.name}`,
          changedPath: "build",
        };
      }

      case "apply_patch": {
        const relative = str(args, "path");
        const patch = str(args, "patch");

        const existing = await readFile(workspaceId, relative, {
          maxChars: limits.readChars,
        });
        let applied;
        try {
          applied = applyPatch(existing.content, patch);
        } catch (error) {
          return {
            ok: false,
            content: `Error: ${
              error instanceof Error ? error.message : "could not apply patch"
            }`,
            summary: `Patch did not apply to ${relative}`,
          };
        }

        await writeFile(workspaceId, relative, applied.content);
        return {
          ok: true,
          content:
            `Applied ${applied.hunksApplied} hunk` +
            `${applied.hunksApplied === 1 ? "" : "s"} to ${relative}.`,
          summary: `Patched ${relative}`,
          changedPath: relative,
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
        const doc = await readDocument(kind, bytes, { maxChars: limits.docChars });
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

      case "inspect_binary": {
        const target = str(args, "path");
        const allowed = new Set([
          "summary",
          "strings",
          "entropy",
          "carve",
          "dependencies",
          "capa",
          "decompile",
        ]);
        const requested = new Set<string>();
        if (Array.isArray(args.analyses)) {
          for (const value of args.analyses) {
            const layer = String(value).toLowerCase();
            if (layer === "all") {
              for (const name of allowed) requested.add(name);
            } else if (allowed.has(layer)) requested.add(layer);
          }
        }
        // Cheap and useful rather than "everything" when the model omitted a
        // choice. The schema/prompt teaches it to select based on user intent.
        if (requested.size === 0) requested.add("summary");

        const explicitAnalyses = Array.isArray(args.analyses);
        if (args.artifacts === true && !explicitAnalyses) {
          requested.add("summary");
          requested.add("strings");
          requested.add("entropy");
          requested.add("carve");
        }
        const artifactLayers = {
          summary: requested.has("summary"),
          strings: requested.has("strings"),
          entropy: requested.has("entropy"),
          carve: requested.has("carve"),
        };
        const artifactsEnabled =
          args.artifacts !== false && Object.values(artifactLayers).some(Boolean);
        const runCapa =
          typeof args.run_capa === "boolean"
            ? args.run_capa
            : requested.has("capa");
        const runDeep =
          typeof args.deep === "boolean"
            ? args.deep
            : requested.has("decompile");
        const inspectDependencies =
          typeof args.dependencies === "boolean"
            ? args.dependencies
            : requested.has("dependencies");
        const includeSelectedStrings =
          typeof args.include_strings === "boolean"
            ? args.include_strings
            : requested.has("strings") || requested.has("summary");
        const focusTerms = Array.isArray(args.focus_terms)
          ? args.focus_terms.map((term) => String(term))
          : [];
        const analyzerPreset: "fast" | "full" =
          args.analyzer_preset === "full" ? "full" : "fast";
        const analyzers = {
          preset: analyzerPreset,
          ...(Array.isArray(args.disable_analyzers)
            ? { disable: args.disable_analyzers.map((a) => String(a)) }
            : {}),
          ...(Array.isArray(args.enable_analyzers)
            ? { enable: args.enable_analyzers.map((a) => String(a)) }
            : {}),
        };
        const result = await inspectWorkspaceBinary(workspaceId, target, {
          artifacts: artifactsEnabled,
          artifactLayers,
          runCapa,
          deep: runDeep,
          forceDeep: args.force_decompile === true,
          focusTerms,
          focusedOnly: args.focused_only !== false,
          allowFullFallback: args.allow_full_fallback === true,
          analyzers,
          signal: context.signal,
          dependencies: inspectDependencies,
          maxDepth: num(args, "max_depth") ?? undefined,
          includeStrings: includeSelectedStrings,
          stringFilter:
            typeof args.string_filter === "string"
              ? args.string_filter
              : undefined,
          minStringLength: num(args, "min_string_length") ?? undefined,
          maxStrings: num(args, "max_strings") ?? undefined,
        });
        const p = result.inspection;
        const generated =
          result.artifacts.outputs.length +
          result.deep.outputs.length +
          (result.capa.output ? 1 : 0);
        return {
          ok: true,
          content: formatBinaryInspection(result),
          summary:
            `Inspected ${target} — ${p.architecture}, ` +
            `${p.imports.length} libraries, ${p.exports.length} exports, ` +
            `packing ${p.packing.status}` +
            (generated
              ? `, ${generated} analysis artifact${generated === 1 ? "" : "s"}`
              : ""),
          changedPath: result.artifacts.root ||
            result.deep.outputs[0]?.split("/").slice(0, 2).join("/"),
        };
      }

      case "note_binary": {
        const notePath = str(args, "path");
        const noteText = str(args, "note");
        if (!notePath || !noteText) {
          return {
            ok: false,
            content: "note_binary requires path and note.",
            summary: "Missing path or note",
          };
        }
        const sha = str(args, "sha256");
        const wrote = await noteBinaryInspection(workspaceId, {
          path: notePath,
          note: noteText,
          ...(sha ? { sha256: sha } : {}),
        });
        return {
          ok: wrote.updated > 0,
          content:
            wrote.updated > 0
              ? `Verdict saved for ${notePath}. It will be shown in this workspace's binary analysis record on every later turn, so you will not need to re-inspect it to remember what you concluded.`
              : `Could not save a verdict for ${notePath}.`,
          summary: wrote.updated > 0 ? `Noted: ${notePath}` : "Note not saved",
        };
      }

      case "note_finding": {
        const claim = str(args, "claim");
        if (!claim) {
          return {
            ok: false,
            content: "note_finding requires a claim (the conclusion).",
            summary: "Missing claim",
          };
        }
        const id = str(args, "id");
        const status = str(args, "status");
        if (id && status === "disproved") {
          const reason = str(args, "evidence") || "Corrected by later analysis.";
          const revised = await reviseFinding(
            workspaceId,
            { id, reason, status: "disproved" },
            {
              claim,
              refs: Array.isArray(args.refs)
                ? args.refs.map((r) => String(r))
                : undefined,
              evidence: reason,
            }
          );
          return {
            ok: revised.updated,
            content: revised.updated
              ? `Finding ${id} marked disproved and replaced with the corrected conclusion. It will no longer steer later turns.`
              : `No active finding with id ${id} was found to revise.`,
            summary: revised.updated ? "Finding corrected" : "Finding not found",
          };
        }
        const refs = Array.isArray(args.refs)
          ? args.refs.map((r) => String(r))
          : [];
        const evidence = str(args, "evidence");
        const finding = await addFinding(workspaceId, {
          claim,
          refs,
          evidence,
        });
        return {
          ok: true,
          content: `Finding recorded [${finding.id}]. It will be shown on every later turn in this workspace so you do not re-derive it. If it turns out wrong, note_finding again with id=${finding.id} and status='disproved'.`,
          summary: "Finding recorded",
        };
      }

      case "list_processes": {
        const running = listProcesses(workspaceId);
        const leftovers = listLeftoverDecompilers();
        if (running.length === 0 && leftovers.length === 0) {
          return {
            ok: true,
            content: "No background processes are running in this workspace.",
            summary: "No processes",
          };
        }
        /*
         * describeProcess already returns "id: command — status".
         *
         * This wrapped it in the id AGAIN and the status AGAIN, so one process
         * read:
         *
         *   proc-1-abc — proc-1-abc: node slowsrv.js — running (4s) — running
         *
         * Every duplicated word is resent on every later round, and the model
         * has to work out that the two "running"s are one fact. Found by
         * reading the output while testing wait_for_output.
         */
        const listing = running.map((proc) => describeProcess(proc)).join("\n");
        const leftoverLines = leftovers
          .filter((item) => !running.some((proc) => proc.id === item.id))
          .map((item) => `${item.id}: ${item.display} — leftover (stop_process id=leftover)`);
        const lines = [listing, ...leftoverLines].filter(Boolean).join("\n");
        const total = running.length + leftoverLines.length;
        return {
          ok: true,
          content: `${total} process(es):\n${lines}`,
          summary: `Listed ${total} process(es)`,
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
        const batch = raw.slice(0, limits.writeFiles);
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
              `${limits.writeFiles} per call. Call again with the rest.]`
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
