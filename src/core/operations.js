// Phase 3 S3.1 (slice 4): the operations journal, read side. No DOM code, no
// browser storage, no pedal access (docs/PHASE3_S3_BRIEF.md section 5;
// docs/PHASE3_DESIGN.md 3.5 and 4.2).
//
// One record per operation, written by executor.js through a store with
// save / update / all (IdbOperationStore in src/ui/store-idb.js, the
// "operations" store of the database for the page's pedal kind; or
// MemoryOperationStore below in tests). The record is committed before
// anything is sent and amended before and after every step, in this order:
//   step pending -> "in-flight" (BEFORE the upload) -> verified / failed /
//   unknown / refused (AFTER the read-back).
// So after a crash the record is never more optimistic than the pedal: a step
// that was being written reads "in-flight", which recovery shows as unknown.
//
// At start-up the app lists UNFINISHED operations: every record whose state
// is not "complete" or "nothing-written" (an interrupted run, or a stop that
// left slots changed: "not-finished", "end-state-failed"). Detection and the
// summary only READ: they never resume, undo, retry or write anything, to the
// store or to the pedal. Recovery actions come later (S3.1, "Check and
// recover"), each read-first and separately confirmed.
//
// Resolution (S3.1 slice 6, recovery.js): an operation stops being unfinished
// only when a separate RESOLUTION record names it ({kind: "resolution",
// target: <its id>}), written after "Check and recover" re-read the pedal and
// the user chose. The operation record and the Phase 2 journal entry are never
// changed (history and before-images are kept for Undo and audit). Hiding
// the warning resolves nothing. Until resolved, the operation's slots are
// BLOCKED for new writes (blockedSlots); a store that cannot be read blocks
// everything (the caller fails closed).
//
// The Phase 2 journal ("journal" store, copy.js) is migrated READ-ONLY: its
// entries are never copied, rewritten or deleted. legacyOperation() shows one
// in the same shape, marked legacy, and one left at "before-image saved", or
// stopped at a failed or unknown write, counts as unfinished.
//
// SPDX-License-Identifier: GPL-3.0-only

import { displayName } from "./patch.js";
import { slotToDisplayLabel } from "./slots.js";

/** Version of the operation record layout written by executor.js. */
export const RECORD_VERSION = 1;
/** Record states after which nothing on the pedal is left half-done. */
export const FINISHED_STATES = Object.freeze(["complete", "nothing-written"]);

const isSlot = (s) => Number.isInteger(s) && s >= 0 && s <= 255;
const label = (s) => (isSlot(s) ? slotToDisplayLabel(s) : `slot ${s}`);
const nameOf = (dump) => (dump instanceof Uint8Array && dump.length ? displayName(dump) || "(no name)" : null);

/**
 * In-memory operation store with the IndexedDB store's interface. A "disk"
 * (any Map) can be shared to simulate an app restart: a new store on a
 * snapshot of the disk sees exactly what was committed. Fault injection for
 * tests: failSave, failUpdate (true, or a function of the update count),
 * failAll.
 */
export class MemoryOperationStore {
  constructor({ disk = new Map(), pedalKind = "demo", failSave = false, failUpdate = false, failAll = false } = {}) {
    this.disk = disk;
    this.pedalKind = pedalKind;
    this.failSave = failSave;
    this.failUpdate = failUpdate;
    this.failAll = failAll;
    this.updates = 0;
    this.writes = 0; // successful save + update calls (detection must not add any)
  }

  async save(record) {
    if (this.failSave) throw new Error("operation store unavailable (test)");
    const id = (Math.max(0, ...this.disk.keys()) || 0) + 1;
    this.disk.set(id, structuredClone({ ...record, id, pedalKind: this.pedalKind, savedAt: new Date().toISOString() }));
    this.writes++;
    return id;
  }

  async update(id, patch) {
    this.updates++;
    const fail = typeof this.failUpdate === "function" ? this.failUpdate(this.updates) : this.failUpdate;
    if (fail) throw new Error("operation store update failed (test)");
    const r = this.disk.get(id);
    if (!r) throw new Error(`no operation record ${id}`);
    const { pedalKind, ...rest } = patch; // the marker is the store's
    void pedalKind;
    this.disk.set(id, structuredClone({ ...r, ...rest, updatedAt: new Date().toISOString() }));
    this.writes++;
  }

  async all() {
    if (this.failAll) throw new Error("operation store could not be read (test)");
    return [...this.disk.values()].map((r) => structuredClone(r));
  }

  /** What survives a crash right now: a copy of the committed records (pass to a new store as `disk`). */
  snapshot() {
    return new Map([...this.disk].map(([k, v]) => [k, structuredClone(v)]));
  }
}

/** Is this an operation record from executor.js (any version)? */
export const isOperationRecord = (r) => !!r && typeof r === "object" && r.kind === "operation";

/**
 * A Phase 2 journal entry (copy.js: one copy or Undo, one slot) in the
 * operation shape, for display only. The entry itself is not changed.
 */
export function legacyOperation(entry) {
  const dest = entry?.dest ?? {};
  const st = String(entry?.state ?? "");
  const stepState = st === "verified" ? "verified"
    : /^FAILED verification/.test(st) ? "failed"
      : /^write failed/.test(st) ? "unknown"
        : st === "before-image saved" ? "in-flight" // the tab stopped after saving the before-image: the write may have been sent
          : "not-started"; // aborted or refused before anything was sent
  const finished = stepState === "verified" || stepState === "not-started";
  const what = entry?.op === "undo" ? `Undo of the copy to ${label(dest.slot)}` : `Copy ${entry?.source?.label ?? "?"} → ${dest.label ?? label(dest.slot)}`;
  return {
    kind: "operation", legacy: true, id: `journal-${entry?.id ?? "?"}`, journalId: entry?.id ?? null,
    op: entry?.op === "undo" ? "undo" : "copy", action: what, title: what, createdAt: entry?.createdAt ?? null,
    pedalKind: entry?.pedalKind, state: finished ? (stepState === "verified" ? "complete" : "nothing-written") : "not-finished",
    legacyState: st,
    inputs: [{ slot: dest.slot, label: dest.label ?? label(dest.slot), name: dest.name ?? nameOf(dest.before), role: "dest", before: dest.before ?? null }],
    steps: [{ index: 0, slot: dest.slot, label: dest.label ?? label(dest.slot), from: entry?.source?.slot ?? null, transform: "identity",
      why: what, state: stepState, content: entry?.write?.dump ?? null }],
  };
}

/** True when the record leaves something on the pedal to check (resolutions are applied by findUnfinished). */
export function isUnfinished(record) {
  if (!record || typeof record !== "object") return false;
  return !FINISHED_STATES.includes(record.state);
}

/** Is this a resolution record (recovery.js)? */
export const isResolutionRecord = (r) => !!r && typeof r === "object" && r.kind === "resolution";
/** The key a resolution names: an operation record's id, or "journal-<id>" for a Phase 2 entry. */
export const operationKey = (record) => String(record?.id ?? "");

/**
 * Every unfinished operation, newest first: the operations store's records,
 * plus legacy Phase 2 journal entries (read-only view). Pure: reads its
 * arguments, changes nothing.
 * @param {object[]} operations records from the operations store
 * @param {object[]} [journal] entries from the Phase 2 journal
 */
export function findUnfinished(operations, journal = []) {
  const ops = (operations ?? []).filter(isOperationRecord);
  const resolved = new Set((operations ?? []).filter(isResolutionRecord).map((r) => String(r.target)));
  const legacy = (journal ?? []).filter((e) => e && typeof e === "object" && e.dest).map(legacyOperation);
  return [...ops, ...legacy].filter((r) => isUnfinished(r) && !resolved.has(operationKey(r)))
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

const SHOW = {
  verified: { mark: "✓", text: "changed and checked" },
  failed: { mark: "✗", text: "problem: did not verify" },
  unknown: { mark: "?", text: "unknown: the write may or may not have landed" },
  "in-flight": { mark: "?", text: "unknown: the app stopped while writing it" },
  refused: { mark: "·", text: "not written (refused before sending)" },
  "not-started": { mark: "·", text: "not started" },
  pending: { mark: "·", text: "not started" },
};

/**
 * The read-only recovery summary of one record (brief section 5): the
 * operation, each affected slot with what it held and what the plan meant to
 * put there, the last confirmed step and the unknown slots. Tolerates a
 * damaged record (it says so instead of throwing).
 */
export function recoverySummary(record) {
  const action = record?.action ?? record?.title ?? `${record?.op ?? "an operation"}`;
  const headline = `An operation did not finish: ${action}.`;
  const steps = Array.isArray(record?.steps) ? record.steps : null;
  const inputs = Array.isArray(record?.inputs) ? record.inputs : [];
  if (!steps || !steps.length) {
    return { id: record?.id ?? null, legacy: !!record?.legacy, headline, action, damaged: true, slots: [], lastConfirmedStep: null,
      unknown: [], heldOffPedal: [], lines: ["The record of this operation is incomplete, so the app cannot tell what was written. " +
        "Nothing will be done automatically. Read the pedal and compare with your backups."] };
  }
  const byInput = new Map(inputs.map((i) => [i.slot, i]));
  const rows = [];
  const seen = new Set();
  for (const s of steps) {
    seen.add(s.slot);
    const inp = byInput.get(s.slot);
    const intended = s.transform === "default" ? "(empty)" : nameOf(s.content) ?? (isSlot(s.from) ? `the patch from ${label(s.from)}` : "?");
    const show = SHOW[s.state] ?? { mark: "?", text: `unrecognised state "${s.state}"` };
    rows.push({ slot: s.slot, label: s.label ?? label(s.slot), step: (s.index ?? steps.indexOf(s)) + 1, before: inp?.unused ? "(empty)" : inp?.name ?? "?",
      intended, state: s.state, mark: show.mark, text: show.text });
  }
  for (const i of inputs) {
    if (seen.has(i.slot)) continue;
    rows.push({ slot: i.slot, label: i.label ?? label(i.slot), step: null, before: i.unused ? "(empty)" : i.name ?? "?", intended: null,
      state: "read-only", mark: " ", text: "read only (a source this operation does not write)" });
  }
  const verified = steps.filter((s) => s.state === "verified").map((s) => (s.index ?? steps.indexOf(s)) + 1);
  const lastConfirmedStep = verified.length ? Math.max(...verified) : null;
  const unknown = rows.filter((r) => ["unknown", "in-flight"].includes(r.state) || !SHOW[r.state] && r.state !== "read-only").map((r) => r.label);
  // A swap's held patch: off the pedal until its step is confirmed.
  const heldOffPedal = (Array.isArray(record?.held) ? record.held : []).filter((h) => {
    const back = steps.find((s) => (s.index ?? steps.indexOf(s)) === h.backAtStep);
    return back?.state !== "verified";
  }).map((h) => ({ slot: h.slot, label: label(h.slot), name: byInput.get(h.slot)?.name ?? "?" }));

  const lines = [
    `${rows.filter((r) => r.state === "verified").length} of ${steps.length} slot${steps.length === 1 ? "" : "s"} changed and checked.` +
      (lastConfirmedStep ? ` Last confirmed step: ${lastConfirmedStep} of ${steps.length}.` : " No step was confirmed."),
  ];
  if (unknown.length) lines.push(`Unknown: ${unknown.join(", ")}. The pedal must be read before anything else is done with ${unknown.length === 1 ? "it" : "them"}.`);
  for (const h of heldOffPedal) {
    // Decision 4 (2026-10-19): the record alone cannot say where the patch is now; Check and recover reads the slots.
    lines.push(`"${h.name}" (from ${h.label}) may no longer be in the affected slots; it is kept in this operation's record and its ` +
      "before-image file. Check and recover will look.");
  }
  lines.push("Nothing has been changed since. The original patches are kept in this record and in the before-image file.");
  return {
    id: record.id ?? null, legacy: !!record.legacy, headline, action, damaged: false, state: record.state ?? null,
    createdAt: record.createdAt ?? null, stopReason: record.stopReason?.message ?? null,
    slots: rows, lastConfirmedStep, unknown, heldOffPedal, lines,
  };
}

/**
 * The slots each unfinished operation may have written (its steps): no new
 * write may touch them until the operation is resolved.
 * @returns {Map<number, {key: string, action: string}[]>}
 */
export function blockedSlots(unfinished) {
  const out = new Map();
  for (const r of unfinished ?? []) {
    const slots = new Set((Array.isArray(r?.steps) ? r.steps : []).map((s) => s?.slot).filter(isSlot));
    // A damaged record names no steps: block every slot it mentions at all.
    if (!slots.size) for (const i of Array.isArray(r?.inputs) ? r.inputs : []) if (isSlot(i?.slot)) slots.add(i.slot);
    for (const slot of slots) {
      if (!out.has(slot)) out.set(slot, []);
      out.get(slot).push({ key: operationKey(r), action: r.action ?? r.title ?? "an operation" });
    }
  }
  return out;
}

/**
 * May an operation write `slots` now? Reads the stores; FAILS CLOSED: an
 * unreadable store, or a damaged unfinished record that names no slot at all,
 * blocks the write.
 *
 * A RECOVERY of an unfinished operation (slice 7: put back / finish; option
 * `recoveryOf` = that operation's key) is not blocked by that operation, nor
 * by the operations it was itself recovering (its recoveryOf chain), so an
 * unresolved operation never blocks its own authorised recovery. It must stay
 * inside that operation's slots, and every OTHER unfinished operation still
 * blocks it.
 * @returns {Promise<{ok: true} | {ok: false, code: "store-unreadable"|"blocked"|"recovery-target"|"outside-recovery", message: string, blocking?: object[]}>}
 */
export async function writeClearance(operations, journal, slots, { recoveryOf = null } = {}) {
  const c = await checkUnfinished(operations, journal);
  if (!c.ok) {
    return { ok: false, code: "store-unreadable", message: `The operation history could not be read, so this write is refused (${c.error}).` };
  }
  let unfinished = c.unfinished;
  if (recoveryOf !== null) {
    const byKey = new Map(unfinished.map((r) => [operationKey(r), r]));
    const target = byKey.get(String(recoveryOf));
    if (!target) {
      return { ok: false, code: "recovery-target", message: "The operation to recover is not unfinished (already resolved, or unknown); nothing was written." };
    }
    const allowed = blockedSlots([target]);
    const outside = [...new Set(slots)].filter((s) => !allowed.has(s));
    if (outside.length) {
      return { ok: false, code: "outside-recovery", message: `A recovery may write only the slots of the operation it recovers; ` +
        `${outside.map(label).join(", ")} ${outside.length === 1 ? "is" : "are"} not among them. Nothing was written.` };
    }
    const exempt = new Set();
    for (let r = target; r && !exempt.has(operationKey(r)); r = byKey.get(String(r.recoveryOf ?? ""))) exempt.add(operationKey(r));
    unfinished = unfinished.filter((r) => !exempt.has(operationKey(r)));
  }
  const anonymous = unfinished.filter((r) => !blockedSlots([r]).size);
  if (anonymous.length) {
    return { ok: false, code: "blocked", blocking: anonymous.map((r) => ({ key: operationKey(r), action: r.action ?? "an operation" })),
      message: "An operation did not finish and its record does not say which slots it touched. Use Check and recover first." };
  }
  const map = blockedSlots(unfinished);
  const hits = [...new Set(slots)].filter((s) => map.has(s));
  if (!hits.length) return { ok: true };
  const blocking = [...new Map(hits.flatMap((s) => map.get(s)).map((b) => [b.key, b])).values()];
  return {
    ok: false, code: "blocked", blocking,
    message: `${hits.map(label).join(", ")} ${hits.length === 1 ? "is" : "are"} part of an operation that did not finish ` +
      `(${blocking.map((b) => b.action).join("; ")}). Use Check and recover first; nothing was written.`,
  };
}

/**
 * The start-up check: read both stores, never write. A storage failure is
 * reported, never treated as "nothing unfinished".
 * @param {{all: () => Promise<object[]>}} operations
 * @param {{all: () => Promise<object[]>}|null} journal the Phase 2 journal (read-only)
 * @returns {Promise<{ok: true, unfinished: object[], summaries: object[], counts: {operations: number, legacy: number}}
 *   | {ok: false, error: string}>}
 */
export async function checkUnfinished(operations, journal = null) {
  let ops;
  let old = [];
  try {
    ops = await operations.all();
    if (journal) old = await journal.all();
  } catch (e) {
    return { ok: false, error: `could not read the operation history (${e.message}); unfinished operations cannot be ruled out` };
  }
  const unfinished = findUnfinished(ops, old);
  return {
    ok: true, unfinished, summaries: unfinished.map(recoverySummary),
    counts: { operations: (ops ?? []).filter(isOperationRecord).length, legacy: (old ?? []).length },
  };
}

/** Plain text of a summary, for the log and the panel's Details. */
export function formatRecoverySummary(s) {
  const out = [s.headline, ...s.lines];
  if (s.slots.length) {
    out.push("");
    for (const r of s.slots) {
      out.push(`  ${r.mark} ${r.label.padEnd(5)} before: ${r.before}${r.intended ? `  → planned: ${r.intended}` : ""}  — ${r.text}`);
    }
  }
  if (s.stopReason) out.push("", `Stopped: ${s.stopReason}`);
  if (s.legacy) out.push("", "From the Phase 2 journal (read only).");
  return out.join("\n");
}
