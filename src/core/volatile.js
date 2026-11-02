// Classified comparison of two raw dumps of the same slot.
//
// Two plain reads of an untouched slot do not return identical bytes. On the
// user's GP-200 (firmware 1.8.0, 3 reads x 256 slots, 2026-10-07) every
// read-to-read difference was at one of these documented positions, and
// nothing else ever changed:
//   - the dead bytes 0x43 and 0x9F: single-read noise around 0x00
//     (donpark PROTOCOL_NOTES.md findings 2, 5 and 8);
//   - tail block entries 0-7, bytes +6/+7: live device state that changes on
//     every plain read (donpark PROTOCOL.md "Tail block", PROTOCOL_NOTES.md
//     finding 8).
//
// This is a DELIBERATELY CLOSED LIST. Do not add a position to it because it
// was seen changing: any other differing byte is a patch-content difference
// and a finding to investigate. tests/volatile.test.js pins the exact set.
//
// Nothing is hidden: classifyDumpDiff returns every differing byte, either
// as `volatile` (with its class) or as `content`.
//
// SPDX-License-Identifier: GPL-3.0-only

import { CONTENT_FILE_START, DEAD_BYTE_FILE_OFFSETS, describeOffset, TAIL_BLOCK_FILE_OFFSETS } from "./patch.js";

export const VOLATILE_TAIL = "tail +6/+7";
export const VOLATILE_DEAD = "dead byte 0x43/0x9F";

/** file offset -> volatile class. The closed list described above (18 offsets). */
const READ_VOLATILE = new Map([
  ...DEAD_BYTE_FILE_OFFSETS.map((off) => [off, VOLATILE_DEAD]),
  ...TAIL_BLOCK_FILE_OFFSETS.map((off) => [off, VOLATILE_TAIL]),
]);

/** The documented read-volatile file offsets, sorted. */
export const READ_VOLATILE_FILE_OFFSETS = Object.freeze([...READ_VOLATILE.keys()].sort((a, b) => a - b));

/** The volatile class of a file offset, or null if it is patch content. */
export function readVolatileClass(fileOff) {
  return READ_VOLATILE.get(fileOff) ?? null;
}

/**
 * Compare two raw dumps of one slot and classify every differing byte.
 * Offsets in the result are FILE offsets (dump offset + 0x28).
 * A length difference always counts as a patch-content difference.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {{volatile: {off: number, a: number|undefined, b: number|undefined, what: string, cls: string}[],
 *   content: {off: number, a: number|undefined, b: number|undefined, what: string}[],
 *   lengthA: number, lengthB: number, rawIdentical: boolean, contentIdentical: boolean}}
 */
export function classifyDumpDiff(a, b) {
  const volatile = [];
  const content = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    const off = i + CONTENT_FILE_START;
    const d = { off, a: a[i], b: b[i], what: describeOffset(off) };
    const cls = readVolatileClass(off);
    if (cls) volatile.push({ ...d, cls });
    else content.push(d);
  }
  const sameLength = a.length === b.length;
  return {
    volatile, content, lengthA: a.length, lengthB: b.length,
    rawIdentical: sameLength && volatile.length === 0 && content.length === 0,
    contentIdentical: sameLength && content.length === 0,
  };
}

/** Count volatile differences by class: [[cls, bytes, slots]] in a fixed order. */
export function summarizeVolatile(perSlot) {
  const out = [];
  for (const cls of [VOLATILE_TAIL, VOLATILE_DEAD]) {
    let bytes = 0;
    let slots = 0;
    for (const diffs of perSlot) {
      const k = diffs.filter((d) => d.cls === cls).length;
      bytes += k;
      if (k) slots++;
    }
    out.push([cls, bytes, slots]);
  }
  return out;
}
