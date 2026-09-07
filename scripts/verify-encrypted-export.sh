#!/usr/bin/env bash
#
# verify-encrypted-export.sh — non-JavaScript data-loss verification
#
# Decrypts a password-encrypted Note Haven export using ONLY standard tools:
#   * openssl  (>= 3: `openssl kdf PBKDF2` + `openssl enc AES-256-CBC`)
#   * jq        (extract fields from the JSON payload)
#   * perl      (pull the payload out of an exported .html)
#   * od        (binary -> hex)
#   * sha256sum / shasum  (integrity check)
#
# No application code, no Node.js — the same primitives OpenSSL itself uses.
#
# Workflow (safe by construction):
#   1. decrypt into a throwaway temp dir (never a "real" path),
#   2. checksum the decrypted bytes and compare against the original note,
#   3. only copy the file into the *working directory* if the checksums match.
#   On any mismatch it exits non-zero and leaves nothing behind.
#
# Usage:
#   bash scripts/verify-encrypted-export.sh <encrypted> <original> [password] [-o out]
#   VERIFY_PASSWORD=secret bash scripts/verify-encrypted-export.sh <encrypted> <original>
#
#   <encrypted>  the export to decrypt, either
#                  - a JSON payload {"method":"password","ciphertext":"...","iv":"...","salt":"..."}
#                  - an exported note .html holding a <pre class="encrypted-payload"> block
#   <original>   the source note's plaintext markdown to verify against (checksum source)
#   [password]   optional; defaults to $VERIFY_PASSWORD, else prompted hidden
#   -o <out>     destination filename in the working directory (default: roundtrip.md)
#
# If <original> is omitted the decrypted bytes are printed to stdout UNVERIFIED
# (the gated copy requires a checksum reference to compare against).
set -euo pipefail

outfile="roundtrip.md"
while getopts ":o:h" opt; do
  case "$opt" in
    o) outfile="$OPTARG" ;;
    h) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: -$OPTARG" >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))

input="${1:-}"
original="${2:-}"
password="${3:-${VERIFY_PASSWORD:-}}"

if [[ -z "$input" ]]; then
  echo "Usage: bash scripts/verify-encrypted-export.sh <encrypted> <original> [password] [-o out]" >&2
  exit 2
fi
if [[ -z "$password" ]]; then
  read -r -s -p "Password: " password
  echo >&2
fi

for tool in openssl jq perl od; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

if command -v sha256sum >/dev/null 2>&1; then
  cksum() { sha256sum "$1" | awk '{print $1}'; }
else
  cksum() { shasum -a 256 "$1" | awk '{print $1}'; }
fi

# --- 0. Decrypt into a throwaway temp dir only -------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Locate the EncryptedPayload JSON (raw JSON file, or HTML <pre> block).
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
iv="$(jq -r .iv "$tmp/payload.json")"
ciphertext="$(jq -r .ciphertext "$tmp/payload.json")"

# Decode octet strings. NOTE: `openssl base64 -d` discards input with no
# trailing newline, and the app's base64 has none — always feed a newline.
salthex="$(printf '%s\n' "$salt" | openssl base64 -d 2>/dev/null | od -An -tx1 -v | tr -d ' \n')"
ivhex="$(printf '%s\n' "$iv" | openssl base64 -d 2>/dev/null | od -An -tx1 -v | tr -d ' \n')"
printf '%s\n' "$ciphertext" | openssl base64 -d 2>/dev/null > "$tmp/cipher.bin"

# Derive the AES-256 key (PBKDF2-HMAC-SHA256, 600000 iters) — mirrors crypto.ts.
keyhex="$(openssl kdf -keylen 32 -kdfopt digest:SHA256 -kdfopt "pass:${password}" \
  -kdfopt "hexsalt:${salthex}" -kdfopt iter:600000 PBKDF2 2>/dev/null \
  | tr -d ':' | tr 'A-Z' 'a-z')"
[[ -n "$keyhex" ]] || { echo "key derivation (openssl kdf PBKDF2) failed" >&2; exit 1; }

if ! openssl enc -d -aes-256-cbc -K "$keyhex" -iv "$ivhex" \
    -in "$tmp/cipher.bin" -out "$tmp/plain.bin" 2>/dev/null; then
  echo "decryption failed (wrong password or corrupted data)" >&2
  exit 1
fi

# --- No <original> given? print UNVERIFIED to stdout (no gated copy). --------
if [[ -z "$original" ]]; then
  echo "no <original> supplied — printing decrypted bytes UNVERIFIED to stdout" >&2
  cat "$tmp/plain.bin"
  exit 0
fi

# --- Verify checksum, then copy into the working directory ONLY on match. ----
if [[ ! -f "$original" ]]; then
  echo "original file not found: $original" >&2
  exit 1
fi

got="$(cksum "$tmp/plain.bin")"
want="$(cksum "$original")"
echo "decrypted sha256: $got"
echo "original  sha256: $want"

if [[ "$got" != "$want" ]]; then
  echo "MISMATCH — decrypted content does not match the original; nothing written." >&2
  echo "Check the password and that <original> is the correct source." >&2
  exit 1
fi

# Verified: now copy the decrypted bytes out of tmp into the working directory.
cp "$tmp/plain.bin" "$outfile"
echo "VERIFIED — checksums match. Wrote ./$outfile"
