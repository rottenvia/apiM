import type { NextConfig } from "next";
import path from "node:path";
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
  serverExternalPackages: ["pdfjs-dist"],

  // Hide the floating Next.js dev-tools badge (the small "N" circle in the
  // bottom-left corner during `next dev`). It never ships in production
  // builds, but it overlaps the sidebar's Settings button, so switch it off.
  devIndicators: false,

  turbopack: {
    root: projectRoot,
  },
};

export default nextConfig;
