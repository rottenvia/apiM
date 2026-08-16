/**
 * Letting the agent look at a page, not just read about one.
 *
 * Until now the only route to the outside world was web search, which returns
 * articles *about* a site. Asked to inject an overlay into a Faceit match
 * page, the model had never seen that page: it could not know whether the
 * scoreboard is `.match-header__score` or something else entirely, so it
 * wrote a plausible generic overlay that hooked into nothing. That is not a
 * reasoning failure — no model can guess a DOM it has never been shown.
 *
 * This fetches the page itself. The HTML is what matters for that job, so
 * both raw HTML and a readable text rendering are available; the model picks
 * depending on whether it needs structure or prose.
 */

/** Enough for a large page, short of pulling a whole app bundle into context. */
export const MAX_FETCH_BYTES = 5 * 1024 * 1024;
/**
 * What reaches the model after extraction.
 *
 * This was 200_000 chars (~55k tokens). A fetched page is resent on every
 * later agent round, and `pruneTranscript` keeps the most recent results
 * verbatim, so one big fetch could dominate the whole request and push it
 * toward the model's context limit. 80_000 chars (~22k tokens) still covers
 * an ordinary article or API response; for anything larger the tool already
 * supports `find` to extract just the matching passages, and `browse` renders
 * JS apps. The truncation note tells the model which to use.
 */
export const MAX_FETCH_CHARS = 80_000;
/** A page that has not responded by now is not going to be useful. */
export const FETCH_TIMEOUT_MS = 25_000;

/**
 * A browser's user agent, deliberately.
 *
 * Most sites serve a stripped page, a consent wall, or a 403 to anything that
 * announces itself as a script. The point of this tool is to see what the
 * user sees, so it asks for the same thing their browser would.
 */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class WebError extends Error {}

/**
 * Reject anything that is not a public http(s) address.
 *
 * The agent chooses these URLs, so this is the boundary between "read a web
 * page" and "read whatever is reachable from the machine this runs on". A
 * link to 169.254.169.254 or localhost:3000 would otherwise let a page the
 * model was told to visit pull internal services or cloud credentials.
 */
export interface UrlPolicy {
  /** Allow only loopback hosts, for explicitly requested local API testing. */
  allowLoopback?: boolean;
}

/** Loopback only — never private LAN ranges or cloud metadata. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  ) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return Boolean(v4 && Number(v4[1]) === 127);
}

export function assertPublicUrl(raw: string, policy: UrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebError(`Not a valid URL: ${raw}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebError(
      `Only http and https are supported, not "${url.protocol}".`
    );
  }

  const host = url.hostname.toLowerCase();

  // Loopback is available only to http_request's explicit local-dev mode.
  // fetch_url, inspect_page, download_file and browse remain public-web-only.
  if (isLoopbackHost(host)) {
    if (policy.allowLoopback) return url;
    throw new WebError(
      "That address is on this machine, not the public web. " +
        "For a local development API, use http_request with allow_local=true."
    );
  }

  // Names that may resolve inside the local network are never opted in.
  if (
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new WebError(
      "That address is on this machine or its private network, which this tool will not fetch."
    );
  }

  // Private IPv4 ranges, plus the cloud metadata endpoint specifically.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const isPrivate =
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0;
    if (isPrivate) {
      throw new WebError(
        "That is a private network address, which this tool will not fetch."
      );
    }
  }

  // IPv6 private/loopback prefixes.
  if (host.startsWith("[fc") || host.startsWith("[fd") || host.startsWith("[fe80")) {
    throw new WebError(
      "That is a private network address, which this tool will not fetch."
    );
  }

  return url;
}

/** Strip the parts of a document that are never worth reading. */
function stripNoise(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/**
 * Turn a document into something readable.
 *
 * Not a full parser on purpose: pulling in a DOM library to read text is
 * weight this does not need, and the model is perfectly able to work with
 * slightly rough text. Block elements become newlines so paragraphs and list
 * items stay separated rather than running together into one line.
 */
export function htmlToText(html: string): string {
  return stripNoise(html)
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The document title, when there is one. */
export function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? htmlToText(match[1]).slice(0, 200) : "";
}

export interface DownloadedResource {
  url: string;
  status: number;
  contentType: string;
  data: Uint8Array;
}

/** Binary downloads may be larger than text handed to the model, but bounded. */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Download bytes without trying to interpret them as a web page.
 *
 * fetchPage deliberately rejects images, PDFs and archives because decoding
 * them as UTF-8 is useless. download_file has the opposite job: preserve the
 * bytes so read_document/view_image can consume them afterwards.
 */
export async function downloadResource(
  rawUrl: string,
  options: { signal?: AbortSignal; allowLocal?: boolean } = {}
): Promise<DownloadedResource> {
  let url = assertPublicUrl(rawUrl, {
    allowLoopback: options.allowLocal === true,
  });
  const requestSignal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
    : AbortSignal.timeout(FETCH_TIMEOUT_MS);

  let response: Response;
  for (let redirects = 0; ; redirects += 1) {
    response = await fetch(url, {
      redirect: "manual",
      signal: requestSignal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "*/*",
      },
    });

    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
    if (redirects >= 5) throw new WebError("Too many redirects (more than 5).");
    // Re-check every hop. Local mode permits loopback only; neither mode may
    // redirect into cloud metadata or a private-LAN service.
    url = assertPublicUrl(new URL(location, url).toString(), {
      allowLoopback: options.allowLocal === true,
    });
  }

  if (!response.ok) {
    throw new WebError(
      `Download failed: HTTP ${response.status} ${response.statusText || "Error"}.`
    );
  }

  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new WebError(
      `That file is ${(declared / 1024 / 1024).toFixed(1)}MB, over the ${
        MAX_DOWNLOAD_BYTES / 1024 / 1024
      }MB download limit.`
    );
  }

  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new WebError(
      `That file is ${(data.byteLength / 1024 / 1024).toFixed(1)}MB, over the ${
        MAX_DOWNLOAD_BYTES / 1024 / 1024
      }MB download limit.`
    );
  }

  return {
    url: response.url || url.toString(),
    status: response.status,
    contentType: (response.headers.get("content-type") ?? "unknown").split(";")[0],
    data,
  };
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  title: string;
  /** Readable text, or the raw body for non-HTML content. */
  text: string;
  /** Present only when `raw` was requested and the response was HTML. */
  html?: string;
  truncated: boolean;
  bytes: number;
  /**
   * True when the response is an app shell rather than a real page.
   *
   * Measured: for a React/Vue/Angular site the server sends `<div id="root">`
   * and nothing else, so this tool returns almost no text and no usable
   * selectors. Previously it reported that as a successful fetch of an
   * almost-empty page, and the model believed it — which is how the Faceit
   * overlay was written against selectors that did not exist.
   *
   * Detecting it and saying so turns a silent wrong answer into a signpost.
   */
  needsBrowser: boolean;
}

/**
 * Does this look like an app shell?
 *
 * Three signals together, because any one alone has false positives:
 *
 *   - very little visible text for the amount of HTML
 *   - a well-known empty mount point (#root, #app, #__next)
 *   - script tags present
 *
 * A short static page has little text but no mount point and few scripts. A
 * heavy article has scripts but plenty of text. Requiring the combination
 * keeps this quiet on the pages where fetch_url genuinely works.
 */
export function looksLikeAppShell(html: string, text: string): boolean {
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  if (scripts === 0) return false;

  const visible = text.replace(/\s+/g, " ").trim();
  const hasMount =
    /<div[^>]+id=["'](root|app|__next|__nuxt|main-app)["'][^>]*>\s*<\/div>/i.test(
      html
    ) || /<div[^>]+id=["'](root|app|__next)["'][^>]*\/?>\s*(<\/div>)?\s*<\/body>/i.test(html);

  // An empty mount point is close to conclusive on its own.
  if (hasMount && visible.length < 2_000) return true;

  // Otherwise: a lot of markup, almost no words.
  return html.length > 1_000 && visible.length < 200;
}

/**
 * Fetch one page.
 *
 * Redirects are followed, because a bare domain almost always redirects and
 * refusing to follow would make the tool useless on most real URLs.
 */
export async function fetchPage(
  rawUrl: string,
  options: { raw?: boolean; signal?: AbortSignal } = {}
): Promise<FetchedPage> {
  const url = assertPublicUrl(rawUrl);

  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
        : AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new WebError(`${url.hostname} did not respond within 25 seconds.`);
    }
    throw new WebError(
      `Could not reach ${url.hostname}: ${
        error instanceof Error ? error.message : "network error"
      }`
    );
  }

  const contentType = res.headers.get("content-type") ?? "";

  // Refuse binaries by content type before downloading the body — a video or
  // an installer would otherwise be pulled in full and then discarded.
  if (
    /^(image|video|audio)\//i.test(contentType) ||
    /application\/(zip|octet-stream|pdf|x-)/i.test(contentType)
  ) {
    throw new WebError(
      `That URL is ${contentType.split(";")[0]}, which this tool cannot read. ` +
        `It reads web pages and text.`
    );
  }

  const buffer = await res.arrayBuffer();
  const bytes = buffer.byteLength;
  if (bytes > MAX_FETCH_BYTES) {
    throw new WebError(
      `That page is ${(bytes / 1024 / 1024).toFixed(1)}MB, over the ${
        MAX_FETCH_BYTES / 1024 / 1024
      }MB limit.`
    );
  }

  const body = new TextDecoder("utf-8").decode(buffer);
  const isHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);

  const text = isHtml ? htmlToText(body) : body;
  const truncated = text.length > MAX_FETCH_CHARS;

  return {
    url: res.url || url.toString(),
    status: res.status,
    contentType: contentType.split(";")[0] || "unknown",
    title: isHtml ? extractTitle(body) : "",
    needsBrowser: isHtml ? looksLikeAppShell(body, text) : false,
    text: truncated ? text.slice(0, MAX_FETCH_CHARS) : text,
    html:
      options.raw && isHtml
        ? body.length > MAX_FETCH_CHARS
          ? body.slice(0, MAX_FETCH_CHARS)
          : body
        : undefined,
    truncated,
    bytes,
  };
}

/**
 * Pull the selectors out of a document.
 *
 * The reason this exists rather than leaving the model to read raw HTML: a
 * real page is mostly markup, and 200k characters of it is both expensive and
 * hard to reason over. What someone writing a userscript actually needs is
 * the list of ids and classes to hook into. This gives them that directly.
 */
export function extractSelectors(
  html: string,
  limit = 400
): { ids: string[]; classes: string[]; dataAttrs: string[] } {
  const clean = stripNoise(html);

  const ids = new Set<string>();
  // Requires whitespace before `id=`, so `data-match-id="..."` is not read as
  // an id — \b matches inside a hyphenated attribute name and captured it.
  for (const m of clean.matchAll(/\sid=["']([^"']+)["']/g)) {
    const value = m[1].trim();
    if (value) ids.add(value);
  }

  const classes = new Set<string>();
  for (const m of clean.matchAll(/\bclass=["']([^"']+)["']/g)) {
    for (const cls of m[1].split(/\s+/)) {
      // Utility soup and hashed build classes tell the model nothing about
      // the page's structure, and there are thousands of them.
      if (cls && cls.length > 2 && cls.length < 60) classes.add(cls);
    }
  }

  const dataAttrs = new Set<string>();
  for (const m of clean.matchAll(/\b(data-[a-z0-9-]+)=/gi)) {
    dataAttrs.add(m[1].toLowerCase());
  }

  return {
    ids: [...ids].slice(0, limit),
    classes: [...classes].slice(0, limit),
    dataAttrs: [...dataAttrs].slice(0, limit),
  };
}
