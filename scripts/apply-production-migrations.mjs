#!/usr/bin/env node
// Applies supabase/migrations/*.sql to the hosted production database as
// the LAST step of every Vercel build -- deliberately after `next build`,
// not before (see package.json's "build" script: `next build && node
// scripts/apply-production-migrations.mjs`). No-ops for local/CI/Preview
// builds -- VERCEL_ENV is only "production" on an actual production
// deployment -- so this never touches the hosted database from anywhere
// else. A failed migration fails the whole build (the previous deployment
// stays live) rather than shipping app code the database schema doesn't
// match yet.
//
// Ordering matters here in a way that's easy to get backwards: if the
// migration ran BEFORE `next build`, a migration that succeeds followed by
// a `next build` that fails for an unrelated reason (a stray type error,
// an OOM, whatever) would still leave the migration applied -- the OLD
// deployment (still serving traffic, since the new one never shipped) is
// now silently running against the NEW schema, with no rollback and no
// code that was ever tested against it. Running the migration last means
// the new code has already proven it builds before the database is
// touched at all.
//
// This does NOT solve the more fundamental rollback gap: Vercel's
// "Instant Rollback" re-points production at an already-built artifact,
// it does not re-run this script (or any build step) -- so rolling back
// the app code, for any reason, never rolls back a migration that already
// shipped with it. There's no down-migration mechanism in this project.
// The only real mitigation is migration discipline: write every migration
// to stay backward-compatible with the code it's replacing (add a column
// and let both versions read/write it; don't rename/drop until a later,
// separate deploy once nothing depends on the old shape).
//
// Connects via SUPABASE_DB_URL (a direct Postgres connection string using
// the project's transaction pooler, IPv4-compatible -- the project's own
// db.<ref>.supabase.co:5432 host is IPv6-only and unreachable from most
// CI/build networks), not a Supabase account access token: the pooler
// connection can only ever reach this one project's database, while an
// access token can manage every project in the account. Smaller blast
// radius for a secret that now lives in the build environment.
import { execFileSync } from "node:child_process";

if (process.env.VERCEL_ENV !== "production") {
  console.log("apply-production-migrations: not a production build, skipping.");
  process.exit(0);
}

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("apply-production-migrations: SUPABASE_DB_URL is not set for a production build.");
  process.exit(1);
}

console.log("apply-production-migrations: pushing pending migrations to production...");
try {
  execFileSync("npx", ["supabase", "db", "push", "--db-url", dbUrl, "--yes"], {
    stdio: "inherit",
  });
} catch {
  console.error("apply-production-migrations: migration push failed -- aborting build.");
  process.exit(1);
}
console.log("apply-production-migrations: migrations applied successfully.");
