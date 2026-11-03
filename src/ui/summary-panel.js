// The patch panel (Phase 3 S1; redesign V3): renders patchSummary()
// (src/core/summary.js), level 0 only, plus the patch's actions from the
// action registry. Since V3 it is the home for single-patch actions: the
// registry's write actions (Copy / Move / Swap / Rename) as a 2×2 grid, the
// rest as a compact list. Which actions exist, and whether each is enabled,
// is still decided by the registry (src/core/actions.js); this file only
// lays them out. Rendering only; no write imports. Planned actions are not
// shown (More ▾ → What's coming).
//
// SPDX-License-Identifier: GPL-3.0-only

const SVG = "http://www.w3.org/2000/svg";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** V3: the primary actions, in registry order, with a one-line description and a small line icon (decision 4). */
const PRIMARY = Object.freeze({
  "copy-to": { what: "Keep this one; put a copy in another slot", icon: ["M8 8h12v12H8z", "M16 8V4H4v12h4"] },
  "move-to": { what: "Put it in another slot; this one becomes unused", icon: ["M4 12h15", "M14 6l6 6-6 6"] },
  "swap-with": { what: "Exchange places with another slot", icon: ["M4 8h15l-4-4", "M20 16H5l4 4"] },
  rename: { what: "Change only the name", icon: ["M4 20h4L19 9l-4-4L4 16z", "M13 7l4 4"] },
});
/** 0.11.0: Clear… sits on its own below the grid, marked as the destructive one. */
const CLEAR = Object.freeze({ what: "Reset this slot to the factory default", icon: ["M5 7h14", "M10 7V4h4v3", "M7 7l1 13h8l1-13"] });

function icon(paths) {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    s.append(p);
  }
  return s;
}

/**
 * @param {HTMLElement} root the panel body
 * @param {ReturnType<import("../core/summary.js").patchSummary>|null} s
 * @param {ReturnType<import("../core/actions.js").actionsFor>} actions
 * @param {(id: string) => void} onAction
 * @param {(how: "highlight"|"select", slots: number[]) => void} [onGroup] the duplicate group's buttons
 * @param {{empty?: string[], kinds?: string[]}} [o] the empty panel's lines; the patch's IR/NAM kinds (header badges)
 */
export function renderSummary(root, s, actions, onAction, onGroup = () => {}, { empty = ["Click a patch to see it here."], kinds = [] } = {}) {
  root.replaceChildren();
  if (!s) {
    for (const line of empty) root.append(el("p", "sum-empty", line));
    return;
  }
  const head = el("div", "sum-head");
  head.append(el("span", "sum-label", s.label), el("span", "sum-name", s.name ?? "—"));
  const tags = el("div", "sum-tags");
  for (const k of kinds) tags.append(el("span", `badge ${k.toLowerCase()}`, k));
  if (s.active) tags.append(el("span", "badge active", "▶ on the pedal now"));
  if (tags.firstChild) head.append(tags);
  root.append(head, el("p", "sum-status", s.status));
  if (s.compareText) root.append(el("p", "sum-compare", s.compareText));
  // U-H3-3: whose state each line describes ("In this backup", "On the pedal now").
  for (const l of s.compareLines ?? []) {
    const p = el("p", "sum-compare");
    p.append(el("b", "", `${l.label}: `), l.text);
    root.append(p);
  }

  // The summary is already shown: its own "Show summary" is left out (live and backup).
  const shown = actions.filter((x) => x.id !== "summary" && x.id !== "backup-summary");
  const button = (a, cls) => {
    const b = el("button", cls);
    b.type = "button";
    b.dataset.id = a.id; // the stylesheet tags demo-only actions (Rename)
    b.disabled = !a.enabled;
    if (a.reason) b.title = a.reason;
    b.addEventListener("click", () => onAction(a.id));
    return b;
  };
  const actButton = (a, cls, d) => {
    const b = button(a, cls);
    const head = el("span", "act-label");
    head.append(icon(d.icon), a.label);
    // V3: a disabled action says why on screen, in place of its description (the reason comes from the registry).
    b.append(head, el("span", a.enabled ? "act-what" : "act-why", a.enabled ? d.what : a.reason));
    return b;
  };
  const primary = shown.filter((a) => PRIMARY[a.id]);
  if (primary.length) {
    const grid = el("div", "sum-actions sum-primary");
    for (const a of primary) grid.append(actButton(a, "act", PRIMARY[a.id]));
    root.append(grid);
  }
  const clear = shown.find((a) => a.id === "clear");
  if (clear) {
    const row = el("div", "sum-actions sum-clear");
    row.append(actButton(clear, "act act-clear", CLEAR));
    root.append(row);
  }
  const rest = shown.filter((a) => !PRIMARY[a.id] && a.id !== "clear");
  if (rest.length) {
    const list = el("div", "sum-more");
    for (const a of rest) {
      const b = button(a, "small");
      b.textContent = a.label;
      if (!a.enabled && a.reason) b.append(el("span", "act-why", a.reason));
      list.append(b);
    }
    root.append(list);
  }
  if (s.exactHint) root.append(el("p", "sum-fine sum-exact", s.exactHint)); // B2

  for (const n of s.notes) root.append(el("p", "sum-note", n));
  if (s.matchText) root.append(el("p", "sum-note", s.matchText));
  if (s.duplicateText) {
    const g = el("div", "sum-group");
    g.append(el("p", "sum-note", s.duplicateText));
    const hl = el("button", "small", "Highlight group");
    hl.addEventListener("click", () => onGroup("highlight", s.duplicateGroup));
    const sel = el("button", "small", "Select group");
    sel.addEventListener("click", () => onGroup("select", s.duplicateGroup));
    g.append(hl, sel);
    root.append(g);
  }

  const facts = el("dl", "sum-facts");
  const fact = (k, v) => { if (v) facts.append(el("dt", "", k), el("dd", "", v)); };
  fact("Writes", s.writableText);
  if (s.capture?.startedAt) fact("Read at", new Date(s.capture.startedAt).toLocaleTimeString());
  root.append(facts);
  root.append(el("p", "sum-fine", "Effects and blocks are not shown yet: only fields confirmed against this pedal are displayed."));

  if (s.technical.length || s.hex.length) {
    // Technical details (evidence notes, state signature, raw bytes), collapsed. The hex is drawn
    // only when opened and removed when closed, so the panel stays small.
    const d = el("details", "sum-hex");
    d.append(el("summary", "", "Technical details"));
    if (s.capture) d.append(el("p", "sum-fine", `From read #${s.capture.readNumber} of this session.`));
    for (const line of s.technical) d.append(el("p", "sum-fine", line));
    const hexWrap = el("div");
    d.append(hexWrap);
    d.addEventListener("toggle", () => {
      if (d.open && s.hex.length && !hexWrap.firstChild) hexWrap.append(el("pre", "", s.hex.join("\n")));
      if (!d.open) hexWrap.replaceChildren();
    });
    root.append(d);
  }
}
