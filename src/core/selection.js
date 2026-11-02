// Multi-selection of slots, for the librarian workflow. Pure state, no DOM.
// A selection is used for display, "back up selected", and (one slot) as
// the source of a copy. It is never a write target: writes go only to the
// scratch slot chosen separately, and the write guard enforces that.
//
// SPDX-License-Identifier: GPL-3.0-only

import { ALL_SLOTS, bankSlots, checkSlot } from "./slots.js";

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

  selectAll() {
    this.slots = new Set(ALL_SLOTS);
  }

  /**
   * A click on a slot, with modifier keys, the usual way:
   * plain = only this slot; ctrl/cmd = toggle it; shift = range from the
   * anchor (ctrl+shift adds the range to the selection).
   */
  click(slot, { ctrl = false, shift = false } = {}) {
    checkSlot(slot);
    if (shift && this.anchor !== null) {
      const [a, b] = this.anchor < slot ? [this.anchor, slot] : [slot, this.anchor];
      if (!ctrl) this.slots.clear();
      for (let s = a; s <= b; s++) this.slots.add(s);
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
