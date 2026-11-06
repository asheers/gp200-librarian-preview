// Slot numbering: 256 slots, shown on the pedal as banks 1-64 x A-D.
// Slot 0 = 1-A, slot 140 = 36-A, slot 255 = 64-D.
//
// Adapted from GP-200 Patch Manager Web (donpark2000, src/core/slots.js
// @ ff618e7, GPL-3.0). See docs/ATTRIBUTION.md.
//
// SPDX-License-Identifier: GPL-3.0-only

export const TOTAL_SLOTS = 256;
export const BANKS = 64;
export const POSITIONS = "ABCD";

export function checkSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= TOTAL_SLOTS) {
    throw new RangeError(`slot ${slot} out of range 0-${TOTAL_SLOTS - 1}`);
  }
  return slot;
}

/** "36A": compact form, used in backup file names (matches donpark's CLI and web app). */
export function slotToLabel(slot) {
  checkSlot(slot);
  return `${bankOf(slot)}${POSITIONS[slot % 4]}`;
}

/** "36-A": how Valeton writes a slot; used for display. */
export function slotToDisplayLabel(slot) {
  checkSlot(slot);
  return `${bankOf(slot)}-${POSITIONS[slot % 4]}`;
}

/** Bank number 1-64. */
export function bankOf(slot) {
  return Math.floor(checkSlot(slot) / 4) + 1;
}

/** The four slots of bank 1-64. */
export function bankSlots(bank) {
  if (!Number.isInteger(bank) || bank < 1 || bank > BANKS) throw new RangeError(`bank ${bank} out of range 1-${BANKS}`);
  const base = (bank - 1) * 4;
  return [base, base + 1, base + 2, base + 3];
}

/** Accepts "34B", "34-B", " 34b ". */
export function labelToSlot(label) {
  const s = String(label).trim().toUpperCase().replace(/-/g, "");
  const m = /^(\d+)([ABCD])$/.exec(s);
  if (!m) throw new RangeError(`invalid slot label "${label}"; expected e.g. 34B or 34-B`);
  const slot = (Number(m[1]) - 1) * 4 + POSITIONS.indexOf(m[2]);
  if (slot < 0 || slot >= TOTAL_SLOTS) {
    throw new RangeError(`slot label "${label}" is out of range (banks 1-64, A-D)`);
  }
  return slot;
}

export const ALL_SLOTS = Object.freeze(Array.from({ length: TOTAL_SLOTS }, (_, i) => i));

/**
 * Slots as short text (0.12.0): "36-A" alone, "36-A…36-C" when they run on without a gap, otherwise the
 * slots themselves ("2-A, 2-C, 36-D"), so a scattered selection never reads as a continuous range.
 */
export function slotSpan(slots) {
  const labels = slots.map(slotToDisplayLabel);
  if (slots.length < 2) return labels.join("");
  if (slots.every((s, i) => i === 0 || s === slots[i - 1] + 1)) return `${labels[0]}…${labels.at(-1)}`;
  return labels.length <= 4 ? labels.join(", ") : `${labels.slice(0, 3).join(", ")} … ${labels.at(-1)}`;
}
