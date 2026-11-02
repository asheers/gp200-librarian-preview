// The ⋯ menus (Phase 3 S1), built from the action registry
// (src/core/actions.js). Since UI-3 a menu holds only actions that exist now
// (planned ones are under More ▾ → What's coming); a disabled one shows its
// reason as secondary text. One menu at a time; closes on Escape, outside
// click, or after a choice. No write imports.
//
// SPDX-License-Identifier: GPL-3.0-only

let open = null;

export function closeMenu() {
  if (!open) return;
  open.el.remove();
  document.removeEventListener("pointerdown", open.outside, true);
  document.removeEventListener("keydown", open.key, true);
  open.anchor.setAttribute("aria-expanded", "false");
  const anchor = open.anchor;
  open = null;
  anchor.focus({ preventScroll: true });
}

/**
 * @param {HTMLElement} anchor the ⋯ button
 * @param {string} title e.g. "36-A Acoustic"
 * @param {ReturnType<import("../core/actions.js").actionsFor>} items
 * @param {(id: string) => void} onPick
 */
export function openMenu(anchor, title, items, onPick) {
  closeMenu();
  const m = document.createElement("div");
  m.className = "menu";
  m.setAttribute("role", "menu");
  m.setAttribute("aria-label", title);
  const h = document.createElement("div");
  h.className = "menu-title";
  h.textContent = title;
  m.append(h);
  const addItem = (a) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.className = "menu-item";
    b.dataset.id = a.id;
    b.disabled = !a.enabled;
    b.textContent = a.label;
    if (a.reason) {
      b.title = a.reason;
      const why = document.createElement("span");
      why.className = "menu-why";
      why.textContent = a.reason;
      b.append(why);
    }
    b.addEventListener("click", () => {
      closeMenu();
      onPick(a.id);
    });
    m.append(b);
  };
  items.forEach(addItem);
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  const below = r.bottom + 4;
  const top = below + m.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - m.offsetHeight - 4) : below;
  m.style.left = `${left + window.scrollX}px`;
  m.style.top = `${top + window.scrollY}px`;
  anchor.setAttribute("aria-expanded", "true");
  const outside = (e) => { if (!m.contains(e.target) && e.target !== anchor) closeMenu(); };
  const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeMenu(); } };
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", key, true);
  open = { el: m, anchor, outside, key };
  m.querySelector(".menu-item:not(:disabled)")?.focus({ preventScroll: true });
}
