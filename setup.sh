#!/bin/sh
# One-command setup: prepares .env (generating a secret key and, if needed,
# an admin password), generates a self-signed TLS cert if one isn't already
# in place, and starts the app with docker compose.
#
# Usage: ./setup.sh <hostname-or-ip> [https-port] [http-port]
#   ./setup.sh 192.168.1.50
#   ./setup.sh 192.168.1.50 8443 8080
#
# <hostname-or-ip> is whatever address you'll actually type into a browser
# to reach this box — used for the certificate's subject and printed at the
# end. Re-running this script is safe: it never overwrites an existing .env
# or existing certs, it only fills in what's missing.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ -z "$1" ]; then
    echo "Usage: $0 <hostname-or-ip> [https-port] [http-port]"
    echo "Example: $0 192.168.1.50"
    echo "Example: $0 192.168.1.50 8443 8080"
    exit 1
fi
HOST="$1"
HTTPS_PORT="${2:-8443}"
HTTP_PORT="${3:-8080}"

if ! command -v docker >/dev/null 2>&1; then
    echo "docker not found on PATH. Install Docker (TrueNAS SCALE ships it) and re-run this script."
    exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
    echo "'docker compose' not available. Install the Docker Compose plugin and re-run this script."
    exit 1
fi

# --- .env ---
if [ -f .env ]; then
    echo "== .env already exists — leaving it as-is (delete it first if you want a clean setup) =="
else
    echo "== creating .env from .env.example =="
    cp .env.example .env
fi

# Portable (no bash-only features) way to read/write a KEY=value line in .env.
_get_env() {
    # $1 = key. Prints the value (may be empty) or nothing if the key is absent.
    grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d'=' -f2-
}
_set_env() {
    # $1 = key, $2 = value. Updates the line in place if present, else appends it.
    key="$1"; value="$2"
    if grep -qE "^$key=" .env 2>/dev/null; then
        tmp="$(mktemp)"
        awk -F'=' -v k="$key" -v v="$value" 'BEGIN{OFS="="} $1==k{$0=k"="v} {print}' .env > "$tmp"
        mv "$tmp" .env
    else
        echo "$key=$value" >> .env
    fi
}

if [ -z "$(_get_env VG_SECRET_KEY)" ]; then
    echo "== generating VG_SECRET_KEY =="
    SECRET="$(openssl rand -hex 32 2>/dev/null || python3 -c 'import secrets; print(secrets.token_hex(32))')"
    _set_env VG_SECRET_KEY "$SECRET"
fi

GENERATED_PASSWORD=""
if [ -z "$(_get_env VG_ADMIN_PASSWORD)" ]; then
    if [ -t 0 ]; then
        echo "== no VG_ADMIN_PASSWORD set — enter one for the bootstrap 'admin' account =="
        printf "Admin password: "
        stty -echo 2>/dev/null || true
        read -r ADMIN_PW
        stty echo 2>/dev/null || true
        echo
    else
        ADMIN_PW=""
    fi
    if [ -z "$ADMIN_PW" ]; then
        ADMIN_PW="$(openssl rand -hex 12 2>/dev/null || python3 -c 'import secrets; print(secrets.token_hex(12))')"
        GENERATED_PASSWORD="$ADMIN_PW"
    fi
    _set_env VG_ADMIN_PASSWORD "$ADMIN_PW"
fi

_set_env VG_HTTPS_PORT "$HTTPS_PORT"
_set_env VG_HTTP_PORT "$HTTP_PORT"

CERT_DIR="$(_get_env VG_CERT_DIR)"
CERT_DIR="${CERT_DIR:-./nginx/certs}"

# --- certificate ---
echo "== checking TLS certificate =="
./nginx/generate-self-signed-cert.sh "$HOST" "$CERT_DIR"

# --- launch ---
VG_IMAGE="$(_get_env VG_IMAGE)"
if [ -n "$VG_IMAGE" ]; then
    echo "== VG_IMAGE is set ($VG_IMAGE) — pulling instead of building =="
    docker compose pull
    docker compose up -d
else
    echo "== starting docker compose (building the image locally — this can take a"
    echo "   few minutes the first time; set VG_IMAGE in .env to pull a prebuilt"
    echo "   image instead, see the README's \"Publishing to Docker Hub\" section) =="
    docker compose up -d --build
fi

echo
echo "Done. Visit: https://$HOST:$HTTPS_PORT/"
if [ -n "$GENERATED_PASSWORD" ]; then
    echo
    echo "No admin password was set, so one was generated for you:"
    echo "  username: $(_get_env VG_ADMIN_USER)"
    echo "  password: $GENERATED_PASSWORD"
    echo "(also saved in .env as VG_ADMIN_PASSWORD — change it after your first login)"
fi
echo
echo "Your browser will warn about the self-signed certificate — that's expected;"
echo "see the README's \"Putting it behind HTTPS\" section for why, and how to use"
echo "a real certificate instead if you'd rather not click through that warning."
