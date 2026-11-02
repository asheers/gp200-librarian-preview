// The Templates panel (Phase 3 S2): lists Librarian-owned templates with
// their name, patch name, source (exact or lossy) and where the same patch is
// on the live pedal; details on request. Rendering only: the app runs the
// actions. No pedal access and no write imports.
//
// SPDX-License-Identifier: GPL-3.0-only

import { hexRows } from "../core/summary.js";
import { isLossy, provenanceText } from "../core/templates.js";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");

/**
 * @param {HTMLElement} root
 * @param {object[]} templates
 * @param {{matches: (t: object) => string[], onMenu: (t: object, anchor: HTMLElement) => void, onOpen: (t: object) => void, selectedId: string|null}} o
 */
export function renderTemplateList(root, templates, { matches, onMenu, onOpen, selectedId }) {
  root.replaceChildren();
  if (!templates.length) {
    root.append(el("p", "sum-empty", "No templates yet. Use \"Save as template…\" on a patch, or Import."));
    return;
  }
  for (const t of templates) {
    const row = el("div", `tpl-row${t.id === selectedId ? " sel" : ""}`);
    row.tabIndex = 0;
    const main = el("div", "tpl-main");
    main.append(el("div", "tpl-name", t.name));
    const sub = [t.derived.patchName ? `patch "${t.derived.patchName}"` : "", isLossy(t) ? "not exact (.prst)" : "exact",
      `saved ${when(t.createdAt)}`].filter(Boolean).join(" · ");
    main.append(el("div", "tpl-sub", sub));
    const m = matches(t);
    if (m.length) main.append(el("div", "tpl-match", `Same patch: ${m.join(", ")}`));
    const badges = el("span", "tpl-badges");
    if (isLossy(t)) badges.append(Object.assign(el("span", "badge lossy", "NOT EXACT"), { title: provenanceText(t) }));
    if (t.derived.irNam.length) badges.append(Object.assign(el("span", "badge ir", "IR/NAM"), { title: t.derived.irNam.join("\n") }));
    const menu = el("button", "menu-btn", "⋯");
    menu.type = "button";
    menu.title = `Actions for template ${t.name}`;
    menu.setAttribute("aria-label", `Actions for template ${t.name}`);
    menu.addEventListener("click", (e) => { e.stopPropagation(); onMenu(t, menu); });
    row.append(main, badges, menu);
    row.addEventListener("click", () => onOpen(t));
    row.addEventListener("keydown", (e) => { if (e.key === "Enter") onOpen(t); });
    root.append(row);
  }
}

/** Details of one template (level 0: no effect decoding), with the raw bytes on request. */
export function renderTemplateDetails(root, t, { matches }) {
  root.replaceChildren();
  if (!t) return;
  root.append(el("h3", "tpl-d-name", t.name));
  const dl = el("dl", "sum-facts");
  const fact = (k, v) => { if (v) dl.append(el("dt", "", k), el("dd", "", v)); };
  fact("Patch name", t.derived.patchName || "(no name)");
  fact("Source", provenanceText(t));
  if (t.origin?.label) fact("From slot", t.origin.label);
  if (t.origin?.backupFile) fact("From backup", t.origin.backupFile);
  if (t.origin?.fileName) fact("From file", t.origin.fileName);
  fact("Saved", when(t.createdAt));
  if (t.updatedAt !== t.createdAt) fact("Changed", when(t.updatedAt));
  fact("Uses", t.derived.irNam.join(", "));
  fact("Same patch", matches.join(", "));
  fact("Notes", t.notes);
  root.append(dl);
  if (isLossy(t)) root.append(el("p", "sum-note", "This template came from a .prst file, which zeroes a few stored values. It is not an exact copy of the original patch, and stays marked \"not exact\"."));
  const d = el("details", "sum-hex");
  d.append(el("summary", "", "Technical details"));
  const hexWrap = el("div");
  d.append(el("p", "sum-fine", `Id ${t.id}; provenance ${t.provenance}${t.origin?.readNumber ? `; read #${t.origin.readNumber}` : ""}.`), hexWrap);
  d.addEventListener("toggle", () => {
    if (d.open && !hexWrap.firstChild) hexWrap.append(el("pre", "", hexRows(t.payload.bytes).join("\n")));
    if (!d.open) hexWrap.replaceChildren();
  });
  root.append(d);
}
