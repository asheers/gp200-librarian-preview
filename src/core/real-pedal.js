// Which S3.1/S3.2 engine writes the REAL pedal may run. E1 (2026-10-29) and
// Slice A (2026-11-01) allowed one patch in bank 60; 0.6.0 (approved
// 2026-11-01) allows one patch between any of the 256 slots: Copy, Move and
// Swap, and the single-level Undo of exactly such an operation. 0.8.0 adds
// Rename of one patch in its own slot. 0.10.0 adds bank Copy, Move and Swap
// (all four positions) and their Undo; 0.11.0 Clear of one patch. Several selected patches stay
// demo-only (D3). This narrows what the app
// asks for; the planner (zone, write refusals), the write guard and its
// per-operation permit still check on their own. No DOM code.
//
// SPDX-License-Identifier: GPL-3.0-only

import { bankSlots } from "./slots.js";
import { isWritableSlot } from "./write-guard.js";

/** Patch-menu actions the real pedal may use (actions.js). */
export const REAL_PEDAL_ACTIONS = Object.freeze(["copy-to", "move-to", "swap-with", "rename", "clear"]);

const slotOk = (s) => Number.isInteger(s) && isWritableSlot(s);
const bankOk = (b) => Number.isInteger(b) && b >= 1 && b <= 64 && bankSlots(b).every(slotOk);

/** May the real pedal start this patch-menu action on this slot? */
export function realPedalSourceOk(id, slot) {
  return REAL_PEDAL_ACTIONS.includes(id) && slotOk(slot);
}

/**
 * May the real pedal run this planner operation? Only one patch: {kind: "copy"|"move", from: [s], to}
 * or {kind: "swap", a: [s], b}, between two different writable slots; or {kind: "rename", slot} (0.8.0);
 * or {kind: "bank-copy"|"bank-move"|"bank-swap", fromBank, toBank} between two different banks (0.10.0);
 * or {kind: "clear", slot} (0.11.0).
 */
export function realPedalAllows(op) {
  if (op?.kind === "rename" || op?.kind === "clear") return slotOk(op.slot);
  if (["bank-copy", "bank-move", "bank-swap"].includes(op?.kind)) return bankOk(op.fromBank) && bankOk(op.toBank) && op.fromBank !== op.toBank;
  if (op?.kind === "swap") return Array.isArray(op.a) && op.a.length === 1 && slotOk(op.a[0]) && slotOk(op.b) && op.a[0] !== op.b;
  if (op?.kind !== "copy" && op?.kind !== "move") return false;
  return Array.isArray(op.from) && op.from.length === 1 && slotOk(op.from[0]) && slotOk(op.to) && op.to !== op.from[0];
}

/**
 * May the real pedal Undo this operation record (findUndoable's pick)? Only a completed, engine-made
 * one-patch Copy, Rename or Clear (one step), Move or Swap (one or two steps: a no-op step is dropped), or bank
 * Copy (up to 4) or bank Move or Swap (up to 8, 0.10.0), with every step writable; not a recovery and not
 * itself an Undo. undo.js's own strict check still runs before anything is written.
 */
export function realPedalUndoable(record) {
  const steps = Array.isArray(record?.steps) ? record.steps : [];
  const most = { copy: 1, move: 2, swap: 2, rename: 1, clear: 1, "bank-copy": 4, "bank-move": 8, "bank-swap": 8 }[record?.op];
  return !!record && record.kind === "operation" && record.state === "complete" && !!most &&
    record.recoveryOf == null && record.undoOf == null && steps.length >= 1 && steps.length <= most &&
    steps.every((s) => slotOk(s?.slot));
}
