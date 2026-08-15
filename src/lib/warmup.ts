/**
 * Compile the API routes before the user asks for them.
 *
 * Measured on a cold start: a route that touches the workspace module graph
 * takes ~760ms the first time it is hit and ~25ms every time after. That is
 * not the query being slow — it is the one-off cost of loading and compiling
 * the modules behind it, paid by whoever arrives first.
 *
 * Clicking a chat fires three of those at once, so the first click of a
 * session stalls while they all wait on the same compile, and every click
 * afterwards is instant. The work is unavoidable, but *when* it happens is
 * not: doing it during the seconds the page is first on screen moves it off
 * the critical path entirely.
 *
 * Deliberately fire-and-forget. Nothing waits on it, nothing reports it, and
 * a failure is silent — this must never be able to make the app slower or
 * noisier than not having it.
 */

/**
 * The routes a first chat click actually hits.
 *
 * Each route compiles separately, so warming a sibling does not help:
 * /api/conversations and /api/conversations/[id] are different entry points
 * and pay the cost independently. These are the three fired together the
 * moment a chat is opened.
 *
 * A workspace id is required to reach them. "__warmup__" is a valid id
 * shape that no chat uses, and every one of these handlers answers a missing
 * workspace with an empty result rather than an error — so this compiles the
 * route without creating anything on disk.
 */
const WARM_ID = "__warmup__";

const ROUTES = [
  `/api/conversations/${WARM_ID}`,
  `/api/workspace/${WARM_ID}`,
  `/api/workspace/${WARM_ID}/snapshots`,
] as const;

let started = false;

/**
 * Warm the routes once per page load.
 *
 * Runs after first paint so it competes with nothing the user can see, and
 * sequentially rather than in parallel — three concurrent cold compiles on a
 * single dev server contend with each other and with whatever the user does
 * next, which is the opposite of the point.
 */
export function warmRoutes(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  const run = async () => {
    for (const route of ROUTES) {
      try {
        await fetch(route, {
          method: "GET",
          // The response body is irrelevant; only the compile matters.
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        /* a cold cache is the status quo, not a failure */
      }
    }
  };

  // requestIdleCallback where available, so this yields to anything the user
  // is actually doing. Safari still lacks it, hence the timeout fallback.
  const idle = (
    window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
    }
  ).requestIdleCallback;

  if (typeof idle === "function") idle(() => void run(), { timeout: 2_000 });
  else setTimeout(() => void run(), 300);
}
