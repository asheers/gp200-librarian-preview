// Phase 3 S3.1 (second slice): the plan executor. Runs a plan from plan.js
// with the Phase 2 safety sequence, generalised to several steps
// (docs/PHASE3_DESIGN.md 3.2 and 3.5; docs/PHASE3_S3_BRIEF.md sections 2 and 5).
//
//   confirm   confirmPlan(): every plan needs an explicit confirmation, a Swap
//             included; the tick box only where the preview has one (a real
//             patch is lost). Only tokens made by confirmPlan for THIS plan
//             object are accepted.
//   gate      the before-image file (planJournalZip) was saved and confirmed
//             on disk (beforeImageVerified), and it holds exactly this plan's
//             before-images. Fails closed.
//   journal   ONE operation record with every before-image, every step's
//             content and expected bytes, and each step's state. Committed
//             before anything is sent; updated before and after every step.
//             A failed save aborts; a failed update stops before the next
//             write.
//   capture   the plan comes from capture.js captureForPlan: every input read
//             while it was the active patch. A plan without it is refused.
//   re-check  every input is read again; abort if any differs (PATCH CONTENT,
//             allowing capture.js sameOrClamped) from what the user confirmed against.
//   steps     in plan order: re-read the slot immediately before writing; it
//             must still hold what the plan expects (its original, same allowance); write with
//             the CLI pacing (device.writeImage, under the guard's permit for
//             exactly the plan's slots, ended in `finally`);
//             read back and verify against `expected` with copy.js's
//             readBackAndVerify (strict PATCH CONTENT, no allowance; on a mismatch
//             2 confirmation reads, never a second write).
//   stop      at the first step that is not verified, at an unexpected state,
//             at a failed read, or after a preset change the app did not send
//             (a footswitch). Never retried, never rolled back on its own.
//   end       when every step verified: re-read every input. Written slots
//             must still verify; the others must be unchanged (same allowance:
//             by now another patch is active).
//
// Step states: pending -> in-flight -> verified | failed | unknown | refused;
// steps after a stop stay not-started. The record keeps the before-images
// and the read-backs, which is what recovery ("Check and recover") and
// multi-level Undo need later.
//
// The guard still refuses an upload or preset change outside the plan's
// permit, whatever zone the plan was built with.
//
// SPDX-License-Identifier: GPL-3.0-only

import { beforeImageVerified } from "./before-image-gate.js";
import { sameOrClamped } from "./capture.js";
import { readBackAndVerify } from "./copy.js";
import { WriteRefused } from "./device.js";
import { RECORD_VERSION, writeClearance } from "./operations.js";
import { OwnershipError, requestWakeLock } from "./ownership.js";
import { actionTitle, checkOrdering, historyTitle, previewPlan } from "./plan.js";
import { rawEntryName } from "./backup.js";
import { slotToDisplayLabel } from "./slots.js";
import { EXPECTED_DUMP_LEN, UPLOAD_HEADER_SLOT_INDICES } from "./sysex.js";
import { readZip } from "./unzip.js";
import { classifyDumpDiff } from "./volatile.js";
import { WriteGuardViolation } from "./write-guard.js";

const label = (s) => slotToDisplayLabel(s);

export class ExecError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "ExecError";
    this.code = code;
  }
}

const CONFIRMED = new WeakSet();

/**
 * The user's explicit confirmation of one plan. Every plan needs `confirmed:
 * true` (a Swap too, although nothing is lost); a plan whose preview has a
 * tick box also needs `tickBoxAccepted: true`.
 */
export function confirmPlan(plan, { confirmed = false, tickBoxAccepted = false, now = () => new Date() } = {}) {
  const p = previewPlan(plan);
  if (confirmed !== true) throw new ExecError("not-confirmed", `${p.headline} was not confirmed; nothing was written.`);
  if (p.tickBox && tickBoxAccepted !== true) {
    throw new ExecError("tick-box", `The box "${p.tickBox}" was not ticked; nothing was written.`);
  }
  const token = Object.freeze({ plan, headline: p.headline, tickBox: p.tickBox, confirmedAt: now().toISOString() });
  CONFIRMED.add(token);
  return token;
}

/** Does the confirmed before-image zip hold exactly this plan's before-images? */
async function zipHoldsBeforeImages(plan, bytes) {
  let entries;
  try {
    entries = await readZip(bytes);
  } catch {
    return false;
  }
  return plan.inputs.every((i) => {
    const raw = entries.get(rawEntryName(i.slot));
    return raw && raw.length === i.dumpAtConfirm.length && raw.every((b, k) => b === i.dumpAtConfirm[k]);
  });
}

async function readFull(device, slot) {
  const { decoded } = await device.readDump(slot);
  if (!(decoded instanceof Uint8Array) || decoded.length !== EXPECTED_DUMP_LEN) {
    throw new Error(`${label(slot)} read ${decoded?.length ?? "no"} bytes, expected ${EXPECTED_DUMP_LEN}`);
  }
  return decoded;
}

const stepRecord = (s) => ({
  index: s.index, slot: s.slot, label: s.label, from: s.from, transform: s.transform, why: s.why,
  dependsOn: s.dependsOn, heldUntil: s.heldUntil, content: s.content, expected: s.expected, state: "pending",
});

/**
 * Run a confirmed plan. Throws ExecError when it stops before the operation
 * record exists (nothing sent). Once the record exists it always returns a
 * result, and the record says where it stopped.
 * @param {import("./device.js").GP200} device
 * @param {import("./plan.js").Plan} plan from buildPlan()
 * @param {object} o
 * @param {object} o.confirmation from confirmPlan(plan, ...)
 * @param {{saved: object, bytes: Uint8Array}} o.beforeImage the planJournalZip bytes and their saveFile() result
 * @param {{save: Function, update: Function}} o.journal
 * @param {import("./log.js").Logger} o.log
 * @param {number} [o.confirmReads] extra reads after a mismatching read-back (Phase 2: 2)
 * @param {(e: {phase: string, step?: number}) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal] cancellation, honoured between steps (never inside one)
 * @param {import("./ownership.js").PedalOwnership} o.ownership this tab's control of the pedal (required; slice 5)
 * @param {object} [o.wakeLock] navigator.wakeLock, or absent: a screen wake lock during the steps (never a gate)
 * @param {{all: Function}} [o.history] the Phase 2 journal (read only), whose unfinished copies also block their slots
 */
export async function executePlan(device, plan, opts) {
  // ---- before anything: the confirmation, then this tab's control of the pedal (slice 5) ----
  const { confirmation, ownership } = opts;
  if (!confirmation || !CONFIRMED.has(confirmation) || confirmation.plan !== plan) {
    throw new ExecError("not-confirmed", "this plan has not been confirmed by the user; nothing was written.");
  }
  let operation;
  try {
    if (!ownership || typeof ownership.beginOperation !== "function") {
      throw new OwnershipError("not-owner", "no pedal ownership was given");
    }
    operation = await ownership.beginOperation();
  } catch (e) {
    throw new ExecError(e instanceof OwnershipError && e.code !== "error" ? e.code : "not-owner",
      `${e.message} Nothing was written.`);
  }
  // Losing control revokes the guard's permit at once: an upload in progress cannot be followed by anything.
  const unsubscribe = ownership.whenLost(() => device.output.revokePermit());
  try {
    // Slice 6: no write to a slot of an operation that did not finish, until it is resolved (Check and
    // recover). An unreadable store blocks everything: fail closed. Checked under the operation lock.
    const clear = await writeClearance(opts.journal, opts.history ?? null, plan.permitSlots, { recoveryOf: plan.recoveryOf ?? null });
    if (!clear.ok) throw new ExecError(clear.code, clear.message);
    return await runPlan(device, plan, { ...opts, operation });
  } finally {
    unsubscribe();
    operation.end(); // released on success, stop, refusal and exception alike
  }
}

async function runPlan(device, plan, { confirmation, beforeImage, journal, log, confirmReads = 2, onProgress = () => {}, signal = null, operation, wakeLock }) {
  try {
    checkOrdering(plan);
  } catch (e) {
    throw new ExecError("bad-plan", `the plan is not safe to run (${e.message}); nothing was written.`);
  }
  for (const s of plan.steps) {
    const imageSlots = UPLOAD_HEADER_SLOT_INDICES.map((i) => s.image?.[i]);
    if (imageSlots.some((x) => x !== s.slot)) {
      throw new ExecError("bad-plan", `step ${s.index + 1}'s image is not addressed to ${label(s.slot)}; nothing was written.`);
    }
  }
  if (plan.activeSlotCapture !== true) {
    throw new ExecError("not-captured", "this plan was not read with each slot active; nothing was written.");
  }
  if (!beforeImage || !beforeImageVerified(beforeImage.saved, beforeImage.bytes)) {
    throw new ExecError("before-image-not-saved", "the before-image file was not saved and confirmed on disk; nothing was written.");
  }
  if (!(await zipHoldsBeforeImages(plan, beforeImage.bytes))) {
    throw new ExecError("before-image-mismatch", "the saved before-image file does not hold this operation's slots as read; " +
      "nothing was written.");
  }

  const title = historyTitle(plan);
  const steps = plan.steps.map(stepRecord);
  onProgress({ phase: "journal" });
  let recordId;
  try {
    recordId = await journal.save({
      kind: "operation", recordVersion: RECORD_VERSION, op: plan.kind, requested: plan.requested, title, action: actionTitle(plan),
      recoveryOf: plan.recoveryOf ?? undefined, // slice 7: the operation this one recovers (put back / finish)
      undoOf: plan.undoOf ?? undefined, // slice 4 (undo.js): the operation this one undoes; excludes it from being undone again (no redo)
      activeSlotCapture: true, // the before-images are true bytes (capture.js); older records lack this
      createdAt: plan.createdAt, state: "started",
      zone: plan.zone, held: plan.held, replaced: plan.replaced, confirmedAt: confirmation.confirmedAt,
      inputs: plan.inputs.map((i) => ({ slot: i.slot, label: i.label, name: i.name, unused: i.unused, role: i.role, before: i.dumpAtConfirm })),
      steps,
    });
  } catch (e) {
    throw new ExecError("journal-failed", `could not save the operation record (${e.message}); nothing was written.`);
  }
  log.info(`${title}: operation record ${recordId} saved with ${plan.inputs.length} before-image(s); ${steps.length} step(s)`);

  let journalOk = true;
  const record = async (patch) => {
    try {
      await journal.update(recordId, { ...patch, steps });
    } catch (e) {
      journalOk = false;
      log.error(`operation record ${recordId}: update failed (${e.message}); stopping before the next write`);
    }
  };
  let wakeState = null; // the screen wake lock during the steps: {held, reason}, or null if the steps were not reached
  const finish = async (stopReason, endState = null) => {
    for (const s of steps) if (s.state === "pending") s.state = "not-started";
    const verified = steps.filter((s) => s.state === "verified").length;
    const allVerified = !stopReason && verified === steps.length;
    const ok = allVerified && !!endState && endState.problems.length === 0;
    const anyWritten = steps.some((s) => ["verified", "failed", "unknown"].includes(s.state));
    const status = ok ? "complete" : allVerified ? "end-state-failed" : !anyWritten ? "nothing-written" : "not-finished";
    const summary = ok ? title
      : status === "end-state-failed" ? `Written and checked, but the final check found a problem: ${endState.problems.join("; ")}`
        : status === "nothing-written" ? `Nothing was written: ${stopReason.message}`
          : `Not finished: ${verified} of ${steps.length} slot${steps.length === 1 ? "" : "s"} changed`;
    await record({ state: status, stopReason, endState, finishedAt: new Date().toISOString() });
    if (ok) log.info(`${title}: COMPLETE, every step verified and the end-state check passed`);
    else log.error(`${title}: ${summary}. ${stopReason ? `Stopped: ${stopReason.message}` : ""} ` +
      steps.map((s) => `${s.label} ${s.state}`).join(", "));
    return {
      ok, status, summary, title, recordId, stopReason, endState, wakeLock: wakeState,
      steps: steps.map((s) => ({ index: s.index, slot: s.slot, label: s.label, why: s.why, state: s.state, readBack: s.readBack ?? null,
        consistency: s.consistency ?? null, error: s.error ?? null })),
      // What Undo needs: each written slot's before-image and what our write left there.
      undo: steps.filter((s) => s.readBack).map((s) => ({ slot: s.slot, before: plan.inputs.find((i) => i.slot === s.slot).dumpAtConfirm, after: s.readBack })),
    };
  };
  const stop = (code, message) => ({ code, message });

  // ---- re-check every input against what the user confirmed ----
  onProgress({ phase: "recheck" });
  for (const inp of plan.inputs) {
    let now;
    try {
      now = await readFull(device, inp.slot);
    } catch (e) {
      return finish(stop("recheck-failed", `${inp.label} could not be re-read before writing (${e.message})`));
    }
    const c = classifyDumpDiff(inp.dumpAtConfirm, now);
    if (!sameOrClamped(inp.dumpAtConfirm, now)) {
      return finish(stop("input-changed", `${inp.label} changed since you confirmed (${c.content.length} patch-content byte(s) differ)`));
    }
  }

  await device.enterEditorMode();
  const externalAtStart = device.externalPresetChanges;

  // ---- the screen wake lock: only now, after every gate; its failure changes nothing else ----
  const wake = await requestWakeLock(wakeLock, log);
  wakeState = { held: wake.held, reason: wake.reason };
  onProgress({ phase: "wake-lock", held: wake.held, reason: wake.reason });

  // ---- the steps, under the guard's permit for exactly the plan's slots ----
  let permit;
  if (!operation.held) {
    await wake.release();
    return finish(stop("ownership-lost", "this tab lost control of the pedal before the first step"));
  }
  try {
    permit = device.beginPermit(plan.permitSlots);
  } catch (e) {
    await wake.release();
    return finish(stop("permit-refused", `the write guard refused this operation's slots (${e.message})`));
  }
  let stopped = null;
  try {
    for (const s of steps) {
      const st = plan.steps[s.index];
      if (signal?.aborted) {
        stopped = stop("cancelled", `cancelled before step ${s.index + 1} of ${steps.length}`);
        break;
      }
      if (device.externalPresetChanges !== externalAtStart) {
        stopped = stop("pedal-activity", "the pedal changed patch during the operation (a footswitch?); stopped before " +
          `step ${s.index + 1} of ${steps.length}`);
        break;
      }
      onProgress({ phase: "step", step: s.index });
      let current;
      try {
        current = await readFull(device, s.slot);
      } catch (e) {
        stopped = stop("read-failed", `${s.label} could not be read before step ${s.index + 1} (${e.message}); is the pedal connected?`);
        break;
      }
      const pre = classifyDumpDiff(st.expectBefore, current);
      if (!sameOrClamped(st.expectBefore, current)) {
        stopped = stop("unexpected-state", `${s.label} does not hold what the plan expects before step ${s.index + 1} ` +
          `(${pre.content.length} patch-content byte(s) differ)`);
        break;
      }
      s.state = "in-flight";
      await record({ state: `step ${s.index + 1} in flight` });
      if (!journalOk) {
        s.state = "not-started";
        stopped = stop("journal-failed", "the operation record could not be updated");
        break;
      }
      if (!operation.held) { // lost before this step was written (checked right before the upload): nothing of it was sent
        s.state = "not-started";
        stopped = stop("ownership-lost", `this tab lost control of the pedal; stopped before writing step ${s.index + 1}`);
        break;
      }
      try {
        await device.writeImage(s.slot, st.image, { permit });
      } catch (e) {
        s.error = e.message;
        if (e instanceof WriteGuardViolation || e instanceof WriteRefused) {
          s.state = "refused";
          stopped = stop("refused", `step ${s.index + 1} (${s.label}) was refused before the upload was sent: ${e.message}`);
        } else {
          s.state = "unknown";
          stopped = stop("upload-failed", `the write to ${s.label} failed part-way (${e.message}); its state is unknown`);
        }
        break;
      }
      const v = await readBackAndVerify(device, s.slot, st.expected, { log, confirmReads });
      s.readBack = v.readBack;
      s.consistency = v.consistency;
      s.state = v.ok ? "verified" : "failed";
      await record({ state: `step ${s.index + 1} ${s.state}` });
      log.info(`Step ${s.index + 1} of ${steps.length} (${s.why}): ${v.ok ? "VERIFIED" : `NOT VERIFIED (${v.consistency})`}`);
      if (!v.ok) {
        stopped = stop("not-verified", `${s.label} did not verify after step ${s.index + 1}`);
        break;
      }
    }
  } finally {
    permit.end(); // revoked on success, stop, cancellation and exception alike
    await wake.release();
  }
  if (stopped) return finish(stopped);

  if (!journalOk) return finish(stop("journal-failed", "the operation record could not be updated"));

  // ---- end-state check ----
  onProgress({ phase: "end-state" });
  const endState = { problems: [] };
  for (const inp of plan.inputs) {
    const step = plan.steps.find((x) => x.slot === inp.slot);
    try {
      const expected = step ? step.expected : inp.dumpAtConfirm;
      const now = await readFull(device, inp.slot);
      if (!sameOrClamped(expected, now)) {
        const c = classifyDumpDiff(expected, now);
        endState.problems.push(`${inp.label} ${step ? "no longer verifies" : "CHANGED although the plan did not write it"} ` +
          `(${c.content.length} byte(s))`);
      }
    } catch (e) {
      endState.problems.push(`${inp.label} could not be re-read: ${e.message}`);
    }
  }
  return finish(null, endState);
}
