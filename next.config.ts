import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the floating Next.js dev-tools badge (the small "N" circle in the
  // bottom-left corner during `next dev`). It never ships in production
  // builds, but it overlaps the sidebar's Settings button, so switch it off.
  devIndicators: false,
};

export default nextConfig;
