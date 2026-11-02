// Wording for backing up selected patches (UI-5, Stop B findings B2 and B3).
// B2: the selection bar's button says what it does. B3: a short confirmation
// before a selection or bank backup is saved, naming the patches and saying
// that the file is an exact Librarian .zip, not a Valeton .prst. No DOM code;
// nothing here reads or writes the pedal or a file. The full Back up… stays a
// direct operation with no confirmation (decided at Stop C).
//
// SPDX-License-Identifier: GPL-3.0-only

import { slotToDisplayLabel } from "./slots.js";

export const LIST_MAX = 12;

/** The selection bar's backup button (B2): "Back up 36-A (exact)…", "Back up 3 patches (exact)…". */
export function backupSelectedLabel(slots) {
  if (!slots.length) return "Back up selected";
  return slots.length === 1 ? `Back up ${slotToDisplayLabel(slots[0])} (exact)…` : `Back up ${slots.length} patches (exact)…`;
}

/**
 * The confirmation before saving a selection or bank backup (B3).
 * @param {{slot: number, name: string}[]} included the patches that will be in the file, in slot order
 * @param {{missing?: number[], missingWhy?: string}} o slots asked for but not included, and why
 * @returns {{title: string, lines: string[], ok: string}}
 */
export function describeBackupChoice(included, { missing = [], missingWhy = "not read" } = {}) {
  const n = included.length;
  const title = n === 1 ? `Back up ${slotToDisplayLabel(included[0].slot)}?` : `Back up ${n} patches?`;
  const shown = included.slice(0, LIST_MAX).map((p) => `${slotToDisplayLabel(p.slot)} ${p.name}`);
  const more = n > LIST_MAX ? ` · and ${n - LIST_MAX} more` : "";
  const lines = [shown.join(" · ") + more];
  if (missing.length) lines.push(`Not included (${missingWhy}): ${missing.map(slotToDisplayLabel).join(", ")}.`);
  lines.push("Format: an exact GP200 Librarian backup (.zip), byte for byte. It is not a Valeton .prst file: " +
    "to open a patch in Valeton's editor, use Export for Valeton editor (.prst).");
  lines.push("Next, you choose where to save it.");
  return { title, lines, ok: "Save backup…" };
}
