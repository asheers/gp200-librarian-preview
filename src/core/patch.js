// A patch as read from the pedal: an opaque 1176-byte dump. This module
// only *reads* a few fields (name, effect model codes) and builds .prst
// export files. It never changes patch content.
//
// Dump <-> .prst: file_offset = dump_offset + 0x28. A dump has no file
// magic/version (file 0x00-0x27) and no footer/checksum (0x4C0-0x4C7), so a
// .prst is built by overlaying the dump onto a skeleton .prst.
//
// Adapted from GP-200 Patch Manager Web (donpark2000, src/core/prst.js
// @ ff618e7, GPL-3.0), which ports the CLI's gp200.py; donpark's credit: the
// .prst layout, the 0x28 shift and the User-IR range come from GP200 Studio
// (Kabir S. Tamari, GPL-3.0); the SnapTone ranges were confirmed against
// RigSheet as facts only (no RigSheet code). The export normalization rules
// are donpark's own hardware findings. See docs/ATTRIBUTION.md.
//
// SPDX-License-Identifier: GPL-3.0-only

import { slotToLabel } from "./slots.js";

export const PRST_LEN = 1224;
export const CHECKSUM_OFF = 0x4c6;
export const CONTENT_FILE_START = 0x28; // file_offset = dump_offset + 0x28

const NAME_DUMP_OFF = 0x44 - CONTENT_FILE_START; // 28
const NAME_LEN = 16;

// Effect blocks, in dump offsets (file 0xA0 - 0x28 = 0x78).
export const EFFECT_BLOCK_COUNT = 11;
const DUMP_EFFECT_BLOCK_START = 0x78;
const DUMP_EFFECT_BLOCK_SIZE = 0x48;
const DUMP_EFFECT_MODEL_OFFSET = 8;

/** Shortest dump worth accepting: must cover the name and all effect blocks (912 bytes). */
export const MIN_DUMP_LEN = DUMP_EFFECT_BLOCK_START + EFFECT_BLOCK_COUNT * DUMP_EFFECT_BLOCK_SIZE;

// ---- Field categories (file offsets). Kept as separate named groups, as in
// donpark's code, because each exists for a different documented reason.
const tail = (ks) => ks.flatMap((k) => Array.from({ length: 8 }, (_, q) => 1120 + q * 12 + k));
/** Tail block bytes that are live device state (change on reads/saves). */
export const TAIL_BLOCK_FILE_OFFSETS = tail([6, 7]);
/** Slot-mirror byte that Valeton's exporter zeroes. */
export const EXPORT_ZEROED_SLOT_ECHO_OFFSET = 0x2e;
/** Further bytes Valeton's own exporter always writes as 0. */
export const STUDIO_ADDITIONAL_ZEROED_OFFSETS = [0x3e, 0x40, ...tail([5, 10, 11])];
/** The device only ever stores 0x00 here. */
export const DEAD_BYTE_FILE_OFFSETS = [0x43, 0x9f];
/** Pedal-managed bytes (not a setting; donpark journal 2026-10-01). */
export const PEDAL_MANAGED_FILE_OFFSETS = [0x44e, 0x456];
/** Slot-mirror bytes that carry the slot number on export. */
export const SLOT_MIRROR_OFFSETS = [0x34, 0x90];

/** Every file offset that normalizeExport() forces to 0x00. */
export const EXPORT_NORMALIZED_OFFSETS = Object.freeze([...new Set([
  ...TAIL_BLOCK_FILE_OFFSETS, EXPORT_ZEROED_SLOT_ECHO_OFFSET, ...STUDIO_ADDITIONAL_ZEROED_OFFSETS, ...DEAD_BYTE_FILE_OFFSETS,
])].sort((a, b) => a - b));

export function prstChecksum(data) {
  let sum = 0;
  for (let i = 0; i < CHECKSUM_OFF; i++) sum += data[i];
  return sum & 0xffff;
}

function writeChecksum(out) {
  const c = prstChecksum(out);
  out[CHECKSUM_OFF] = c >> 8;
  out[CHECKSUM_OFF + 1] = c & 0xff;
}

export function checksumOk(fileBytes) {
  return fileBytes.length >= CHECKSUM_OFF + 2 &&
    ((fileBytes[CHECKSUM_OFF] << 8) | fileBytes[CHECKSUM_OFF + 1]) === prstChecksum(fileBytes);
}

/** Is this a plausible .prst file? */
export function isPrst(bytes) {
  return bytes.length === PRST_LEN && bytes[0] === 0x54 && bytes[1] === 0x53 && bytes[2] === 0x52 && bytes[3] === 0x50;
}

export function validateSkeleton(bytes) {
  if (!isPrst(bytes)) throw new Error("not a valid 1224-byte .prst skeleton");
  return bytes;
}

/** Overlay a device dump onto the skeleton's content region; recompute the checksum. */
export function buildPrstFromDump(decoded, skeleton) {
  const out = Uint8Array.from(skeleton);
  const end = Math.min(CONTENT_FILE_START + decoded.length, CHECKSUM_OFF);
  out.set(decoded.subarray(0, end - CONTENT_FILE_START), CONTENT_FILE_START);
  writeChecksum(out);
  return out;
}

/** Zero the fields that aren't stable patch content, so the same patch
 *  always exports to the same bytes (donpark's normalize_export_dynamic_fields).
 *  Leaves the 0x34/0x90 slot mirrors alone. */
export function normalizeExport(fileBytes) {
  const out = Uint8Array.from(fileBytes);
  for (const off of EXPORT_NORMALIZED_OFFSETS) out[off] = 0;
  writeChecksum(out);
  return out;
}

/** The .prst export for one dump: skeleton overlay, then normalization (= donpark's export). */
export function exportPrst(decoded, skeleton) {
  return normalizeExport(buildPrstFromDump(decoded, skeleton));
}

/** Patch name for display and file naming. Non-ASCII bytes become U+FFFD
 *  rather than a confident-looking guess (the character set is unconfirmed). */
export function extractNameField(decoded) {
  let s = "";
  for (let i = NAME_DUMP_OFF; i < NAME_DUMP_OFF + NAME_LEN && i < decoded.length; i++) {
    const b = decoded[i];
    if (b === 0) break;
    s += b < 0x80 ? String.fromCharCode(b) : "�";
  }
  return s;
}

/** Name for on-screen display: control characters shown as spaces, trimmed. */
export function displayName(decoded) {
  // eslint-disable-next-line no-control-regex
  return pyStrip(extractNameField(decoded).replace(/[\x00-\x1f\x7f]/g, " "));
}

// Python's str.strip() with no argument (ASCII part). Includes \x1c-\x1f,
// which JavaScript's trim() does not; needed to match donpark's file names.
const PY_WHITESPACE = " \t\n\x0b\x0c\r\x1c\x1d\x1e\x1f";

function pyStrip(s, chars = PY_WHITESPACE) {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

/** Sanitize a patch name for use as a file name (donpark's safe_filename). */
export function safeFilename(name) {
  let n = pyStrip(name) || "patch";
  n = n.replace(/[\\/:*?"<>|]+/g, "_");
  return pyStrip(n, " .") || "patch";
}

/** e.g. "34A_Clean Tone.prst", as donpark's CLI and web app name exports. */
export function exportFileName(slot, decoded) {
  const label = slotToLabel(slot);
  return `${label}_${safeFilename(extractNameField(decoded) || label)}.prst`;
}

/** The effect model code (u32 LE) of each of the 11 blocks; null if the dump is too short. */
export function effectModelCodes(decoded) {
  const codes = [];
  for (let i = 0; i < EFFECT_BLOCK_COUNT; i++) {
    const base = DUMP_EFFECT_BLOCK_START + i * DUMP_EFFECT_BLOCK_SIZE + DUMP_EFFECT_MODEL_OFFSET;
    codes.push(base + 4 > decoded.length ? null
      : (decoded[base] | (decoded[base + 1] << 8) | (decoded[base + 2] << 16) | (decoded[base + 3] << 24)) >>> 0);
  }
  return codes;
}

/**
 * Effect blocks that point at a User-IR or SnapTone (NAM) slot by number.
 * The patch stores only the slot index (as stored, counting from 0), never
 * the IR/NAM content itself.
 * @returns {{kind: "IR"|"NAM", index: number, role: "amp"|"dist"|null, block: number, text: string}[]}
 */
export function irNamDependencies(decoded) {
  const found = [];
  effectModelCodes(decoded).forEach((code, block) => {
    if (code === null) return;
    if (code >= 0x0a100000 && code < 0x0a100000 + 30) {
      const index = code - 0x0a100000;
      found.push({ kind: "IR", index, role: null, block, text: `User-IR slot ${index}` });
    } else if (code >= 0x0f000000 && code < 0x0f000005) {
      const index = code - 0x0f000000;
      found.push({ kind: "NAM", index, role: "amp", block, text: `SnapTone (NAM) slot ${index} (amp)` });
    } else if (code >= 0x0f000005 && code < 0x0f00000a) {
      const index = code - 0x0f000005;
      found.push({ kind: "NAM", index, role: "dist", block, text: `SnapTone (NAM) slot ${index} (dist)` });
    }
  });
  return found;
}

/** Human-readable name for a .prst file offset, for difference reports. */
export function describeOffset(off) {
  const r = (a, b) => off >= a && off < b;
  if (r(0x00, 0x04)) return "magic";
  if (r(0x1c, 0x20)) return "per-export nonce";
  if (r(0x28, 0x2e)) return "PC-software stamp";
  if (off === 0x2e || off === 0x34 || off === 0x90) return "slot-mirror byte";
  if (off === 0x3e || off === 0x40) return "export-zeroed byte";
  if (off === 0x43 || off === 0x9f) return "dead byte";
  if (r(0x44, 0x54)) return `name[${off - 0x44}]`;
  if (r(0x54, 0x64)) return `author[${off - 0x54}]`;
  if (r(0x64, 0x8c)) return `note[${off - 0x64}]`;
  if (r(0x8c, 0xa0)) return "pre-effects header";
  if (r(0xa0, 0xa0 + 11 * 72)) {
    const block = Math.floor((off - 0xa0) / 72);
    const rel = (off - 0xa0) % 72;
    let what = `+${rel}`;
    if (rel === 4) what = "slot index";
    else if (rel === 5) what = "enabled";
    else if (rel >= 8 && rel < 12) what = "model code";
    else if (rel >= 12) what = `param ${Math.floor((rel - 12) / 4)}`;
    return `effect block ${block} ${what}`;
  }
  if (PEDAL_MANAGED_FILE_OFFSETS.includes(off)) return "pedal-managed byte (not a setting)";
  if (r(1120, 1120 + 96)) return `tail block entry ${Math.floor((off - 1120) / 12)} +${(off - 1120) % 12}`;
  if (r(0x4c6, 0x4c8)) return "checksum";
  return "other";
}
