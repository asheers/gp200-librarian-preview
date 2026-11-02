// Compare an open backup with the live pedal (Phase 3 S2). Read only; no DOM
// code. The byte-level verdicts come from the existing comparator
// (compare.js compareBackups: raw vs raw with the read-volatile list and the
// six-byte STATE-DEPENDENT rule; raw vs .prst with the documented export
// normalisation). On top of that, each backup slot gets one plain status:
//
//   same        no patch-content difference
//   moved       differs here, but the backup's patch is on the live pedal in
//               another slot (normalised key), e.g. "-> 40-A"
//   now-used    the backup had an unused slot here; live has a real patch
//   changed     the backup's real patch is not on the pedal any more, and a
//               real patch is here now (edited or replaced)
//   gone        the backup's real patch is not on the pedal any more, and
//               this slot is now unused
//
// SPDX-License-Identifier: GPL-3.0-only

import { compareBackups, formatCompareReport } from "./compare.js";
import { slotToDisplayLabel, TOTAL_SLOTS } from "./slots.js";

/** The backup source as compareBackups input: raw dumps where present, otherwise the original .prst. */
function backupAsLoaded(src) {
  const raw = new Map();
  const prst = new Map();
  for (let s = 0; s < TOTAL_SLOTS; s++) {
    if (src.provenance[s] === "raw") raw.set(s, src.dumps[s]);
    else if (src.provenance[s] === "prst" && src.prstFiles[s]) prst.set(s, { name: `${slotToDisplayLabel(s)}.prst`, data: src.prstFiles[s] });
  }
  return { fileName: src.fileName, raw, prst, manifest: src.manifest, ignored: [], info: src.info };
}

function liveAsLoaded(snapshot) {
  const raw = new Map();
  snapshot.dumps.forEach((d, s) => { if (d) raw.set(s, d); });
  return { fileName: `live pedal, read #${snapshot.readNumber}`, raw, prst: new Map(), manifest: { state: snapshot.state ?? null }, ignored: [], info: null };
}

/**
 * @param {import("./backup-source.js").BackupSource} src
 * @param {object} backupView buildBankView(src)
 * @param {object} liveSnapshot a complete live read
 * @param {object} liveView buildBankView(liveSnapshot)
 */
export function compareWithLive(src, backupView, liveSnapshot, liveView) {
  const rep = compareBackups(backupAsLoaded(src), liveAsLoaded(liveSnapshot));
  const problemSlots = new Map();
  for (const p of rep.problems) problemSlots.set(p.slot, (problemSlots.get(p.slot) ?? 0) + (p.diffs?.length ?? 1));
  const liveByKey = new Map();
  for (const s of liveView.slots) if (s.read && !s.unused) liveByKey.set(s.nkey, [...(liveByKey.get(s.nkey) ?? []), s.slot]);
  const slots = new Array(TOTAL_SLOTS).fill(null);
  const counts = { same: 0, moved: 0, "now-used": 0, changed: 0, gone: 0, compared: 0 };
  for (let s = 0; s < TOTAL_SLOTS; s++) {
    const b = backupView.slots[s];
    const l = liveView.slots[s];
    if (!b.read || !l.read) continue;
    counts.compared++;
    let r;
    if (!problemSlots.has(s)) r = { status: "same" };
    else {
      const elsewhere = b.unused ? [] : (liveByKey.get(b.nkey) ?? []).filter((x) => x !== s);
      if (elsewhere.length) r = { status: "moved", to: elsewhere };
      else if (b.unused) r = { status: "now-used" };
      else if (l.unused) r = { status: "gone" };
      else r = { status: "changed", bytes: problemSlots.get(s) };
    }
    counts[r.status]++;
    slots[s] = r;
  }
  return { slots, counts, report: rep, stateBytes: rep.stateBytes };
}

/**
 * "256 compared: 240 same · on the pedal now: 9 changed · 3 moved or copied · 2 used (unused in this backup) · 2 gone".
 * U-H3-3 (S3.0): the differences are introduced once as the pedal's state now; a slot that is used now
 * says that it is unused in this backup. Kept short: the banner is one line (A3).
 */
export function describeCounts(c) {
  const head = `${c.compared} compared: ${c.same} same`;
  const parts = [];
  if (c.changed) parts.push(`${c.changed} changed`);
  if (c.moved) parts.push(`${c.moved} moved or copied`);
  if (c["now-used"]) parts.push(`${c["now-used"]} used (unused in this backup)`);
  if (c.gone) parts.push(`${c.gone} gone`);
  return parts.length ? `${head} · on the pedal now: ${parts.join(" · ")}` : head;
}

/**
 * Tile mark for one slot's status: {text, title} or null for "same". The tile itself shows the
 * BACKUP's patch; the mark (and its title, which starts "On the pedal now") is about the pedal now (U-H3-3).
 */
export function compareMark(r) {
  if (!r || r.status === "same") return null;
  switch (r.status) {
    case "moved": return { text: `→ ${r.to.map(slotToDisplayLabel).join(", ")}`, title: `On the pedal now: this patch is at ${r.to.map(slotToDisplayLabel).join(", ")}` };
    case "now-used": return { text: "+ used now", title: "On the pedal now: a patch is here (this slot is unused in this backup)" };
    case "gone": return { text: "∅", title: "On the pedal now: this slot is unused, and this backup's patch is not anywhere on the pedal" };
    default: return { text: "Δ", title: `On the pedal now: a different patch is here (${r.bytes} byte difference(s); see the report)` };
  }
}

/**
 * The summary's two named lines (U-H3-3): this backup's slot and the pedal's slot now.
 * @param {{read: boolean, unused: boolean, name: string|null}} backupSlot
 * @param {{read: boolean, unused: boolean, name: string|null}|null} liveSlot
 * @param {object|null} r this slot's compareWithLive status
 * @param {{pedal?: string}} [o] the pedal's name in the label ("the pedal", "the demo pedal")
 * @returns {{label: string, text: string}[]}
 */
export function compareLines(backupSlot, liveSlot, r, { pedal = "the pedal" } = {}) {
  const what = (s) => (!s?.read ? null : s.unused ? "unused (\"It's GP-200\")" : `"${s.name || "(no name)"}"`);
  const lines = [{ label: "In this backup", text: what(backupSlot) ?? "not in this backup" }];
  if (!r || !liveSlot?.read) return lines;
  const now = what(liveSlot);
  const text = r.status === "same" ? `${now}, the same`
    : r.status === "moved" ? `${now}; this backup's patch is now at ${r.to.map(slotToDisplayLabel).join(", ")}`
      : r.status === "now-used" ? `${now} (unused in this backup)`
        : r.status === "gone" ? `${now}; this backup's patch is not anywhere on the pedal`
          : `${now}, a different patch (${r.bytes} byte difference(s); see the report)`;
  lines.push({ label: `On ${pedal} now`, text });
  return lines;
}

/** The full comparison report (the same text format as tools/compare-backups.js), with the status summary first. */
export function compareReportText(result) {
  return [`Backup vs live pedal: ${describeCounts(result.counts)}.`, "", formatCompareReport(result.report)].join("\n");
}
