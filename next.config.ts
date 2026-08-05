import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the floating Next.js dev-tools badge (the small "N" circle in the
  // bottom-left corner during `next dev`). It never ships in production
  // builds, but it overlaps the sidebar's Settings button, so switch it off.
  devIndicators: false,

  // Keep the bundler out of ./data.
  //
  // Nothing there is imported — it is chat history and workspaces — but the
  // tracer still walks it, and a Python virtualenv contains absolute symlinks
  // to the system interpreter. Turbopack treats those as pointing outside the
  // project root and panics, so building would fail purely because the user
  // had installed a package.
  outputFileTracingExcludes: {
    "*": ["./data/**"],
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
