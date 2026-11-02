// Real and demo history (S3.0 O2, approved 2026-10-18). No DOM code.
//
// From 0.4.2-o2 the demo pedal and the real pedal keep their history in
// separate browser databases (src/ui/store-idb.js), and every new journal
// entry carries `pedalKind: "real" | "demo"`, stamped by the store.
//
// Entries recorded earlier have no pedalKind. They are never moved, changed
// or deleted. They are classified at read time, by evidence only:
//   "demo-evidence"  one of its patch dumps has exactly the patch content of
//                    an INVENTED demo patch (src/dev/demo-patches.js, a patch
//                    whose settings differ from the factory default). Such
//                    content cannot come from a real pedal unless it was put
//                    there from the demo;
//   "unmarked"       no such evidence. Ambiguous, so it stays real history.
// Default-family demo patches (the factory default, renamed or slightly
// edited defaults) are NOT evidence: the same content exists on real pedals
// (the demo's 44-A "It's GP-200JBBBA" is also on the user's pedal).
//
// SPDX-License-Identifier: GPL-3.0-only

import { classifyDefault } from "./defaults.js";
import { contentKey } from "./match.js";
import { slotToDisplayLabel } from "./slots.js";
import { EXPECTED_DUMP_LEN } from "./sysex.js";
import { displayName } from "./patch.js";

export const PEDAL_KINDS = Object.freeze(["real", "demo"]);
/** The first version that stamps pedalKind on journal entries. */
export const MARKED_SINCE = "0.4.2-o2";

/**
 * The demo evidence index: contentKey -> the invented demo patch it identifies.
 * @param {Map<number, Uint8Array>} demoDumps slot -> dump of the demo pedal (realisticDemoDumps)
 * @returns {Map<string, {slot: number, label: string, name: string}>}
 */
export function buildDemoEvidence(demoDumps) {
  const index = new Map();
  for (const [slot, dump] of demoDumps) {
    if (classifyDefault(dump, slot).cls !== "real") continue; // default-family content: not evidence
    index.set(contentKey(dump), { slot, label: slotToDisplayLabel(slot), name: displayName(dump) });
  }
  return index;
}

/** Every patch dump in an entry, with its path ("source.dump", "dest.before", ...). */
function dumpsIn(entry) {
  const out = [];
  const walk = (v, path) => {
    if (v instanceof Uint8Array) {
      if (v.length === EXPECTED_DUMP_LEN) out.push({ path, dump: v });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${i}`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(entry, "");
  return out;
}

/**
 * Where a journal entry came from.
 * @param {object} entry a journal entry (live or archived)
 * @param {Map<string, {slot: number, label: string, name: string}>} evidence buildDemoEvidence()
 * @returns {{provenance: "real"|"demo"|"demo-evidence"|"unmarked", evidence: {path: string, label: string, name: string}[],
 *   tag: string, detail: string, inRealHistory: boolean}}
 */
export function classifyHistoryEntry(entry, evidence) {
  if (entry?.pedalKind === "real") {
    return { provenance: "real", evidence: [], tag: "", inRealHistory: true, detail: "Recorded with the real pedal." };
  }
  if (entry?.pedalKind === "demo") {
    return { provenance: "demo", evidence: [], tag: "demo", inRealHistory: false, detail: "Recorded with the demo pedal (simulated, not a GP-200)." };
  }
  if (entry?.pedalKind !== undefined) {
    // An unknown marker: never guess; keep it, as unmarked.
    return { provenance: "unmarked", evidence: [], tag: "", inRealHistory: true,
      detail: `Unrecognised pedal marker ${JSON.stringify(entry.pedalKind)}; kept as real history.` };
  }
  const found = [];
  for (const { path, dump } of dumpsIn(entry)) {
    const hit = evidence.get(contentKey(dump));
    if (hit) found.push({ path, label: hit.label, name: hit.name });
  }
  if (found.length) {
    return {
      provenance: "demo-evidence", evidence: found, tag: "demo", inRealHistory: false,
      detail: `Recorded before ${MARKED_SINCE}, with no pedal marker. Demo by content: ` +
        found.map((f) => `${f.path} has the patch content of the demo pedal's ${f.label} "${f.name}"`).join("; ") + ".",
    };
  }
  return {
    provenance: "unmarked", evidence: [], tag: "", inRealHistory: true,
    detail: `Recorded before ${MARKED_SINCE}, with no pedal marker. No demo evidence was found, so it stays real history.`,
  };
}

/**
 * The history that goes into a Full Librarian backup.
 * Real pedal: real and unmarked entries; demo entries (marked, or by evidence)
 * are left out of the file and listed. Nothing is removed from the browser.
 * Demo pedal: everything in the demo database (all demo).
 * @param {object[]} entries the journal of the database in use
 * @param {Map<string, object>} evidence buildDemoEvidence()
 * @param {{demo: boolean}} opts
 */
export function historyForFullBackup(entries, evidence, { demo }) {
  const included = [];
  const excluded = [];
  const counts = { real: 0, demo: 0, "demo-evidence": 0, unmarked: 0 };
  for (const entry of entries) {
    const c = classifyHistoryEntry(entry, evidence);
    counts[c.provenance]++;
    if (demo || c.inRealHistory) included.push(entry);
    else {
      excluded.push({ id: entry.id ?? null, createdAt: entry.createdAt ?? null, op: entry.op ?? null,
        dest: entry.dest?.label ?? null, provenance: c.provenance, detail: c.detail });
    }
  }
  return { journal: included, excluded, counts };
}
