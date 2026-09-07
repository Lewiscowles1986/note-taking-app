#!/usr/bin/env node
/*
 * Verify a password-encrypted Note Haven export by decrypting it locally, so
 * you can compare the output to the source and confirm there is no data loss.
 *
 * Usage:
 *   node scripts/verify-encrypted-export.mjs <input> [password]
 *   VERIFY_PASSWORD=secret node scripts/verify-encrypted-export.mjs <input>
 *
 * <input> is either:
 *   - a JSON payload file, e.g. {"method":"password","ciphertext":"...",...}
 *   - an exported note .html whose <pre class="encrypted-payload"> block holds
 *     the JSON payload (HTML entities are decoded automatically)
 *
 * If neither [password] nor VERIFY_PASSWORD is given you are prompted (hidden).
 * Prints the decrypted plaintext (byte-exact) to stdout so you can diff it
 * against your original note. Fully offline — no network, no third-party deps.
 *
 * NOTE: this script decrypts PASSWORD-encrypted notes only. Key-pair notes
 * require the matching private key and are out of scope here.
 */
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

const subtle = webcrypto.subtle;

// Must match src/lib/crypto.ts (password method).
const PBKDF2_ITERATIONS = 600_000;

const USAGE = `Usage:
  node scripts/verify-encrypted-export.mjs <input> [password]

<input> is either:
  - a JSON payload: {"method":"password","ciphertext":"...","iv":"...","salt":"..."}
  - an exported note .html containing a <pre class="encrypted-payload"> block

Optional [password] or env VERIFY_PASSWORD; otherwise you are prompted (hidden).`;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function unescapeHtml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&"); // &amp; last so we don't re-escape
}

function loadPayload(input) {
  let raw;
  try {
    raw = readFileSync(input, "utf8");
  } catch (e) {
    die(`Could not read ${input}: ${e?.message ?? e}`);
  }
  if (raw.trim().startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      die(`File looks like JSON but failed to parse: ${e?.message ?? e}`);
    }
  }
  // Exported HTML: the encrypted payload is the <pre class="encrypted-payload"> block.
  const m = raw.match(/<pre class="encrypted-payload">([\s\S]*?)<\/pre>/i);
  if (!m) die(`No <pre class="encrypted-payload"> block found in ${input}.`);
  try {
    return JSON.parse(unescapeHtml(m[1]));
  } catch (e) {
    die(`Could not parse the encrypted payload inside ${input}: ${e?.message ?? e}`);
  }
}

function promptHidden(question) {
  return new Promise((resolve) => {
    if (stdin.isTTY) stdout.write(question);
    let line = "";
    const onKeypress = (key) => {
      const s = String(key);
      if (s === "\r" || s === "\n" || s === "\u0004") {
        if (stdin.isTTY) stdin.setRawMode(false);
        stdout.write("\n");
        stdin.off("data", onKeypress);
        resolve(line);
      } else if (s === "\u0003") {
        if (stdin.isTTY) stdin.setRawMode(false);
        stdout.write("\n");
        stdin.off("data", onKeypress);
        die("Aborted.");
      } else if (s === "\u007f" || s === "\b") {
        line = line.slice(0, -1);
      } else {
        line += s;
      }
    };
    stdin.on("data", onKeypress);
    if (stdin.isTTY) stdin.setRawMode(true);
  });
}

async function deriveKey(password, saltB64) {
  const salt = Buffer.from(saltB64, "base64");
  const keyMaterial = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-CBC", length: 256 },
    false,
    ["decrypt"],
  );
}

function isUtf8(buf) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

(async () => {
  const [input, passwordArg] = process.argv.slice(2);
  if (!input) {
    console.error(USAGE);
    process.exit(1);
  }

  const payload = loadPayload(input);
  if (!payload.method || payload.method !== "password") {
    die(
      `This payload is not password-encrypted (method=${payload?.method ?? "missing"}).\n` +
        "This script only decrypts password-encrypted notes; key-pair notes need their private key.",
    );
  }
  for (const f of ["ciphertext", "iv", "salt"]) {
    if (typeof payload[f] !== "string" || payload[f].length === 0) {
      die(`Malformed payload: missing "${f}".`);
    }
  }

  const password =
    passwordArg || process.env.VERIFY_PASSWORD || (await promptHidden("Password: "));

  let key;
  try {
    key = await deriveKey(password, payload.salt);
  } catch (e) {
    die(`Key derivation failed: ${e?.message ?? e}`);
  }

  let plain;
  try {
    plain = new Uint8Array(
      await subtle.decrypt(
        { name: "AES-CBC", iv: Buffer.from(payload.iv, "base64") },
        key,
        Buffer.from(payload.ciphertext, "base64"),
      ),
    );
  } catch (e) {
    die(`Decryption failed (wrong password or corrupted data): ${e?.message ?? e}`);
  }

  // AES-CBC is *not* authenticated, so a wrong password can occasionally yield
  // well-padded garbage instead of an error — flag non-UTF8 output as suspect.
  if (!isUtf8(plain)) {
    console.error(
      "\nWARNING: decrypted bytes are not valid UTF-8 — the password is probably\n" +
        "wrong, or the payload is damaged. Treat the output below as garbage.\n",
    );
  }

  // Write the exact bytes the note held, so diffing against the original source
  // is byte-for-byte (no added trailing newline). Redirect to a file to compare.
  process.stdout.write(Buffer.from(plain));
})().catch((e) => {
  console.error(`Unexpected error: ${e?.stack ?? e}`);
  process.exit(1);
});
