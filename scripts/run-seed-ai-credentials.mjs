// scripts/run-seed-ai-credentials.mjs
//
// Tiny bootstrapper for `npm run seed:ai-keys`. The actual seeding logic
// lives in scripts/seed-ai-credentials.ts (real TypeScript, reusing
// lib/ai/crypto.ts and lib/ai/credentials.ts exactly like the rest of the
// app does -- no separate/duplicated encryption logic for the seed path).
// This file only exists to work around two resolution problems plain
// `node scripts/seed-ai-credentials.ts` runs into on its own:
//
//   1. Node's native TypeScript support (type-stripping, default-on since
//      Node 22.18-ish) only ERASES type syntax -- it does not bundle or
//      resolve modules, so it requires an explicit file extension on every
//      relative import. This project's lib/ code deliberately uses
//      extensionless imports everywhere (the convention every bundler this
//      project actually ships with -- Next.js/webpack, Vitest/esbuild --
//      already resolves for it), so the moment seed-ai-credentials.ts pulls
//      in lib/ai/credentials.ts (which itself does `from "./crypto"`,
//      extensionless), plain native-node ESM fails with
//      ERR_MODULE_NOT_FOUND -- long before the seeding logic itself runs.
//      Rewriting lib/ai/*.ts to use explicit extensions just for this one
//      script would be a real style deviation from the rest of the
//      codebase, not a fix.
//   2. lib/ai/crypto.ts and lib/ai/credentials.ts both `import "server-only"`
//      (CLAUDE.md convention for every module touching a secret) -- which
//      unconditionally throws when resolved via its plain "default" export
//      condition (see node_modules/server-only/index.js). Vitest's own
//      configs (vitest.config.mts / vitest.integration.config.mts) dodge
//      this with an esbuild `resolve.alias` pointing "server-only" at its
//      own empty.js escape hatch (the same one the package ships for React
//      Server Components); this script needs the equivalent for a plain
//      Node run outside any bundler.
//
// esbuild (already present in node_modules as a transitive dependency of
// this project's existing tooling -- not a new dependency added just for
// this script) solves both at once: it bundles seed-ai-credentials.ts and
// every lib/ file it imports into one self-contained CommonJS file (so
// extensionless imports resolve exactly like they do everywhere else in
// this project, via real bundler resolution, not native-ESM's strict
// extension requirement), with the same "server-only" -> empty.js alias
// Vitest already relies on. Real npm dependencies (@supabase/supabase-js,
// etc.) are left as real `require()`s (`packages: "external"`), not
// bundled. The bundle is written next to this file, run, then deleted
// (in a `finally`, so it's cleaned up even if the seed script itself
// fails) -- see .gitignore's `scripts/*.bundle.cjs` entry for the case
// where the process is killed before that finally block runs.

import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(__dirname, "seed-ai-credentials.ts");
const outfile = path.join(__dirname, "seed-ai-credentials.bundle.cjs");

// "server-only"'s package.json only exposes its throwing index.js under the
// "default" export condition (its non-throwing empty.js is gated behind a
// "react-server" condition Next.js sets, but nothing else does) -- so
// require.resolve("server-only/empty.js") itself fails with
// ERR_PACKAGE_PATH_NOT_EXPORTED. Resolving the package's main entry first
// and deriving empty.js's path from its directory sidesteps that (this
// never executes index.js -- require.resolve() only resolves a path, it
// doesn't run the module).
const serverOnlyEmptyPath = path.join(path.dirname(require.resolve("server-only")), "empty.js");

buildSync({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  packages: "external",
  alias: { "server-only": serverOnlyEmptyPath },
  logLevel: "warning",
});

try {
  // Inherits process.env (including whatever `--env-file=.env.local`
  // already loaded into THIS process, since seed:ai-keys' npm script runs
  // `node --env-file=.env.local scripts/run-seed-ai-credentials.mjs`) --
  // child_process.spawnSync defaults `env` to `process.env` when not
  // overridden.
  const result = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(outfile, { force: true });
}
