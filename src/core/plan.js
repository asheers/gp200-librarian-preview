// Phase 3 S3.1 (first slice): the operation planner for Copy, Move and Swap.
// docs/PHASE3_S3_BRIEF.md sections 2-5; docs/PHASE3_DESIGN.md sections 2, 3.1
// and 3.3.
//
// OFFLINE ONLY. buildPlan() takes dumps already in memory (rule R-d: every
// input is read in full before the first write) and returns a plan: which
// slots are written, with what bytes, in what order, and why. It sends
// nothing, reads nothing and has no executor; the guard, the whitelist and
// copy.js are unchanged. The write image and the expected read-back of each
// step come from copy.js's proven buildWriteImage / expectedAfterWrite.
//
// Model. Every operation is reduced to the final content of each written
// slot: "slot X ends up holding the ORIGINAL content of slot S" (identity:
// copy, move, swap) or "slot X ends up holding the canonical default"
// (clear: the source of a Move). Because the originals are held in memory,
// overlapping sources and destinations ("move 60-A..B to 60-B") lose
// nothing: the bytes always come from the snapshot, never from a slot an
// earlier step has already written. Each slot is written at most once.
//
// Ordering (design 3.3; tests pin these):
//   R-a  a step that overwrites slot S runs only after every step that
//        copies S's original elsewhere (dependsOn). Move clears therefore
//        come after the destinations.
//   R-b  an original real patch stays on the pedal in at least one slot,
//        except where the plan says it is held in the backup until a named
//        later step (a swap: a dependency cycle), or replaced for good (an
//        overwrite the confirmation names).
//   R-c  when only a cycle is left, the step chosen first is one whose
//        slot holds an unused patch (nothing goes off the pedal), then the
//        first declared. Swaps therefore run pairwise.
//   R-d  inputs are the in-memory snapshot (the caller's fresh reads).
// No-op steps (the slot already holds the intended content, PATCH CONTENT)
// are dropped; a plan with no effective step is refused.
//
// Refused before any plan exists (PlanError, with a plain message):
// unknown operation, bad or duplicate slots, same slot, a range past 64-D,
// any written slot outside the write zone (the whole plan, never partly),
// a missing or wrong-length read, a read whose slot fields do not carry its
// own slot number, moving an unused slot, a swap of identical content,
// a clear when the default self-check has not allowed it, and nothing to do.
//
// The write zone defaults to the guard's static WRITABLE_SLOTS (all 256,
// 0.6.0). Tests may pass a narrower zone to prove the refusal.
//
// SPDX-License-Identifier: GPL-3.0-only

import { buildWriteImage, expectedAfterWrite, slotFieldMismatches } from "./copy.js";
import { canonicalDefault, classifyDefault } from "./defaults.js";
import { contentKey } from "./match.js";
import { encodeName, quoteName as quoted, validateName, withName } from "./names.js";
import { displayName, irNamDependencies } from "./patch.js";
import { bankSlots, BANKS, slotSpan as range, slotToDisplayLabel, TOTAL_SLOTS } from "./slots.js";
import { EXPECTED_DUMP_LEN } from "./sysex.js";
import { classifyDumpDiff } from "./volatile.js";
import { WRITABLE_SLOTS } from "./write-guard.js";

export const PLAN_KINDS = Object.freeze(["copy", "move", "swap", "bank-copy", "bank-move", "bank-swap", "rename", "clear"]);
/** Seconds per write step, including its reads (design 3.6, CLI pacing measured in W1). */
export const SECONDS_PER_WRITE = 2.5;

// Correction (2026-10-25): this used to promise "and you can Undo afterwards" before Undo was
// wired to these operations at all (S3.2 slice 4 built it). Kept precise about the real, narrow
// scope -- single-level, most-recent-only (src/core/undo.js) -- rather than overclaiming again.
export const SAFEGUARD_LINE = "A backup of the changed slots is saved first, and you can Undo it afterwards " +
  "(only the most recent operation can be undone, and only while nothing else has touched its slots since).";
/** Decision 5 (2026-10-19): the one-tab lock cannot see other programs, browsers or addresses. */
export const OTHER_EDITORS_LINE = "Close other MIDI editors (Valeton's editor, GP200 Studio) and any other Librarian window while writing: " +
  "they are not locked out.";
/** 0.13.0: the app shows the note holding this as a warning block, not a plain line. */
export const UNSAVED_EDITS_WARNING = "Switching can discard unsaved edits on the pedal, even if you then cancel: save any you want to keep first.";
/** 0.13.0: what the pedal does after the confirmation (capture.js), then during the writes. */
export const switchLine = (lastLabel) => `After you confirm, the pedal switches patches to read each slot exactly, and it ends on ${lastLabel}. ${UNSAVED_EDITS_WARNING}`;

export class PlanError extends Error {
  /** @param {string} code @param {string} message @param {object} [detail] */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "PlanError";
    this.code = code;
    this.detail = detail;
  }
}

const label = (s) => slotToDisplayLabel(s);
const isSlot = (s) => Number.isInteger(s) && s >= 0 && s < TOTAL_SLOTS;
const nameOf = (dump) => displayName(dump) || "(no name)";

function asSlotList(v, what) {
  const list = Array.isArray(v) ? v : [v];
  if (!list.length) throw new PlanError("bad-slot", `no ${what} slot given`);
  for (const s of list) if (!isSlot(s)) throw new PlanError("bad-slot", `${what} slot ${s} does not exist (slots are 1-A to 64-D)`);
  if (new Set(list).size !== list.length) throw new PlanError("duplicate-slot", `the ${what} slots list the same slot twice`);
  return list;
}

function checkBank(b, what) {
  if (!Number.isInteger(b) || b < 1 || b > BANKS) throw new PlanError("bad-slot", `${what} bank ${b} does not exist (banks 1-64)`);
  return b;
}

/**
 * Reduce an operation to targets: slot -> {from: origin slot} | {clear: true},
 * in declaration order (destinations first, then clears).
 */
function targetsFor(op, info) {
  const targets = [];
  const rangeOp = (from, to, { clear, allowUnused }) => {
    const sources = asSlotList(from, "source");
    if (!isSlot(to)) throw new PlanError("bad-slot", `destination slot ${to} does not exist (slots are 1-A to 64-D)`);
    if (to + sources.length > TOTAL_SLOTS) {
      throw new PlanError("bad-range", `${sources.length} patches starting at ${label(to)} would run past 64-D`);
    }
    const dests = sources.map((_, i) => to + i);
    if (sources.every((s, i) => s === dests[i])) {
      throw new PlanError("same-slot", `the source and destination are the same (${range(sources)})`);
    }
    if (!allowUnused) {
      for (const s of sources) {
        if (info(s).unused) throw new PlanError("source-unused", `${label(s)} is unused; there is nothing to ${op.kind}`);
      }
    }
    sources.forEach((s, i) => targets.push({ slot: dests[i], from: s }));
    if (clear) for (const s of sources) if (!dests.includes(s)) targets.push({ slot: s, clear: true });
    return { sources, dests };
  };

  switch (op?.kind) {
    case "copy":
      return { targets, ...rangeOp(op.from, op.to, { clear: false, allowUnused: false }) };
    case "move":
      return { targets, ...rangeOp(op.from, op.to, { clear: true, allowUnused: false }) };
    case "swap": {
      if (Array.isArray(op.a)) {
        // S3.2: several patches (a list) with consecutive slots from op.b, pairwise like a bank swap.
        const sources = asSlotList(op.a, "source");
        if (!isSlot(op.b)) throw new PlanError("bad-slot", `destination slot ${op.b} does not exist (slots are 1-A to 64-D)`);
        if (op.b + sources.length > TOTAL_SLOTS) {
          throw new PlanError("bad-range", `${sources.length} patches starting at ${label(op.b)} would run past 64-D`);
        }
        const dests = sources.map((_, i) => op.b + i);
        const both = dests.filter((d) => sources.includes(d));
        if (both.length) {
          throw new PlanError("overlapping-swap", `${both.map(label).join(", ")} would be in two swaps at once; ` +
            "choose destination slots outside the selection");
        }
        sources.forEach((s, i) => targets.push({ slot: dests[i], from: s }, { slot: s, from: dests[i] }));
        return { targets, sources, dests };
      }
      const [a, b] = asSlotList([op.a, op.b], "swap");
      targets.push({ slot: b, from: a }, { slot: a, from: b });
      return { targets, sources: [a], dests: [b] };
    }
    case "rename": {
      const slot = op.slot;
      if (!isSlot(slot)) throw new PlanError("bad-slot", `slot ${slot} does not exist (slots are 1-A to 64-D)`);
      try {
        validateName(op.name);
      } catch (e) {
        throw new PlanError(e.code ?? "bad-name", e.message);
      }
      targets.push({ slot, renameTo: op.name });
      return { targets, sources: [slot], dests: [slot] };
    }
    case "clear": {
      // 0.11.0: one patch back to the built-in default, the same clear a Move's source gets.
      const slot = op.slot;
      if (!isSlot(slot)) throw new PlanError("bad-slot", `slot ${slot} does not exist (slots are 1-A to 64-D)`);
      if (info(slot).unused) throw new PlanError("source-unused", `${label(slot)} is already unused; there is nothing to clear`);
      targets.push({ slot, clear: true });
      return { targets, sources: [slot], dests: [slot] };
    }
    case "bank-copy":
    case "bank-move":
    case "bank-swap": {
      const from = checkBank(op.fromBank, "source");
      const to = checkBank(op.toBank, "destination");
      if (from === to) throw new PlanError("same-slot", `the source and destination are both bank ${from}`);
      const sources = bankSlots(from);
      const dests = bankSlots(to);
      if (op.kind === "bank-swap") {
        // Pairwise (design 2.5): each position's pair is declared together.
        sources.forEach((s, i) => targets.push({ slot: dests[i], from: s }, { slot: s, from: dests[i] }));
      } else {
        // Exact positional (Q2): unused positions are included, verbatim.
        sources.forEach((s, i) => targets.push({ slot: dests[i], from: s }));
        if (op.kind === "bank-move") for (const s of sources) targets.push({ slot: s, clear: true });
      }
      return { targets, sources, dests };
    }
    default:
      throw new PlanError("bad-op", `unknown operation "${op?.kind}" (expected one of ${PLAN_KINDS.join(", ")})`);
  }
}

/**
 * Order the steps (R-a, R-c) and record where an original goes off the pedal.
 * dependsOn: the steps that copy this slot's original elsewhere.
 */
function orderSteps(steps, unusedAt) {
  for (const s of steps) {
    s.needs = steps.filter((o) => o !== s && o.from === s.slot); // must run before s
  }
  const done = new Set();
  const order = [];
  const ready = (s) => s.needs.every((o) => done.has(o));
  while (order.length < steps.length) {
    const left = steps.filter((s) => !done.has(s));
    let next = left.find(ready);
    if (!next) {
      // Only cycles left (a swap). Break with a slot that holds nothing worth keeping, else the first declared.
      next = left.find((s) => unusedAt(s.slot)) ?? left[0];
    }
    order.push(next);
    done.add(next);
  }
  order.forEach((s, i) => { s.index = i; });
  for (const s of order) {
    s.dependsOn = s.needs.map((o) => o.index).sort((a, b) => a - b);
    // A dependency that runs later = the cycle was broken here: s's original is held in the backup until then.
    s.heldUntil = s.dependsOn.filter((i) => i > s.index);
    delete s.needs;
  }
  return order;
}

/**
 * Build a plan from an operation and the in-memory dumps (no pedal access).
 * @param {{kind: string, from?: number|number[], to?: number, a?: number, b?: number, fromBank?: number, toBank?: number}} op
 * @param {Map<number, Uint8Array>|(Uint8Array|null|undefined)[]} dumps slot -> 1176-byte dump (fresh reads)
 * @param {object} [o]
 * @param {readonly number[]} [o.zone] slots that may be written (default: the guard's static bank-60 zone)
 * @param {boolean} [o.moveClearAllowed] from defaultSelfCheck(); a clear to the default is refused without it
 * @param {{info: Function, debug: Function}} [o.log]
 * @returns {Plan}
 */
export function buildPlan(op, dumps, { zone = WRITABLE_SLOTS, moveClearAllowed = false, log = null, now = () => new Date() } = {}) {
  const get = (s) => (dumps instanceof Map ? dumps.get(s) : dumps?.[s]);
  const infoCache = new Map();
  const info = (s) => {
    if (!infoCache.has(s)) {
      const dump = get(s);
      if (!(dump instanceof Uint8Array) || dump.length !== EXPECTED_DUMP_LEN) {
        throw new PlanError("not-read", `${label(s)} has not been read completely (${dump?.length ?? "no"} bytes); read the pedal first`);
      }
      const bad = slotFieldMismatches(dump, s);
      if (bad.length) {
        throw new PlanError("slot-fields", `the read of ${label(s)} does not carry its own slot number ` +
          `(file ${bad.map((o) => `0x${o.toString(16)}`).join(", ")}); read the pedal again`);
      }
      infoCache.set(s, { dump, unused: classifyDefault(dump, s).unused, name: nameOf(dump) });
    }
    return infoCache.get(s);
  };

  // A swap with one unused slot is a Move of the real patch (design 2.3), planned as one.
  if (op?.kind === "swap" && Array.isArray(op.a) && op.a.length === 1) op = { ...op, a: op.a[0] };
  let kind = op?.kind;
  let effectiveOp = op;
  if (kind === "swap" && isSlot(op.a) && isSlot(op.b) && op.a !== op.b) {
    const ua = info(op.a).unused;
    const ub = info(op.b).unused;
    if (ua && ub) throw new PlanError("nothing-to-do", `${label(op.a)} and ${label(op.b)} are both unused; there is nothing to swap`);
    if (ua !== ub) {
      effectiveOp = ua ? { kind: "move", from: op.b, to: op.a } : { kind: "move", from: op.a, to: op.b };
      kind = "move";
    }
  } else if (kind === "swap" && op.a === op.b && isSlot(op.a)) {
    throw new PlanError("same-slot", `cannot swap ${label(op.a)} with itself`);
  }

  const { targets, sources, dests } = targetsFor(effectiveOp, info);
  const written = targets.map((t) => t.slot);
  const inputSlots = [...new Set([...sources, ...dests, ...written])];

  const zoneSet = new Set(zone);
  const outside = written.filter((s) => !zoneSet.has(s));
  if (outside.length) {
    throw new PlanError("not-in-zone", `${[...new Set(outside)].map(label).join(", ")} ${outside.length === 1 ? "is" : "are"} not writable yet. ` +
      "Nothing was written.", { slots: [...new Set(outside)] });
  }
  for (const s of inputSlots) info(s); // every input read and slot-checked

  if (kind === "swap" && !Array.isArray(op.a)) {
    if (identicalPatch(info(op.a).dump, info(op.b).dump, op.b)) {
      throw new PlanError("nothing-to-do", `${label(op.a)} and ${label(op.b)} hold the same patch; swapping them would change nothing`);
    }
  }

  // Build every step, then drop the ones that change nothing.
  let steps = targets.map((t) => {
    const before = info(t.slot).dump;
    const content = t.clear ? canonicalDefault(t.slot)
      : t.renameTo !== undefined ? withName(before, encodeName(t.renameTo))
        : info(t.from).dump;
    const expected = expectedAfterWrite(content, t.slot, before);
    return {
      slot: t.slot,
      from: t.clear || t.renameTo !== undefined ? null : t.from,
      transform: t.clear ? "default" : t.renameTo !== undefined ? "rename" : "identity",
      content, image: buildWriteImage(content, t.slot), expected, expectBefore: before,
      noop: classifyDumpDiff(before, expected).contentIdentical,
      why: t.clear ? (kind === "clear" ? `clear ${label(t.slot)}` : `clear ${label(t.slot)} (moved away)`)
        : t.renameTo !== undefined ? `rename ${label(t.slot)} to ${quoted(t.renameTo)}`
          : `${label(t.from)} → ${label(t.slot)}`,
    };
  });
  const dropped = steps.filter((s) => s.noop).map((s) => s.slot);
  steps = steps.filter((s) => !s.noop);
  for (const s of steps) delete s.noop;
  if (!steps.length) {
    throw new PlanError("nothing-to-do", "every slot already holds what this operation would write; nothing to write " +
      "(and a write that changes nothing could not be verified)");
  }
  const clears = steps.filter((s) => s.transform === "default");
  if (clears.length && !moveClearAllowed) {
    throw new PlanError("clear-not-allowed", `${kind === "clear" ? "Clear" : "a Move"} must clear ${clears.map((s) => label(s.slot)).join(", ")} to the built-in default, ` +
      "but the default check has not found that default on this pedal (a complete read is needed). Copy instead, or read the pedal again.");
  }

  const ordered = orderSteps(steps, (s) => info(s).unused);
  // Rename changes the content key of its own slot (the name is part of it), but nothing is
  // lost: it is the same patch, under a new name. The generic by-content survival tracking
  // would otherwise see it as "replaced". trackPatches is for identity-preserving moves.
  const survival = kind === "rename" ? { replaced: [], held: [] } : trackPatches(ordered, inputSlots, (s) => info(s).unused, (s) => info(s).dump);

  const plan = {
    kind, requested: op.kind, createdAt: now().toISOString(), zone: [...zone],
    sources, dests,
    inputs: inputSlots.map((s) => ({
      slot: s, label: label(s), dumpAtConfirm: info(s).dump, name: info(s).name, unused: info(s).unused,
      role: written.includes(s) ? (sources.includes(s) || targets.some((t) => t.from === s) ? "both" : "dest") : "source",
    })),
    steps: ordered.map((s) => ({ ...s, label: label(s.slot), name: nameOf(s.content), irNam: irNamDependencies(s.content) })),
    dropped,
    permitSlots: ordered.map((s) => s.slot),
    replaced: survival.replaced,
    held: survival.held,
    estimateSeconds: ordered.length * SECONDS_PER_WRITE,
  };
  checkOrdering(plan);
  if (log) {
    log.info(`Plan (${plan.kind}): ${historyTitle(plan)}; ${plan.steps.length} write(s)` +
      (dropped.length ? `, ${dropped.length} unchanged slot(s) skipped (${dropped.map(label).join(", ")})` : ""));
    for (const s of plan.steps) {
      log.debug(`  step ${s.index + 1}: ${s.why}` + (s.dependsOn.length ? ` (after step ${s.dependsOn.map((i) => i + 1).join(", ")})` : "") +
        (s.heldUntil.length ? ` — ${label(s.slot)}'s original is held in the backup until step ${s.heldUntil.map((i) => i + 1).join(", ")}` : ""));
    }
  }
  return plan;
}

/** Same patch content in two slots, ignoring their own slot fields and stamp. */
function identicalPatch(a, b, slotB) {
  return classifyDumpDiff(expectedAfterWrite(a, slotB, b), b).contentIdentical;
}

/**
 * Follow every original REAL patch through the steps, by content (contentKey:
 * the same patch in another slot counts): which ones are off the pedal for a
 * while (held in the backup) and which are gone at the end (replaced; they
 * survive only in the backup and journal).
 */
export function trackPatches(steps, inputSlots, unusedAt, dumpAt) {
  const keyOf = new Map(inputSlots.map((s) => [s, contentKey(dumpAt(s))]));
  const holds = new Map(keyOf); // slot -> key of what it holds now
  const reals = inputSlots.filter((s) => !unusedAt(s));
  const offAt = new Map(); // original slot -> step index after which it went off
  const held = [];
  for (const st of steps) {
    holds.set(st.slot, contentKey(st.expected));
    const present = new Set(holds.values());
    for (const r of reals) {
      const here = present.has(keyOf.get(r));
      if (!here && !offAt.has(r)) offAt.set(r, st.index);
      if (here && offAt.has(r)) {
        held.push({ slot: r, offAfterStep: offAt.get(r), backAtStep: st.index });
        offAt.delete(r);
      }
    }
    st.onPedalAfter = reals.filter((r) => present.has(keyOf.get(r)));
  }
  const replaced = [...offAt.keys()].sort((a, b) => a - b);
  return { replaced, held };
}

/**
 * Invariants every plan must satisfy (thrown as PlanError "bad-order"; tests
 * pin them): each slot written once, every written slot in the zone, and R-a:
 * a slot is overwritten only after every step that copies its original, unless
 * that step is recorded as holding it in the backup (heldUntil).
 */
export function checkOrdering(plan) {
  const zone = new Set(plan.zone);
  const seen = new Set();
  for (const [i, s] of plan.steps.entries()) {
    if (s.index !== i) throw new PlanError("bad-order", `step ${i} carries index ${s.index}`);
    if (seen.has(s.slot)) throw new PlanError("bad-order", `${label(s.slot)} is written twice`);
    seen.add(s.slot);
    if (!zone.has(s.slot)) throw new PlanError("bad-order", `${label(s.slot)} is outside the write zone`);
    for (const later of plan.steps.slice(i + 1)) {
      if (later.from === s.slot && !s.heldUntil.includes(later.index)) {
        throw new PlanError("bad-order", `step ${i + 1} overwrites ${label(s.slot)} before step ${later.index + 1} copies it`);
      }
    }
  }
  return true;
}

/**
 * The slot contents after the plan ran (or after its first `upTo` steps),
 * from the steps' expected bytes. A dry run: no pedal.
 */
export function simulatePlan(plan, upTo = plan.steps.length) {
  const out = new Map();
  for (const inp of plan.inputs) out.set(inp.slot, inp.dumpAtConfirm);
  for (const s of plan.steps.slice(0, upTo)) out.set(s.slot, s.expected);
  return out;
}

const VERB = { copy: "Copy", move: "Move", swap: "Swap", "bank-copy": "Copy", "bank-move": "Move", "bank-swap": "Swap", rename: "Rename", clear: "Clear" };
const PAST = { copy: "Copied", move: "Moved", swap: "Swapped", "bank-copy": "Copied", "bank-move": "Moved", "bank-swap": "Swapped", rename: "Renamed", clear: "Cleared" };
const ARROW = (kind) => (kind.endsWith("swap") ? "⇄" : "→");
const bankOfSlot = (s) => Math.floor(s / 4) + 1;

/** History title, e.g. "Moved 36-A → 40-A", "Swapped 36-A ⇄ 40-A", "Copied bank 36 → bank 40". */
export function historyTitle(plan) {
  if (plan.titles?.history) return plan.titles.history; // a recovery plan names itself (recovery.js)
  if (plan.kind === "rename") return `${PAST.rename} ${label(plan.dests[0])} to ${quoted(plan.steps[0].name)}`;
  if (plan.kind === "clear") return `${PAST.clear} ${label(plan.dests[0])}`;
  if (plan.kind.startsWith("bank-")) {
    return `${PAST[plan.kind]} bank ${bankOfSlot(plan.sources[0])} ${ARROW(plan.kind)} bank ${bankOfSlot(plan.dests[0])}`;
  }
  return `${PAST[plan.kind]} ${range(plan.sources)} ${ARROW(plan.kind)} ${range(plan.dests)}`;
}

/** The operation in the present tense, e.g. "Move 36-A → 40-A", "Swap 36-A ⇄ 40-A", "Copy bank 36 → bank 40". */
export function actionTitle(plan) {
  if (plan.titles?.action) return plan.titles.action;
  if (plan.kind === "rename") return `${VERB.rename} ${label(plan.dests[0])} to ${quoted(plan.steps[0].name)}`;
  if (plan.kind === "clear") return `${VERB.clear} ${label(plan.dests[0])}`;
  if (plan.kind.startsWith("bank-")) {
    return `${VERB[plan.kind]} bank ${bankOfSlot(plan.sources[0])} ${ARROW(plan.kind)} bank ${bankOfSlot(plan.dests[0])}`;
  }
  return `${VERB[plan.kind]} ${range(plan.sources)} ${ARROW(plan.kind)} ${range(plan.dests)}`;
}

/**
 * The Now → After preview for the confirmation (brief 3.3, 3.4): one
 * headline, one row per slot, a tick-box sentence only when a real patch
 * would be lost, and the plain notes. Technical detail goes under `details`.
 */
export function previewPlan(plan) {
  if (plan.preview) return plan.preview; // a recovery plan carries its own preview (recovery.js buildRecoveryPlan)
  const inp = new Map(plan.inputs.map((i) => [i.slot, i]));
  const gone = plan.kind === "clear" ? "cleared" : "replaced";
  const writtenBy = new Map(plan.steps.map((s) => [s.slot, s]));
  const show = (unused, name) => (unused ? "(empty)" : name);
  const afterOf = (slot) => {
    const st = writtenBy.get(slot);
    if (!st) return show(inp.get(slot).unused, inp.get(slot).name);
    if (st.transform === "default") return "(empty)";
    if (st.transform === "rename") return st.name;
    const origin = inp.get(st.from);
    return show(origin.unused, origin.name);
  };
  // Rows: sources first, then destinations, in the order the operation names them.
  const order = [...plan.sources, ...plan.dests, ...plan.inputs.map((i) => i.slot)];
  const rows = [...new Set(order)].map((slot) => {
    const i = inp.get(slot);
    const now = show(i.unused, i.name);
    const changes = writtenBy.has(slot);
    let note = "";
    if (plan.replaced.includes(slot)) note = `${quoted(i.name)} will be ${gone}`;
    else if (!changes) note = "unchanged";
    // 0.12.0: with several patches, where each one comes from (names alone may repeat, and sources may be scattered).
    const from = (plan.kind === "copy" || plan.kind === "move") && plan.sources.length > 1 ? writtenBy.get(slot)?.from : null;
    return { slot, label: label(slot), now, after: afterOf(slot), origin: Number.isInteger(from) ? label(from) : null, changes, note };
  });

  const s0 = plan.sources[0];
  const d0 = plan.dests[0];
  const n0 = inp.get(s0).name;
  let headline;
  if (plan.kind === "clear") {
    headline = `Clear ${n0} from ${label(d0)}?`;
  } else if (plan.kind === "rename") {
    headline = `Rename ${label(d0)} from ${quoted(n0)} to ${quoted(plan.steps[0].name)}?`;
  } else if (plan.kind.startsWith("bank-")) {
    headline = `${VERB[plan.kind]} bank ${bankOfSlot(s0)} ${plan.kind === "bank-swap" ? "with" : "to"} bank ${bankOfSlot(d0)}?`;
  } else if (plan.kind === "swap" && plan.sources.length === 1) {
    headline = `Swap ${n0} (${label(s0)}) with ${inp.get(d0).name} (${label(d0)})?`;
  } else if (plan.kind === "swap") {
    headline = `Swap ${plan.sources.length} patches (${range(plan.sources)}) with ${range(plan.dests)}?`;
  } else if (plan.sources.length === 1) {
    headline = `${VERB[plan.kind]} ${n0} from ${label(s0)} to ${label(d0)}?`;
  } else {
    headline = `${VERB[plan.kind]} ${plan.sources.length} patches from ${range(plan.sources)} to ${range(plan.dests)}?`;
  }

  const lost = plan.replaced.map((s) => `${label(s)} ${quoted(inp.get(s).name)}`);
  const tickBox = !lost.length ? null : lost.length === 1
    ? `I understand ${lost[0]} will be ${gone}.`
    : `I understand that ${lost.length} patches will be ${gone}: ${lost.join(", ")}.`;

  const notes = [];
  if (plan.kind === "rename") {
    notes.push("Only the name changes. Every other byte of the patch — effects, settings, IR/NAM references — stays exactly as it is now.");
  }
  if (plan.kind === "clear") {
    notes.push(`${label(d0)} gets the built-in default patch ("It's GP-200") and shows as unused. The patch is kept only in the backup saved first.`);
  }
  if (plan.kind === "move" || plan.kind === "bank-move") {
    const emptied = plan.steps.filter((s) => s.transform === "default").map((s) => label(s.slot));
    if (emptied.length) notes.push(`${emptied.join(", ")} will be empty afterwards.`);
  }
  if (plan.kind.endsWith("swap")) {
    notes.push(plan.sources.length > 1 ? "Every patch stays on the pedal, in its partner's place." : "Both patches stay on the pedal, in each other's place.");
  }
  for (const h of plan.held) {
    notes.push(`During the swap, ${quoted(inp.get(h.slot).name)} is held in the backup until it is written back.`);
  }
  notes.push(SAFEGUARD_LINE);
  notes.push(OTHER_EDITORS_LINE);
  const last = plan.steps[plan.steps.length - 1];
  notes.push(switchLine(last.label));
  const deps = [...new Set(plan.steps.flatMap((s) => (s.transform === "identity" ? s.irNam.map((x) => x.text) : [])))];
  if (deps.length) {
    notes.push(`Uses ${deps.join(", ")}: the patch keeps pointing at the same IR / NAM slot on this pedal; that data itself is not copied.`);
  }

  const details = [
    `${plan.steps.length} write${plan.steps.length === 1 ? "" : "s"}, about ${Math.round(plan.estimateSeconds)} s.`,
    ...plan.steps.map((s) => `Step ${s.index + 1}: ${s.why}` +
      (s.dependsOn.filter((i) => i < s.index).length ? ` (after step ${s.dependsOn.filter((i) => i < s.index).map((i) => i + 1).join(", ")} has verified)` : "")),
    ...(plan.dropped.length ? [`Skipped (already as intended): ${plan.dropped.map(label).join(", ")}.`] : []),
  ];

  return {
    headline, rows, tickBox, notes, details,
    // A real patch would be lost by a single Copy or Move: the confirmation also offers Swap (brief 3.4).
    swapInstead: lost.length > 0 && (plan.kind === "copy" || plan.kind === "move") && plan.sources.length === 1,
    confirmLabel: VERB[plan.kind],
  };
}

/** The preview as plain text (log, tests, and the dialog's fallback), e.g. "  36-A   80s Chorus   →   (empty)". */
export function formatPreview(p) {
  const w1 = Math.max(4, ...p.rows.map((r) => r.now.length));
  const afterText = (r) => (r.origin ? `${r.after} (from ${r.origin})` : r.after);
  const w2 = Math.max(5, ...p.rows.map((r) => afterText(r).length));
  const lines = [p.headline, "", `        ${"Now".padEnd(w1)}     ${"After".padEnd(w2)}`];
  for (const r of p.rows) {
    lines.push(`  ${r.label.padEnd(4)}  ${r.now.padEnd(w1)}  →  ${afterText(r).padEnd(w2)}${r.note ? `   ${r.note}` : ""}`.trimEnd());
  }
  // 0.12.0: past a bank Move's 8 rows the sentence only repeats them; the rows name every slot.
  const written = p.rows.length > 8 ? `This writes ${p.rows.filter((r) => r.changes).length} slots, each listed above.` : writtenSlotsLine(p.rows);
  lines.push("", ...(written ? [written] : []), ...p.notes);
  if (p.tickBox) lines.push("", `[ ] ${p.tickBox}`);
  return lines.join("\n");
}

/**
 * 0.6.0: one line naming every slot the write changes and what happens to it there: overwritten,
 * cleared (a Move's source included) or written into an empty slot. Null when nothing is written.
 */
export function writtenSlotsLine(rows) {
  const parts = rows.filter((r) => r.changes).map((r) => {
    const now = r.now === "(empty)" ? "(empty)" : quoted(r.now);
    if (r.after === "(empty)") return `${r.label} ${now} will be cleared (left empty)`;
    if (r.now === "(empty)") return `${r.label} (empty) will receive ${quoted(r.after)}`;
    return `${r.label} ${now} will be overwritten with ${quoted(r.after)}`;
  });
  return parts.length ? `This writes ${parts.length} slot${parts.length === 1 ? "" : "s"}: ${parts.join("; ")}.` : null;
}
