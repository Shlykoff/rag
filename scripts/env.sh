# Load environment variables into the CURRENT shell for one-off checks
# against local or production Supabase, run from the repo root:
#   source scripts/env.sh production
#   source scripts/env.sh local
#
# .env.local always points at local Docker Supabase and is loaded
# automatically by `npm run dev`/`npm run build` -- nothing here changes
# that. This script exists only for ad-hoc shell commands (curl, a
# one-off node -e, psql) that need production credentials for a single
# check, without those credentials ever landing in .env.local or any
# file the running app reads.
#
# Must be sourced, not executed, since a script run as its own process
# can never modify its parent shell's environment.

if (return 0 2>/dev/null); then
  :
else
  echo "This must be sourced, not executed: 'source scripts/env.sh production'" >&2
  exit 1
fi

case "$1" in
  production|prod)
    env_file=".env.production.local"
    ;;
  local)
    env_file=".env.local"
    ;;
  *)
    echo "Usage: source scripts/env.sh <production|local>" >&2
    return 1
    ;;
esac

if [ ! -f "$env_file" ]; then
  echo "$env_file not found (run this from the repo root)." >&2
  return 1
fi

set -a
source "$env_file"
set +a

echo "Loaded '$1' environment into this shell (from $env_file)."
