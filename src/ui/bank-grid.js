// The bank cards (Phase 3 S1): renders the bank view model
// (src/core/bank-view.js) as 64 compact cards of four tiles. Banks 1-32 go
// in a container that starts collapsed. Rendering only: it reports clicks
// through callbacks and imports nothing from the write path.
//
// Visual language (design 1.3, user's S1 notes):
//   - unused (exact default): subdued, dashed outline, "unused";
//   - renamed / edited defaults: styled as real patches, with a small note;
//   - badges stay compact: IR, NAM, DUP (DUP highlights its group; details
//     are in the summary). Pedal-dependent data has no tile badge (H1);
//   - the write zone is marked once, on its bank header ("writes enabled"),
//     never with a lock on every other tile.
//
// SPDX-License-Identifier: GPL-3.0-only

import { classLabel } from "../core/bank-view.js";
import { BANKS, POSITIONS } from "../core/slots.js";

export const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 10;

/**
 * Touch long press: `fire` after LONG_PRESS_MS of a still touch. Mouse and pen
 * are ignored (desktop uses Ctrl/Shift and the Select button). Exported for tests.
 */
export function attachLongPress(target, fire, { ms = LONG_PRESS_MS, timers = globalThis } = {}) {
  let timer = null;
  let start = null;
  const cancel = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  target.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = timers.setTimeout(() => {
      timer = null;
      target.longPressed = true;
      fire();
    }, ms);
  });
  target.addEventListener("pointermove", (e) => {
    if (timer !== null && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_MOVE_PX) cancel();
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) target.addEventListener(ev, cancel);
}

export const DRAG_START_PX = 8;

/** 0.9.1: auto-scroll while a drag is near the top or bottom of the visible banks. Starting values; tune here. */
export const AUTO_SCROLL = Object.freeze({ edgePx: 72, maxStepPx: 18 });

/**
 * 0.9.1: how far to scroll this frame (negative: up; 0: none) for a pointer at `y`, given the visible band
 * {top, bottom} (between the sticky tabs bar and the fixed status strip). Faster nearer the edge; at most maxStepPx,
 * also when the pointer is over the bars or outside the window.
 */
export function autoScrollStep(y, { top, bottom }, { edgePx, maxStepPx } = AUTO_SCROLL) {
  const depth = y < top + edgePx ? y - (top + edgePx) : y > bottom - edgePx ? y - (bottom - edgePx) : 0;
  return Math.sign(depth) * Math.min(maxStepPx, Math.ceil((Math.abs(depth) / edgePx) * maxStepPx));
}

/**
 * V5 Lite: desktop mouse drag of one tile onto another visible tile. Mouse only (touch keeps the menus and
 * the panel), left button, no Ctrl/Shift/Meta (those select), never from a button on the tile. Below
 * DRAG_START_PX it is an ordinary click. A drag reports `drop(from, to)` and nothing else: no write here.
 * Esc, or a release outside a tile or on the same tile, cancels. `canDrag()` false: no drag at all.
 * `hover(to, from)` marks the tile under the pointer (null when none). Exported for tests.
 * Look only (V5 polish): a grab cursor while a drag is possible, then a floating copy of the tile under the
 * pointer (pointer-events none, so it never hides the drop target from elementFromPoint), removed on every end.
 * 0.9.1: while dragging, a frame loop scrolls the page when the pointer is near an edge of `edges()` (the visible
 * band) and re-marks the tile now under the still pointer; every end stops it. No requestAnimationFrame: no scroll.
 */
export function attachMouseDrag(target, slot, { drop, canDrag = () => true, hover = () => {}, doc = target.ownerDocument,
  autoScroll = AUTO_SCROLL, edges = () => ({ top: 0, bottom: doc.defaultView.innerHeight }) }) {
  let start = null;
  let over = null;
  let ghost = null;
  let last = null; // the latest pointer position, for the frame loop
  let frame = null;
  const win = doc.defaultView;
  const root = doc.documentElement;
  const place = (e) => { ghost.style.transform = `translate(${e.clientX - start.ox}px, ${e.clientY - start.oy}px)`; };
  const lift = (e) => {
    root?.classList.add("patch-drag");
    const r = target.getBoundingClientRect?.();
    start.ox = start.x - (r?.left ?? start.x);
    start.oy = start.y - (r?.top ?? start.y);
    ghost = target.cloneNode?.(true) ?? null;
    if (!ghost || !doc.body) { ghost = null; return; }
    ghost.className = ["tile", "drag-ghost", ...["real", "unused", "active"].filter((c) => target.classList.contains(c))].join(" ");
    for (const a of ["tabindex", "role", "aria-selected", "title"]) ghost.removeAttribute?.(a);
    ghost.setAttribute?.("aria-hidden", "true");
    const pos = ghost.querySelector?.(".t-pos");
    if (pos) pos.textContent = `${Math.floor(slot / 4) + 1}-${POSITIONS[slot % 4]}`; // the card alone carries no bank number
    ghost.style.width = `${Math.round(r?.width ?? 0)}px`;
    place(e);
    doc.body.append(ghost);
  };
  const tileAt = (e) => {
    const t = doc.elementFromPoint(e.clientX, e.clientY)?.closest?.(".tile");
    return t ? Number(t.dataset.slot) : null;
  };
  const tick = () => {
    frame = null;
    if (!start?.moving || !last) return;
    const dy = autoScrollStep(last.clientY, edges(), autoScroll);
    const before = win.scrollY;
    if (dy) win.scrollBy(0, dy);
    if (win.scrollY !== before) { // the page moved under a still pointer: mark what is under it now
      const to = tileAt(last);
      if (to !== over) hover((over = to), slot);
    }
    frame = win.requestAnimationFrame(tick);
  };
  const end = () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
    last = null;
    start = null;
    over = null;
    target.classList.remove("dragging");
    root?.classList.remove("patch-drag");
    ghost?.remove();
    ghost = null;
    doc.removeEventListener("keydown", onKey, true);
    hover(null);
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    end();
    target.dragged = true; // the release after Esc is not a click either
  };
  target.addEventListener("pointerdown", (e) => {
    target.dragged = false; // a drag released outside the window leaves no click to clear it
    if (e.pointerType !== "mouse" || e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.("button") || !canDrag(slot)) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId, moving: false };
  });
  target.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.id) return;
    if (!start.moving) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_START_PX) return;
      start.moving = true;
      target.setPointerCapture?.(e.pointerId);
      target.classList.add("dragging");
      doc.addEventListener("keydown", onKey, true);
      lift(e);
      if (win?.requestAnimationFrame) frame = win.requestAnimationFrame(tick);
    } else if (ghost) place(e);
    last = { clientX: e.clientX, clientY: e.clientY };
    const to = tileAt(e);
    if (to !== over) hover((over = to), slot);
  });
  target.addEventListener("pointerup", (e) => {
    if (!start || e.pointerId !== start.id) return;
    const moved = start.moving;
    const to = moved ? tileAt(e) : null;
    end();
    if (!moved) return;
    target.dragged = true; // the click that ends a drag is not a click
    if (to !== null && to !== slot) drop(slot, to);
  });
  target.addEventListener("pointercancel", end);
  // The grab cursor shows only where a drag can start now (mouse, demo pedal, connected, idle).
  target.addEventListener("pointerover", (e) => target.classList.toggle("grab", e.pointerType === "mouse" && canDrag(slot)));
}

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * @param {object} o
 * @param {HTMLElement} o.low container for banks 1-32
 * @param {HTMLElement} o.high container for banks 33-64
 * @param {(slot: number, ev: Event) => void} o.onTile click or Enter/Space on a tile
 * @param {(bank: number, ev: Event) => void} o.onBankCheck the bank's select checkbox
 * @param {(kind: "patch"|"bank", id: number, anchor: HTMLElement) => void} o.onMenu a ⋯ button
 * @param {(slot: number) => void} [o.onLongPress] a touch long press (enters select mode)
 * @param {(slot: number) => void} [o.onDup] the DUP badge: show that slot's duplicate group
 * @param {(from: number, to: number) => void} [o.onDrop] V5 Lite: a mouse drag of one tile onto another
 * @param {(slot: number) => boolean} [o.canDrag] V5 Lite: whether a drag of this tile may start now
 * @param {(from: number, to: number) => {ok: boolean}} [o.dropInfo] V5 Lite: may this tile take that drop
 * @param {() => {top: number, bottom: number}} [o.dragEdges] 0.9.1: the visible band for auto-scroll
 */
export function createBankGrid({ low, high, onTile, onBankCheck, onMenu, onLongPress = () => {}, onDup = () => {},
  onDrop = () => {}, canDrag = () => false, dropInfo = () => ({ ok: true }), dragEdges, doc = document }) {
  const tiles = new Array(256);
  let hovered = null;
  const hover = (slot, from) => {
    if (hovered !== null) tiles[hovered].classList.remove("drop-ok", "drop-no");
    hovered = slot;
    if (slot === null) return;
    const info = dropInfo(from, slot);
    tiles[slot].classList.add(info.ok ? "drop-ok" : "drop-no");
  };
  const cards = new Array(BANKS + 1);
  const checks = new Array(BANKS + 1);
  for (let bank = 1; bank <= BANKS; bank++) {
    const card = el(doc, "section", "card");
    card.dataset.bank = bank;
    card.setAttribute("aria-label", `Bank ${bank}`);
    const head = el(doc, "header", "card-h");
    const check = el(doc, "input", "bank-check");
    check.type = "checkbox";
    check.title = `Select all of bank ${bank}`;
    check.setAttribute("aria-label", `Select bank ${bank}`);
    check.addEventListener("change", (e) => onBankCheck(bank, e));
    const num = el(doc, "span", "bank-no", String(bank));
    const note = el(doc, "span", "bank-note");
    const zone = el(doc, "span", "bank-zone");
    const menu = el(doc, "button", "menu-btn", "⋯");
    menu.type = "button";
    menu.title = `Bank ${bank} actions`;
    menu.setAttribute("aria-label", `Bank ${bank} actions`);
    menu.addEventListener("click", (e) => { e.stopPropagation(); onMenu("bank", bank, menu); });
    head.append(check, num, note, zone, menu);
    const grid = el(doc, "div", "tiles");
    grid.setAttribute("role", "row");
    for (let p = 0; p < 4; p++) {
      const slot = (bank - 1) * 4 + p;
      const t = el(doc, "div", "tile unread");
      t.dataset.slot = slot;
      t.tabIndex = 0;
      t.setAttribute("role", "gridcell");
      t.setAttribute("aria-selected", "false");
      const top = el(doc, "div", "t-top");
      const pos = el(doc, "span", "t-pos", POSITIONS[p]);
      const badges = el(doc, "span", "t-badges");
      const tmenu = el(doc, "button", "menu-btn tile-menu", "⋯");
      tmenu.type = "button";
      tmenu.tabIndex = -1;
      tmenu.title = "Patch actions";
      tmenu.setAttribute("aria-label", `Actions for ${bank}-${POSITIONS[p]}`);
      tmenu.addEventListener("click", (e) => { e.stopPropagation(); onMenu("patch", slot, tmenu); });
      top.append(pos, badges, tmenu);
      t.append(top, el(doc, "div", "t-name", "—"), el(doc, "div", "t-sub"));
      attachLongPress(t, () => onLongPress(slot));
      attachMouseDrag(t, slot, { drop: onDrop, canDrag, hover, doc, edges: dragEdges });
      t.addEventListener("click", (e) => {
        if (t.longPressed || t.dragged) {
          t.longPressed = t.dragged = false; // the click that ends a long press or a drag is not a tap
          return;
        }
        onTile(slot, e);
      });
      t.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onTile(slot, e);
        }
      });
      tiles[slot] = t;
      grid.append(t);
    }
    card.append(head, grid);
    cards[bank] = card;
    checks[bank] = check;
    (bank < 33 ? low : high).append(card);
  }

  const badge = (cls, text, title) => {
    const b = el(doc, "span", `badge ${cls}`, text);
    b.title = title;
    return b;
  };

  /**
   * @param {ReturnType<import("../core/bank-view.js").buildBankView>} view
   * @param {{selected: Set<number>, search: {active: boolean, matches: number[], banks: Set<number>}|null,
   *   onlyMatching: boolean, focus: number|null, marks: Map<number,string>}} ui
   */
  function render(view, { selected, search, onlyMatching, focus, marks, group = null, absentText = "—", compare = null, diffOnly = false,
    unusedNote = "all unused", sourceLabel = null }) {
    const matchSet = search?.active ? new Set(search.matches) : null;
    for (const s of view.slots) {
      const t = tiles[s.slot];
      const cl = t.classList;
      cl.toggle("unread", !s.read && !s.error);
      cl.toggle("failed", !!s.error);
      cl.toggle("unused", s.read && s.unused);
      cl.toggle("real", s.read && !s.unused);
      cl.toggle("sel", selected.has(s.slot));
      cl.toggle("match", !!matchSet?.has(s.slot));
      cl.toggle("dim", !!matchSet && !matchSet.has(s.slot));
      cl.toggle("focus", focus === s.slot);
      cl.toggle("group", !!group?.has(s.slot));
      cl.toggle("active", s.active);
      cl.toggle("written", marks.get(s.slot) === "written");
      cl.toggle("write-failed", marks.get(s.slot) === "write-failed");
      t.setAttribute("aria-selected", selected.has(s.slot) ? "true" : "false");
      t.querySelector(".t-name").textContent = !s.read ? (s.error ? "read failed" : absentText) : s.unused ? "unused" : (s.name || "(no name)");
      const sub = s.read && s.unused ? s.name : classLabel(s);
      t.querySelector(".t-sub").textContent = sub;
      const badges = t.querySelector(".t-badges");
      badges.replaceChildren();
      if (s.active) badges.append(badge("active", "▶", "The pedal is on this patch now"));
      // Backup vs live (S2): a small mark for every slot that is not the same.
      const mark = compare ? compare[s.slot] : null;
      cl.toggle("cmp-diff", !!mark);
      cl.toggle("cmp-same", !!compare && s.read && !mark);
      if (mark) badges.append(badge("cmp", mark.text, mark.title));
      for (const kind of ["IR", "NAM"]) {
        const deps = s.irNam.filter((d) => d.kind === kind);
        if (deps.length) badges.append(badge(kind.toLowerCase(), kind, deps.map((d) => d.text).join("\n")));
      }
      // No STATE badge on tiles (H1): pedal-dependent data is explained in plain English in the summary only.
      if (s.dupOf.length) {
        // DUP is a button: it highlights the whole duplicate group (H1).
        const d = el(doc, "button", "badge dup", "DUP");
        d.type = "button";
        d.tabIndex = -1;
        d.title = `Same content as ${s.dupOf.length} other slot(s). Click to highlight the whole group.`;
        d.setAttribute("aria-label", `Highlight the ${s.dupOf.length + 1} slots with this patch content`);
        d.addEventListener("click", (e) => { e.stopPropagation(); onDup(s.slot); });
        badges.append(d);
      }
      const lines = [s.label];
      const pre = sourceLabel ? `${sourceLabel}: ` : ""; // U-H3-3: a backup's tile says whose state it shows
      if (s.read) lines.push(pre + (s.unused ? "Unused (factory default \"It's GP-200\")" : `${s.name || "(no name)"}${sub ? ` · ${sub}` : ""}`));
      else if (s.error) lines.push(`Could not be read: ${s.error}`);
      else if (sourceLabel) lines.push(`${pre}${absentText}`);
      if (mark) lines.push(mark.title);
      t.title = lines.join("\n");
    }
    // 0.6.0: the zone is marked only while it is part of the pedal; with every bank writable, no marker.
    const marked = view.banks.some((b) => !b.writable);
    for (const b of view.banks) {
      const card = cards[b.bank];
      const zone = b.writable && marked;
      card.classList.toggle("all-unused", b.allUnused);
      card.classList.toggle("writable", zone);
      card.classList.toggle("nomatch", !!(onlyMatching && search?.active && !search.banks.has(b.bank)) ||
        !!(diffOnly && compare && !b.slots.some((x) => compare[x]))); // backup: only the banks that differ
      card.querySelector(".bank-note").textContent = b.allUnused ? unusedNote : "";
      card.querySelector(".bank-zone").textContent = zone ? "writes enabled" : "";
      card.querySelector(".bank-zone").title = zone
        ? "This version can write only to this bank (the scratch bank). Other banks: writes are not enabled yet." : "";
      const n = b.slots.filter((x) => selected.has(x)).length;
      checks[b.bank].checked = n === 4;
      checks[b.bank].indeterminate = n > 0 && n < 4;
    }
  }

  return { tiles, cards, render };
}
