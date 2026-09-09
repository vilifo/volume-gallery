#!/bin/sh
# Generates a self-signed certificate for the nginx reverse proxy (see
# nginx/nginx.conf), for LAN/internal use where you don't have a public
# domain to get a real certificate for.
#
# Usage: ./generate-self-signed-cert.sh <hostname-or-ip> [output-dir]
#   ./generate-self-signed-cert.sh 192.168.1.50
#   ./generate-self-signed-cert.sh volume-gallery.home.arpa
#   ./generate-self-signed-cert.sh 192.168.1.50 /mnt/tank/certs/volume-gallery
#
# Output directory, in order of precedence: the second argument, then the
# $VG_CERT_DIR environment variable (e.g. already set from a sourced .env —
# this is what setup.sh does), then ./certs next to this script.
#
# If you DO have a real certificate (e.g. from Let's Encrypt) — or already
# have one issued some other way — skip this script entirely and just place
# your own files, named exactly fullchain.pem and privkey.pem, in whichever
# directory VG_CERT_DIR in your .env points at.

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <hostname-or-ip> [output-dir]"
    echo "Example: $0 192.168.1.50"
    echo "Example: $0 192.168.1.50 /mnt/tank/certs/volume-gallery"
    exit 1
fi
CN="$1"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CERT_DIR="${2:-${VG_CERT_DIR:-$SCRIPT_DIR/certs}}"
mkdir -p "$CERT_DIR"

if [ -f "$CERT_DIR/fullchain.pem" ] && [ -f "$CERT_DIR/privkey.pem" ]; then
    echo "Certificates already exist in $CERT_DIR — remove them first if you want to regenerate."
    exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl not found. Install it, or generate the cert some other way and place"
    echo "the files at $CERT_DIR/fullchain.pem and $CERT_DIR/privkey.pem yourself."
    exit 1
fi

# Modern browsers check the certificate's Subject Alternative Name, not just
# the CN — needs "IP:" for a bare IP address, "DNS:" for a hostname.
case "$CN" in
    *[!0-9.]*) SAN="DNS:$CN" ;;
    *) SAN="IP:$CN" ;;
esac

openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "$CERT_DIR/privkey.pem" \
    -out "$CERT_DIR/fullchain.pem" \
    -days 825 \
    -subj "/CN=$CN" \
    -addext "subjectAltName=$SAN"

chmod 644 "$CERT_DIR/fullchain.pem"
chmod 600 "$CERT_DIR/privkey.pem"

echo
echo "Generated a self-signed certificate for '$CN' in $CERT_DIR"
echo
echo "Browsers will show an untrusted-certificate warning for this — that's expected"
echo "for a self-signed cert; click through it (or import fullchain.pem into your"
echo "OS/browser trust store to avoid the warning). This still satisfies the browser's"
echo "WebGPU 'secure context' requirement either way — that check is about the"
echo "protocol (https://) being used, not about whether the certificate is trusted;"
echo "those are two separate checks."
