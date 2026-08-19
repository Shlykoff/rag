import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */

  // Next.js 16's `next dev`/`next build` otherwise auto-appends a managed
  // "<!-- BEGIN:nextjs-agent-rules -->" block to CLAUDE.md on every run
  // (node_modules/next/dist/server/lib/generate-agent-files.js). CLAUDE.md
  // here is this project's own hand-maintained spec file, not a
  // Next.js-generated one -- disable the feature instead of hand-reverting
  // the diff after every dev/build run.
  agentRules: false,
};

export default nextConfig;
