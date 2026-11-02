// The patch summary, level 0 (Phase 3 S1): only what our own code and
// hardware evidence establish. No block, effect or parameter decoding
// (decision 5: show only fields confirmed against our pedal). No DOM code.
//
// SPDX-License-Identifier: GPL-3.0-only

import { CONTENT_FILE_START } from "./patch.js";
import { slotToDisplayLabel } from "./slots.js";

const CLASS_TEXT = {
  default: "Unused: holds the factory default patch \"It's GP-200\" exactly. The pedal has no empty slots; this is what an unused slot holds.",
  "renamed-default": "Real patch: the factory default's settings under a different name. Treated as a real patch (protected).",
  "edited-default": "Real patch: named like the factory default, with a few settings changed. Treated as a real patch (protected).",
  real: "Real patch.",
  unverified: "Could not be classified (its slot fields do not name this slot, or the read was incomplete). Treated as a real patch.",
};

/**
 * @param {ReturnType<import("./bank-view.js").buildBankView>} view
 * @param {{readNumber?: number, startedAt?: string, state?: {signature: string}, dumps: (Uint8Array|null)[]}|null} snapshot
 * @param {number} slot
 */
export function patchSummary(view, snapshot, slot) {
  const s = view.slots[slot];
  const notes = [];
  const technical = [];
  if (s.read && s.cls === "real" && s.namedLikeDefault) notes.push("Its name is \"It's GP-200\", but its content differs from the factory default.");
  if (s.state) {
    // Plain English for the user (H1 feedback); the evidence detail goes under "Technical details".
    notes.push("Pedal-dependent data detected: one stored value in this patch reads differently depending on which " +
      "patch the pedal is on at the time. The Librarian knows about this and allows for it when comparing reads.");
    technical.push(`Active-patch-dependent byte at file 0x${s.state.fileOff.toString(16).toUpperCase()} ` +
      `(one of the six evidenced in R1; register entry ${s.state.label}). Recorded as observed, not interpreted.`);
  }
  for (const d of s.irNam) notes.push(`Uses ${d.text}: a reference by slot number on this pedal; the IR/NAM itself is not in the patch.`);
  // The state signature only where the six-byte evidence applies to this pedal (otherwise it is "??????", meaningless here).
  const signature = snapshot?.state?.applicable ? snapshot.state.signature : null;
  if (signature) technical.push(`State signature of this read: ${signature}.`);
  const group = s.dupOf.length ? [slot, ...s.dupOf].sort((a, b) => a - b) : [];
  return {
    slot, label: s.label, name: s.read ? (s.name || "(no name)") : null,
    read: s.read, error: s.error,
    status: !s.read ? (s.error ? `Could not be read: ${s.error}` : "Not read yet.") : CLASS_TEXT[s.cls] ?? s.cls,
    notes,
    technical,
    duplicates: s.dupOf.map(slotToDisplayLabel),
    duplicateGroup: group,
    duplicateText: group.length
      ? `Duplicate group: ${group.length} slots hold the same patch content: ` +
        `${group.map((x) => (x === slot ? `${slotToDisplayLabel(x)} (this one)` : slotToDisplayLabel(x))).join(", ")}.` : null,
    active: s.active,
    writableText: s.writable ? "Writes are enabled for this slot." : "Writes are not enabled for this slot yet.",
    capture: snapshot ? { readNumber: snapshot.readNumber ?? null, startedAt: snapshot.startedAt ?? null, signature } : null,
    hex: s.read ? hexRows(snapshot.dumps[slot]) : [],
  };
}

/** The dump as rows of 16 bytes, labelled with FILE offsets (dump offset + 0x28). */
export function hexRows(dump) {
  const rows = [];
  for (let i = 0; i < dump.length; i += 16) {
    const bytes = Array.from(dump.subarray(i, i + 16), (b) => b.toString(16).padStart(2, "0")).join(" ");
    rows.push(`${(i + CONTENT_FILE_START).toString(16).padStart(4, "0")}  ${bytes}`);
  }
  return rows;
}
