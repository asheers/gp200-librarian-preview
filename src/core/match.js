// Patch identity keys for finding the same patch in different places
// (Phase 3 S1/S2). No DOM code.
//
//   contentKey     exact patch content: SHA-256 of the dump with the stamp,
//                  the slot fields and the 18 read-volatile bytes masked.
//                  Used for DUP within one read (S1).
//   normalizedKey  the same, also masking the 45 bytes a .prst export zeroes
//                  (patch.js EXPORT_NORMALIZED_OFFSETS), so a raw dump and a
//                  .prst of the same patch match. Used across sources: live
//                  pedal, backups (raw or .prst) and Templates (S2).
//
// SPDX-License-Identifier: GPL-3.0-only

import { CONTENT_FILE_START, EXPORT_NORMALIZED_OFFSETS } from "./patch.js";
import { sha256Hex } from "./sha256.js";
import { READ_VOLATILE_FILE_OFFSETS } from "./volatile.js";

const STAMP_AND_SLOT = [0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x34, 0x90];
export const CONTENT_KEY_MASK = Object.freeze([...new Set([...STAMP_AND_SLOT, ...READ_VOLATILE_FILE_OFFSETS])]);
export const NORMALIZED_KEY_MASK = Object.freeze([...new Set([...CONTENT_KEY_MASK, ...EXPORT_NORMALIZED_OFFSETS])]);

function maskedHash(dump, mask) {
  const d = Uint8Array.from(dump);
  for (const off of mask) d[off - CONTENT_FILE_START] = 0;
  return sha256Hex(d);
}

/** Exact patch identity (ignores stamp, slot fields and read-volatile bytes). */
export function contentKey(dump) {
  return maskedHash(dump, CONTENT_KEY_MASK);
}

/** Identity across raw dumps and .prst files (also ignores the bytes a .prst export zeroes). */
export function normalizedKey(dump) {
  return maskedHash(dump, NORMALIZED_KEY_MASK);
}

/**
 * An index of where each patch is: normalizedKey -> places. A place is
 * {where: "live"|"backup"|"template", slot?, id?, name?}.
 */
export class MatchIndex {
  constructor() {
    this.map = new Map();
  }

  add(key, place) {
    if (!key) return;
    (this.map.get(key) ?? this.map.set(key, []).get(key)).push(place);
  }

  /** Places with this key, except `self` (compared by where/slot/id). */
  find(key, self = null) {
    return (this.map.get(key) ?? []).filter((p) => !self || p.where !== self.where || p.slot !== self.slot || p.id !== self.id);
  }
}
