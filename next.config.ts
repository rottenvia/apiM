import type { NextConfig } from "next";
import path from "node:path";
import fsSync from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Pin the project root to this file's own directory.
 *
 * Next infers the root by walking up for lockfiles, and picks the highest one
 * it finds. A stray package-lock.json in a parent folder — or a second clone
 * nested inside the first — makes it choose somewhere above the project, and
 * then nothing resolves: `@/lib/auth` and `tailwindcss` are both looked up
 * relative to a directory with no node_modules in it.
 *
 * Derived from import.meta.url rather than process.cwd() so it is the
 * directory containing this config, whatever directory the command was run
 * from. An earlier attempt used process.cwd() and aborted `next dev` on
 * Windows with "VirtualAlloc failed", because with a misinferred root it was
 * pointed at a whole user profile and tried to scan it.
 */
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * The Turbopack root must contain both the source and the dependencies.
 *
 * Pinning it to the project was the right call against misinference: Next
 * walks up for lockfiles and picks the highest one, so a stray lockfile above
 * the project made it choose somewhere above and then nothing resolved.
 *
 * But when this checkout is a copy living inside another clone's data
 * directory — which is how the agent harness runs it — the copy has no
 * node_modules of its own: `next` resolves from the ancestor install. Two
 * fixes fail here: pinning the root to the copy puts that install outside
 * the boundary ("We couldn't find the Next.js package … from the project
 * directory", right after "✓ Ready"), and junctioning the ancestor's
 * node_modules into the copy makes Turbopack abort outright ("Symlink
 * [project]/node_modules is invalid, it points out of the filesystem root").
 *
 * So the root is the nearest directory at or above the project that actually
 * holds node_modules/next: the project itself for a normal clone (unchanged
 * behaviour), the outer clone for a nested copy — whose source and deps are
 * then both inside the boundary.
 */
function findTurbopackRoot(): string {
  let dir = projectRoot;
  for (let hop = 0; hop < 10; hop++) {
    if (fsSync.existsSync(path.join(dir, "node_modules", "next"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return projectRoot;
    dir = parent;
  }
  return projectRoot;
}

const turbopackRoot = findTurbopackRoot();

const nextConfig: NextConfig = {
  /*
   * Keep pdf.js and its worker together in node_modules.
   *
   * Bundling the main module into `.next/server/chunks` changed the base URL
   * of pdf.js's relative `./pdf.worker.mjs` import. The worker itself was not
   * emitted beside that chunk, so read_document failed only through Next dev
   * with "Cannot find module .next/dev/server/chunks/pdf.worker.mjs" while
   * direct tests passed. The read_document tool parses on the server, so keep
   * that server import at its physical package location; browser attachments
   * still use the ordinary client bundle.
   */
  serverExternalPackages: ["pdfjs-dist", "tesseract.js"],

  // Hide the floating Next.js dev-tools badge (the small "N" circle in the
  // bottom-left corner during `next dev`). It never ships in production
  // builds, but it overlaps the sidebar's Settings button, so switch it off.
  devIndicators: false,

  // Next 16 blocks dev resources (/_next/webpack-hmr, stack-frame requests)
  // from hosts it doesn't trust — default is localhost only. The render bench
  // and any human opening the app via 127.0.0.1 got 403s on every dev asset,
  // which killed HMR and hydration. Next's own warning prescribes this entry.
  // Dev-only: no effect on production builds.
  allowedDevOrigins: ["127.0.0.1"],

  turbopack: {
    root: turbopackRoot,
  },

  // proxy.ts clones every request body. The default 10MB cap silently
  // truncated a 37MB client.dll even after /binary-raw stopped 404ing.
  experimental: {
    proxyClientMaxBodySize: "256mb",
  },

  // Composer posts huge DLLs to /binary-raw. The custom server handles that
  // path itself; under `next dev` this rewrite keeps the request from 404ing.
  async rewrites() {
    return [
      {
        source: "/api/workspace/:id/binary-raw",
        destination: "/api/workspace/:id/binary",
      },
    ];
  },
};

export default nextConfig;
