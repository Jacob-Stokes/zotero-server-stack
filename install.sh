#!/usr/bin/env bash
# Installer for zotero-server-stack. Brings up the MCP against Zotero's own
# cloud (api.zotero.org) — there's no sync backend to choose, Zotero's Web
# API already keeps this in step with your library. Safe to re-run — it
# won't overwrite an existing .env.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die() { printf '\033[31mError:\033[0m %s\n' "$1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not installed. See https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "docker compose (v2 plugin) is required."
command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets."
command -v curl >/dev/null 2>&1 || die "curl is required."

say "Setting up the core stack"

if [ ! -f .env ]; then
  cp .env.example .env
  ok "created .env from .env.example"
else
  ok ".env already exists, leaving it alone"
fi

set_env() {
  # set_env KEY VALUE [force] — replaces KEY= in .env, only if currently
  # empty unless "force" is passed. Always quotes the written value: .env
  # gets `source`d as a shell script, so an unquoted value with special
  # characters (an API key can contain almost anything) would break it.
  local key="$1" val="$2" force="${3:-}"
  if grep -q "^${key}=" .env; then
    if [ -n "$force" ] || [ -z "$(grep "^${key}=" .env | cut -d= -f2-)" ]; then
      sed -i.bak "s#^${key}=.*#${key}=\"${val}\"#" .env && rm -f .env.bak
    fi
  else
    echo "${key}=\"${val}\"" >> .env
  fi
}

# shellcheck disable=SC1091
source .env 2>/dev/null || true

if [ -z "${MCP_BEARER_TOKEN:-}" ]; then
  set_env MCP_BEARER_TOKEN "$(openssl rand -hex 32)"
  ok "generated MCP_BEARER_TOKEN"
fi

# Re-read after generating.
# shellcheck disable=SC1091
source .env

# Catch a name collision before docker does. Only a *foreign* collision
# blocks — a container this same project already created is fine, and must
# stay re-runnable, per the README's promise.
PROJECT="${INSTANCE_PREFIX:-}zotero-server-stack"
NAME="${INSTANCE_PREFIX:-}zotero-mcp"
if docker inspect "$NAME" >/dev/null 2>&1; then
  OWNER="$(docker inspect "$NAME" --format '{{ index .Config.Labels "com.docker.compose.project" }}' 2>/dev/null || true)"
  if [ "$OWNER" != "$PROJECT" ]; then
    die "container name '$NAME' is already in use by something else on this machine.
  Set INSTANCE_PREFIX in .env (e.g. INSTANCE_PREFIX=test-) to run a second,
  separate instance alongside the existing one, then re-run this script."
  fi
fi

if [ -z "${ZOTERO_USER_ID:-}" ] || [ -z "${ZOTERO_API_TOKEN:-}" ]; then
  say "Connecting your Zotero account"
  echo "  You need your Zotero user ID and an API key. Both are on:"
  echo "    https://www.zotero.org/settings/keys"
  echo "  Your user ID is the number shown above the \"Create new private key\" button."
  echo "  Click that button to make a key — library read access is enough unless"
  echo "  you want the MCP to create or edit items too. If you want zotero_notes to"
  echo "  work, also tick \"Allow notes access\" — it's separate from library access,"
  echo "  and without it Zotero's API reports notes as saved when they silently aren't."
  echo "  Paste the key below."
  echo
  if [ -z "${ZOTERO_USER_ID:-}" ]; then
    read -rp "  Zotero user ID: " UID_IN
    [ -n "$UID_IN" ] || die "user ID is required"
    set_env ZOTERO_USER_ID "$UID_IN"
  fi
  if [ -z "${ZOTERO_API_TOKEN:-}" ]; then
    read -rsp "  Zotero API key (hidden): " KEY_IN; echo
    [ -n "$KEY_IN" ] || die "API key is required"
    set_env ZOTERO_API_TOKEN "$KEY_IN"
  fi
  source .env
else
  ok "ZOTERO_USER_ID and ZOTERO_API_TOKEN already set, reusing them"
fi

say "Starting zotero-mcp"
# --remove-orphans cleans up containers from older versions of this stack.
docker compose up -d --build --remove-orphans

printf '  waiting for zotero-mcp'
UP=""
for _ in $(seq 1 30); do
  if curl -sf "http://localhost:${MCP_PORT:-7012}/health" >/dev/null 2>&1; then
    UP=1
    break
  fi
  printf '.'
  sleep 1
done
echo
if [ -z "$UP" ]; then
  die "zotero-mcp didn't come up — check 'docker compose logs zotero-mcp'
  A common cause is a wrong Zotero user ID or API key; check ZOTERO_USER_ID
  and ZOTERO_API_TOKEN in .env against https://www.zotero.org/settings/keys"
fi
ok "zotero-mcp is up on http://localhost:${MCP_PORT:-7012}/mcp"

echo
echo "Bearer token for MCP clients is MCP_BEARER_TOKEN in .env."

say "Zotero desktop (optional)"
cat <<'EOF'
  The MCP works fully without this — it's for community plugins (Better
  BibTeX, translators, ...), the Zotero Connector browser extension having
  somewhere to save into, and PDF text extraction: zotero_attachments only
  has text to return once some Zotero client has indexed that PDF, and if
  your other devices are often closed, this is what keeps that happening.
EOF
read -rp "  Set it up now? [y/N] " WANT_DESKTOP
if [ "$WANT_DESKTOP" = "y" ] || [ "$WANT_DESKTOP" = "Y" ]; then
  ( cd extras/zotero-desktop
    [ -f .env ] || cp .env.example .env
    [ -n "${INSTANCE_PREFIX:-}" ] && sed -i.bak "s/^INSTANCE_PREFIX=.*/INSTANCE_PREFIX=${INSTANCE_PREFIX}/" .env && rm -f .env.bak
    # shellcheck disable=SC1091
    source .env
    docker compose up -d
  )
  DPORT=$(grep '^DESKTOP_PORT=' extras/zotero-desktop/.env 2>/dev/null | cut -d= -f2- | tr -d '"')
  ok "zotero-desktop is up"
  echo "  Open https://localhost:${DPORT:-3001} (self-signed cert — your browser"
  echo "  will warn, that's expected) and sign in to your Zotero account. That's"
  echo "  the one step nothing can automate — Zotero has no headless login."
else
  echo "  Skipped. Set it up any time — see extras/zotero-desktop/README.md."
fi
