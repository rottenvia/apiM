import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the floating Next.js dev-tools badge (the small "N" circle in the
  // bottom-left corner during `next dev`). It never ships in production
  // builds, but it overlaps the sidebar's Settings button, so switch it off.
  devIndicators: false,
};

// Nothing here excludes ./data from the bundler, and nothing needs to.
//
// A Python virtualenv contains an absolute symlink to the system interpreter,
// which Turbopack reads as escaping the project root, and it panics rather
// than skipping it. The cause was that literal `path.join("data", ...)` calls
// in workspace.ts and runner.ts were resolved at build time and registered as
// directory dependencies; assembling those paths so static analysis cannot
// follow them fixes it at the source.
//
// `turbopack: { root }` and `outputFileTracingExcludes` were tried as well and
// are deliberately absent: they were redundant once the paths were fixed, and
// setting a turbopack root made `next dev` abort on Windows with
// "VirtualAlloc failed" before it could serve anything.

export default nextConfig;
