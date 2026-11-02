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
//     and symbols; a full 16-character name is entered and displayed.
// Which byte the pedal stores for each symbol is NOT assumed: only byte values
// actually seen in dumps are treated as demonstrated.
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

// ---- Rename (S3.3): restricted to the byte values RESEARCH.md §14 / this
// file's own scan actually demonstrates in dumps (its first listed option,
// since the pedal editor's other symbols are not established). Every value
// below is also its own ASCII code point, so a character and its byte are
// the same thing here; "6" (0x36) and "q" (0x71) are deliberately absent.
// Mirrors tests/fixtures/name-facts.json "demonstratedByteValues".
export const DEMONSTRATED_NAME_BYTES = Object.freeze([
  0x20, 0x27, 0x28, 0x29, 0x2b, 0x2d, 0x2e,
  0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x37, 0x38, 0x39,
  0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d,
  0x4e, 0x4f, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a,
  0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d,
  0x6e, 0x6f, 0x70, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a,
]);
export const NAME_ALLOWED_CHARS = new Set(DEMONSTRATED_NAME_BYTES.map((b) => String.fromCharCode(b)));
/** For messages: what a rename accepts. */
export const NAME_ALLOWED_DESCRIPTION = "space, digits except 6, A-Z, a-z except q, and ' ( ) + - .";

export class NameError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "NameError";
    this.code = code;
  }
}

/** Throws NameError; otherwise returns `text` unchanged. */
export function validateName(text) {
  if (typeof text !== "string" || text.length === 0) throw new NameError("empty", "the name is empty");
  if (text.length > NAME_LEN) throw new NameError("too-long", `the name is ${text.length} characters; at most ${NAME_LEN} are allowed`);
  // No dump on file has a leading or trailing space (RESEARCH.md §14), so neither is assumed to be stored as typed.
  if (text !== text.trim()) throw new NameError("edge-space", "the name starts or ends with a space; remove it");
  const bad = [...new Set([...text].filter((ch) => !NAME_ALLOWED_CHARS.has(ch)))];
  if (bad.length) {
    throw new NameError("bad-char", `"${bad.join("")}" ${bad.length === 1 ? "is" : "are"} not a character the pedal has been shown ` +
      `to store in a name (allowed: ${NAME_ALLOWED_DESCRIPTION})`);
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
