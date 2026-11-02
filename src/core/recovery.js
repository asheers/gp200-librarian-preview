// Phase 3 S3.1 (slice 6): "Check and recover" for an operation that did not
// finish (docs/PHASE3_S3_BRIEF.md section 5; docs/PHASE3_DESIGN.md 3.5).
//
// READS ONLY. checkOperation() re-reads every slot of the operation from the
// pedal, under this tab's operation lock (ownership.js), with no write permit,
// and compares each with the record (operations.js; executor.js):
//   original    still holds what it held before the operation (PATCH CONTENT
//               equal to the before-image)
//   intended    holds what the operation meant to write there, verified now
//               (PATCH CONTENT equal to the step's expected bytes)
//   unexpected  neither (another patch, a half-written slot, an edit)
//   unreadable  could not be read (disconnected, timed out)
// and names every original real patch that is now on none of the checked
// slots: it exists only in the saved backup (the record's before-image and
// the before-image file).
//
// It then proposes actions in plain words: decisions that write nothing, and
// (slice 7) the two recovery WRITES, "Put everything back" and "Finish the
// operation". NOTHING is resumed, undone or restored automatically: a write
// happens only through buildRecoveryPlan() + the normal executor, after the
// user's explicit confirmation of a preview naming every slot, a fresh
// before-image file confirmed on disk, and every executor gate (ownership,
// operation lock, write clearance, journal record, input re-check, permit,
// per-step re-read / write / read-back, end-state check).
//
// Recovery writes (slice 7):
//   put-back  writes each changed slot's ORIGINAL image (the record's
//             before-image) back. Allowed whenever every slot was read; an
//             unexpected slot may be left out by the user.
//   finish    writes the planned patches still missing. Allowed only when the
//             check is "partial": every written step reads exactly as planned
//             and every remaining slot still holds its original, so the
//             continuation is the plan itself.
// A recovery is its own journalled operation (recoveryOf = the operation it
// recovers), so a second interruption is found and recovered the same way. It
// is not blocked by the operation it recovers (operations.js writeClearance).
// Only when it completes and verifies is the recovered operation resolved
// ("original patches put back (verified)" / "operation finished (verified)").
//
// resolveOperation() records the user's decision as a separate RESOLUTION
// record, only:
//   - if the decision is allowed by the check (based on verified contents);
//   - after reading every slot again, under the operation lock, and finding
//     exactly what the check found (otherwise the pedal changed: refused);
//   - with an explicit acknowledgement when a patch now exists only in the
//     saved backup.
// The operation record, its before-images and the Phase 2 journal are never
// changed or deleted: they stay for Undo and audit.
//
// SPDX-License-Identifier: GPL-3.0-only

import { buildWriteImage, expectedAfterWrite } from "./copy.js";
import { classifyDefault } from "./defaults.js";
import { executePlan } from "./executor.js";
import { contentKey } from "./match.js";
import { operationKey } from "./operations.js";
import { OwnershipError } from "./ownership.js";
import { displayName, irNamDependencies } from "./patch.js";
import { checkOrdering, OTHER_EDITORS_LINE, SECONDS_PER_WRITE, trackPatches } from "./plan.js";
import { slotToDisplayLabel } from "./slots.js";
import { evidenceFingerprint, WRITE_REFUSALS } from "./state-evidence.js";
import { EXPECTED_DUMP_LEN } from "./sysex.js";
import { classifyDumpDiff } from "./volatile.js";
import { WRITABLE_SLOTS } from "./write-guard.js";

export const DECISIONS = Object.freeze({
  "nothing-changed": "Close it: nothing was changed on the pedal",
  completed: "Close it: the operation completed",
  "accept-current": "Accept the pedal as it is now",
});
/** The recovery writes (slice 7). */
export const RECOVERY_WRITES = Object.freeze({
  "put-back": "Put everything back",
  finish: "Finish the operation",
});
/**
 * What a resolution record says happened (decision 3, 2026-10-19): accepting
 * the pedal's contents is "accepted current state", never "completed".
 */
export const OUTCOMES = Object.freeze({
  "nothing-changed": "nothing was changed (verified)",
  completed: "operation completed (verified)",
  "accept-current": "accepted current state",
  "put-back": "original patches put back (verified)",
  finish: "operation finished (verified)",
});

export class RecoveryError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "RecoveryError";
    this.code = code;
  }
}

const isDump = (d) => d instanceof Uint8Array && d.length === EXPECTED_DUMP_LEN;
const label = (s) => slotToDisplayLabel(s);
const nameOf = (d) => (isDump(d) ? displayName(d) || "(no name)" : "?");
const showName = (d, slot) => (isDump(d) && classifyDefault(d, slot).unused ? "(empty)" : `"${nameOf(d)}"`);

/** What the record says about each slot it involves: before, expected (for a written slot), role. */
function slotsOf(record) {
  const inputs = Array.isArray(record?.inputs) ? record.inputs : [];
  const steps = Array.isArray(record?.steps) ? record.steps : [];
  const out = new Map();
  for (const i of inputs) {
    if (!Number.isInteger(i?.slot)) continue;
    const before = i.before ?? null;
    // A Phase 2 entry does not say whether the slot was unused: decide by content (design 7).
    const unused = typeof i.unused === "boolean" ? i.unused : isDump(before) && classifyDefault(before, i.slot).unused;
    out.set(i.slot, { slot: i.slot, before, name: i.name ?? null, unused, step: null });
  }
  for (const s of steps) {
    if (!Number.isInteger(s?.slot)) continue;
    const e = out.get(s.slot) ?? { slot: s.slot, before: null, name: null, unused: false, step: null };
    // A Phase 2 entry (legacyOperation) has no expected bytes: derive them exactly as copy.js did.
    const expected = isDump(s.expected) ? s.expected
      : isDump(s.content) && isDump(e.before) ? expectedAfterWrite(s.content, s.slot, e.before) : null;
    e.step = { index: s.index ?? 0, state: s.state, transform: s.transform, from: s.from, expected, content: s.content ?? null };
    out.set(s.slot, e);
  }
  return [...out.values()];
}

async function readAll(device, slots, log) {
  const reads = new Map();
  for (const slot of slots) {
    try {
      const { decoded } = await device.readDump(slot);
      reads.set(slot, isDump(decoded) ? { dump: decoded } : { error: `read ${decoded?.length ?? "no"} bytes` });
    } catch (e) {
      reads.set(slot, { error: e.message });
      log?.warn(`Check and recover: ${label(slot)} could not be read (${e.message})`);
    }
  }
  return reads;
}

const same = (a, b) => isDump(a) && isDump(b) && classifyDumpDiff(a, b).contentIdentical;

/**
 * Re-read and classify every slot of an unfinished operation. Reads only.
 * @param {import("./device.js").GP200} device
 * @param {object} record an operation record, or a legacyOperation() view
 * @param {{ownership: import("./ownership.js").PedalOwnership, log?: object, now?: () => Date}} o
 */
export async function checkOperation(device, record, { ownership, log = null, now = () => new Date() }) {
  const parts = slotsOf(record);
  if (!parts.length || !parts.some((p) => p.step)) {
    throw new RecoveryError("damaged", "The record of this operation does not say which slots it wrote, so it cannot be checked. " +
      "Read the pedal and compare it with your backups.");
  }
  if (parts.some((p) => !isDump(p.before))) {
    throw new RecoveryError("damaged", "The record of this operation is missing an original patch image, so it cannot be checked.");
  }
  const operation = await lockFor(ownership);
  let reads;
  try {
    reads = await readAll(device, parts.map((p) => p.slot), log);
  } finally {
    operation.end();
  }
  const freshReads = new Map([...reads].filter(([, r]) => r.dump).map(([s, r]) => [s, r.dump]));
  const originals = new Map(parts.filter((p) => !p.unused).map((p) => [p.slot, contentKey(p.before)]));
  const keysNow = new Set([...reads.values()].filter((r) => r.dump).map((r) => contentKey(r.dump)));

  const slots = parts.map((p) => {
    const r = reads.get(p.slot);
    const row = { slot: p.slot, label: label(p.slot), written: !!p.step, stepState: p.step?.state ?? null,
      before: showName(p.before, p.slot), intended: p.step?.expected ? showName(p.step.expected, p.slot) : null, now: null, key: null };
    if (!r?.dump) return { ...row, found: "unreadable", detail: r?.error ?? "not read" };
    row.now = showName(r.dump, p.slot);
    row.key = contentKey(r.dump);
    if (same(p.before, r.dump)) return { ...row, found: "original", detail: "still holds its original patch" };
    if (p.step?.expected && same(p.step.expected, r.dump)) return { ...row, found: "intended", detail: "holds the new patch, verified now" };
    const other = [...originals].find(([s, k]) => s !== p.slot && k === row.key);
    return { ...row, found: "unexpected",
      detail: other ? `holds the original patch of ${label(other[0])}, which the operation did not plan here` : "holds neither its original nor the planned patch" };
  });

  const heldOnlyInBackup = parts.filter((p) => !p.unused && !keysNow.has(originals.get(p.slot)))
    .map((p) => ({ slot: p.slot, label: label(p.slot), name: nameOf(p.before) }));
  const written = slots.filter((s) => s.written);
  const readOnly = slots.filter((s) => !s.written);
  let overall;
  if (slots.some((s) => s.found === "unreadable")) overall = "incomplete";
  else if (slots.some((s) => s.found === "unexpected")) overall = "unexpected";
  else if (written.every((s) => s.found === "original")) overall = "nothing-changed";
  else if (written.every((s) => s.found === "intended") && readOnly.every((s) => s.found === "original")) overall = "completed";
  else overall = "partial";

  const allowedDecisions = { "nothing-changed": ["nothing-changed"], completed: ["completed"], partial: ["accept-current"],
    unexpected: ["accept-current"], incomplete: [] }[overall];
  const changed = written.some((s) => s.found !== "original");
  const allowedRecovery = overall === "incomplete" ? [] : [...(changed ? ["put-back"] : []), ...(overall === "partial" ? ["finish"] : [])];
  const check = {
    target: operationKey(record), legacy: !!record.legacy, action: record.action ?? record.title ?? "an operation",
    checkedAt: now().toISOString(), overall, slots, heldOnlyInBackup, allowedDecisions, allowedRecovery,
  };
  // The fresh reads, for a recovery plan built from this check (not enumerable: never copied into a record).
  Object.defineProperty(check, "reads", { value: freshReads, enumerable: false });
  check.lines = describe(check);
  check.proposals = proposals(check);
  log?.info(`Check and recover (${check.action}): ${overall}; ` + slots.map((s) => `${s.label} ${s.found}`).join(", ") +
    (heldOnlyInBackup.length ? `; only in the saved backup: ${heldOnlyInBackup.map((h) => `${h.label} "${h.name}"`).join(", ")}` : ""), { keep: true });
  return check;
}

/**
 * Save a resolution and confirm it is durably there: read the store back and
 * find exactly this record (S3.1 acceptance condition, 2026-10-19). Throws if
 * the save fails or the record is not found; the operation then stays
 * unresolved (findUnfinished sees no resolution).
 */
async function saveResolutionDurably(store, resolution) {
  const id = await store.save(resolution);
  let found = null;
  try {
    found = (await store.all()).find((r) => r?.kind === "resolution" && String(r.id) === String(id));
  } catch (e) {
    throw new Error(`it could not be read back (${e.message})`);
  }
  if (!found || found.target !== resolution.target || found.decision !== resolution.decision) {
    throw new Error("it was not found in the operation history after saving");
  }
  return id;
}

async function lockFor(ownership) {
  try {
    if (!ownership || typeof ownership.beginOperation !== "function") throw new OwnershipError("not-owner", "no pedal ownership was given");
    return await ownership.beginOperation();
  } catch (e) {
    throw new RecoveryError(e instanceof OwnershipError ? e.code : "not-owner", e.message);
  }
}

const FOUND_TEXT = {
  original: "✓ original patch still there",
  intended: "✓ new patch there, verified now",
  unexpected: "✗ unexpected contents",
  unreadable: "? could not be read",
};

/** The plain-English summary lines. */
function describe(c) {
  const head = {
    "nothing-changed": "Nothing was changed: every slot still holds its original patch.",
    completed: "The operation did complete: every slot holds the planned patch, checked now on the pedal.",
    partial: "The operation stopped part-way: some slots hold their new patch, the others still hold their original.",
    unexpected: "Some slots hold something unexpected: neither their original nor the planned patch.",
    incomplete: "Some slots could not be read, so the pedal's state is not known. Check the connection and try again.",
  }[c.overall];
  const lines = [head];
  for (const s of c.slots) {
    lines.push(`${s.label}: ${FOUND_TEXT[s.found]}` + (s.found === "unreadable" ? ` (${s.detail})` : ` — now ${s.now}`) +
      (s.written ? `; was ${s.before}, planned ${s.intended}` : "; not written by this operation") +
      (s.found === "unexpected" ? ` (${s.detail})` : ""));
  }
  for (const h of c.heldOnlyInBackup) {
    // Decision 4 (2026-10-19): only the affected slots were read.
    lines.push(`"${h.name}" (from ${h.label}): not found in the affected slots; it may exist elsewhere on the pedal. ` +
      "It is kept in this operation's record and its before-image file.");
  }
  return lines;
}

/** Proposed actions: what is available now (decisions; nothing written) and what writes (a later version). */
function proposals(c) {
  const changed = c.slots.some((s) => s.written && s.found !== "original");
  const finishable = c.overall === "partial";
  const out = [];
  if (c.allowedDecisions.includes("nothing-changed")) out.push({ id: "nothing-changed", available: true, label: DECISIONS["nothing-changed"], why: "Nothing needs putting back." });
  if (c.allowedDecisions.includes("completed")) out.push({ id: "completed", available: true, label: DECISIONS.completed, why: "Every planned patch is on the pedal." });
  if (changed && c.overall !== "incomplete") {
    out.push({ id: "put-back", available: true, write: true, label: RECOVERY_WRITES["put-back"],
      why: "Writes the original patches back from this operation's record, after a preview and your confirmation." });
  }
  if (finishable) {
    out.push({ id: "finish", available: true, write: true, label: RECOVERY_WRITES.finish,
      why: "Writes the planned patches that are still missing, after a preview and your confirmation." });
  }
  if (c.allowedDecisions.includes("accept-current")) {
    out.push({ id: "accept-current", available: true, label: DECISIONS["accept-current"],
      why: "Nothing is written. It is recorded as \"accepted current state\", never as completed." +
        (c.heldOnlyInBackup.length ? " The patches not found in the affected slots stay in this record and its before-image file." : "") });
  }
  out.push({ id: "leave", available: true, label: "Leave it unresolved for now", why: "Nothing is written; these slots stay blocked for new writes." });
  return out;
}

/**
 * Record the user's decision, after reading every slot again. Writes only a
 * resolution record to the operations store; never anything to the pedal.
 * @param {object} o
 * @param {string} o.decision one of check.allowedDecisions
 * @param {boolean} [o.acknowledgeBackupOnly] required when check.heldOnlyInBackup is not empty
 */
export async function resolveOperation(device, store, record, check, { decision, acknowledgeBackupOnly = false, ownership, log = null, now = () => new Date() }) {
  if (!check || check.target !== operationKey(record)) throw new RecoveryError("no-check", "Check this operation first: a decision needs a fresh check.");
  if (!check.allowedDecisions.includes(decision)) {
    throw new RecoveryError("not-allowed", `"${DECISIONS[decision] ?? decision}" does not fit what the check found (${check.overall}).`);
  }
  if (check.heldOnlyInBackup.length && acknowledgeBackupOnly !== true) {
    throw new RecoveryError("acknowledge", `Confirm first that ${check.heldOnlyInBackup.map((h) => `"${h.name}"`).join(", ")} ` +
      "will exist only in the saved backup.");
  }
  const operation = await lockFor(ownership);
  let reads;
  try {
    reads = await readAll(device, check.slots.map((s) => s.slot), log);
  } finally {
    operation.end();
  }
  const moved = check.slots.filter((s) => { const r = reads.get(s.slot); return !r?.dump || contentKey(r.dump) !== s.key; });
  if (moved.length) {
    throw new RecoveryError("changed", `${moved.map((s) => s.label).join(", ")} changed since the check (or could not be read). ` +
      "Nothing was recorded. Check again.");
  }
  const resolution = {
    kind: "resolution", target: check.target, targetAction: check.action, legacy: check.legacy, decision, outcome: OUTCOMES[decision],
    decidedAt: now().toISOString(),
    checkedAt: check.checkedAt, overall: check.overall, acknowledgedBackupOnly: check.heldOnlyInBackup.length ? true : undefined,
    evidence: check.slots.map((s) => ({ slot: s.slot, found: s.found, key: s.key })), heldOnlyInBackup: check.heldOnlyInBackup,
  };
  let id;
  try {
    id = await saveResolutionDurably(store, resolution);
  } catch (e) {
    throw new RecoveryError("store-failed", `The decision could not be saved (${e.message}); the operation stays unresolved.`);
  }
  log?.info(`Check and recover: "${DECISIONS[decision]}" recorded for ${check.action} (resolution ${id}); nothing was written to the pedal`, { keep: true });
  return { ...resolution, id };
}

// ---- recovery writes (slice 7) ------------------------------------------------------------

/**
 * Build the plan for a recovery write from a FRESH check (its reads are the
 * plan's inputs: what the user confirms against, what the before-image file
 * holds, and what the executor re-checks). The result is an ordinary
 * executor plan (plan.js shape), confirmed with confirmPlan and run with
 * runRecovery. Pure: reads nothing, writes nothing.
 * @param {object} record the unfinished operation (or its legacy view)
 * @param {object} check checkOperation(device, record) just now
 * @param {"put-back"|"finish"} kind
 * @param {{leaveOut?: number[], zone?: readonly number[], register?: readonly object[], now?: () => Date}} [o]
 *   leaveOut: slots found "unexpected" that put-back should not overwrite
 */
export function buildRecoveryPlan(record, check, kind, { leaveOut = [], zone = WRITABLE_SLOTS, register = WRITE_REFUSALS, now = () => new Date() } = {}) {
  if (!RECOVERY_WRITES[kind]) throw new RecoveryError("not-allowed", `unknown recovery "${kind}"`);
  if (!check || check.target !== operationKey(record) || !(check.reads instanceof Map)) {
    throw new RecoveryError("no-check", "Check this operation first: a recovery is built from a fresh check.");
  }
  if (!check.allowedRecovery.includes(kind)) {
    throw new RecoveryError("not-allowed", `"${RECOVERY_WRITES[kind]}" does not fit what the check found (${check.overall}).`);
  }
  const found = new Map(check.slots.map((s) => [s.slot, s]));
  for (const s of leaveOut) {
    if (kind !== "put-back" || found.get(s)?.found !== "unexpected") {
      throw new RecoveryError("not-allowed", `Only a slot with unexpected contents can be left out of "Put everything back" (${label(s)}).`);
    }
  }
  const parts = slotsOf(record);
  const readOf = (slot) => check.reads.get(slot);
  if (parts.some((p) => !isDump(readOf(p.slot)))) throw new RecoveryError("no-check", "Some slots were not read in the check; check again.");

  const chosen = parts.filter((p) => p.step).sort((a, b) => a.step.index - b.step.index).filter((p) => {
    const f = found.get(p.slot).found;
    return kind === "put-back" ? f !== "original" && !leaveOut.includes(p.slot) : f === "original";
  });
  if (!chosen.length) throw new RecoveryError("nothing-to-do", "Nothing would change: every slot already holds what this would write.");

  const steps = chosen.map((p, index) => {
    const current = readOf(p.slot);
    const content = kind === "put-back" ? p.before : p.step.content;
    if (!isDump(content)) throw new RecoveryError("damaged", `The record has no ${kind === "put-back" ? "original" : "planned"} patch image for ${label(p.slot)}.`);
    return {
      index, slot: p.slot, label: label(p.slot), from: null, origin: p.step.from ?? null,
      transform: kind === "put-back" ? "restore" : p.step.transform,
      why: kind === "put-back" ? `put back ${label(p.slot)}'s original patch` : `finish: ${label(p.slot)} gets its planned patch`,
      content, image: buildWriteImage(content, p.slot), expected: expectedAfterWrite(content, p.slot, current), expectBefore: current,
      dependsOn: [], heldUntil: [], name: nameOf(content), irNam: irNamDependencies(content),
    };
  });
  const outside = steps.filter((s) => !zone.includes(s.slot));
  if (outside.length) {
    throw new RecoveryError("not-in-zone", `${outside.map((s) => s.label).join(", ")} ${outside.length === 1 ? "is" : "are"} not writable yet; ` +
      "nothing was written.");
  }
  const dumps = [...steps.map((s) => s.content), ...parts.map((p) => readOf(p.slot))];
  if (dumps.some((d) => register.some((e) => evidenceFingerprint(d, e.fileOff) === e.fingerprint))) {
    throw new RecoveryError("state-dependent", "This involves a patch the pedal reports differently depending on the active patch; " +
      "it cannot be written yet. Nothing was written.");
  }
  const inputSlots = parts.map((p) => p.slot);
  const unusedAt = (s) => classifyDefault(readOf(s), s).unused;
  // Rename changes its own slot's content key (the name is part of it); recovering it is not a
  // loss, just the same patch under a different name (plan.js buildPlan has the same bypass).
  const survival = record.op === "rename" ? { replaced: [], held: [] } : trackPatches(steps, inputSlots, unusedAt, readOf);
  const written = new Set(steps.map((s) => s.slot));
  const plan = {
    kind, requested: kind, recovery: true, recoveryOf: check.target,
    titles: kind === "put-back"
      ? { action: `Put back: ${check.action}`, history: `Put back: ${check.action}` }
      : { action: `Finish: ${check.action}`, history: `Finished: ${check.action}` },
    createdAt: now().toISOString(), zone: [...zone], sources: [], dests: [...written],
    inputs: parts.map((p) => ({ slot: p.slot, label: label(p.slot), dumpAtConfirm: readOf(p.slot), name: nameOf(readOf(p.slot)),
      unused: unusedAt(p.slot), role: written.has(p.slot) ? "dest" : "source" })),
    steps, dropped: [], permitSlots: steps.map((s) => s.slot), replaced: survival.replaced, held: survival.held,
    estimateSeconds: steps.length * SECONDS_PER_WRITE,
  };
  checkOrdering(plan);
  plan.preview = previewRecovery(plan, check, leaveOut);
  return plan;
}

/** The confirmation for a recovery write: every slot, now and after, and what is replaced. */
function previewRecovery(plan, check, leaveOut) {
  const found = new Map(check.slots.map((s) => [s.slot, s]));
  const bySlot = new Map(plan.steps.map((s) => [s.slot, s]));
  const show = (d, slot) => (classifyDefault(d, slot).unused ? "(empty)" : nameOf(d));
  const rows = plan.inputs.map((i) => {
    const st = bySlot.get(i.slot);
    const now = show(i.dumpAtConfirm, i.slot);
    let note = "unchanged";
    if (st && plan.replaced.includes(i.slot)) note = `"${i.name}" will be replaced`;
    else if (st && found.get(i.slot)?.found === "unexpected") note = "its unexpected contents will be replaced";
    else if (st) note = "";
    else if (leaveOut.includes(i.slot)) note = "left as it is (unexpected contents, by your choice)";
    return { slot: i.slot, label: i.label, now, after: st ? show(st.content, i.slot) : now, changes: !!st, note };
  });
  const lost = plan.replaced.map((s) => `${label(s)} "${plan.inputs.find((i) => i.slot === s).name}"`);
  const headline = plan.kind === "put-back" ? `Put back the original patches for ${check.action}?` : `Finish ${check.action}?`;
  const notes = [
    plan.kind === "put-back" ? "The original patches are written back from this operation's record."
      : "The planned patches that are still missing are written from this operation's record.",
    "A backup of these slots as they are now is saved first, and every slot is read back and checked.",
    ...plan.held.map((h) => `During this, "${plan.inputs.find((i) => i.slot === h.slot).name}" is held in the backup until it is written back.`),
    OTHER_EDITORS_LINE,
    `The pedal will switch to ${plan.steps[plan.steps.length - 1].label} while writing. Save any edits on the pedal first.`,
  ];
  return {
    headline, rows, notes,
    tickBox: !lost.length ? null : lost.length === 1 ? `I understand ${lost[0]} will be replaced.`
      : `I understand that ${lost.length} patches will be replaced: ${lost.join(", ")}.`,
    details: [`${plan.steps.length} write${plan.steps.length === 1 ? "" : "s"}, about ${Math.round(plan.estimateSeconds)} s.`,
      ...plan.steps.map((s) => `Step ${s.index + 1}: ${s.why}`)],
    swapInstead: false,
    confirmLabel: RECOVERY_WRITES[plan.kind],
  };
}

/**
 * Run a confirmed recovery plan through the normal executor (every gate). If,
 * and only if, it completes and verifies, the recovered operation is resolved
 * by a separate resolution record. Never retries.
 * @returns {Promise<{result: object, resolution: object|null, resolutionError: string|null}>}
 */
export async function runRecovery(device, plan, { store, history = null, confirmation, beforeImage, ownership, log, wakeLock, onProgress, signal, now = () => new Date() }) {
  if (!plan?.recovery) throw new RecoveryError("not-allowed", "not a recovery plan");
  const result = await executePlan(device, plan, { confirmation, beforeImage, journal: store, history, log, ownership, wakeLock, onProgress, signal });
  if (!result.ok) {
    log?.error(`${plan.titles.action}: did not complete (${result.summary}); the operation stays unresolved, and so does this recovery`);
    return { result, resolution: null, resolutionError: null };
  }
  const resolution = {
    kind: "resolution", target: plan.recoveryOf, targetAction: plan.titles.action.replace(/^(Put back|Finish): /, ""), decision: plan.kind,
    outcome: OUTCOMES[plan.kind], decidedAt: now().toISOString(), byRecovery: result.recordId,
    evidence: result.steps.map((s) => ({ slot: s.slot, found: "verified" })),
  };
  try {
    // Only now: every requested step verified and the end-state check passed (result.ok). The
    // resolution must also be durably saved (read back); otherwise the operation stays unresolved.
    const id = await saveResolutionDurably(store, resolution);
    log?.info(`${plan.titles.action}: verified; the operation is resolved ("${resolution.outcome}", resolution ${id})`, { keep: true });
    return { result, resolution: { ...resolution, id }, resolutionError: null };
  } catch (e) {
    log?.error(`${plan.titles.action}: verified, but the resolution could not be saved (${e.message}); check it again`);
    return { result, resolution: null, resolutionError: e.message };
  }
}
