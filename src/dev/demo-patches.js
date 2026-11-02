// Invented patch data for the demo mode and tests: 256 dumps built from the
// skeleton's content region with made-up names and a few User-IR/SnapTone
// references. Like the real pedal (hardware read, 2026-10-07), each dump
// carries its own slot number at file 0x2E, 0x34 and 0x90 and the stamp
// 00 00 04 00 01 00 at file 0x28-0x2D, and bank 60 (the scratch bank) holds
// the factory default "It's GP-200".
//
// SPDX-License-Identifier: GPL-3.0-only

import { CONTENT_FILE_START } from "../core/patch.js";
import { EXPECTED_DUMP_LEN } from "../core/sysex.js";

const NAMES = [
  "Clean AC30", "Crunch", "Gilmour", "Solo", "Wake Me Up", "I Ran", "Hackett", "Clean",
  "JC Chorus", "Marshall", "Flanger", "Acoustic", "Edge Delay", "Fuzz Face", "Plexi Lead", "Twin Clean",
  "Funk Rhythm", "Big Rhythm", "Ambient Pad", "Shimmer", "Blues Drive", "Tremolo", "Octave Up", "Wah Lead",
];

/** A 1176-byte dump for `slot`: the skeleton's content region with `name` and the slot fields written in. */
export function makeDump(skeleton, name, { irSlot = null, namAmp = null, slot = 0 } = {}) {
  const dump = Uint8Array.from(skeleton.subarray(CONTENT_FILE_START, CONTENT_FILE_START + EXPECTED_DUMP_LEN));
  dump.set([0x00, 0x00, 0x04, 0x00, 0x01, 0x00], 0); // file 0x28-0x2D, as on the real pedal
  for (const off of [0x2e, 0x34, 0x90]) dump[off - CONTENT_FILE_START] = slot;
  const nameOff = 0x44 - CONTENT_FILE_START;
  dump.fill(0, nameOff, nameOff + 16);
  for (let i = 0; i < Math.min(16, name.length); i++) dump[nameOff + i] = name.charCodeAt(i) & 0x7f;
  const setModel = (block, code) => {
    const at = 0x78 + block * 0x48 + 8;
    dump[at] = code & 0xff;
    dump[at + 1] = (code >> 8) & 0xff;
    dump[at + 2] = (code >> 16) & 0xff;
    dump[at + 3] = (code >>> 24) & 0xff;
  };
  if (irSlot !== null) setModel(5, 0x0a100000 + irSlot);
  if (namAmp !== null) setModel(4, 0x0f000000 + namAmp);
  return dump;
}

/**
 * A demo pedal laid out like a real one (Phase 3 S1, for ?demo): real patches
 * whose settings differ from the default, whole banks of exact defaults, a
 * renamed default (44-A), an edited default (57-B), duplicates (50-A = 51-B;
 * 51-A = 52-A = 53-A = 54-A), User-IR and SnapTone references, and the
 * scratch bank 60 holding defaults. Invented data, not the user's.
 */
export function realisticDemoDumps(skeleton) {
  const dumps = new Map();
  const def = (slot) => makeDump(skeleton, "It's GP-200", { slot });
  const settings = (dump, seed) => {
    // Change 12 parameter bytes in effect blocks 1-3 (dump offsets of block params), so it is clearly not the default.
    for (let i = 0; i < 12; i++) dump[0x78 + (1 + (i % 3)) * 0x48 + 12 + i] = (seed * 37 + i * 11) & 0xff || 1;
    return dump;
  };
  const real = (slot, name, opts = {}, seed = slot) => settings(makeDump(skeleton, name, { slot, ...opts }), seed);
  const unusedBanks = new Set([44, 46, 47, 48, 49, 59, 60, 61, 62, 63]);
  for (let slot = 0; slot < 256; slot++) {
    const bank = Math.floor(slot / 4) + 1;
    const name = `${NAMES[slot % NAMES.length]}${bank > 6 ? ` ${Math.floor(slot / NAMES.length) + 1}` : ""}`;
    dumps.set(slot, unusedBanks.has(bank) ? def(slot) : real(slot, name, {
      irSlot: slot % 11 === 3 ? slot % 30 : null,
      namAmp: slot % 17 === 5 ? slot % 5 : null,
    }));
  }
  dumps.set(172, makeDump(skeleton, "It's GP-200JBBBA", { slot: 172 })); // 44-A: renamed default
  for (const s of [173, 174, 175, 178, 179, 186, 187, 228, 229]) dumps.set(s, def(s)); // more unused slots, as on a real pedal
  const edited = def(225); // 57-B: the default with one setting changed
  edited[0x3c - CONTENT_FILE_START] ^= 1;
  dumps.set(225, edited);
  const twin = (slot, from, name) => dumps.set(slot, real(slot, name, {}, from)); // same settings as `from`
  twin(196, 196, "Big Rhythm 9");
  twin(201, 196, "Big Rhythm 9"); // 51-B = 50-A
  for (const s of [200, 204, 208, 212]) twin(s, 200, "Funk Rhythm 9"); // 51-A = 52-A = 53-A = 54-A
  return dumps;
}

/** slot -> dump for all 256 slots (the original demo set, used by the tests). */
export function demoDumps(skeleton) {
  const dumps = new Map();
  for (let slot = 0; slot < 256; slot++) {
    const name = slot >= 236 && slot <= 239 ? "It's GP-200" : `${NAMES[slot % NAMES.length]}${slot >= NAMES.length ? ` ${Math.floor(slot / NAMES.length) + 1}` : ""}`;
    dumps.set(slot, makeDump(skeleton, name, {
      slot,
      irSlot: slot % 11 === 3 ? slot % 30 : null,
      namAmp: slot % 17 === 5 ? slot % 5 : null,
    }));
  }
  return dumps;
}
