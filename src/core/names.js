// The patch-name field: what the evidence shows about its encoding.
// Phase 3 S0 establishes the facts only; the rename encoder is written in S3
// against them (docs/PHASE3_DESIGN.md 2.4, 12.2). Nothing here changes a patch.
//
// Evidence (2026-10-08):
//   - layout: 16 raw bytes at file 0x44-0x53 (donpark PROTOCOL.md; Studio
//     PRSTDecoder.ts; patch.js);
//   - the user's pedal (all backups on file, scanned with tools/scan-names.js,
//     summarised in tests/fixtures/name-facts.json): which byte values occur,
//     how short names are padded, whether full 16-byte names have a terminator;
//   - the pedal's own name editor (checked by hand by the user, no MIDI): at
//     most 16 characters; A-Z, a-z, 0-9, space and keyboard-style punctuation
//     and symbols; a full 16-character name is entered and displayed;
//   - symbols typed in that editor, saved and read back (2026-11-05): every
//     printable ASCII character the editor offers, stored as its ASCII code. It
//     does not offer "$" (RESEARCH.md §14).
// A byte value counts as demonstrated only if it was seen in a dump.
//
// SPDX-License-Identifier: GPL-3.0-only

import { CONTENT_FILE_START } from "./patch.js";

export const NAME_FILE_OFFSET = 0x44;
export const NAME_LEN = 16;
const D = NAME_FILE_OFFSET - CONTENT_FILE_START;

/** The 16 raw name bytes of a dump. */
export function nameField(dump) {
  return dump.subarray(D, D + NAME_LEN);
}

// ---- Rename (S3.3): restricted to the byte values demonstrated in dumps (RESEARCH.md §14):
// printable ASCII, 0x20-0x7E, except "$" (0x24), which the pedal's own editor does not offer.
// Each value is its own ASCII code, so a character and its byte are the same thing here.
// tests/names.test.js checks this list against the evidence in tests/fixtures/name-facts.json.
export const DEMONSTRATED_NAME_BYTES = Object.freeze(
  Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i).filter((b) => b !== 0x24),
);
export const NAME_ALLOWED_CHARS = new Set(DEMONSTRATED_NAME_BYTES.map((b) => String.fromCharCode(b)));
/** For messages: what a rename accepts. */
export const NAME_ALLOWED_DESCRIPTION = "A-Z, a-z, 0-9, space and keyboard symbols except $";

export class NameError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "NameError";
    this.code = code;
  }
}

/** A name for display: curly outer quotes when it holds a straight one (no patch name can hold a curly one). */
export function quoteName(name) {
  const s = `${name}`;
  return s.includes('"') ? `“${s}”` : `"${s}"`;
}

/** Throws NameError; otherwise returns `text` unchanged. */
export function validateName(text) {
  if (typeof text !== "string" || text.length === 0) throw new NameError("empty", "the name is empty");
  if (text.length > NAME_LEN) throw new NameError("too-long", `the name is ${text.length} characters; at most ${NAME_LEN} are allowed`);
  // No dump on file has a leading or trailing space (RESEARCH.md §14), so neither is assumed to be stored as typed.
  if (text !== text.trim()) throw new NameError("edge-space", "the name starts or ends with a space; remove it");
  const bad = [...new Set([...text].filter((ch) => !NAME_ALLOWED_CHARS.has(ch)))];
  if (bad.length) {
    throw new NameError("bad-char", `"${bad.join("")}" ${bad.length === 1 ? "is not a character" : "are not characters"} ` +
      `the Librarian can put in a patch name (allowed: ${NAME_ALLOWED_DESCRIPTION})`);
  }
  return text;
}

/** The 16-byte name field for `text` (validated), zero-padded. Throws NameError. */
export function encodeName(text) {
  validateName(text);
  const bytes = new Uint8Array(NAME_LEN);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** `dump` with its name field replaced by `bytes` (16). Everything else is untouched. */
export function withName(dump, bytes) {
  const out = Uint8Array.from(dump);
  out.set(bytes, D);
  return out;
}

/**
 * Aggregate facts about the name fields of `dumps` (no names are returned).
 * @param {Uint8Array[]} dumps raw 1176-byte dumps
 */
export function scanNameFields(dumps) {
  const lengths = new Array(NAME_LEN + 1).fill(0);
  const byteValues = new Map(); // value -> count, bytes before the first 0x00
  let fullLength = 0;
  let nonZeroAfterTerminator = 0;
  let leadingSpace = 0;
  let trailingSpace = 0;
  let empty = 0;
  for (const d of dumps) {
    const f = nameField(d);
    const z = f.indexOf(0);
    const len = z === -1 ? NAME_LEN : z;
    lengths[len]++;
    if (len === NAME_LEN) fullLength++;
    if (len === 0) empty++;
    if (z !== -1 && f.subarray(z).some((b) => b !== 0)) nonZeroAfterTerminator++;
    if (len && f[0] === 0x20) leadingSpace++;
    if (len && f[len - 1] === 0x20) trailingSpace++;
    for (let i = 0; i < len; i++) byteValues.set(f[i], (byteValues.get(f[i]) ?? 0) + 1);
  }
  const values = [...byteValues.keys()].sort((a, b) => a - b);
  return {
    names: dumps.length,
    lengthHistogram: Object.fromEntries(lengths.map((n, i) => [i, n]).filter(([, n]) => n)),
    fullLength16NoTerminator: fullLength,
    empty,
    nonZeroAfterTerminator,
    leadingSpace,
    trailingSpace,
    distinctByteValues: values.length,
    byteValues: values.map((v) => `0x${v.toString(16).padStart(2, "0")}`),
    minByte: values.length ? values[0] : null,
    maxByte: values.length ? values[values.length - 1] : null,
    allPrintableAscii: values.every((v) => v >= 0x20 && v <= 0x7e),
  };
}
