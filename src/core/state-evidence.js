// The R1 state bytes: recorded as observed, classified conservatively.
// (Phase 3 S0, approved rule; docs/PHASE3_DESIGN.md section 8.)
//
// Evidence (R1 and W1, the user's GP-200, firmware 1.8.0, 2026-10-07):
// six specific bytes read differently depending on which patch is ACTIVE on
// the pedal. In all 16 complete reads on file they read either 2,2,2,2,3,3 or
// 0,0,0,0,0,0 (in the register order below), never a mix, and nothing else
// changed between reads. Not established: that there are exactly two
// meaningful pedal states, which property of the active patch matters, or
// that other content has other such bytes. So this module gives the state
// no meaning. It records what was read (the six values, as a "signature")
// and the active slot when known (recorded only, never used to classify).
//
// THE EVIDENCE REGISTER BELOW IS CLOSED, and separate from the 18-byte
// read-volatile list (volatile.js), which it does not change. Each entry is
// tied to its patch by a content fingerprint, so the evidence does not
// follow an edited or replaced patch. Changing the register is a deliberate,
// reviewed change; tests/state-evidence.test.js pins it.
//
// A differing byte at (slot, offset) between two COMPLETE reads is
// STATE-DEPENDENT only if ALL hold:
//   1. (slot, offset) is a register entry;
//   2. both dumps of that slot match the entry's fingerprint;
//   3. both values are in the entry's observed set;
//   4. both reads are complete and "recognised": all six evidenced slots
//      hold their evidenced patches and the signature is an observed one.
// Otherwise it stays PATCH CONTENT. A complete read whose six evidenced
// patches are all present but whose signature was never observed is a
// FINDING, never excused. Single-slot reads, selections and copy
// verification have no full-read context and are never classified here.
//
// SPDX-License-Identifier: GPL-3.0-only

import { CONTENT_FILE_START } from "./patch.js";
import { sha256Hex } from "./sha256.js";
import { labelToSlot, slotToDisplayLabel, TOTAL_SLOTS } from "./slots.js";
import { EXPECTED_DUMP_LEN } from "./sysex.js";
import { READ_VOLATILE_FILE_OFFSETS } from "./volatile.js";

const entry = (label, fileOff, values, fingerprint) =>
  Object.freeze({ label, slot: labelToSlot(label), fileOff, values: Object.freeze(values), fingerprint });

/** The six evidenced bytes, in signature order. Fingerprints computed from the user's backups
 *  (identical in all 16 complete reads, Phase 1 r1-r3, W1 B1-B3, R1 A1-A10). */
export const STATE_EVIDENCE = Object.freeze([
  entry("12D", 0x44e, [0, 2], "fb52d8aeb74f3997ce260f9a31dd86f43ff8c5e096f9c32da5589a479b5b6f03"),
  entry("33D", 0x44e, [0, 2], "87bc9614cfd0d70468597a32c542b73ffefcd59594d1424274300013593a483b"),
  entry("35D", 0x456, [0, 2], "fc6ddf45ad03f14ced9f0fe29b4f3a1eb5f2e1f76e1ad16627862b8354542ac6"),
  entry("51D", 0x456, [0, 2], "6698235473eb05094775b2d69128382cd58f09bfa39538464ee3583fedb7a34a"),
  entry("41D", 0x3be, [0, 3], "cf2f38ee3c68014675d3adb97a8c7ca1ddb3adaee8509c5d2955818287399012"),
  entry("58A", 0x3be, [0, 3], "bda8c7d8ecd0e079d4e2530f301733eb988e409b0dee86b16390ff9a1cde85be"),
]);

/** Whole-read signatures seen in the 16 complete reads on file. */
export const OBSERVED_SIGNATURES = Object.freeze(["000000", "222233"]);

/**
 * D1 (approved 2026-11-01): the patches every write refuses. The register above, plus patches later
 * seen to read differently with the active patch: 41-D at 0x3BE (0/3), fingerprinted again after its
 * edit because the dependence survived the edit (CP1, Slice A), and 64-A..64-D at 0x44E (0/5; E1, W2,
 * CP1). Fingerprints from the SA-0, SA-8, W2 and E1 pre-flight backups (identical in all four). Kept
 * apart from the register, so compare classification and signatures do not change. Changing this
 * list is a deliberate, reviewed change; tests/unlock.test.js pins it.
 */
export const WRITE_REFUSALS = Object.freeze([
  ...STATE_EVIDENCE,
  entry("41D", 0x3be, [0, 3], "7a1353d3dad93490955ef93a6b13abd0bda3097bfd8c98c3abd16e7240d5763e"),
  entry("64A", 0x44e, [0, 5], "da0b39eae313dba78196acac99cb8be5edc897b82db727ba2f0f69e6ef483ebb"),
  entry("64B", 0x44e, [0, 5], "e7052580a20cc59b7cd2331803645ab1c110e7457485a17d2aed5f11a15c208f"),
  entry("64C", 0x44e, [0, 5], "ff6a78b59711a2774feb5a4a2b7fdbfc10ce49f6ee3222c2d577977825b8c3e6"),
  entry("64D", 0x44e, [0, 5], "e1d34a162db92ad41249d35d60eba875173ed37a48789715fbae92077c7f7448"),
]);

/**
 * Must a write refuse this input? Yes if its slot is a listed slot (so an edit does not lift a refusal
 * unnoticed, as 41-D's edit did) or its content matches a listed fingerprint (wherever it now is).
 */
export function writeRefused(slot, dump, list = WRITE_REFUSALS) {
  return list.some((e) => e.slot === slot || (dump instanceof Uint8Array && evidenceFingerprint(dump, e.fileOff) === e.fingerprint));
}

/** File offsets masked to 0x00 in every fingerprint (besides the entry's own byte). */
export const FINGERPRINT_MASKED_FILE_OFFSETS = Object.freeze([
  0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, // PC stamp
  0x2e, 0x34, 0x90, // slot fields
  ...READ_VOLATILE_FILE_OFFSETS,
]);

/**
 * The patch's identity apart from the evidenced byte: SHA-256 of the dump
 * with that byte, the stamp, the slot fields and the 18 read-volatile
 * offsets set to 0x00.
 */
export function evidenceFingerprint(dump, fileOff) {
  const d = Uint8Array.from(dump);
  for (const off of [...FINGERPRINT_MASKED_FILE_OFFSETS, fileOff]) d[off - CONTENT_FILE_START] = 0;
  return sha256Hex(d);
}

const digit = (v) => (v < 16 ? v.toString(16) : `[${v.toString(16)}]`);

/**
 * What one read shows of the evidenced bytes.
 * @param {(Uint8Array|null|undefined)[]|Map<number,Uint8Array>} dumps by slot
 * @param {{activeSlot?: object|null, register?: typeof STATE_EVIDENCE, signatures?: readonly string[]}} [opts]
 * @returns {StateObservation}
 * @typedef {{values: {label: string, slot: number, fileOff: number, value: number|null, evidencedPatch: boolean}[],
 *   signature: string, complete: boolean, applicable: boolean, recognised: boolean, finding: string|null,
 *   activeSlot: object|null}} StateObservation
 *   complete: all 256 slots present with full-length dumps;
 *   applicable: complete, and all six evidenced patches present (fingerprints match);
 *   recognised: applicable, and the signature is an observed one.
 */
export function observeState(dumps, { activeSlot = null, register = STATE_EVIDENCE, signatures = OBSERVED_SIGNATURES } = {}) {
  const get = (s) => (dumps instanceof Map ? dumps.get(s) : dumps[s]);
  let complete = true;
  for (let s = 0; s < TOTAL_SLOTS; s++) {
    const d = get(s);
    if (!d || d.length !== EXPECTED_DUMP_LEN) {
      complete = false;
      break;
    }
  }
  const values = register.map((e) => {
    const d = get(e.slot);
    const ok = !!d && d.length === EXPECTED_DUMP_LEN;
    return {
      label: e.label, slot: e.slot, fileOff: e.fileOff,
      value: ok ? d[e.fileOff - CONTENT_FILE_START] : null,
      evidencedPatch: ok && evidenceFingerprint(d, e.fileOff) === e.fingerprint,
    };
  });
  const signature = values.map((v) => (v.value === null ? "-" : !v.evidencedPatch ? "?" : digit(v.value))).join("");
  const applicable = complete && values.every((v) => v.evidencedPatch);
  const recognised = applicable && signatures.includes(signature);
  return {
    values, signature, complete, applicable, recognised,
    finding: applicable && !recognised
      ? `unrecognised state signature ${signature} (observed so far: ${signatures.join(", ")}): a finding to investigate`
      : null,
    activeSlot: activeSlot ? { ...activeSlot } : null,
  };
}

/** One line describing an observation, for logs and reports. */
export function describeObservation(o) {
  const active = o.activeSlot ? `${slotToDisplayLabel(o.activeSlot.slot)} (${o.activeSlot.how})` : "unknown";
  if (!o.complete) return `state signature not recorded (not a complete set of 256 raw dumps); active slot ${active}`;
  if (!o.applicable) {
    const present = o.values.filter((v) => v.evidencedPatch).length;
    return `state evidence does not apply (${present} of ${o.values.length} evidenced patches present: signature ${o.signature}); ` +
      `active slot ${active}`;
  }
  return `state signature ${o.signature} (${o.recognised ? "observed before" : "NOT observed before"}); active slot ${active}`;
}

/**
 * Split one slot's PATCH CONTENT differences (from classifyDumpDiff) into
 * STATE-DEPENDENT and remaining PATCH CONTENT, by the rule above.
 * @returns {{stateDependent: object[], content: object[]}}
 */
export function splitStateDependent(slot, contentDiffs, dumpA, dumpB, obsA, obsB, { register = STATE_EVIDENCE } = {}) {
  if (!obsA?.recognised || !obsB?.recognised || !contentDiffs.length) return { stateDependent: [], content: contentDiffs };
  const entries = register.filter((e) => e.slot === slot);
  if (!entries.length) return { stateDependent: [], content: contentDiffs };
  const stateDependent = [];
  const content = [];
  for (const d of contentDiffs) {
    const e = entries.find((x) => x.fileOff === d.off);
    const ok = e && d.a !== undefined && d.b !== undefined &&
      e.values.includes(d.a) && e.values.includes(d.b) &&
      evidenceFingerprint(dumpA, e.fileOff) === e.fingerprint && evidenceFingerprint(dumpB, e.fileOff) === e.fingerprint;
    (ok ? stateDependent : content).push(ok ? { ...d, cls: "state-dependent" } : d);
  }
  return { stateDependent, content };
}
