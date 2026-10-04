#!/usr/bin/env bash
# Fill in deploy/worker/worker.env's secrets without opening an editor.
#
#   deploy/worker/fill-env.sh
#
# Asks for each secret without echoing it, reads the GitHub App's private key from
# its .pem file, and fetches the database URL from Neon's CLI when it is signed in.
# Values already set are kept unless you type a new one. Nothing is printed.
set -euo pipefail
cd "$(dirname "$0")"
[ -f worker.env ] || cp worker.env.example worker.env
chmod 600 worker.env

current() { grep -E "^$1=" worker.env | head -1 | cut -d= -f2-; }

set_value() {
  python3 - "$1" "$2" <<'EOF'
import sys
key, value = sys.argv[1], sys.argv[2]
lines = open('worker.env').read().splitlines()
out, done = [], False
for line in lines:
    if line.startswith(key + '='):
        out.append(f'{key}={value}'); done = True
    else:
        out.append(line)
if not done:
    out.append(f'{key}={value}')
open('worker.env', 'w').write('\n'.join(out) + '\n')
EOF
}

ask_secret() {
  local key="$1" prompt="$2" value
  if [ -n "$(current "$key")" ]; then prompt="$prompt [set; Enter keeps it]"; fi
  read -r -s -p "$prompt: " value; echo
  [ -n "$value" ] && set_value "$key" "$value"
  return 0
}

# Database: from Neon's CLI if it is signed in, else asked for.
if [ -z "$(current DATABASE_URL)" ]; then
  read -r -p "Neon project id [billowing-wind-54847316]: " project; project="${project:-billowing-wind-54847316}"
  url="$(npx -y neonctl@latest connection-string --project-id "$project" --branch production 2>/dev/null || true)"
  if [ -n "$url" ]; then set_value DATABASE_URL "$url"; echo "DATABASE_URL: from Neon"; else ask_secret DATABASE_URL "DATABASE_URL (Neon connection string)"; fi
fi

ask_secret PAGER_MASTER_KEY "PAGER_MASTER_KEY (Render → Environment Groups → pager-secrets)"

# The private key, from its file, newlines escaped for an env file.
if [ -z "$(current GITHUB_APP_PRIVATE_KEY)" ]; then
  guess="$(ls -t "$HOME"/Downloads/pager-developer-zeel991.*.private-key.pem 2>/dev/null | head -1 || true)"
  read -r -p "Path to the GitHub App's .pem [${guess:-none found}]: " pem; pem="${pem:-$guess}"
  pem="${pem/#\~/$HOME}"
  [ -f "$pem" ] || { echo "No file at $pem" >&2; exit 1; }
  set_value GITHUB_APP_PRIVATE_KEY "\"$(awk 'BEGIN{ORS="\\n"} {print}' "$pem")\""
  echo "GITHUB_APP_PRIVATE_KEY: from $(basename "$pem")"
fi

ask_secret GITHUB_APP_CLIENT_SECRET "GITHUB_APP_CLIENT_SECRET (GitHub App → Client secrets)"
ask_secret GITHUB_APP_WEBHOOK_SECRET "GITHUB_APP_WEBHOOK_SECRET (what you typed when creating the app)"

missing=$(grep -E '^(DATABASE_URL|PAGER_MASTER_KEY|GITHUB_APP_[A-Z_]+)=$' worker.env | cut -d= -f1 | tr '\n' ' ')
if [ -n "$missing" ]; then echo "Still empty: $missing"; else echo "worker.env is complete. Start the worker: deploy/worker/run-here.sh"; fi
