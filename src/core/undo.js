// Phase 3 S3.2 slice 4: single-level Undo of the most recent, successfully
// completed S3.1/S3.2 operation (docs/PHASE3_S3_BRIEF.md section 3.5;
// docs/PHASE3_DESIGN.md section 4.1, first increment only). On the real
// pedal, only what real-pedal.js allows.
//
// This is NOT the legacy Test tools' Undo (copy.js prepareUndo): that one is
// untouched. This Undo is for the Copy/Move/Swap operations run through the
// S3.1 plan engine (plan.js/executor.js), one patch, several, or a whole
// bank, from a menu or the selection bar (app.js runOperation).
//
// Reused, unchanged: checkOperation (recovery.js) does the fresh read and
// per-slot classification; plan.js's ordering/tracking/preview helpers;
// executor.js's executePlan for the actual write (confirmation, the
// before-image file gate, the journal record, the guard's permit, per-step
// re-read/write/read-back verification, the end-state check: every gate the
// engine already has). It does NOT reuse buildRecoveryPlan/runRecovery: those
// are for an operation that is still UNFINISHED and end in a separate
// RESOLUTION record once it is settled. Undo's target is already FINISHED
// ("complete") -- there is nothing to resolve, and writeClearance's
// `recoveryOf` exemption (which requires the target to still be unfinished)
// does not apply. An Undo therefore goes through an ORDINARY writeClearance
// check: it is refused, exactly like any other new write, if some OTHER
// still-unfinished operation overlaps its slots.
//
// Eligibility (findUndoable): only the SINGLE MOST RECENT operation record,
// of any kind, decides. If it is a successfully completed write that is not
// itself an Undo, it is offered. Anything else -- an Undo record (no redo),
// a failed or interrupted write, nothing recorded yet -- means nothing is
// offered. This is deliberately simpler than the brief's eventual
// multi-level History/Undo stack (design 4.1-4.2): once something else has
// happened, no earlier operation becomes reachable again in this slice.
//
// Precondition (checkUndo): a fresh, read-only check of every slot the
// target operation touched. Undo is offered only when checkOperation finds
// every slot EXACTLY as the operation left it (its "completed" verdict:
// every written slot verifies against its recorded, read-back-verified
// `after`; every other slot is still at its original). Any deviation at
// all -- not just an "unexpected" one -- refuses Undo outright, before
// anything is built or written. This also makes a failed or interrupted Undo
// safe by construction: if an Undo attempt wrote some but not all of its
// steps, the target's own precondition can no longer hold (one of its slots
// now reads as something other than "intended"), so a second attempt at the
// SAME target refuses too -- it is never retried blindly. The half-done
// Undo itself becomes an ordinary unfinished operation record (its own
// before-images, its own blocked slots), picked up by the existing Check and
// recover, exactly like any other interrupted write.
//
// SPDX-License-Identifier: GPL-3.0-only

import { buildWriteImage, expectedAfterWrite } from "./copy.js";
import { classifyDefault } from "./defaults.js";
import { executePlan } from "./executor.js";
import { isOperationRecord, operationKey } from "./operations.js";
import { checkOperation } from "./recovery.js";
import { displayName, irNamDependencies } from "./patch.js";
import { checkOrdering, OTHER_EDITORS_LINE, SECONDS_PER_WRITE, trackPatches } from "./plan.js";
import { slotToDisplayLabel } from "./slots.js";
import { evidenceFingerprint, WRITE_REFUSALS } from "./state-evidence.js";
import { EXPECTED_DUMP_LEN } from "./sysex.js";
import { WRITABLE_SLOTS } from "./write-guard.js";

export class UndoError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "UndoError";
    this.code = code;
  }
}

const isDump = (d) => d instanceof Uint8Array && d.length === EXPECTED_DUMP_LEN;
const label = (s) => slotToDisplayLabel(s);
const nameOf = (d) => (isDump(d) ? displayName(d) || "(no name)" : "?");

/**
 * The single operation eligible for Undo, or null: the most recent record
 * in the operations store, if (and only if) it is a successfully completed
 * write ("complete") that is not itself an Undo. Pure; reads its argument.
 * @param {object[]} operations records from the operations store (resolution
 *   records and anything else are ignored)
 */
export function findUndoable(operations) {
  const ops = (operations ?? []).filter(isOperationRecord)
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  const latest = ops[0];
  if (!latest || latest.state !== "complete" || latest.undoOf) return null;
  return latest;
}

/**
 * Fresh, read-only check of every slot the operation touched (checkOperation,
 * unchanged), then the stricter Undo precondition: the check's "completed"
 * verdict, meaning every slot is EXACTLY as the operation left it. Anything
 * else throws before anything is built: no write, however small.
 * @param {import("./device.js").GP200} device
 * @param {object} record from findUndoable()
 * @param {{ownership: import("./ownership.js").PedalOwnership, log?: object, now?: () => Date}} o
 */
export async function checkUndo(device, record, { ownership, log = null, now = () => new Date() } = {}) {
  const check = await checkOperation(device, record, { ownership, log, now });
  if (check.overall !== "completed") {
    // A written slot must read "intended" (what the operation verified); any other input must
    // still read "original" (untouched by it). Anything else is exactly what changed.
    const bad = check.slots.filter((s) => (s.written ? s.found !== "intended" : s.found !== "original"));
    throw new UndoError("changed", `${record.action ?? record.title ?? "This operation"} cannot be undone: the pedal has changed since` +
      (bad.length ? ` (${bad.map((s) => `${s.label} ${s.found === "unreadable" ? "could not be read" : "no longer matches what it was verified as"}`).join(", ")})` : "") +
      ". Nothing was written.");
  }
  return check;
}

/**
 * Build the Undo plan from a passing check: write each affected slot's
 * recorded ORIGINAL ("before") patch back. Pure: reads nothing, writes
 * nothing. Every slot must already be exactly "as the operation left it"
 * (checkUndo's precondition); buildUndoPlan re-asserts this rather than
 * trusting a stale check object.
 * @param {object} record the operation being undone
 * @param {object} check checkUndo(device, record) just now
 * @param {{zone?: readonly number[], register?: readonly object[], now?: () => Date}} [o]
 */
export function buildUndoPlan(record, check, { zone = WRITABLE_SLOTS, register = WRITE_REFUSALS, now = () => new Date() } = {}) {
  if (check?.overall !== "completed" || check.target !== operationKey(record)) {
    throw new UndoError("no-check", "Check this operation again: Undo is built only from a fresh, passing check.");
  }
  const inputs = Array.isArray(record?.inputs) ? record.inputs : [];
  const steps = Array.isArray(record?.steps) ? record.steps.filter((s) => Number.isInteger(s?.slot)) : [];
  if (!inputs.length || !steps.length) throw new UndoError("damaged", "The record of this operation is incomplete, so it cannot be undone.");
  const readOf = (slot) => check.reads.get(slot);
  const byInput = new Map(inputs.map((i) => [i.slot, i]));

  const chosen = steps.map((s, index) => {
    const inp = byInput.get(s.slot);
    if (!inp || !isDump(inp.before)) throw new UndoError("damaged", `The record has no original patch image for ${label(s.slot)}.`);
    const current = readOf(s.slot);
    if (!isDump(current)) throw new UndoError("no-check", `${label(s.slot)} was not freshly read; check again.`);
    return {
      index, slot: s.slot, label: label(s.slot), from: null, origin: s.from ?? null, transform: "restore",
      why: `undo: put back ${label(s.slot)}'s patch from before "${record.action ?? record.title ?? "this operation"}"`,
      content: inp.before, image: buildWriteImage(inp.before, s.slot), expected: expectedAfterWrite(inp.before, s.slot, current), expectBefore: current,
      dependsOn: [], heldUntil: [], name: nameOf(inp.before), irNam: irNamDependencies(inp.before),
    };
  });
  const outside = chosen.filter((s) => !zone.includes(s.slot));
  if (outside.length) {
    throw new UndoError("not-in-zone", `${outside.map((s) => s.label).join(", ")} ${outside.length === 1 ? "is" : "are"} not writable yet; ` +
      "nothing was written.");
  }
  const dumps = [...chosen.map((s) => s.content), ...inputs.map((i) => readOf(i.slot)).filter(isDump)];
  if (dumps.some((d) => register.some((e) => evidenceFingerprint(d, e.fileOff) === e.fingerprint))) {
    throw new UndoError("state-dependent", "This involves a patch the pedal reports differently depending on the active patch; " +
      "it cannot be undone yet. Nothing was written.");
  }
  const inputSlots = inputs.map((i) => i.slot);
  const unusedAt = (s) => classifyDefault(readOf(s), s).unused;
  // Rename changes its own slot's content key (the name is part of it); undoing it is not a
  // loss, just the same patch under its old name again (plan.js buildPlan has the same bypass).
  const survival = record.op === "rename" ? { replaced: [], held: [] } : trackPatches(chosen, inputSlots, unusedAt, readOf);
  const written = new Set(chosen.map((s) => s.slot));
  const action = record.action ?? record.title ?? "this operation";
  const plan = {
    kind: "undo", requested: "undo", undo: true, undoOf: operationKey(record),
    titles: { action: `Undo: ${action}`, history: `Undo of: ${action}` },
    createdAt: now().toISOString(), zone: [...zone], sources: [], dests: [...written],
    inputs: inputs.map((i) => ({ slot: i.slot, label: i.label ?? label(i.slot), dumpAtConfirm: readOf(i.slot), name: nameOf(readOf(i.slot)),
      unused: unusedAt(i.slot), role: written.has(i.slot) ? "dest" : "source" })),
    steps: chosen, dropped: [], permitSlots: chosen.map((s) => s.slot), replaced: survival.replaced, held: survival.held,
    estimateSeconds: chosen.length * SECONDS_PER_WRITE,
  };
  checkOrdering(plan);
  plan.preview = previewUndo(plan, action);
  return plan;
}

/** The confirmation for an Undo write: every affected slot, now and after, and what is replaced. */
function previewUndo(plan, action) {
  const bySlot = new Map(plan.steps.map((s) => [s.slot, s]));
  const show = (d, slot) => (classifyDefault(d, slot).unused ? "(empty)" : nameOf(d));
  const rows = plan.inputs.map((i) => {
    const st = bySlot.get(i.slot);
    const now = show(i.dumpAtConfirm, i.slot);
    let note = "unchanged";
    if (st && plan.replaced.includes(i.slot)) note = `${quoted(i.name)} will be replaced`;
    else if (st) note = "";
    return { slot: i.slot, label: i.label, now, after: st ? show(st.content, i.slot) : now, changes: !!st, note };
  });
  const lost = plan.replaced.map((s) => `${label(s)} ${quoted(plan.inputs.find((i) => i.slot === s).name)}`);
  return {
    headline: `Undo "${action}"?`, rows,
    tickBox: !lost.length ? null : lost.length === 1 ? `I understand ${lost[0]} will be replaced.`
      : `I understand that ${lost.length} patches will be replaced: ${lost.join(", ")}.`,
    notes: [
      `The patches from before "${action}" are written back, from its saved record.`,
      "A backup of these slots as they are now is saved first, and every slot is read back and checked.",
      ...plan.held.map((h) => `During this, ${quoted(plan.inputs.find((i) => i.slot === h.slot).name)} is held in the backup until it is written back.`),
      OTHER_EDITORS_LINE,
      `The pedal will switch to ${plan.steps[plan.steps.length - 1].label} while writing. Save any edits on the pedal first.`,
    ],
    details: [`${plan.steps.length} write${plan.steps.length === 1 ? "" : "s"}, about ${Math.round(plan.estimateSeconds)} s.`,
      ...plan.steps.map((s) => `Step ${s.index + 1}: ${s.why}`)],
    swapInstead: false, confirmLabel: "Undo",
  };
}

const quoted = (n) => `"${n}"`;

/**
 * Run a confirmed Undo plan through the normal executor (every gate:
 * confirmation, the before-image file, the journal record, the guard's
 * permit, per-step verification, the end-state check). No separate
 * resolution step: the target operation was already finished, so there is
 * nothing to resolve. A failure or interruption leaves an ordinary
 * unfinished operation record (its own before-images, its own blocked
 * slots), picked up by the normal Check and recover like any other write;
 * nothing here retries, resumes or exposes the target operation differently.
 * @param {import("./device.js").GP200} device
 * @param {object} plan from buildUndoPlan()
 * @param {object} opts passed straight to executePlan: confirmation, beforeImage, journal,
 *   history, ownership, log, wakeLock, onProgress, signal
 */
export async function runUndo(device, plan, opts) {
  if (!plan?.undo) throw new UndoError("not-allowed", "not an Undo plan");
  return executePlan(device, plan, opts);
}
