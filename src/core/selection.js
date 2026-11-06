// Multi-selection of slots, for the librarian workflow. Pure state, no DOM.
// A selection is used for display, "back up selected", and as the sources of
// a Copy or Move. It is never a write target by itself: the destination is
// chosen separately, and the planner, permit and write guard still check it.
//
// SPDX-License-Identifier: GPL-3.0-only

import { ALL_SLOTS, bankSlots, checkSlot, slotToDisplayLabel } from "./slots.js";

/** 0.12.0 (approved 2026-11-05): the most patches one Copy or Move of a selection may carry. */
export const MAX_SELECTED_PATCHES = 16;

const labels = (slots) => slots.map(slotToDisplayLabel).join(", ");

/**
 * What a Copy or Move of the selected slots would use (0.12.0, decisions 2-4). Unused slots are left out;
 * a protected slot among the rest, or too many patches, refuses the whole operation with `problem`.
 * The planner re-checks everything from fresh reads; this only says so early and by name.
 * @param {number[]} list the selection, in slot order
 * @param {{unused: (slot: number) => boolean, isProtected: (slot: number) => boolean}} o
 * @returns {{sources: number[], skipped: number[], problem: string|null}}
 */
export function assessSources(list, { unused, isProtected }) {
  const skipped = list.filter(unused);
  const sources = list.filter((s) => !unused(s));
  const barred = sources.filter(isProtected);
  let problem = null;
  if (!sources.length) problem = "Every selected slot is unused: there is nothing to copy or move.";
  else if (barred.length) problem = `Can't copy or move this selection: ${labels(barred)} ${barred.length === 1 ? "is" : "are"} locked for verification safety (a write can't be verified yet). Ctrl+click to deselect.`;
  else if (sources.length > MAX_SELECTED_PATCHES) problem = `${sources.length} patches selected: at most ${MAX_SELECTED_PATCHES} can be copied or moved at once.`;
  return { sources, skipped, problem };
}

/** The sentence that names the unused slots left out, and what that does to the destination. */
export function skippedNote(skipped) {
  return `Skipped because unused: ${labels(skipped)}. The other patches land side by side, so the gaps close up.`;
}

export class Selection {
  constructor() {
    this.slots = new Set();
    this.anchor = null;
  }

  /** Slots in slot order. */
  list() {
    return [...this.slots].sort((a, b) => a - b);
  }

  has(slot) {
    return this.slots.has(slot);
  }

  get size() {
    return this.slots.size;
  }

  clear() {
    this.slots.clear();
    this.anchor = null;
  }

  selectAll(visible = () => true) {
    this.slots = new Set(ALL_SLOTS.filter(visible));
  }

  /**
   * A click on a slot, with modifier keys, the usual way:
   * plain = only this slot; ctrl/cmd = toggle it; shift = range from the
   * anchor (ctrl+shift adds the range to the selection). A range takes only
   * the slots `visible` allows, so it never picks up a hidden bank's patches.
   */
  click(slot, { ctrl = false, shift = false, visible = () => true } = {}) {
    checkSlot(slot);
    if (shift && this.anchor !== null) {
      const [a, b] = this.anchor < slot ? [this.anchor, slot] : [slot, this.anchor];
      if (!ctrl) this.slots.clear();
      for (let s = a; s <= b; s++) if (visible(s)) this.slots.add(s);
      return;
    }
    if (ctrl) {
      if (this.slots.has(slot)) this.slots.delete(slot);
      else this.slots.add(slot);
    } else {
      this.slots = new Set([slot]);
    }
    this.anchor = slot;
  }

  /** Touch select mode: a tap toggles one slot. */
  toggle(slot) {
    checkSlot(slot);
    if (this.slots.has(slot)) this.slots.delete(slot);
    else this.slots.add(slot);
    this.anchor = slot;
  }

  /** A bank checkbox: select the whole bank, or deselect it if it is fully selected. */
  toggleBank(bank) {
    this.clickBank(bank, { ctrl: true });
  }

  /** Replace the selection with `slots` (e.g. every search match). */
  set(slots) {
    for (const s of slots) checkSlot(s);
    this.slots = new Set(slots);
    this.anchor = slots.length ? slots[0] : null;
  }

  /** A click on a bank label: the whole bank (ctrl/cmd adds it, or removes it if fully selected). */
  clickBank(bank, { ctrl = false } = {}) {
    const slots = bankSlots(bank);
    if (ctrl) {
      const all = slots.every((s) => this.slots.has(s));
      for (const s of slots) all ? this.slots.delete(s) : this.slots.add(s);
    } else {
      this.slots = new Set(slots);
    }
    this.anchor = slots[0];
  }
}
