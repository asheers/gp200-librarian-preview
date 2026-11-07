// 0.13.0: active-slot capture. docs/ACTIVE_SLOT_CAPTURE.md has the evidence and design.
//
// A read returns a control assignment's parameter index (the +6 byte of the 12 assignment
// records) only if that index exists in the ACTIVE patch's model at the record's block;
// otherwise it reads 0. Stage A proved it on hardware (102 of 102 predicted bytes). A patch's
// own model never clamps it (313 of 313 indexes on file), so a slot read while it is itself the
// active patch returns the true bytes.
//
// So, after the user confirms and before the before-image, every input of the plan is selected
// and read, and the plan is rebuilt from those reads. Any failure stops here: nothing has been
// uploaded and no operation record exists, because the executor makes the record afterwards.
//
// sameOrClamped is the one tolerance, for re-checks only. It is NEVER used on the read-back of
// a write (copy.js readBackAndVerify): at that moment the written slot is the active patch.
// These offsets are not read-volatile: volatile.js stays closed and does not list them.
//
// SPDX-License-Identifier: GPL-3.0-only

import { CONTENT_FILE_START } from "./patch.js";
import { slotToDisplayLabel as label } from "./slots.js";
import { EXPECTED_DUMP_LEN } from "./sysex.js";
import { classifyDumpDiff } from "./volatile.js";

/** The +6 byte of the 16-byte records from 0x3B8 and the 8-byte records from 0x448. */
export const ASSIGNMENT_INDEX_FILE_OFFSETS = Object.freeze([
  ...Array.from({ length: 9 }, (_, i) => 0x3b8 + i * 16 + 6), 0x44e, 0x456, 0x45e,
]);
const INDEX = new Set(ASSIGNMENT_INDEX_FILE_OFFSETS);
/** Effect blocks are 0..10. The record's +5 byte holds 0xFF or 0x0B when it names no block. */
const MAX_BLOCK = 10;

/** What the Undo and recovery previews ask for a record saved before 0.13.0. */
export const OLDER_RECORD_TICK = "I understand this operation was saved before version 0.13.0, so the patches it saved may hold " +
  "inaccurate control assignments (footswitch or expression targets).";

/** Was this record's before-image captured with each slot active? */
export const recordCaptured = (record) => record?.activeSlotCapture === true;

export class CaptureError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`${message} Nothing was written.`);
    this.name = "CaptureError";
    this.code = code;
  }
}

/**
 * PATCH CONTENT equal, apart from assignment indexes that read 0 where `expected` holds a
 * non-zero index. `eitherWay` also accepts the reverse, for a record saved before 0.13.0,
 * whose own image may hold the clamped 0.
 */
export function sameOrClamped(expected, read, { eitherWay = false } = {}) {
  const c = classifyDumpDiff(expected, read);
  if (c.contentIdentical) return true;
  if (c.lengthA !== c.lengthB) return false;
  return c.content.every((d) => INDEX.has(d.off) && expected[d.off - 1 - CONTENT_FILE_START] <= MAX_BLOCK &&
    ((d.b === 0 && d.a !== 0) || (eitherWay && d.a === 0 && d.b !== 0)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isActive = (device, slot) => device.activeSlot?.slot === slot && device.activeSlot.how === "echo";

async function echoed(device, slot, waitMs) {
  const end = performance.now() + waitMs;
  while (!isActive(device, slot) && performance.now() < end) await sleep(5);
  return isActive(device, slot);
}

/** Make `slot` the active patch; only the pedal's own echo proves it. */
async function makeActive(device, slot, waitMs) {
  await device.selectSlot(slot);
  if (!(await echoed(device, slot, waitMs))) throw new CaptureError("no-echo", `The pedal did not confirm the change to ${label(slot)}.`);
}

/**
 * Select and read each slot, under this tab's operation lock and the guard's capture permit
 * (preset changes to these slots and the first one's neighbour; no uploads). It starts by leaving
 * the active patch, whatever it is: its unsaved edits are not stored bytes, and a change to the
 * patch already active might not reload it. Every slot after that is reached from a different patch.
 * @returns {Promise<Map<number, Uint8Array>>}
 */
export async function captureSlots(device, slots, { ownership, log, echoWaitMs = 1000 }) {
  let operation;
  try {
    if (typeof ownership?.beginOperation !== "function") throw new Error("no pedal ownership was given");
    operation = await ownership.beginOperation();
  } catch (e) {
    throw new CaptureError("not-owner", `${e.message}.`);
  }
  // Losing control revokes the capture permit too, so the next preset change is refused.
  const unsubscribe = ownership.whenLost(() => device.output.revokePermit());
  let permit = null;
  const reads = new Map();
  try {
    await device.enterEditorMode(); // as the write path does, before its first preset change
    const external = device.externalPresetChanges;
    if (!slots.length) throw new Error("no slots");
    permit = device.beginCapture([...new Set([slots[0] ^ 1, ...slots])]);
    await device.selectSlot(slots[0] ^ 1);
    await echoed(device, slots[0] ^ 1, echoWaitMs); // no proof needed, and none comes if the pedal was already there
    log?.info(`Capture: reading ${slots.length} slot(s) with each one active: ${slots.map(label).join(", ")}`, { keep: true });
    for (const slot of slots) {
      await makeActive(device, slot, echoWaitMs);
      const { decoded } = await device.readDump(slot);
      if (decoded?.length !== EXPECTED_DUMP_LEN) throw new CaptureError("bad-read", `${label(slot)} read ${decoded?.length ?? "no"} bytes.`);
      if (device.externalPresetChanges !== external || !isActive(device, slot)) {
        throw new CaptureError("pedal-activity", `The pedal changed patch while ${label(slot)} was being read (a footswitch?).`);
      }
      reads.set(slot, decoded);
    }
    return reads;
  } catch (e) {
    const err = e instanceof CaptureError ? e : new CaptureError("failed", `The slots could not be read with each one active (${e.message}).`);
    log?.error(`Capture stopped: ${err.message}`);
    throw err;
  } finally {
    permit?.end();
    unsubscribe();
    operation.end();
  }
}

const shape = (p) => JSON.stringify({ kind: p.kind, permit: p.permitSlots, inputs: p.inputs.map((i) => i.slot),
  steps: p.steps.map((s) => [s.slot, s.from ?? null, s.transform]) });

/**
 * The plan to run: rebuilt from a capture of every input of the confirmed plan. Stops if the
 * capture differs from what the user confirmed in any way but a clamped index, or if the rebuilt
 * plan would write something else or replace a patch the confirmation did not name.
 * @param {object} plan the plan the user confirmed
 * @param {(reads: Map<number, Uint8Array>) => object} rebuild builds the same plan from the capture
 */
export async function captureForPlan(device, plan, rebuild, opts) {
  const reads = await captureSlots(device, plan.inputs.map((i) => i.slot), opts);
  const refuse = (code, message) => {
    const e = new CaptureError(code, message);
    opts.log?.error(`Capture stopped: ${e.message}`);
    return e;
  };
  for (const inp of plan.inputs) {
    const truth = reads.get(inp.slot);
    if (!sameOrClamped(truth, inp.dumpAtConfirm)) throw refuse("changed", `${inp.label} changed since you confirmed, or the pedal had unsaved edits on it.`);
    const c = classifyDumpDiff(truth, inp.dumpAtConfirm);
    for (const d of c.content) opts.log?.info(`Capture: ${inp.label} file 0x${d.off.toString(16)} read ${d.b} with another patch active, ${d.a} with this one`, { keep: true });
  }
  let rebuilt;
  try {
    rebuilt = rebuild(reads);
  } catch (e) {
    throw refuse("rebuild-failed", `The operation could not be rebuilt from the exact reads (${e.message}).`);
  }
  const named = new Set(plan.replaced);
  if (shape(rebuilt) !== shape(plan) || rebuilt.replaced.some((s) => !named.has(s))) {
    throw refuse("plan-changed", "The exact reads change what this operation would do. Start it again to see the new preview.");
  }
  rebuilt.activeSlotCapture = true;
  return rebuilt;
}
