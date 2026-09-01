#!/usr/bin/env node
// Applies supabase/migrations/*.sql to the hosted production database as
// the first step of every Vercel build (wired into package.json's "build"
// script). No-ops for local/CI/Preview builds -- VERCEL_ENV is only
// "production" on an actual production deployment -- so this never touches
// the hosted database from anywhere else. A failed migration fails the
// whole build (the previous deployment stays live) rather than shipping
// app code the database schema doesn't match yet.
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
