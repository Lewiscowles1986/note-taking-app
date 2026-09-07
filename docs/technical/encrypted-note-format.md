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

The repository ships a small, dependency-free Node script for exactly this:

```text
scripts/verify-encrypted-export.mjs
```

### Step 1 — export the note

Produce either the HTML export (File → Export → HTML) or the ZIP, then extract
the note. You need the `EncryptedPayload` JSON. From a ZIP you can take the JSON
fence out of `README.md`, or a standalone `.json` file:

```json
{
  "method": "password",
  "ciphertext": "…",
  "iv": "…",
  "salt": "…"
}
```

### Step 2 — decrypt it with the script

```bash
node scripts/verify-encrypted-export.mjs note.html "your password" > roundtrip.md
# or against the exported JSON payload directly:
node scripts/verify-encrypted-export.mjs payload.json "your password" > roundtrip.md
```

- Password may be passed as an argument, via `VERIFY_PASSWORD=…`, or prompted
  (hidden) when omitted.
- The script reads the `<pre class="encrypted-payload">` block straight from an
  exported `.html` file — no need to copy JSON by hand.
- It is fully offline: Node's built-in `webcrypto` only.

### Step 3 — compare

```bash
diff <original-note-markdown> roundtrip.md   # empty output = identical
```

The script writes the **exact bytes** the note held (no added trailing newline),
so `diff` (or `cmp`) is byte-for-byte.

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
- Verify script: `scripts/verify-encrypted-export.mjs`
