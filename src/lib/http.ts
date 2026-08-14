/**
 * Talking to an API, rather than reading a page.
 *
 * `fetch_url` is built for documents: it GETs a URL and turns HTML into
 * readable prose. That is the wrong shape for an API. Testing an endpoint
 * needs a method, headers, a body, and — most of all — the status code and
 * the response headers, all of which `fetch_url` discards because a person
 * reading an article does not care about them.
 *
 * The alternative today is `run_command` with curl, which works and costs
 * more than it should: an approval prompt, a shell-quoting problem the model
 * gets wrong roughly one time in five, and output that has to be parsed back
 * out of terminal text.
 *
 * This is the direct route. The agent can now build something, call it, read
 * the status, and fix it — the same loop `run_tests` gives it for tests.
 *
 * Public URLs use the same SSRF boundary as fetch_url. Local development APIs
 * are a narrow opt-in: only localhost, 127.0.0.0/8 and ::1, never private LAN
 * ranges or cloud metadata. Every redirect is validated again before it is
 * followed, so a public URL cannot bounce around the guard.
 */

import { assertPublicUrl, WebError } from "@/lib/web";

/** Longer than a page fetch: an API doing real work can be slow. */
export const HTTP_TIMEOUT_MS = 30_000;
/** Response body kept, before truncation. */
export const MAX_BODY_CHARS = 100_000;

const METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/**
 * Headers the agent may not set.
 *
 * Not a security boundary — the agent could send these through curl anyway —
 * but a correctness one. Overriding Host or Content-Length produces requests
 * that fail in ways that look like a bug in the API being tested, which is
 * the most expensive kind of wrong answer.
 */
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
]);

export interface HttpResult {
  status: number;
  statusText: string;
  /** Response headers, lowercased. */
  headers: Record<string, string>;
  body: string;
  /** True when the body was cut at MAX_BODY_CHARS. */
  truncated: boolean;
  /** Round-trip time, which is often the thing being investigated. */
  ms: number;
  /** Set when the body parsed as JSON, so the model does not have to guess. */
  json?: unknown;
}

export async function httpRequest(options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Explicit opt-in for localhost/127.0.0.0/8/[::1] dev servers only. */
  allowLocal?: boolean;
}): Promise<HttpResult> {
  let url = assertPublicUrl(options.url, {
    allowLoopback: options.allowLocal === true,
  });

  let method = (options.method ?? "GET").toUpperCase();
  if (!METHODS.has(method)) {
    throw new WebError(
      `"${method}" is not a supported method. Use one of ${[...METHODS].join(", ")}.`
    );
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    const name = key.toLowerCase().trim();
    if (!name || FORBIDDEN_HEADERS.has(name)) continue;
    headers[name] = String(value);
  }

  // A JSON body with no content type is the single most common way an API
  // call fails for a reason unrelated to the API.
  if (options.body && !headers["content-type"]) {
    const trimmed = options.body.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      headers["content-type"] = "application/json";
    }
  }

  if (!headers["user-agent"]) headers["user-agent"] = "apiM-agent/1.0";

  const started = Date.now();
  let res: Response;
  let requestBody = options.body;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)])
    : AbortSignal.timeout(HTTP_TIMEOUT_MS);

  try {
    /*
     * Follow redirects ourselves and re-check every destination.
     *
     * Native `redirect: "follow"` validates only the URL we started with. A
     * public endpoint could redirect to 169.254.169.254 or a private service
     * and cross the boundary after the guard had already passed. Local mode
     * makes this especially important: it opts into loopback, not the whole
     * private network.
     */
    for (let redirects = 0; ; redirects += 1) {
      res = await fetch(url, {
        method,
        headers,
        // GET and HEAD cannot carry one, and sending it is a TypeError.
        body: method === "GET" || method === "HEAD" ? undefined : requestBody,
        redirect: "manual",
        signal,
      });

      const location = res.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(res.status) || !location) break;
      if (redirects >= 5) throw new WebError("Too many redirects (more than 5).");

      url = assertPublicUrl(new URL(location, url).toString(), {
        allowLoopback: options.allowLocal === true,
      });

      // Match normal browser/fetch semantics: 303, and POST on 301/302,
      // becomes GET. 307/308 deliberately preserve method and body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        requestBody = undefined;
        delete headers["content-type"];
      }
    }
  } catch (error) {
    if (error instanceof WebError) throw error;
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new WebError(
        `${url.hostname} did not respond within ${HTTP_TIMEOUT_MS / 1000} seconds.`
      );
    }
    throw new WebError(
      `Could not reach ${url.hostname}: ${
        error instanceof Error ? error.message : "network error"
      }`
    );
  }

  const ms = Date.now() - started;

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });

  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "[response body could not be read]";
  }

  const truncated = text.length > MAX_BODY_CHARS;
  const body = truncated ? text.slice(0, MAX_BODY_CHARS) : text;

  const result: HttpResult = {
    status: res.status,
    statusText: res.statusText,
    headers: responseHeaders,
    body,
    truncated,
    ms,
  };

  // Parsed once here rather than by the model reading it back out of a
  // string. Only when it is complete — parsing a truncated body yields
  // nothing useful and would throw.
  if (!truncated && /json/i.test(responseHeaders["content-type"] ?? "")) {
    try {
      result.json = JSON.parse(text);
    } catch {
      /* a content-type that lies is the API's problem, not an error here */
    }
  }

  return result;
}

/**
 * Render a response for the model.
 *
 * Status first, because it is the answer to "did this work". Then the headers
 * that actually matter — the full set is mostly caching and CDN noise that
 * would bury the two useful lines.
 */
const INTERESTING_HEADERS = [
  "content-type",
  "location",
  "www-authenticate",
  "retry-after",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
];

export function formatHttpResult(result: HttpResult): string {
  const lines = [
    `${result.status} ${result.statusText} (${result.ms}ms)`,
  ];

  const shown = INTERESTING_HEADERS.filter((h) => result.headers[h]);
  if (shown.length) {
    for (const h of shown) lines.push(`${h}: ${result.headers[h]}`);
  }

  lines.push("");

  if (!result.body.trim()) {
    lines.push("[empty response body]");
  } else if (result.json !== undefined) {
    // Re-serialised with indentation: an API that returns minified JSON is
    // otherwise one unreadable line.
    lines.push(JSON.stringify(result.json, null, 2).slice(0, MAX_BODY_CHARS));
  } else {
    lines.push(result.body);
  }

  if (result.truncated) {
    lines.push("", "[body truncated — it was larger than the limit]");
  }

  return lines.join("\n");
}
