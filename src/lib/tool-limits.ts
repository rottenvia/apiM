/**
 * Per-model tool ceilings.
 *
 * Default numbers exist so a runaway call cannot dump a whole project into
 * one DeepSeek round. Ox Alpha is opted out: the user asked for full
 * capabilities on that model only — read as much as it wants, no per-call
 * batch cap. Safety rails (path sandbox, private LAN, command approval)
 * are unchanged.
 */

import { getModel } from "@/lib/models";

export const DEFAULT_READ_FILES = 60;
export const DEFAULT_WRITE_FILES = 30;
export const DEFAULT_BATCH_EDITS = 40;
export const DEFAULT_READ_CHARS = 400_000;
export const DEFAULT_SEARCH_HITS = 60;
export const DEFAULT_SEARCHABLE_BYTES = 512 * 1024;
export const DEFAULT_FETCH_CHARS = 200_000;
export const DEFAULT_FETCH_BYTES = 5 * 1024 * 1024;
export const DEFAULT_DOC_CHARS = 800_000;
export const DEFAULT_SEARCH_RESULTS = 8;
export const DEFAULT_SEARCH_SNIPPET = 700;
export const DEFAULT_FETCH_FIND_MATCHES = 20;

/**
 * Open ceilings for Ox Alpha.
 *
 * Not literally infinite — a 2GB file would still OOM the process — but
 * high enough that an ordinary project, page or document is never cut.
 * The workspace file-size rail (512 MB) still applies.
 */
export const OPEN_READ_FILES = 10_000;
export const OPEN_WRITE_FILES = 10_000;
export const OPEN_BATCH_EDITS = 10_000;
export const OPEN_READ_CHARS = 8_000_000;
export const OPEN_SEARCH_HITS = 10_000;
export const OPEN_SEARCHABLE_BYTES = 32 * 1024 * 1024;
export const OPEN_FETCH_CHARS = 4_000_000;
export const OPEN_FETCH_BYTES = 32 * 1024 * 1024;
export const OPEN_DOC_CHARS = 8_000_000;
export const OPEN_SEARCH_RESULTS = 20;
export const OPEN_SEARCH_SNIPPET = 4_000;
export const OPEN_FETCH_FIND_MATCHES = 200;

export interface ToolLimits {
  readFiles: number;
  writeFiles: number;
  batchEdits: number;
  readChars: number;
  searchHits: number;
  searchableBytes: number;
  fetchChars: number;
  fetchBytes: number;
  docChars: number;
  searchResults: number;
  searchSnippet: number;
  fetchFindMatches: number;
  open: boolean;
}

export const DEFAULT_TOOL_LIMITS: ToolLimits = {
  readFiles: DEFAULT_READ_FILES,
  writeFiles: DEFAULT_WRITE_FILES,
  batchEdits: DEFAULT_BATCH_EDITS,
  readChars: DEFAULT_READ_CHARS,
  searchHits: DEFAULT_SEARCH_HITS,
  searchableBytes: DEFAULT_SEARCHABLE_BYTES,
  fetchChars: DEFAULT_FETCH_CHARS,
  fetchBytes: DEFAULT_FETCH_BYTES,
  docChars: DEFAULT_DOC_CHARS,
  searchResults: DEFAULT_SEARCH_RESULTS,
  searchSnippet: DEFAULT_SEARCH_SNIPPET,
  fetchFindMatches: DEFAULT_FETCH_FIND_MATCHES,
  open: false,
};

export const OPEN_TOOL_LIMITS: ToolLimits = {
  readFiles: OPEN_READ_FILES,
  writeFiles: OPEN_WRITE_FILES,
  batchEdits: OPEN_BATCH_EDITS,
  readChars: OPEN_READ_CHARS,
  searchHits: OPEN_SEARCH_HITS,
  searchableBytes: OPEN_SEARCHABLE_BYTES,
  fetchChars: OPEN_FETCH_CHARS,
  fetchBytes: OPEN_FETCH_BYTES,
  docChars: OPEN_DOC_CHARS,
  searchResults: OPEN_SEARCH_RESULTS,
  searchSnippet: OPEN_SEARCH_SNIPPET,
  fetchFindMatches: OPEN_FETCH_FIND_MATCHES,
  open: true,
};

/** Ox Alpha only. DeepSeek and Qwen keep the default ceilings. */
export function modelHasOpenToolLimits(
  id: string | null | undefined
): boolean {
  return getModel(id).openToolLimits === true;
}

export function toolLimitsFor(id: string | null | undefined): ToolLimits {
  return modelHasOpenToolLimits(id) ? OPEN_TOOL_LIMITS : DEFAULT_TOOL_LIMITS;
}
