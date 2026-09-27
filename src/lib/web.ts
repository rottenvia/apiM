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
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const MAX_FETCH_BYTES = 5 * 1024 * 1024;
/** What reaches the model after extraction. */
export const MAX_FETCH_CHARS = 200_000;
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

/* ------------------------------------------------------------------ *
 * Where an address actually points
 *
 * assertPublicUrl judged the URL as written. A security review found every
 * one of these passing it: http://[::ffff:127.0.0.1]:3000/ (IPv4-mapped
 * loopback — this app's own API), http://[::]:3000/, 127.0.0.1.nip.io (a
 * public NAME for loopback), [::ffff:a9fe:a9fe] (cloud metadata) and
 * 100.64.0.0/10. So literal addresses are classified after unwrapping the
 * IPv6 forms that embed an IPv4 one, and names are resolved before use.
 * ------------------------------------------------------------------ */

function v4Private(parts: number[]): boolean {
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && parts[2] === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Eight 16-bit groups of an IPv6 literal, or null. */
function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes two groups.
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const n = tail.slice(1).map(Number);
    if (n.some((x) => x > 255)) return null;
    text =
      text.slice(0, tail.index) +
      ((n[0] << 8) | n[1]).toString(16) + ":" + ((n[2] << 8) | n[3]).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array(fill).fill("0"), ...rest];
  if (all.length !== 8) return null;
  const groups = all.map((g) => parseInt(g, 16));
  return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True for any address that is not on the public internet. */
export function isNonPublicIp(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) return v4Private(v4.slice(1).map(Number));
  const g = v6Groups(ip);
  if (!g) return true; // unparseable: refuse rather than guess
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible)
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return v4Private(embedded(g[6], g[7]));
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4Private(embedded(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return v4Private(embedded(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

function isLoopbackIp(ip: string): boolean {
  const v4 = /^(\d{1,3})\./.exec(ip);
  if (v4) return Number(v4[1]) === 127;
  const g = v6Groups(ip);
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  return g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff && g[6] >> 8 === 127;
}

/**
 * Ports this app itself serves on. http_request's local mode exists for the
 * user's OWN dev servers; pointed at this app it would let text on a web
 * page drive the app's API (autoRunCommands and all). Filled from the Host
 * of incoming chat requests, plus PORT.
 */
const selfPorts = new Set<string>(process.env.PORT ? [process.env.PORT] : []);
export function rememberSelfHost(host: string | null | undefined): void {
  const port = /:(\d+)$/.exec(host ?? "")?.[1];
  if (port) selfPorts.add(port);
}

function refuseSelf(url: URL): void {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (selfPorts.has(port)) {
    throw new WebError(
      "That is this app's own server. Local mode is for your own dev servers, not the app's API."
    );
  }
}

/**
 * assertPublicUrl, then resolve the name and check where it really points.
 * Use this before every connection (and every redirect hop).
 */
export async function assertPublicUrlResolved(
  raw: string | URL,
  policy: UrlPolicy = {}
): Promise<URL> {
  const url = assertPublicUrl(String(raw), policy);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (policy.allowLoopback && isLoopbackHost(url.hostname)) {
    refuseSelf(url);
    return url;
  }
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new WebError(`Could not resolve ${host}.`);
    }
  }
  for (const address of addresses) {
    if (!isNonPublicIp(address)) continue;
    if (policy.allowLoopback && isLoopbackIp(address)) {
      refuseSelf(url);
      continue;
    }
    throw new WebError(
      `${host} points at ${address}, which is on this machine or a private network — this tool will not fetch it.`
    );
  }
  return url;
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

  // Every other literal, after unwrapping mapped/NAT64/6to4 forms.
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal) && isNonPublicIp(literal)) {
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

/**
 * Binary downloads may be larger than text handed to the model.
 *
 * This used to be 25MB, which was pointless: the agent can already download
 * anything of any size via `run_command` (curl/python), so the cap only made
 * the built-in tool refuse the legitimately large file - a game client.dll,
 * an installer, a dataset - and forced a slow shell round-trip. Set high
 * enough for real binaries, overridable for the self-hosted case. The hard
 * ceiling remains writeFileBytes' MAX_FILE_BYTES (512MB) and free disk space.
 */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES =
  Number(process.env.APIM_MAX_DOWNLOAD_MB) > 0
    ? Number(process.env.APIM_MAX_DOWNLOAD_MB) * 1024 * 1024
    : DEFAULT_MAX_DOWNLOAD_BYTES;

/** Enough for a large binary download; page fetches keep the shorter limit. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Download bytes without trying to interpret them as a web page.
 *
 * fetchPage deliberately rejects images, PDFs and archives because decoding
 * them as UTF-8 is useless. download_file has the opposite job: preserve the
 * bytes so read_document/view_image can consume them afterwards.
 */
export async function downloadResource(
  rawUrl: string,
  options: { signal?: AbortSignal; allowLocal?: boolean; maxBytes?: number } = {}
): Promise<DownloadedResource> {
  let url = await assertPublicUrlResolved(rawUrl, {
    allowLoopback: options.allowLocal === true,
  });
  const requestSignal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
    : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);

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
    url = await assertPublicUrlResolved(new URL(location, url).toString(), {
      allowLoopback: options.allowLocal === true,
    });
  }

  if (!response.ok) {
    throw new WebError(
      `Download failed: HTTP ${response.status} ${response.statusText || "Error"}.`
    );
  }

  const downloadCap = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > downloadCap) {
    throw new WebError(
      `That file is ${(declared / 1024 / 1024).toFixed(1)}MB, over the ${
        downloadCap / 1024 / 1024
      }MB download limit.`
    );
  }

  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > downloadCap) {
    throw new WebError(
      `That file is ${(data.byteLength / 1024 / 1024).toFixed(1)}MB, over the ${
        downloadCap / 1024 / 1024
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
  options: {
    raw?: boolean;
    signal?: AbortSignal;
    maxBytes?: number;
    maxChars?: number;
  } = {}
): Promise<FetchedPage> {
  let url = await assertPublicUrlResolved(rawUrl);

  let res: Response;
  try {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(FETCH_TIMEOUT_MS);
    // Redirects are followed by hand so every hop is checked: with
    // redirect "follow" only the first URL was, and a public page could
    // bounce the fetch into 169.254.169.254 or the LAN.
    for (let redirects = 0; ; redirects += 1) {
      res = await fetch(url, {
        redirect: "manual",
        signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      const location = res.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(res.status) || !location) break;
      if (redirects >= 5) throw new WebError("Too many redirects (more than 5).");
      url = await assertPublicUrlResolved(new URL(location, url).toString());
    }
  } catch (error) {
    if (error instanceof WebError) throw error;
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
  const byteCap = options.maxBytes ?? MAX_FETCH_BYTES;
  const charCap = options.maxChars ?? MAX_FETCH_CHARS;
  if (bytes > byteCap) {
    throw new WebError(
      `That page is ${(bytes / 1024 / 1024).toFixed(1)}MB, over the ${
        byteCap / 1024 / 1024
      }MB limit.`
    );
  }

  const body = new TextDecoder("utf-8").decode(buffer);
  const isHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);

  const text = isHtml ? htmlToText(body) : body;
  const truncated = text.length > charCap;

  return {
    url: res.url || url.toString(),
    status: res.status,
    contentType: contentType.split(";")[0] || "unknown",
    title: isHtml ? extractTitle(body) : "",
    needsBrowser: isHtml ? looksLikeAppShell(body, text) : false,
    text: truncated ? text.slice(0, charCap) : text,
    html:
      options.raw && isHtml
        ? body.length > charCap
          ? body.slice(0, charCap)
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
