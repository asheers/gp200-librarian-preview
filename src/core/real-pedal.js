// Which S3.1/S3.2 engine writes the REAL pedal may run. E1 (2026-10-29) and
// Slice A (2026-11-01) allowed one patch in bank 60; 0.6.0 (approved
// 2026-11-01) allows one patch between any of the 256 slots: Copy, Move and
// Swap, and the single-level Undo of exactly such an operation. 0.8.0 adds
// Rename of one patch in its own slot. Several patches and banks stay
// demo-only (D3). This narrows what the app
// asks for; the planner (zone, write refusals), the write guard and its
// per-operation permit still check on their own. No DOM code.
//
// SPDX-License-Identifier: GPL-3.0-only

import { isWritableSlot } from "./write-guard.js";

/** Patch-menu actions the real pedal may use (actions.js). */
export const REAL_PEDAL_ACTIONS = Object.freeze(["copy-to", "move-to", "swap-with", "rename"]);

const slotOk = (s) => Number.isInteger(s) && isWritableSlot(s);

/** May the real pedal start this patch-menu action on this slot? */
export function realPedalSourceOk(id, slot) {
  return REAL_PEDAL_ACTIONS.includes(id) && slotOk(slot);
}

/**
 * May the real pedal run this planner operation? Only one patch: {kind: "copy"|"move", from: [s], to}
 * or {kind: "swap", a: [s], b}, between two different writable slots; or {kind: "rename", slot} (0.8.0).
 */
export function realPedalAllows(op) {
  if (op?.kind === "rename") return slotOk(op.slot);
  if (op?.kind === "swap") return Array.isArray(op.a) && op.a.length === 1 && slotOk(op.a[0]) && slotOk(op.b) && op.a[0] !== op.b;
  if (op?.kind !== "copy" && op?.kind !== "move") return false;
  return Array.isArray(op.from) && op.from.length === 1 && slotOk(op.from[0]) && slotOk(op.to) && op.to !== op.from[0];
}

/**
 * May the real pedal Undo this operation record (findUndoable's pick)? Only a completed, engine-made
 * one-patch Copy or Rename (one step), Move or Swap (one or two steps: a no-op step is dropped) with every step
 * writable; not a recovery and not itself an Undo. undo.js's own strict check still runs before
 * anything is written.
 */
export function realPedalUndoable(record) {
  const steps = Array.isArray(record?.steps) ? record.steps : [];
  const most = { copy: 1, move: 2, swap: 2, rename: 1 }[record?.op];
  return !!record && record.kind === "operation" && record.state === "complete" && !!most &&
    record.recoveryOf == null && record.undoOf == null && steps.length >= 1 && steps.length <= most &&
    steps.every((s) => slotOk(s?.slot));
}
