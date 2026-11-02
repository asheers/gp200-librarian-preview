// Comparing two backups (Phase 1 acceptance test; Phase 2 before/after checks):
//   - two GP200 Librarian backups (read #1 vs read #2), and
//   - a GP200 Librarian backup vs a GP-200 Patch Manager (donpark) backup.
//
// STRICT by design: nothing is ignored. Every differing byte is reported.
// Two kinds of difference are classified rather than failed, and both are
// still listed and counted in full, never hidden:
//   - raw dump vs raw dump: bytes at the documented read-volatile positions
//     (src/core/volatile.js: dead bytes 0x43/0x9F, tail +6/+7). These make
//     RAW DUMP: DIFFERENT but leave PATCH CONTENT: IDENTICAL;
//   - raw dump vs a .prst export made from the same dump: bytes donpark's
//     documented export normalization sets to 0x00 (EXPORT_NORMALIZED_OFFSETS).
//   - raw dump vs raw dump, between two COMPLETE backups whose state
//     observations are both recognised: the six evidenced active-patch-
//     dependent bytes, under the closed rule in src/core/state-evidence.js.
//     Reported as STATE-DEPENDENT, never as read-volatile, and the verdict
//     says "IDENTICAL apart from n STATE-DEPENDENT byte(s)", never plain
//     IDENTICAL. Raw vs .prst comparisons are never classified this way.
// Any other difference fails PATCH CONTENT. Pedal-managed bytes are NOT
// excused here: a backup compare must show every change, including these.
//
// Slot matching by the label a .prst file name starts with ("36A_...")
// follows donpark's tools/compare-lib.js (@ ff618e7, GPL-3.0).
//
// SPDX-License-Identifier: GPL-3.0-only

import {
  CHECKSUM_OFF, checksumOk, CONTENT_FILE_START, describeOffset, EXPORT_NORMALIZED_OFFSETS, isPrst, PRST_LEN,
} from "./patch.js";
import { BACKUP_FORMAT, BACKUP_FORMAT_V1, BACKUP_KINDS } from "./backup.js";
import { sha256Hex } from "./sha256.js";
import { labelToSlot, slotToDisplayLabel, TOTAL_SLOTS } from "./slots.js";
import { readZip } from "./unzip.js";
import { stateLines } from "./library.js";
import { describeObservation, observeState, splitStateDependent } from "./state-evidence.js";
import { classifyDumpDiff, summarizeVolatile } from "./volatile.js";

const NORMALIZED = new Set(EXPORT_NORMALIZED_OFFSETS);
const baseName = (name) => name.split(/[\\/]/).pop();

function labelOfPrst(name) {
  try {
    return labelToSlot(baseName(name).split("_")[0]);
  } catch {
    return null;
  }
}

/**
 * Load a backup zip (ours or donpark's) into slot-indexed maps.
 * @returns {Promise<{fileName: string, prst: Map<number,{name: string, data: Uint8Array}>, raw: Map<number,Uint8Array>,
 *   manifest: object|null, ignored: string[]}>}
 */
export async function loadBackup(zipBytes, fileName = "backup.zip") {
  const zip = await readZip(zipBytes);
  const prst = new Map();
  const raw = new Map();
  const ignored = [];
  let manifest = null;
  for (const [name, data] of zip) {
    if (name.endsWith("/")) continue;
    const rawMatch = /^raw\/(\d+[ABCD])\.bin$/i.exec(name);
    if (rawMatch) {
      raw.set(labelToSlot(rawMatch[1]), data);
    } else if (name === "manifest.json") {
      manifest = JSON.parse(new TextDecoder().decode(data));
    } else if (name.toLowerCase().endsWith(".prst") && labelOfPrst(name) !== null) {
      const slot = labelOfPrst(name);
      if (prst.has(slot)) throw new Error(`${fileName}: two .prst files for ${slotToDisplayLabel(slot)}`);
      prst.set(slot, { name: baseName(name), data });
    } else {
      ignored.push(name);
    }
  }
  // `entries`: every zip entry by name (views into the file's bytes: read them, never change them).
  return { fileName, prst, raw, manifest, ignored, entries: zip, info: identifyBackup(zip, manifest, { prst, raw, fileName }) };
}

/**
 * Which kind of file this is, and (format 2) verify every entry's SHA-256
 * against the manifest. A damaged or incomplete format-2 backup is refused.
 * @returns {{format: string, version: 1|2|null, kind: string, checksums: "verified"|"none (format 1)"|"none", verifiedEntries: number}}
 */
function identifyBackup(zip, manifest, { prst, raw, fileName }) {
  if (!manifest) {
    return { format: "none", version: null, kind: prst.size || raw.size ? "foreign" : "unknown", checksums: "none", verifiedEntries: 0 };
  }
  if (manifest.format === BACKUP_FORMAT_V1) {
    const kind = manifest.slotsIncluded === TOTAL_SLOTS && !manifest.missing?.length ? "pedal" : "selection";
    return { format: manifest.format, version: 1, kind, checksums: "none (format 1)", verifiedEntries: 0 };
  }
  if (manifest.format !== BACKUP_FORMAT) {
    throw new Error(`${fileName}: unsupported backup format "${manifest.format}" (this version reads ${BACKUP_FORMAT_V1} and ${BACKUP_FORMAT})`);
  }
  if (!BACKUP_KINDS.includes(manifest.kind)) throw new Error(`${fileName}: unknown backup kind "${manifest.kind}"`);
  const sums = manifest.sha256;
  if (!sums || typeof sums !== "object") throw new Error(`${fileName}: format 2 backup without checksums: damaged or not ours`);
  let verifiedEntries = 0;
  for (const [name, expected] of Object.entries(sums)) {
    const data = zip.get(name);
    if (!data) throw new Error(`${fileName}: damaged backup: ${name} is listed in the manifest but missing`);
    if (sha256Hex(data) !== expected) throw new Error(`${fileName}: damaged backup: ${name} does not match its SHA-256 checksum`);
    verifiedEntries++;
  }
  for (const name of zip.keys()) {
    if (name !== "manifest.json" && !name.endsWith("/") && !(name in sums)) {
      throw new Error(`${fileName}: damaged backup: ${name} is not listed in the manifest`);
    }
  }
  return { format: manifest.format, version: 2, kind: manifest.kind, checksums: "verified", verifiedEntries };
}

/** "librarian backup format 2, pedal, 513 entries checksum-verified" etc. */
export function describeBackupInfo(info) {
  if (info.version === 2) return `GP200 Librarian backup format 2, ${info.kind} backup, ${info.verifiedEntries} entries checksum-verified`;
  if (info.version === 1) return `GP200 Librarian backup format 1, ${info.kind} backup (no checksums in format 1)`;
  return info.kind === "foreign" ? "backup without a GP200 Librarian manifest (e.g. GP-200 Patch Manager): .prst files only, no checksums"
    : "not a recognised backup";
}

function diffBytes(a, b) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) out.push({ off: i, a: a[i], b: b[i] });
  return out;
}

/**
 * Compare a raw dump with a .prst file over the dump's range. A byte is
 * "explained" if the .prst holds 0x00 at a documented export-normalized
 * offset where the raw dump holds something else; anything else that
 * differs is unexplained. Bytes outside the dump (file header/footer) are
 * not covered by a raw dump and are reported by the caller via the .prst
 * comparison or checksum check.
 */
export function compareRawWithPrst(raw, prst) {
  const explained = [];
  const unexplained = [];
  if (!isPrst(prst)) return { explained, unexplained: [{ off: -1, raw: null, prst: null, what: "not a valid 1224-byte .prst" }] };
  const end = Math.min(CONTENT_FILE_START + raw.length, CHECKSUM_OFF);
  for (let off = CONTENT_FILE_START; off < end; off++) {
    const r = raw[off - CONTENT_FILE_START];
    const p = prst[off];
    if (r === p) continue;
    const d = { off, raw: r, prst: p, what: describeOffset(off) };
    if (NORMALIZED.has(off) && p === 0) explained.push(d);
    else unexplained.push(d);
  }
  if (raw.length + CONTENT_FILE_START !== PRST_LEN - 8) {
    unexplained.push({ off: -1, raw: null, prst: null, what: `raw dump is ${raw.length} bytes, expected 1176` });
  }
  return { explained, unexplained };
}

/**
 * Compare backup B against backup A, slot by slot.
 * @param {Awaited<ReturnType<typeof loadBackup>>} A
 * @param {Awaited<ReturnType<typeof loadBackup>>} B
 */
export function compareBackups(A, B, { evidence = null } = {}) {
  const slotsOf = (x) => new Set([...x.prst.keys(), ...x.raw.keys()]);
  const sa = slotsOf(A);
  const sb = slotsOf(B);
  const rep = {
    a: A.fileName, b: B.fileName, infoA: A.info ?? null, infoB: B.info ?? null,
    onlyA: [...sa].filter((s) => !sb.has(s)).sort((x, y) => x - y),
    onlyB: [...sb].filter((s) => !sa.has(s)).sort((x, y) => x - y),
    slotsCompared: 0,
    checks: { prstVsPrst: 0, rawVsRaw: 0, rawVsPrst: 0, selfCheck: 0 },
    bytesCompared: 0,
    problems: [], // {slot, kind, detail, diffs?}
    explained: [], // {slot, kind, diffs}: documented export-format differences
    rawVolatile: [], // {slot, diffs}: raw vs raw differences at documented read-volatile positions
    rawDifferingSlots: 0,
    ignoredEntries: { a: A.ignored, b: B.ignored },
    stateDependent: [], // {slot, diffs}: raw vs raw, the evidenced state bytes (state-evidence.js rule)
    stateBytes: 0,
    // `evidence` ({register, signatures}) is for tests only; the tool and app use the pinned register.
    stateA: observeState(A.raw, { activeSlot: A.manifest?.state?.activeSlot ?? null, ...evidence }),
    stateB: observeState(B.raw, { activeSlot: B.manifest?.state?.activeSlot ?? null, ...evidence }),
  };
  rep.findings = [rep.stateA.finding && `A: ${rep.stateA.finding}`, rep.stateB.finding && `B: ${rep.stateB.finding}`].filter(Boolean);
  const problem = (slot, kind, detail, diffs) => rep.problems.push({ slot, kind, detail, diffs });

  // Each librarian backup's .prst must be consistent with its own raw dump.
  for (const [X, side] of [[A, "a"], [B, "b"]]) {
    for (const [slot, raw] of X.raw) {
      const p = X.prst.get(slot);
      if (!p) continue;
      rep.checks.selfCheck++;
      const c = compareRawWithPrst(raw, p.data);
      if (c.unexplained.length) problem(slot, `self-check ${side}`, `${X.fileName}: .prst does not match its own raw dump`, c.unexplained);
    }
  }

  for (const slot of [...sa].filter((s) => sb.has(s)).sort((x, y) => x - y)) {
    rep.slotsCompared++;
    const pa = A.prst.get(slot);
    const pb = B.prst.get(slot);
    const ra = A.raw.get(slot);
    const rb = B.raw.get(slot);

    for (const [p, X] of [[pa, A], [pb, B]]) {
      if (p && !checksumOk(p.data)) problem(slot, "checksum", `${X.fileName}: ${p.name} has an invalid checksum`);
    }
    let stateOffsets = new Map(); // file offset -> {a, b}: this slot's STATE-DEPENDENT raw bytes
    if (ra && rb) {
      rep.checks.rawVsRaw++;
      rep.bytesCompared += Math.max(ra.length, rb.length);
      const c = classifyDumpDiff(ra, rb);
      if (!c.rawIdentical) rep.rawDifferingSlots++;
      if (c.volatile.length) rep.rawVolatile.push({ slot, diffs: c.volatile });
      if (c.lengthA !== c.lengthB) problem(slot, "raw vs raw (patch content)", `raw dump lengths differ: ${c.lengthA} vs ${c.lengthB}`);
      const { stateDependent, content } = splitStateDependent(slot, c.content, ra, rb, rep.stateA, rep.stateB, evidence ?? {});
      if (stateDependent.length) {
        rep.stateDependent.push({ slot, diffs: stateDependent });
        stateOffsets = new Map(stateDependent.map((x) => [x.off, x]));
        rep.stateBytes += stateDependent.length;
      }
      if (content.length) {
        problem(slot, "raw vs raw (patch content)", `raw dumps differ in ${content.length} byte(s) outside the ` +
          "documented read-volatile positions", content);
      }
    }
    if (pa && pb) {
      rep.checks.prstVsPrst++;
      rep.bytesCompared += Math.max(pa.data.length, pb.data.length);
      let d = diffBytes(pa.data, pb.data).map((x) => ({ ...x, what: describeOffset(x.off) }));
      if (stateOffsets.size) {
        // The .prst copies carry the same STATE-DEPENDENT bytes (same offsets and values as the raw dumps),
        // and so their checksums differ. Excuse exactly those offsets, and the checksum only if nothing else differs.
        const rest = d.filter((x) => !(stateOffsets.get(x.off)?.a === x.a && stateOffsets.get(x.off)?.b === x.b));
        const onlyChecksum = rest.every((x) => x.off === CHECKSUM_OFF || x.off === CHECKSUM_OFF + 1);
        d = onlyChecksum && checksumOk(pa.data) && checksumOk(pb.data) ? [] : rest;
      }
      if (d.length) problem(slot, ".prst vs .prst", `${pa.name} vs ${pb.name}: ${d.length} byte(s) differ`, d);
      if (pa.name !== pb.name) problem(slot, "file name", `file names differ: "${pa.name}" vs "${pb.name}"`);
    }
    // Cross-format: one side has only a .prst (e.g. donpark's backup), the other a raw dump.
    for (const [raw, p, rawSide, prstSide] of [[ra, pb, A, B], [rb, pa, B, A]]) {
      if (!raw || !p) continue;
      if (rawSide.prst.has(slot) && prstSide.raw.has(slot)) continue; // both sides complete: covered above
      rep.checks.rawVsPrst++;
      rep.bytesCompared += raw.length;
      const c = compareRawWithPrst(raw, p.data);
      if (c.explained.length) rep.explained.push({ slot, kind: `raw (${rawSide.fileName}) vs .prst (${prstSide.fileName})`, diffs: c.explained });
      if (c.unexplained.length) {
        problem(slot, "raw vs .prst", `raw dump (${rawSide.fileName}) vs ${p.name} (${prstSide.fileName}): ` +
          `${c.unexplained.length} unexplained byte difference(s)`, c.unexplained);
      }
    }
  }
  rep.contentMatch = rep.onlyA.length === 0 && rep.onlyB.length === 0 && rep.problems.length === 0 && rep.slotsCompared > 0;
  // null when no slot has a raw dump on both sides (e.g. against a .prst-only backup).
  rep.rawMatch = rep.checks.rawVsRaw === 0 ? null : rep.rawDifferingSlots === 0;
  return rep;
}

/** The verdict lines: RAW DUMP, PATCH CONTENT, then STATE-DEPENDENT and FINDING lines if any. */
export function backupVerdicts(rep) {
  const volatileBytes = rep.rawVolatile.reduce((t, v) => t + v.diffs.length, 0);
  const raw = rep.rawMatch === null ? "RAW DUMP: NOT COMPARED (no slot has a raw dump in both backups)"
    : rep.rawMatch ? `RAW DUMP: IDENTICAL (${rep.checks.rawVsRaw} slot(s))`
      : `RAW DUMP: DIFFERENT (${rep.rawDifferingSlots} of ${rep.checks.rawVsRaw} slot(s); ` +
        `${volatileBytes.toLocaleString("en-US")} byte(s) at documented read-volatile positions)`;
  const content = rep.contentMatch
    ? (rep.stateBytes ? `PATCH CONTENT: IDENTICAL apart from ${rep.stateBytes} STATE-DEPENDENT byte(s)` : "PATCH CONTENT: IDENTICAL")
    : `PATCH CONTENT: DIFFERENT (${rep.problems.length} problem(s), ` +
      `${rep.onlyA.length + rep.onlyB.length} slot(s) missing on one side)`;
  return [raw, content, ...stateLines(rep.stateBytes, rep.stateA, rep.stateB, rep.findings)];
}

const hex = (x) => (x === undefined || x === null ? "--" : x.toString(16).padStart(2, "0"));

/** Plain-text report (used by the command-line tool and the in-app compare). */
export function formatCompareReport(rep, { maxPerSlot = Infinity } = {}) {
  const L = [];
  L.push(`A: ${rep.a}${rep.infoA ? ` (${describeBackupInfo(rep.infoA)})` : ""}`);
  L.push(`B: ${rep.b}${rep.infoB ? ` (${describeBackupInfo(rep.infoB)})` : ""}`);
  L.push(`${rep.slotsCompared} slot(s) in both; ${rep.bytesCompared.toLocaleString("en-US")} bytes compared ` +
    `(.prst vs .prst: ${rep.checks.prstVsPrst}, raw vs raw: ${rep.checks.rawVsRaw}, ` +
    `raw vs .prst: ${rep.checks.rawVsPrst}, self-checks: ${rep.checks.selfCheck})`);
  for (const s of rep.onlyA) L.push(`only in A: ${slotToDisplayLabel(s)}`);
  for (const s of rep.onlyB) L.push(`only in B: ${slotToDisplayLabel(s)}`);
  for (const [side, names] of Object.entries(rep.ignoredEntries)) {
    if (names.length) L.push(`not compared (not a slot file) in ${side.toUpperCase()}: ${names.join(", ")}`);
  }
  for (const p of rep.problems) {
    L.push(`${slotToDisplayLabel(p.slot)} [${p.kind}] ${p.detail}`);
    for (const d of (p.diffs ?? []).slice(0, maxPerSlot)) {
      const a = "a" in d ? d.a : d.raw;
      const b = "b" in d ? d.b : d.prst;
      L.push(`    ${d.off >= 0 ? "0x" + d.off.toString(16).padStart(3, "0") : "     "} ${hex(a)} vs ${hex(b)}  ${d.what ?? ""}`);
    }
    if ((p.diffs?.length ?? 0) > maxPerSlot) L.push(`    ... ${p.diffs.length - maxPerSlot} more`);
  }
  if (rep.explained.length) {
    const byWhat = new Map();
    let total = 0;
    for (const e of rep.explained) {
      for (const d of e.diffs) {
        total++;
        byWhat.set(d.what, (byWhat.get(d.what) ?? 0) + 1);
      }
    }
    L.push(`Documented export-format differences (raw dump vs donpark-normalized .prst, which sets these to 0x00): ` +
      `${total} byte(s) in ${rep.explained.length} slot(s):`);
    for (const [what, n] of [...byWhat].sort((x, y) => y[1] - x[1])) L.push(`    ${what}: ${n}`);
    for (const e of rep.explained) {
      L.push(`    ${slotToDisplayLabel(e.slot)}: ` + e.diffs.map((d) => `0x${d.off.toString(16)}=${hex(d.raw)}`).join(", "));
    }
  }
  if (rep.rawVolatile.length) {
    const summary = summarizeVolatile(rep.rawVolatile.map((v) => v.diffs));
    const total = summary.reduce((t, [, bytes]) => t + bytes, 0);
    L.push(`Read-volatile raw dump differences (documented closed list: dead bytes 0x43/0x9F, tail block +6/+7; ` +
      `not patch content): ${total.toLocaleString("en-US")} byte(s) in ${rep.rawVolatile.length} slot(s):`);
    for (const [cls, bytes, slots] of summary) L.push(`    ${cls}: ${bytes.toLocaleString("en-US")} byte(s) in ${slots} slot(s)`);
    for (const v of rep.rawVolatile) {
      L.push(`    ${slotToDisplayLabel(v.slot)}: ` + v.diffs.map((d) => `0x${d.off.toString(16)} ${hex(d.a)}->${hex(d.b)}`).join(", "));
    }
  }
  L.push(`State observation A: ${describeObservation(rep.stateA)}`);
  L.push(`State observation B: ${describeObservation(rep.stateB)}`);
  if (rep.stateDependent.length) {
    L.push(`STATE-DEPENDENT raw dump differences (the six evidenced bytes, closed rule; not read-volatile, not ignored): ` +
      `${rep.stateBytes} byte(s) in ${rep.stateDependent.length} slot(s):`);
    for (const s of rep.stateDependent) {
      L.push(`    ${slotToDisplayLabel(s.slot)}: ` + s.diffs.map((d) => `0x${d.off.toString(16)} ${hex(d.a)}->${hex(d.b)}`).join(", "));
    }
  }
  L.push(...backupVerdicts(rep));
  return L.join("\n");
}
