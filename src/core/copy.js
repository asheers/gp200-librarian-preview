// Phase 2: copy one patch into a scratch slot, verify it, and undo it.
//
// Safety sequence (CLAUDE.md "Safety rules", the user's Phase 2 brief):
//   prepare  1. destination must be a scratch slot (60-A..60-D), checked
//               before anything is read; the write guard checks it again
//            2. read the complete source and destination
//            3. both dumps must carry their own slot number in the slot
//               fields (proves the reads were addressed correctly)
//            4. refuse if the destination already holds this patch content
//               (a write that changes nothing cannot be verified)
//   (the UI shows the plan; the user confirms the overwrite by name)
//   execute  5. save the before-image to the journal; abort if that fails
//            6. re-read source and destination; abort if either changed
//               (PATCH CONTENT compare) since the user confirmed
//            7. enter editor mode (once per connection)
//            8. upload with the CLI pacing (device.writeImage)
//            9. read the destination back and verify it with the PATCH
//               CONTENT comparator against the expected bytes; on a
//               mismatch read it again (never write again) and report
//               whether the difference was stable
//           10. end-state check: re-read source (must be unchanged) and
//               destination (must still verify)
// Undo writes the captured before-image back through the same sequence,
// after checking the destination still holds what our copy left there.
//
// Patch bytes are copied verbatim. Only the destination-dependent bytes
// differ from the source: file 0x2E, 0x34 and 0x90 hold the slot's own
// number (all 256 slots of the user's pedal, 2026-10-07). The upload sends
// 0x2E = destination slot and 0x34/0x90 = 0xFF (the protocol's device-owned
// marker; the pedal fills in the slot). File 0x28-0x2D are not part of an
// upload at all. User-IR and NAM/SnapTone selectors are model codes inside
// the effect blocks, so they are copied unchanged and keep pointing at the
// same resource slot on this pedal; the resources themselves are untouched.
//
// SPDX-License-Identifier: GPL-3.0-only

import { WriteRefused } from "./device.js";
import { CONTENT_FILE_START, displayName, irNamDependencies } from "./patch.js";
import { slotToDisplayLabel } from "./slots.js";
import {
  EXPECTED_DUMP_LEN, UPLOAD_CONTENT_FILE_START, UPLOAD_HEADER_LEN, UPLOAD_HEADER_SLOT_INDICES, UPLOAD_IMAGE_LEN, uploadHeader,
} from "./sysex.js";
import { classifyDumpDiff } from "./volatile.js";
import { isScratchSlot, WriteGuardViolation } from "./write-guard.js";

/** File offsets that hold the slot's own number (hardware: 256 of 256 slots). */
export const SLOT_FIELD_FILE_OFFSETS = Object.freeze([0x2e, 0x34, 0x90]);
/** File offsets an upload does not carry (the 0x28-0x2D stamp). */
export const NOT_UPLOADED_FILE_OFFSETS = Object.freeze([0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d]);

const D = (fileOff) => fileOff - CONTENT_FILE_START; // file offset -> dump offset
const I = (fileOff) => UPLOAD_HEADER_LEN + fileOff - UPLOAD_CONTENT_FILE_START; // file offset -> image index

export class CopyError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "CopyError";
    this.code = code;
  }
}

function checkDump(dump, what) {
  if (!(dump instanceof Uint8Array) || dump.length !== EXPECTED_DUMP_LEN) {
    throw new CopyError("bad-dump", `${what} is ${dump?.length ?? "no"} bytes, expected ${EXPECTED_DUMP_LEN}`);
  }
}

/** Offsets (file) whose slot field does not hold `slot`. */
export function slotFieldMismatches(dump, slot) {
  return SLOT_FIELD_FILE_OFFSETS.filter((off) => dump[D(off)] !== slot);
}

/**
 * The upload image that writes `dump` to `destSlot`: inner header for the
 * destination, then dump bytes 6..1175 verbatim, except file 0x2E = the
 * destination slot and file 0x34/0x90 = 0xFF.
 */
export function buildWriteImage(dump, destSlot) {
  checkDump(dump, "the patch to write");
  const image = new Uint8Array(UPLOAD_IMAGE_LEN);
  image.set(uploadHeader(destSlot), 0);
  image.set(dump.subarray(D(UPLOAD_CONTENT_FILE_START)), UPLOAD_HEADER_LEN);
  image[I(0x2e)] = destSlot;
  image[I(0x34)] = 0xff;
  image[I(0x90)] = 0xff;
  return image;
}

/**
 * What the destination should read back as after writing `dump` to it:
 * `dump`, with the slot fields holding the destination slot and the bytes an
 * upload does not carry kept from the destination's own before-image.
 */
export function expectedAfterWrite(dump, destSlot, destBefore) {
  checkDump(dump, "the patch to write");
  checkDump(destBefore, "the destination before-image");
  const out = Uint8Array.from(dump);
  for (const off of SLOT_FIELD_FILE_OFFSETS) out[D(off)] = destSlot;
  for (const off of NOT_UPLOADED_FILE_OFFSETS) out[D(off)] = destBefore[D(off)];
  return out;
}

const label = slotToDisplayLabel;
const nameOf = (dump) => displayName(dump) || "(no name)";

async function readFull(device, slot, what) {
  const { decoded } = await device.readDump(slot);
  checkDump(decoded, `${what} (${label(slot)})`);
  return decoded;
}

/**
 * Steps 1-4: read and check everything a copy needs; send nothing but reads.
 * @returns {Promise<CopyPlan>}
 * @typedef {{op: "copy"|"undo", createdAt: string,
 *   source: {slot: number, dump: Uint8Array, name: string, irNam: object[]}|null,
 *   dest: {slot: number, before: Uint8Array, name: string, irNam: object[]},
 *   write: {dump: Uint8Array, name: string, irNam: object[]},
 *   image: Uint8Array, expected: Uint8Array}} CopyPlan
 */
export async function prepareCopy(device, sourceSlot, destSlot, { log }) {
  if (!isScratchSlot(destSlot)) {
    throw new CopyError("not-scratch", `${Number.isInteger(destSlot) && destSlot >= 0 && destSlot < 256 ? label(destSlot) : destSlot} ` +
      "is not a scratch slot. Phase 2 can write only to 60-A, 60-B, 60-C or 60-D.");
  }
  if (!Number.isInteger(sourceSlot) || sourceSlot < 0 || sourceSlot > 255) throw new CopyError("bad-source", `no slot ${sourceSlot}`);
  if (sourceSlot === destSlot) throw new CopyError("same-slot", `source and destination are both ${label(destSlot)}`);
  log.info(`Copy ${label(sourceSlot)} -> ${label(destSlot)}: reading source and destination`);
  const source = await readFull(device, sourceSlot, "source");
  const before = await readFull(device, destSlot, "destination");
  for (const [dump, slot, what] of [[source, sourceSlot, "source"], [before, destSlot, "destination"]]) {
    const bad = slotFieldMismatches(dump, slot);
    if (bad.length) {
      throw new CopyError("slot-fields", `the ${what} read of ${label(slot)} does not carry its own slot number at file ` +
        `${bad.map((o) => `0x${o.toString(16)}=0x${dump[D(o)].toString(16)}`).join(", ")}. Nothing was written.`);
    }
  }
  const plan = makePlan("copy", { source: { slot: sourceSlot, dump: source }, destSlot, before, write: source });
  if (classifyDumpDiff(before, plan.expected).contentIdentical) {
    throw new CopyError("nothing-to-do", `${label(destSlot)} already holds the same patch content as ${label(sourceSlot)}; ` +
      "nothing to write (and a write that changes nothing could not be verified).");
  }
  log.info(`Copy plan: ${describePlan(plan).title}`);
  return plan;
}

function makePlan(op, { source = null, destSlot, before, write }) {
  return {
    op,
    createdAt: new Date().toISOString(),
    source: source && { slot: source.slot, dump: source.dump, name: nameOf(source.dump), irNam: irNamDependencies(source.dump) },
    dest: { slot: destSlot, before, name: nameOf(before), irNam: irNamDependencies(before) },
    write: { dump: write, name: nameOf(write), irNam: irNamDependencies(write) },
    image: buildWriteImage(write, destSlot),
    expected: expectedAfterWrite(write, destSlot, before),
  };
}

/**
 * Undo, steps 1-4: the destination must still hold exactly what our write
 * left there (PATCH CONTENT compare with the read-back we verified).
 * @param {{dest: number, before: Uint8Array, after: Uint8Array|null}} undo from executeWrite's result
 */
export async function prepareUndo(device, undo, { log }) {
  if (!undo || !isScratchSlot(undo.dest)) throw new CopyError("not-scratch", "nothing to undo in the scratch bank");
  if (!undo.after) {
    throw new CopyError("undo-unknown-state", `the state of ${label(undo.dest)} after the copy is unknown (no read-back), so ` +
      "Undo cannot check it has not changed since. Restore it from the before-image download instead.");
  }
  log.info(`Undo on ${label(undo.dest)}: checking it still holds what the copy left there`);
  const current = await readFull(device, undo.dest, "destination");
  const c = classifyDumpDiff(undo.after, current);
  if (!c.contentIdentical) {
    throw new CopyError("undo-dest-changed", `${label(undo.dest)} has changed since the copy (${c.content.length} patch-content ` +
      `byte(s) differ, e.g. file 0x${c.content[0]?.off.toString(16)} ${c.content[0]?.what}). Undo will not overwrite it. ` +
      "Nothing was written.");
  }
  const plan = makePlan("undo", { destSlot: undo.dest, before: current, write: undo.before });
  if (classifyDumpDiff(current, plan.expected).contentIdentical) {
    throw new CopyError("nothing-to-do", `${label(undo.dest)} already holds the original patch; nothing to undo.`);
  }
  log.info(`Undo plan: ${describePlan(plan).title}`);
  return plan;
}

/** Text for the confirmation dialog. Names every slot written and the patch it holds now. */
export function describePlan(plan) {
  const d = label(plan.dest.slot);
  const title = plan.op === "copy"
    ? `Copy ${label(plan.source.slot)} "${plan.source.name}" → ${d} "${plan.dest.name}"`
    : `Undo: restore ${d} to "${plan.write.name}" (replacing "${plan.dest.name}")`;
  const lines = [
    `${d} will be OVERWRITTEN. It now holds "${plan.dest.name}".`,
    plan.op === "copy"
      ? `It will hold an exact copy of ${label(plan.source.slot)} "${plan.source.name}"; ${label(plan.source.slot)} itself is not changed.`
      : `It will hold the patch that was there before the copy, "${plan.write.name}".`,
    `The pedal will switch patches during the write and stay on ${d} afterwards. ` +
      "Unsaved edits to the patch the pedal is on now may be lost.",
  ];
  const deps = plan.write.irNam;
  if (deps.length) {
    lines.push(`The patch uses ${deps.map((x) => x.text).join(", ")}. It refers to these by slot number on this pedal; ` +
      "the copy keeps the same reference and does not copy or change any IR or NAM/SnapTone data.");
  }
  return { title, lines };
}

/**
 * Read `slot` back and compare with `expected` (PATCH CONTENT). On a
 * mismatch, read it `confirmReads` more times; never write again.
 */
export async function readBackAndVerify(device, slot, expected, { log, confirmReads }) {
  const seen = [];
  for (let n = 1; n <= 1 + confirmReads; n++) {
    let dump;
    try {
      dump = await readFull(device, slot, "read-back");
    } catch (e) {
      seen.push({ error: e.message });
      log.warn(`${label(slot)}: read-back ${n} failed: ${e.message}`);
      continue;
    }
    const diff = classifyDumpDiff(expected, dump);
    seen.push({ dump, diff });
    if (diff.contentIdentical) {
      if (n > 1) log.warn(`${label(slot)}: read-back ${n} verified after ${n - 1} mismatching read(s)`);
      return { ok: true, readBack: dump, diff, reads: n, matchedLate: n > 1, consistency: n > 1 ? "matched later" : "first read" };
    }
    log.warn(`${label(slot)}: read-back ${n} differs from the expected patch in ${diff.content.length} patch-content byte(s): ` +
      diff.content.slice(0, 8).map((x) => `0x${x.off.toString(16)} ${x.what} expected ${x.a} got ${x.b}`).join("; "));
  }
  const keys = seen.map((s) => (s.diff ? s.diff.content.map((x) => `${x.off}:${x.b}`).join(",") : "unreadable"));
  const last = [...seen].reverse().find((s) => s.dump) ?? null;
  return {
    ok: false, readBack: last?.dump ?? null, diff: last?.diff ?? null, reads: seen.length, matchedLate: false,
    consistency: keys.every((k) => k === keys[0]) ? "stable" : "varies",
  };
}

/**
 * Steps 5-10. Throws CopyError for an abort before anything is written.
 * Once the upload has been sent it always returns a result; `ok` is true
 * only if the read-back AND the end-state check verified.
 * @param {object} opts
 * @param {{save: (entry: object) => Promise<any>, update: (id: any, patch: object) => Promise<void>}} opts.journal
 */
export async function executeWrite(device, plan, { journal, log, confirmReads = 2, onStep = () => {} }) {
  const dest = plan.dest.slot;
  const d = label(dest);
  if (!isScratchSlot(dest)) throw new CopyError("not-scratch", `${d} is not a scratch slot`);
  const imageSlots = [...UPLOAD_HEADER_SLOT_INDICES, I(0x2e)].map((i) => plan.image?.[i]);
  if (plan.image?.length !== UPLOAD_IMAGE_LEN || imageSlots.some((x) => x !== dest)) {
    throw new CopyError("image-mismatch", `the write image is not addressed to ${d} (slot fields ${imageSlots.join(", ")}). Nothing was written.`);
  }

  onStep("journal");
  let entryId;
  // After the write, a journal failure must not hide the write's result: log it instead.
  const note = async (patch) => {
    try {
      await journal.update(entryId, patch);
    } catch (e) {
      log.error(`journal update failed (${e.message}); the result below still stands`);
    }
  };
  try {
    entryId = await journal.save({
      op: plan.op, createdAt: plan.createdAt, state: "before-image saved",
      dest: { slot: dest, label: d, name: plan.dest.name, before: plan.dest.before },
      source: plan.source && { slot: plan.source.slot, label: label(plan.source.slot), name: plan.source.name, dump: plan.source.dump },
      write: { name: plan.write.name, dump: plan.write.dump },
    });
  } catch (e) {
    throw new CopyError("journal-failed", `could not save the before-image of ${d} (${e.message}). Nothing was written.`);
  }
  log.info(`${d}: before-image saved to the journal (entry ${entryId})`);

  onStep("recheck");
  const reread = async (slot, what) => {
    try {
      return await readFull(device, slot, what);
    } catch (e) {
      await note({ state: `aborted: ${what} could not be re-read` });
      throw new CopyError("recheck-failed", `${label(slot)} could not be re-read before writing (${e.message}). Nothing was written.`);
    }
  };
  if (plan.source) {
    const now = await reread(plan.source.slot, "source");
    const c = classifyDumpDiff(plan.source.dump, now);
    if (!c.contentIdentical) {
      await note({ state: "aborted: source changed" });
      throw new CopyError("source-changed", `${label(plan.source.slot)} changed since you confirmed (${c.content.length} ` +
        "patch-content byte(s) differ). Nothing was written.");
    }
  }
  const destNow = await reread(dest, "destination");
  const dc = classifyDumpDiff(plan.dest.before, destNow);
  if (!dc.contentIdentical) {
    await note({ state: "aborted: destination changed" });
    throw new CopyError("dest-changed", `${d} changed since you confirmed (${dc.content.length} patch-content byte(s) differ). ` +
      "Nothing was written.");
  }

  onStep("write");
  await device.enterEditorMode();
  let timing;
  let permit = null;
  try {
    // S3.1 (D-P1): the write declares its one destination; the guard refuses anything else.
    permit = device.beginPermit([dest]);
    timing = await device.writeImage(dest, plan.image, { permit });
  } catch (e) {
    if (e instanceof WriteGuardViolation || e instanceof WriteRefused) {
      // The guard and the device refuse before any chunk is sent: nothing was uploaded.
      await note({ state: `refused by the write guard: ${e.message}` });
      throw new CopyError("guard-refused", `${e.message} Nothing was written.`);
    }
    // A failure mid-upload leaves the slot in an unknown state.
    log.error(`${d}: the write failed part-way (${e.message}); the slot's state is unknown`);
    await note({ state: `write failed: ${e.message}` });
    return { ok: false, written: "unknown", op: plan.op, plan, error: e.message, verify: null, endState: null,
      undo: plan.op === "copy" ? { dest, before: plan.dest.before, after: null } : null };
  } finally {
    permit?.end(); // revoked whatever happened; the read-back below needs no permit
  }
  log.info(`${d}: upload sent in ${timing.uploadMs.toFixed(0)} ms (${timing.totalMs.toFixed(0)} ms with pauses); reading back`);

  onStep("verify");
  const verify = await readBackAndVerify(device, dest, plan.expected, { log, confirmReads });

  onStep("end-state");
  const endState = { sourceUnchanged: null, destVerified: false, problems: [] };
  if (plan.source) {
    try {
      const s = classifyDumpDiff(plan.source.dump, await readFull(device, plan.source.slot, "source"));
      endState.sourceUnchanged = s.contentIdentical;
      if (!s.contentIdentical) endState.problems.push(`SOURCE ${label(plan.source.slot)} CHANGED: ${s.content.length} patch-content byte(s)`);
    } catch (e) {
      endState.problems.push(`source could not be re-read: ${e.message}`);
    }
  }
  try {
    const late = classifyDumpDiff(plan.expected, await readFull(device, dest, "destination"));
    endState.destVerified = late.contentIdentical;
    if (!late.contentIdentical) endState.problems.push(`${d} no longer verifies on the end-state re-read (${late.content.length} byte(s))`);
  } catch (e) {
    endState.problems.push(`${d} could not be re-read: ${e.message}`);
  }

  const ok = verify.ok && endState.destVerified && endState.sourceUnchanged !== false && endState.problems.length === 0;
  await note({ state: ok ? "verified" : "FAILED verification", readBack: verify.readBack, endState });
  if (ok) log.info(`${d}: VERIFIED (PATCH CONTENT identical to the expected patch; end-state check passed)`);
  else log.error(`${d}: NOT VERIFIED. ${[verify.ok ? "" : `read-back differs (${verify.consistency})`, ...endState.problems].filter(Boolean).join("; ")}`);
  return {
    ok, written: true, op: plan.op, plan, verify, endState, timing,
    // Undo needs the state our write left behind; offered after a copy even if verification failed.
    undo: plan.op === "copy" ? { dest, before: plan.dest.before, after: verify.readBack, sourceSlot: plan.source.slot } : null,
  };
}
