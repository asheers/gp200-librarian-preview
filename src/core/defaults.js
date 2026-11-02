// Which slots hold the pedal's factory default patch ("It's GP-200")?
// Decided by CONTENT, never by the name alone (Phase 3 S0 item D; approved
// rule, docs/PHASE3_DESIGN.md section 7).
//
// The canonical default is the skeleton's dump region. On the user's pedal
// (2026-10-08) 43 slots match it exactly under the rule below.
//
// Compared: the whole 1176-byte dump (file 0x28-0x4BF) EXCEPT
//   - 0x28-0x2D, the PC stamp (pedal-owned, never uploaded);
//   - 0x2E/0x34/0x90, the slot fields, which instead must hold the slot's
//     own number (otherwise the slot is "unverified");
//   - the 18 read-volatile offsets.
// That leaves 1,149 compared bytes, INCLUDING the 16 name bytes.
//
// Classes:
//   default          all 1,149 bytes equal, name included: the only class
//                    that counts as unused;
//   renamed-default  differs only inside the name (0x44-0x53): real, protected;
//   edited-default   name bytes equal the default's, and 1-8 other bytes
//                    differ: real, protected (the 8 is a display label only);
//   real             everything else (namedLikeDefault marks a real patch
//                    whose name bytes equal the default's);
//   unverified       wrong length, or slot fields not holding the slot's own
//                    number: treated as real.
//
// SPDX-License-Identifier: GPL-3.0-only

import { CONTENT_FILE_START, EXPORT_NORMALIZED_OFFSETS } from "./patch.js";
import { NAME_FILE_OFFSET, NAME_LEN } from "./names.js";
import { skeletonBytes } from "./skeleton.js";
import { slotToDisplayLabel } from "./slots.js";
import { EXPECTED_DUMP_LEN } from "./sysex.js";
import { readVolatileClass } from "./volatile.js";

export const SLOT_FIELD_FILE_OFFSETS = Object.freeze([0x2e, 0x34, 0x90]);
const STAMP = [0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d];
export const EDITED_DEFAULT_MAX_DIFFS = 8; // display label only

// The canonical default patch: the skeleton's 1176-byte dump region (private; canonicalDefault() hands out copies).
const CANONICAL_DEFAULT = Uint8Array.from(skeletonBytes().subarray(CONTENT_FILE_START, CONTENT_FILE_START + EXPECTED_DUMP_LEN));

/** A copy of the canonical default dump, with its slot fields set to `slot` if given. */
export function canonicalDefault(slot = null) {
  const d = Uint8Array.from(CANONICAL_DEFAULT);
  if (slot !== null) for (const off of SLOT_FIELD_FILE_OFFSETS) d[off - CONTENT_FILE_START] = slot;
  return d;
}

/** File offsets compared for default detection (1,149 of them). */
export const DEFAULT_COMPARED_FILE_OFFSETS = Object.freeze(Array.from({ length: EXPECTED_DUMP_LEN }, (_, i) => i + CONTENT_FILE_START)
  .filter((off) => !STAMP.includes(off) && !SLOT_FIELD_FILE_OFFSETS.includes(off) && !readVolatileClass(off)));

/** The same, for content from a .prst: also leaves out the bytes the .prst format zeroes. */
export const DEFAULT_COMPARED_NORMALIZED = Object.freeze(DEFAULT_COMPARED_FILE_OFFSETS.filter((off) => !EXPORT_NORMALIZED_OFFSETS.includes(off)));

const inName = (off) => off >= NAME_FILE_OFFSET && off < NAME_FILE_OFFSET + NAME_LEN;

/**
 * Classify one slot's dump against the canonical default.
 * @returns {{cls: "default"|"renamed-default"|"edited-default"|"real"|"unverified", unused: boolean,
 *   nameDiffs: number, otherDiffs: number, namedLikeDefault: boolean, reason?: string}}
 */
export function classifyDefault(dump, slot, { normalized = false } = {}) {
  if (!(dump instanceof Uint8Array) || dump.length !== EXPECTED_DUMP_LEN) {
    return { cls: "unverified", unused: false, nameDiffs: 0, otherDiffs: 0, namedLikeDefault: false, reason: `dump is ${dump?.length ?? "missing"}` };
  }
  // Content from a .prst (normalized): 0x2E and the other export-normalized bytes were zeroed by the
  // format, so they are left out of the comparison and the slot check uses 0x34/0x90 only (Phase 3 S2).
  const slotFields = normalized ? SLOT_FIELD_FILE_OFFSETS.filter((off) => off !== 0x2e) : SLOT_FIELD_FILE_OFFSETS;
  const compared = normalized ? DEFAULT_COMPARED_NORMALIZED : DEFAULT_COMPARED_FILE_OFFSETS;
  const badSlot = slotFields.filter((off) => dump[off - CONTENT_FILE_START] !== slot);
  if (badSlot.length) {
    return {
      cls: "unverified", unused: false, nameDiffs: 0, otherDiffs: 0, namedLikeDefault: false,
      reason: `slot field(s) ${badSlot.map((o) => `0x${o.toString(16)}`).join(", ")} do not hold ${slotToDisplayLabel(slot)}`,
    };
  }
  let nameDiffs = 0;
  let otherDiffs = 0;
  for (const off of compared) {
    const i = off - CONTENT_FILE_START;
    if (dump[i] === CANONICAL_DEFAULT[i]) continue;
    if (inName(off)) nameDiffs++;
    else otherDiffs++;
  }
  const namedLikeDefault = nameDiffs === 0;
  let cls = "real";
  if (!nameDiffs && !otherDiffs) cls = "default";
  else if (!otherDiffs) cls = "renamed-default";
  else if (namedLikeDefault && otherDiffs <= EDITED_DEFAULT_MAX_DIFFS) cls = "edited-default";
  return { cls, unused: cls === "default", nameDiffs, otherDiffs, namedLikeDefault };
}

/**
 * Classify every read slot of a snapshot.
 * @returns {{bySlot: (ReturnType<typeof classifyDefault>|null)[], counts: Record<string, number>,
 *   namedLikeDefaultReal: number[], selfCheck: string|null}}
 */
export function classifyDefaults(dumps) {
  const bySlot = dumps.map((d, slot) => (d ? classifyDefault(d, slot) : null));
  const counts = { default: 0, "renamed-default": 0, "edited-default": 0, real: 0, unverified: 0 };
  for (const c of bySlot) if (c) counts[c.cls]++;
  const namedLikeDefaultReal = bySlot.flatMap((c, s) => (c?.cls === "real" && c.namedLikeDefault ? [s] : []));
  const read = bySlot.filter(Boolean).length;
  return {
    bySlot, counts, namedLikeDefaultReal,
    selfCheck: read && counts.default === 0 ? "no slot on this pedal matches the built-in default patch" : null,
  };
}

/** One line for the log, e.g. "43 unused (exact default), 0 renamed default, 1 edited default (57-B), ...". */
export function describeDefaults(r) {
  const at = (cls) => r.bySlot.flatMap((c, s) => (c?.cls === cls ? [slotToDisplayLabel(s)] : []));
  const list = (cls) => {
    const l = at(cls);
    return l.length && l.length <= 8 ? ` (${l.join(", ")})` : "";
  };
  return `${r.counts.default} unused (exact built-in default), ${r.counts["renamed-default"]} renamed default${list("renamed-default")}, ` +
    `${r.counts["edited-default"]} edited default${list("edited-default")}, ${r.counts.real} real` +
    (r.namedLikeDefaultReal.length
      ? ` (of which ${r.namedLikeDefaultReal.length} named like the default: ${r.namedLikeDefaultReal.slice(0, 8).map(slotToDisplayLabel).join(", ")})` : "") +
    `, ${r.counts.unverified} unverified${list("unverified")}`;
}

/**
 * The canonical default self-check (design 7.3; S3.0, 2026-10-18), after a
 * read. It says plainly whether the built-in default patch ("It's GP-200",
 * the canonical default) exists on this pedal, and so whether a Move may
 * clear its source slot to it. Move-with-clear stays disabled unless the
 * check saw the default on a COMPLETE read (S3: "disabled until it is
 * understood"). No pedal access; it only reads the classification.
 * @param {ReturnType<typeof classifyDefaults>|null|undefined} defaults
 * @param {{complete: boolean}} o whether all 256 slots were read
 * @returns {{status: "present"|"absent"|"not-checked", count: number, moveClearAllowed: boolean, text: string}}
 */
export function defaultSelfCheck(defaults, { complete }) {
  const count = defaults?.counts?.default ?? 0;
  if (!defaults || !complete) {
    return { status: "not-checked", count, moveClearAllowed: false,
      text: "Default check: not done, because not every slot was read. Moving patches will not clear slots until a complete read." };
  }
  if (!count) {
    return { status: "absent", count: 0, moveClearAllowed: false,
      text: "Default check: no slot on this pedal matches the built-in default patch (\"It's GP-200\"), so moving patches will not clear slots." };
  }
  return { status: "present", count, moveClearAllowed: true,
    text: `Default check: ${count} unused slot${count === 1 ? "" : "s"} match${count === 1 ? "es" : ""} the built-in default patch ("It's GP-200").` };
}
