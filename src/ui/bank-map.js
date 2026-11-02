// The bank map (redesign V1): all 64 banks at a glance, four pips each
// (patch, unused, not read, selected). A click jumps to that bank's card.
// Rendering only: it reads the bank view model (src/core/bank-view.js) and
// reports clicks through a callback; it imports nothing from the write path.
//
// SPDX-License-Identifier: GPL-3.0-only

import { BANKS, POSITIONS } from "../core/slots.js";

/**
 * @param {object} o
 * @param {HTMLElement} o.root the map's grid container
 * @param {(bank: number) => void} o.onBank a click on a bank
 */
export function createBankMap({ root, onBank, doc = document }) {
  const cells = new Array(BANKS + 1);
  for (let bank = 1; bank <= BANKS; bank++) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "map-cell";
    b.dataset.bank = bank;
    const n = doc.createElement("b");
    n.textContent = String(bank);
    const pips = doc.createElement("span");
    pips.className = "pips";
    for (let p = 0; p < 4; p++) pips.append(doc.createElement("i"));
    b.append(n, pips);
    b.addEventListener("click", () => onBank(bank));
    cells[bank] = b;
    root.append(b);
  }

  /** @param {ReturnType<import("../core/bank-view.js").buildBankView>} view @param {Set<number>} selected */
  function render(view, selected) {
    for (const bk of view.banks) {
      const cell = cells[bk.bank];
      const parts = [];
      bk.slots.forEach((slot, p) => {
        const s = view.slots[slot];
        const kind = selected.has(slot) ? "sel" : !s.read ? "unread" : s.unused ? "unused" : "real";
        cell.querySelectorAll("i")[p].className = kind;
        parts.push(`${POSITIONS[p]} ${!s.read ? "not read" : s.unused ? "unused" : s.name || "(no name)"}${selected.has(slot) ? " (selected)" : ""}`);
      });
      cell.classList.toggle("has-sel", bk.slots.some((x) => selected.has(x)));
      cell.title = `Bank ${bk.bank}\n${parts.join("\n")}`;
      cell.setAttribute("aria-label", `Bank ${bk.bank}: ${parts.join(", ")}`);
    }
  }

  return { cells, render };
}
