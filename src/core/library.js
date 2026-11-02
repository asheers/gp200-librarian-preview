// The librarian's model of the pedal: a Snapshot is one complete read of
// all 256 slots, keeping every raw 1176-byte dump exactly as received.
// Names and IR/NAM markers are derived from the dumps; nothing is altered.
//
// The read loop's logging (first-read chunk layout, retries, dump lengths)
// follows GP-200 Patch Manager Web's readSlots (donpark2000, src/core/export.js
// @ ff618e7, GPL-3.0). See docs/ATTRIBUTION.md.
//
// SPDX-License-Identifier: GPL-3.0-only

import { ReadError } from "./device.js";
import { displayName, irNamDependencies } from "./patch.js";
import { chunkOffset, chunkPayload, EXPECTED_DUMP_LEN } from "./sysex.js";
import { ALL_SLOTS, slotToDisplayLabel, TOTAL_SLOTS } from "./slots.js";
import { classifyDefaults, defaultSelfCheck, describeDefaults } from "./defaults.js";
import { describeObservation, observeState, splitStateDependent } from "./state-evidence.js";
import { classifyDumpDiff, summarizeVolatile } from "./volatile.js";

/**
 * @typedef {object} Snapshot
 * @property {number} readNumber        1 for the first read of a session, 2 for the next, ...
 * @property {string} startedAt         ISO time
 * @property {number} elapsedMs
 * @property {(Uint8Array|null)[]} dumps raw dump per slot, null if unreadable
 * @property {Map<number,string>} errors slot -> reason, for unreadable slots
 * @property {number} retried           slots that needed more than one attempt
 * @property {Map<number,number>} dumpLengths length -> count
 * @property {boolean} cancelled
 * @property {string|null} firstReadShape chunk layout of the first read, for the log
 * @property {import("./state-evidence.js").StateObservation} state the six evidenced values, signature and
 *   active slot (at the end of the read) as observed; recorded, not interpreted
 * @property {object|null} activeSlotAtStart the device's known active slot when the read started
 * @property {ReturnType<typeof classifyDefaults>} defaults each slot classified against the built-in default (by content)
 */

/**
 * Read `slots` (default all 256) into a Snapshot.
 * @param {import("./device.js").GP200} device
 */
export async function readAll(device, {
  log, readNumber = 1, slots = ALL_SLOTS, onProgress = () => {}, isCancelled = () => false,
} = {}) {
  const dumps = new Array(TOTAL_SLOTS).fill(null);
  const errors = new Map();
  const dumpLengths = new Map();
  let retried = 0;
  let cancelled = false;
  let firstReadShape = null;
  const startedAt = new Date().toISOString();
  const activeSlotAtStart = device.activeSlot ? { ...device.activeSlot } : null;
  // Read integrity (HS-3 follow-up): the slot read right after a slot that needed a retry or failed.
  const followUps = [];
  let troubled = null;
  const t0 = performance.now();
  log.info(`Read #${readNumber}: reading ${slots.length} slot(s)`, { keep: true });

  for (let i = 0; i < slots.length; i++) {
    if (isCancelled()) {
      cancelled = true;
      log.warn(`Read #${readNumber} cancelled after ${i} of ${slots.length} slots`);
      break;
    }
    const slot = slots[i];
    let r;
    try {
      r = await device.readDump(slot);
    } catch (e) {
      if (!(e instanceof ReadError)) throw e;
      log.error(`Could not read ${slotToDisplayLabel(slot)} (${e.reason})`);
      errors.set(slot, e.reason);
      onProgress({ done: i + 1, total: slots.length, slot, ok: false });
      troubled = slot; // the next slot read follows a failed read
      continue;
    }
    if (troubled !== null) {
      followUps.push({ slot, after: troubled });
      log.warn(`${slotToDisplayLabel(slot)} was read right after ${slotToDisplayLabel(troubled)} needed a retry: it is re-read to check it before this read is used for a backup, template or export`);
    }
    troubled = r.attempt > 1 ? slot : null;
    if (firstReadShape === null) {
      firstReadShape = r.chunks.map((m) => `${chunkOffset(m)}:${chunkPayload(m).length}`).join(", ");
      log.info(`First read (${slotToDisplayLabel(slot)}): ${r.chunks.length} chunks as offset:nibbles ` +
        `[${firstReadShape}], ${r.decoded.length} decoded bytes, ${r.ms.toFixed(0)} ms`);
    }
    if (r.attempt > 1) retried++;
    dumpLengths.set(r.decoded.length, (dumpLengths.get(r.decoded.length) ?? 0) + 1);
    dumps[slot] = r.decoded;
    onProgress({ done: i + 1, total: slots.length, slot, ok: true });
  }

  const elapsedMs = performance.now() - t0;
  // Per-read summaries are kept (protected tier): their timings must survive log rotation (H0).
  log.info(`Read #${readNumber}: ${dumps.filter(Boolean).length} of ${slots.length} slots read in ` +
    `${(elapsedMs / 1000).toFixed(2)} s; ${retried} needed a re-read, ${errors.size} unreadable`, { keep: true });
  const odd = [...dumpLengths].filter(([n]) => n !== EXPECTED_DUMP_LEN);
  if (odd.length) {
    log.warn(`Unexpected dump length(s): ${[...dumpLengths].map(([n, c]) => `${n} bytes x${c}`).join(", ")} ` +
      `(expected ${EXPECTED_DUMP_LEN})`);
  }
  const state = observeState(dumps, { activeSlot: device.activeSlot });
  log.info(`Read #${readNumber}: ${describeObservation(state)}`, { keep: true });
  if (state.finding) log.warn(`Read #${readNumber}: ${state.finding}`);
  const defaults = classifyDefaults(dumps);
  log.info(`Read #${readNumber}: slots by content: ${describeDefaults(defaults)}`, { keep: true });
  // The canonical default self-check (design 7.3, S3.0): reported after every read, kept in the log.
  const complete = !cancelled && dumps.length === TOTAL_SLOTS && dumps.every((d) => d && d.length === EXPECTED_DUMP_LEN);
  const defaultCheck = defaultSelfCheck(defaults, { complete });
  log.info(`Read #${readNumber}: ${defaultCheck.text}`, { keep: true });
  for (const [s, c] of defaults.bySlot.entries()) if (c?.cls === "unverified") log.warn(`${slotToDisplayLabel(s)}: ${c.reason}`);
  return { readNumber, startedAt, elapsedMs, dumps, errors, retried, dumpLengths, cancelled, firstReadShape, state, activeSlotAtStart, defaults, defaultCheck,
    followUps, integrity: null };
}

/** True when every one of the 256 slots was read, with the expected length. */
export function isComplete(snapshot) {
  return !snapshot.cancelled && snapshot.dumps.every((d) => d && d.length === EXPECTED_DUMP_LEN);
}

/** What the grid shows for one slot. */
export function slotInfo(snapshot, slot) {
  const dump = snapshot?.dumps[slot] ?? null;
  if (!dump) return { slot, read: false, error: snapshot?.errors.get(slot) ?? null, name: null, irNam: [] };
  return { slot, read: true, error: null, name: displayName(dump), irNam: irNamDependencies(dump) };
}

/**
 * Compare two snapshots byte for byte over every slot, and classify every
 * differing byte (src/core/volatile.js, src/core/state-evidence.js):
 *   rawMatch     - every byte of every slot identical;
 *   contentMatch - every byte identical except at the documented
 *                  read-volatile positions (dead bytes, tail +6/+7) and,
 *                  only where the evidence rule allows, STATE-DEPENDENT
 *                  bytes (reported separately: stateBytes).
 * Nothing is dropped: every differing byte stays in `differing`, with its
 * field and its class (file offset = dump offset + 0x28).
 */
export function compareSnapshots(a, b, { evidence = null } = {}) {
  // `evidence` ({register, signatures}) is for tests only; the app always uses the pinned register.
  const obsA = (!evidence && a.state) || observeState(a.dumps, { activeSlot: a.state?.activeSlot ?? null, ...evidence });
  const obsB = (!evidence && b.state) || observeState(b.dumps, { activeSlot: b.state?.activeSlot ?? null, ...evidence });
  const report = {
    slotsCompared: 0, bytesCompared: 0, identical: 0, differing: [], unreadable: [],
    volatileBytes: 0, contentBytes: 0, contentSlots: 0, stateBytes: 0,
    stateA: obsA, stateB: obsB, findings: [obsA.finding, obsB.finding].filter(Boolean),
  };
  for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
    const da = a.dumps[slot];
    const db = b.dumps[slot];
    if (!da || !db) {
      report.unreadable.push({ slot, inA: !!da, inB: !!db });
      continue;
    }
    report.slotsCompared++;
    report.bytesCompared += Math.max(da.length, db.length);
    const c = classifyDumpDiff(da, db);
    if (c.rawIdentical) {
      report.identical++;
      continue;
    }
    const { stateDependent, content } = splitStateDependent(slot, c.content, da, db, obsA, obsB, evidence ?? {});
    const diffs = [...c.volatile, ...stateDependent, ...content].sort((x, y) => x.off - y.off);
    report.differing.push({ slot, diffs, volatile: c.volatile, stateDependent, content, lenA: c.lengthA, lenB: c.lengthB });
    report.volatileBytes += c.volatile.length;
    report.stateBytes += stateDependent.length;
    report.contentBytes += content.length;
    if (content.length || c.lengthA !== c.lengthB) report.contentSlots++;
  }
  const complete = report.unreadable.length === 0 && report.slotsCompared === TOTAL_SLOTS;
  report.rawMatch = complete && report.differing.length === 0;
  report.contentMatch = complete && report.contentSlots === 0;
  report.volatileSummary = summarizeVolatile(report.differing.map((d) => d.volatile));
  return report;
}

const hex = (x) => (x === undefined ? "--" : x.toString(16).padStart(2, "0"));
const fileOff = (off) => `0x${off.toString(16).padStart(3, "0")}`;
const n = (x) => x.toLocaleString("en-US");

/** "STATE-DEPENDENT: ..." and FINDING lines, shared by the snapshot and backup reports. */
export function stateLines(stateBytes, obsA, obsB, findings) {
  const active = (o) => (o?.activeSlot ? slotToDisplayLabel(o.activeSlot.slot) : "unknown");
  const L = [];
  if (stateBytes) {
    L.push(`STATE-DEPENDENT: ${stateBytes} byte(s) at evidenced positions; signatures ${obsA.signature} → ${obsB.signature}; ` +
      `active slot ${active(obsA)} → ${active(obsB)}`);
  }
  for (const f of findings) L.push(`FINDING: ${f}`);
  return L;
}

/** The verdict lines, e.g. "RAW DUMP: DIFFERENT" and "PATCH CONTENT: IDENTICAL", then STATE-DEPENDENT and FINDING lines. */
export function snapshotVerdicts(rep) {
  if (rep.unreadable.length || rep.slotsCompared !== TOTAL_SLOTS) {
    const why = `${rep.unreadable.length} slot(s) not readable in both reads`;
    return [`RAW DUMP: INCOMPLETE (${why})`, `PATCH CONTENT: INCOMPLETE (${why})`];
  }
  const raw = rep.rawMatch ? "RAW DUMP: IDENTICAL"
    : `RAW DUMP: DIFFERENT (${n(rep.volatileBytes + rep.stateBytes + rep.contentBytes)} byte(s) in ${rep.differing.length} slot(s))`;
  const content = rep.contentMatch
    ? (rep.stateBytes ? `PATCH CONTENT: IDENTICAL apart from ${n(rep.stateBytes)} STATE-DEPENDENT byte(s)` : "PATCH CONTENT: IDENTICAL") +
      (rep.rawMatch ? "" : rep.stateBytes ? " (all other differing byte(s) are at documented read-volatile positions)"
        : ` (all ${n(rep.volatileBytes)} differing byte(s) are at documented read-volatile positions)`)
    : `PATCH CONTENT: DIFFERENT (${n(rep.contentBytes)} byte(s) in ${rep.contentSlots} slot(s) outside the documented ` +
      `read-volatile positions${rep.stateBytes ? ` and the ${n(rep.stateBytes)} STATE-DEPENDENT byte(s)` : ""})`;
  return [raw, content, ...stateLines(rep.stateBytes, rep.stateA, rep.stateB, rep.findings)];
}

/** Plain-text report of compareSnapshots(a, b). Lists and classifies every differing byte. */
export function formatSnapshotCompare(rep, a, b) {
  const L = [];
  L.push(`Read #${b.readNumber} (${b.startedAt}) compared with read #${a.readNumber} (${a.startedAt}), byte for byte. ` +
    "Every differing byte is listed and classified; nothing is ignored.");
  L.push(`${rep.slotsCompared} of ${TOTAL_SLOTS} slots compared, ${n(rep.bytesCompared)} bytes; ` +
    `${rep.identical} identical, ${rep.differing.length} different, ${rep.unreadable.length} not readable in both.`);
  L.push("Documented read-volatile positions (closed list): dead bytes 0x43 and 0x9F; tail block entries 0-7, bytes +6/+7. " +
    "Any other differing byte is a PATCH CONTENT difference.");
  L.push(`Read-volatile differences: ${n(rep.volatileBytes)} byte(s): ` +
    rep.volatileSummary.map(([cls, bytes, slots]) => `${cls}: ${n(bytes)} byte(s) in ${slots} slot(s)`).join("; ") + ".");
  L.push(`Read #${a.readNumber}: ${describeObservation(rep.stateA)}. Read #${b.readNumber}: ${describeObservation(rep.stateB)}.`);
  L.push(`STATE-DEPENDENT differences (six evidenced bytes, only where the evidence rule applies; not read-volatile): ` +
    `${n(rep.stateBytes)} byte(s).`);
  L.push(`Patch-content differences: ${n(rep.contentBytes)} byte(s) in ${rep.contentSlots} slot(s).`);
  for (const u of rep.unreadable) {
    L.push(`${slotToDisplayLabel(u.slot)}: not compared (read #${a.readNumber}: ${u.inA ? "ok" : "FAILED"}, ` +
      `read #${b.readNumber}: ${u.inB ? "ok" : "FAILED"})`);
  }
  if (rep.contentSlots) {
    L.push("PATCH CONTENT differences (every one):");
    for (const d of rep.differing) {
      if (d.lenA !== d.lenB) L.push(`    ${slotToDisplayLabel(d.slot)}: dump lengths differ, ${d.lenA} vs ${d.lenB}`);
      for (const x of d.content) L.push(`    ${slotToDisplayLabel(d.slot)} file ${fileOff(x.off)}: ${hex(x.a)} -> ${hex(x.b)}  ${x.what}`);
    }
  }
  L.push("All differing bytes, by slot:");
  for (const d of rep.differing) {
    L.push(`${slotToDisplayLabel(d.slot)}: ${d.diffs.length} byte(s) differ (${d.volatile.length} read-volatile, ` +
      `${d.stateDependent.length ? `${d.stateDependent.length} state-dependent, ` : ""}${d.content.length} patch content)` + (d.lenA !== d.lenB ? ` (lengths ${d.lenA} vs ${d.lenB})` : ""));
    for (const x of d.diffs) {
      const cls = x.cls === "state-dependent" ? "STATE-DEPENDENT" : x.cls ? `volatile: ${x.cls}` : "PATCH CONTENT";
      L.push(`    file ${fileOff(x.off)}: ${hex(x.a)} -> ${hex(x.b)}  ${x.what}  [${cls}]`);
    }
  }
  L.push(...snapshotVerdicts(rep));
  return L.join("\n");
}
