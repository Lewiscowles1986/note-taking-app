# Encrypted-note format & verifying there is no data loss

Note Haven lets you lock a note with a password (or a key pair). This document
explains **exactly** how an encrypted note is stored and exported, so you can
decrypt an exported note yourself and confirm the content round-trips with zero
data loss.

> Security model: the plaintext of an encrypted note **never** touches disk and
> is **never** put in any export. It exists only in browser memory while the
> note is unlocked. Exports of an encrypted note carry the ciphertext only.

## 1. How an encrypted note is stored

An encrypted note has two relevant fields in its database row:

| Field                 | Contents for an encrypted note                                        |
| --------------------- | ---------------------------------------------------------------------- |
| `content`             | The literal placeholder `[encrypted]`                                  |
| `encrypted`           | `EncryptedPayload` — the real ciphertext and its encryption metadata    |

The `content` placeholder exists so the rest of the app (search, lists, etc.)
always has a plain string to work with without exposing the plaintext.

## 2. The `EncryptedPayload` shape

```jsonc
{
  "method":   "password",            // or "keypair"
  "ciphertext": "<base64>",          // AES-256-CBC ciphertext
  "iv":         "<base64>",          // 128-bit IV
  "salt":       "<base64>",          // PBKDF2 salt (password method, 256-bit)
  // keypair method only:
  "wrappedKey":     "<base64>",      // RSA-OAEP-wrapped random AES key
  "keyFingerprint": "<string>",      // which key pair encrypted the note
}
```

All octet-string values are standard base64.

## 3. The exact cryptography (password method)

This is the algorithm in `src/lib/crypto.ts` (`encryptWithPassword` /
`decryptWithPassword`), used on every password-encrypted note:

1. **Key derivation** — PBKDF2
   - Hash: **SHA-256**
   - Iterations: **600,000**
   - Salt: the base64-decoded `payload.salt` (32 bytes)
   - Input: the password
   - Output: a 256-bit AES-CBC key
2. **Decryption** — **AES-256-CBC**
   - IV: the base64-decoded `payload.iv` (16 bytes)
   - PKCS#7 padding (handled by WebCrypto)
   - Output: decoded as UTF-8 → the original note content

### Not a custom format — verified interoperable

Everything here is a **standard, interoperable primitive**; the app did **not**
invent a cipher. The JSON envelope only records the standard values needed to
recover the key:

| Step | Standard | Reference |
| -----| -------- | --------- |
| PBKDF2-HMAC-SHA-256 key derivation | RFC 2898 | `openssl kdf … PBKDF2` |
| AES-256-CBC + PKCS#7 | FIPS-197 / RFC 3602 | `openssl enc -aes-256-cbc -d` |
| base64 octet fields | RFC 4648 | `openssl base64 -d` |

Concretely, this format was **verified** by decrypting a payload produced by the
app with **OpenSSL alone** — `openssl kdf PBKDF2` for the key and
`openssl enc -aes-256-cbc -d` for the ciphertext — which reproduced the original
plaintext **byte-for-byte**. So you never need to trust the app's JS to decrypt
your data.

## 4. Where the ciphertext appears in each export

| Export      | Where the `EncryptedPayload` lives                                        |
| ----------- | ------------------------------------------------------------------------- |
| HTML / PDF  | In a `<pre class="encrypted-payload">…</pre>` block of the exported page   |
| ZIP (HTML)  | `notes/<slug>/<slug>.html` → same `<pre>` block as above                   |
| ZIP (MD)    | `notes/<slug>/README.md` → inside a ` ```json ` fence                     |
| JSON backup | `exportDatabase()` dumps the raw row, so the `encrypted` object is intact  |

Every artifact that carries the note is clearly labelled *"Password encrypted —
exported in its encrypted form"*.

## 5. Verifying there is no data loss

Because exports keep the note encrypted, the only way to prove the content
survived is to decrypt an exported note with its real password and compare it
to the source markdown.

### Preferred: OpenSSL only (no JavaScript)

`scripts/verify-encrypted-export.sh` decrypts using **standard system tools
only** — `openssl`, `jq`, `perl`, `od`. It never runs the app's code and needs
no Node.js. (Requires OpenSSL ≥ 3 on Linux/macOS — check `openssl version`.)

```bash
bash scripts/verify-encrypted-export.sh note.html "your password" > roundtrip.md
# or against the exported JSON payload directly:
bash scripts/verify-encrypted-export.sh payload.json "your password" > roundtrip.md
```

What it does, step by step (all standard):

```bash
# 1. get the payload fields (base64)                                  # 2. decode -> hex / binary
salt=$(jq -r .salt   payload.json)     #                                salthex=$(…) openssl base64 -d / od -tx1
iv=$(jq -r .iv       payload.json)     #                                ivhex=…
ct=$(jq -r .ciphertext payload.json)   #                                ct.bin=… openssl base64 -d

# 3. derive the AES-256 key (PBKDF2-HMAC-SHA256, 600k iters)          # 4. decrypt AES-256-CBC
key=$(openssl kdf -keylen 32 \
   -kdfopt digest:SHA256 \
   -kdfopt pass:"$password" \
   -kdfopt "hexsalt:${salthex}" \
   -kdfopt iter:600000 PBKDF2 | tr -d ':' | tr 'A-Z' 'a-z')
openssl enc -d -aes-256-cbc -K "$key" -iv "$ivhex" -in ct.bin -o plain.txt
```

- Password may be passed as an argument, via `VERIFY_PASSWORD=…`, or prompted
  (hidden) when omitted.
- The script reads the `<pre class="encrypted-payload">` block straight from an
  exported `.html` file, or a standalone `payload.json`.

### Compare

```bash
diff <original-note-markdown> roundtrip.md   # empty output = identical
```

Both verifiers write the **exact bytes** the note held (no added trailing
newline), so `diff` (or `cmp`) is byte-for-byte.

### Alternative: Node script (fallback)

`scripts/verify-encrypted-export.mjs` does the same with Node's built-in
`webcrypto`, fully offline. Useful if `openssl` or `jq` isn't installed.

```bash
node scripts/verify-encrypted-export.mjs note.html "your password" > roundtrip.md
```

## 6. Caveats worth knowing

- **AES-CBC is not authenticated.** A wrong password normally causes decryption
  to fail, but occasionally it yields well-padded garbage instead of an error.
  The script flags output that isn't valid UTF-8, and the practical check is the
  `diff`: if the content isn't your original markdown, you used the wrong
  password or the data is corrupted.
- **Key-pair (RSA) notes** are a different path: a random AES key is wrapped
  with RSA-OAEP. They still store the plaintext encrypted, but the verification
  script covers password notes only; a key-pair note requires its private key.
- **Re-verify after restoring a backup:** if you restore the JSON backup
  (`exportDatabase`) into another browser/profile, unlock the note and confirm
  it renders — the backup already carries the ciphertext, so data loss (if any)
  would surface only at unlock time.
- The exported file is only as private as you treat it: anyone holding the
  exported ciphertext can attempt an offline brute-force of the password, the
  same as the note itself. Excluding an encrypted note from exports entirely is
  a stricter option if you prefer it.

## 7. Reference

- Crypto implementation: `src/lib/crypto.ts`
- Export handling (encrypted routing): `src/lib/export.ts`
- In-memory plaintext cache: `src/pages/Index.tsx` (`decryptedCache`)
- Verify (OpenSSL, no JS): `scripts/verify-encrypted-export.sh`
- Verify (Node fallback): `scripts/verify-encrypted-export.mjs`
