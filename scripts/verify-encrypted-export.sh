#!/usr/bin/env bash
#
# verify-encrypted-export.sh — non-JavaScript data-loss verification
#
# Decrypts a password-encrypted Note Haven export using ONLY standard tools:
#   * openssl  (>= 3: `openssl kdf PBKDF2` + `openssl enc AES-256-CBC`)
#   * base64 / openssl base64   (encode/decode)
#   * od                        (binary -> hex)
#   * jq                        (extract fields from the JSON payload)
#   * perl                      (pull the payload out of an exported .html)
#
# No application code, no Node.js — the same primitives OpenSSL itself uses.
#
# Usage:
#   bash scripts/verify-encrypted-export.sh <input> [password]
#   VERIFY_PASSWORD=secret bash scripts/verify-encrypted-export.sh <input>
#
# <input> is either:
#   - a JSON payload file:  {"method":"password","ciphertext":"...","iv":"...","salt":"..."}
#   - an exported note .html holding a <pre class="encrypted-payload"> block
#
# Prints the exact decrypted bytes to stdout (no added trailing newline) so you
# can diff against the original source. Fully standard & offline.
set -euo pipefail

input="${1:-}"
password="${2:-${VERIFY_PASSWORD:-}}"
if [[ -z "$input" ]]; then
  echo "Usage: bash scripts/verify-encrypted-export.sh <input> [password]" >&2
  echo "(password may also be set via VERIFY_PASSWORD)" >&2
  exit 2
fi
if [[ -z "$password" ]]; then
  read -r -s -p "Password: " password
  echo >&2
fi

for tool in openssl jq perl od; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- 1. Locate the EncryptedPayload JSON -----------------------------------
if jq -e . "$input" >/dev/null 2>&1; then
  cp "$input" "$tmp/payload.json"
else
  # Exported HTML: read the JSON out of the entity-escaped <pre> block.
  perl -0777 -ne 'if (/<pre class="encrypted-payload">(.*?)<\/pre>/s) {
    $x=$1; $x=~s/&lt;/</g; $x=~s/&gt;/>/g; $x=~s/&quot;/"/g; $x=~s/&amp;/&/g; print $x;
  } else { exit 1 }' "$input" > "$tmp/payload.json" \
    || { echo "no <pre class=\"encrypted-payload\"> block in $input" >&2; exit 1; }
  jq -e . "$tmp/payload.json" >/dev/null \
    || { echo "payload inside $input is not valid JSON" >&2; exit 1; }
fi

method="$(jq -r .method "$tmp/payload.json")"
if [[ "$method" != "password" ]]; then
  echo "unsupported method: $method (only 'password' is supported here; key-pair needs the private key)" >&2
  exit 1
fi

jq -e '(.ciphertext|type=="string" and length>0) and (.iv|type=="string" and length>0) and (.salt|type=="string" and length>0)' "$tmp/payload.json" >/dev/null \
  || { echo "payload is missing ciphertext/iv/salt" >&2; exit 1; }

salt="$(jq -r .salt "$tmp/payload.json")"
iv="$(jq -r .iv     "$tmp/payload.json")"
ciphertext="$(jq -r .ciphertext "$tmp/payload.json")"

# --- 2. Decode octet strings (base64 -> binary, then -> hex) ----------------
# NOTE: `openssl base64 -d` discards input with no trailing newline, and the
# app's base64 has none — always feed a trailing newline.
# salt -> hex (needed for -kdfopt hexsalt; matches a 32-byte salt)
salthex="$(printf '%s\n' "$salt" | openssl base64 -d 2>/dev/null | od -An -tx1 -v | tr -d ' \n')"
ivhex="$(printf '%s\n' "$iv" | openssl base64 -d 2>/dev/null | od -An -tx1 -v | tr -d ' \n')"
printf '%s\n' "$ciphertext" | openssl base64 -d 2>/dev/null > "$tmp/cipher.bin"

# --- 3. Derive the AES-256 key (PBKDF2-HMAC-SHA256, 600000 iters) ----------
# mirrors src/lib/crypto.ts deriveKey()
keyhex="$(openssl kdf -keylen 32 -kdfopt digest:SHA256 -kdfopt "pass:${password}" \
  -kdfopt "hexsalt:${salthex}" -kdfopt iter:600000 PBKDF2 2>/dev/null \
  | tr -d ':' | tr 'A-Z' 'a-z')"
[[ -n "$keyhex" ]] || { echo "key derivation (openssl kdf PBKDF2) failed" >&2; exit 1; }

# --- 4. Decrypt AES-256-CBC with the stored IV ------------------------------
if ! openssl enc -d -aes-256-cbc -K "$keyhex" -iv "$ivhex" \
    -in "$tmp/cipher.bin" -out "$tmp/plain.bin" 2>/dev/null; then
  echo "decryption failed (wrong password or corrupted data)" >&2
  exit 1
fi

# --- 5. Emit the exact bytes ------------------------------------------------
cat "$tmp/plain.bin"
