// scripts/run-telegram-set-webhook.mjs
//
// Tiny bootstrapper for `npm run telegram:set-webhook`, mirroring
// scripts/run-seed-ai-credentials.mjs exactly (see that file's own header
// for the full explanation of why plain `node scripts/telegram-set-webhook.ts`
// can't run on its own: extensionless internal lib/ imports + neutralizing
// the `server-only` guard). The only difference from that script's
// bootstrapper is forwarding this process's own CLI args (--project/--token/--url)
// through to the bundled script, since telegram-set-webhook.ts is
// CLI-arg-driven rather than env-var-driven.

import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(__dirname, "telegram-set-webhook.ts");
const outfile = path.join(__dirname, "telegram-set-webhook.bundle.cjs");

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
  // Forward this process's own CLI args (everything after
  // `npm run telegram:set-webhook --`) to the bundled script, plus inherit
  // process.env (including whatever `--env-file=.env.local` already loaded
  // into THIS process) -- same as run-seed-ai-credentials.mjs.
  const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(outfile, { force: true });
}
