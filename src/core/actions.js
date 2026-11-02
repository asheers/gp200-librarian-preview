// The action registry (Phase 3 S1): every menu (tile, bank header, selection
// bar, summary) is built from this list, so later stages add actions without
// redesigning the interface (design 1.8). No DOM code.
//
// S1 offered only read-side actions; S2 adds Librarian-only ones (templates,
// exports, the read-only Backup Browser). No action writes to the pedal.
//
// UI-3 (U3, U4): menus by purpose, not by format. A menu shows only what can
// be done now. Planned actions are NOT in any menu; they are listed in
// PLANNED and shown under More ▾ → What's coming. An action enters a menu only
// when its stage is approved and built; enabling a write action is a
// deliberate change here AND a stage approval, and the write path itself is
// unchanged and still guarded. The exact single-patch backup is not a patch
// menu item: select the patch and use Back up selected.
//
// SPDX-License-Identifier: GPL-3.0-only

import { REAL_PEDAL_ACTIONS } from "./real-pedal.js";

const LIVE_REREAD = (what) => (c) => (!c.read ? "Not read yet" : c.connected ? true : `Connect first: a live patch is re-read before ${what}`);
const IN_BACKUP = (c) => c.present || "Not in this backup";
/**
 * S3.2 slice 1: Copy, Move and Swap for one patch at a time. The real pedal
 * may use only the actions in REAL_PEDAL_ACTIONS (0.6.0: Copy, Move and Swap,
 * any slot; 0.8.0: Rename).
 */
const PATCH_WRITE = (id) => (c) => (!c.demo && !REAL_PEDAL_ACTIONS.includes(id) ? "Demo mode only, for now"
  : !c.read ? "Not read yet" : c.connected ? true : "Connect first");
/**
 * S3.2 slice 3: bank Copy, Move and Swap, all four positions. Demo pedal only,
 * on the real pedal (D3). `c.writableBanks` are the banks the write zone covers
 * in full (all 64 since 0.6.0): a bank Copy needs one other than this bank; a
 * bank Move or Swap writes BOTH banks, so it needs this one and another.
 */
const BANK_WRITE = (kind) => (c) => {
  if (!c.demo) return "Demo mode only, for now";
  if (!c.anyRead) return "Not read yet";
  if (!c.connected) return "Connect first";
  const zone = c.writableBanks ?? [];
  const only = zone.length === 1 ? `only bank ${zone[0]} can be written` : "no bank can be written";
  if (kind === "copy") return zone.some((b) => b !== c.bank) ? true : `Not possible: ${only}, so there is no other bank to copy it to`;
  if (zone.includes(c.bank) && zone.some((b) => b !== c.bank)) return true;
  return kind === "move" ? `Not possible yet: a bank Move writes both banks (it empties this one), and ${only}`
    : `Not possible yet: a bank Swap writes both banks, and ${only}`;
};

/**
 * @typedef {{id: string, label: string, scope: "patch"|"bank"|"selection"|"template"|"backup-patch",
 *   enabled: (ctx: object) => true|string}} Action
 */
export const ACTIONS = Object.freeze([
  // patch (Pedal): the same three as a backup's patch
  { id: "summary", label: "Show summary", scope: "patch", enabled: (c) => c.read || "Not read yet" },
  { id: "save-template", label: "Save as template…", scope: "patch", enabled: LIVE_REREAD("it is saved") },
  { id: "export-prst", label: "Export for Valeton editor (.prst)…", scope: "patch", enabled: LIVE_REREAD("export") },
  // S3.2 slice 1: one patch at a time (PATCH_WRITE above)
  { id: "copy-to", label: "Copy to…", scope: "patch", enabled: PATCH_WRITE("copy-to") },
  { id: "move-to", label: "Move to…", scope: "patch", enabled: PATCH_WRITE("move-to") },
  { id: "swap-with", label: "Swap with…", scope: "patch", enabled: PATCH_WRITE("swap-with") },
  // S3.3: rename one patch, same gate as Copy/Move/Swap (PATCH_WRITE above; real pedal since 0.8.0)
  { id: "rename", label: "Rename…", scope: "patch", enabled: PATCH_WRITE("rename") },
  // bank
  { id: "select-bank", label: "Select this bank", scope: "bank", enabled: () => true },
  { id: "backup-bank", label: "Back up this bank…", scope: "bank", enabled: (c) => c.anyRead || "Not read yet" },
  // S3.2 slice 3: whole banks (A-D, unused slots included), demo-only (BANK_WRITE above)
  { id: "copy-bank-to", label: "Copy bank to…", scope: "bank", enabled: BANK_WRITE("copy") },
  { id: "move-bank-to", label: "Move bank to…", scope: "bank", enabled: BANK_WRITE("move") },
  { id: "swap-bank-with", label: "Swap with bank…", scope: "bank", enabled: BANK_WRITE("swap") },
  // template (S2): Librarian-only. Clicking a template shows its details, so there is no "Show details".
  { id: "template-rename", label: "Rename…", scope: "template", enabled: () => true },
  { id: "template-notes", label: "Notes…", scope: "template", enabled: () => true },
  { id: "template-duplicate", label: "Duplicate", scope: "template", enabled: () => true },
  { id: "template-export", label: "Export…", scope: "template", enabled: () => true },
  { id: "template-delete", label: "Delete…", scope: "template", enabled: () => true },
  // backup patch (S2): the Backup Browser is strictly read-only
  { id: "backup-summary", label: "Show summary", scope: "backup-patch", enabled: IN_BACKUP },
  { id: "backup-save-template", label: "Save as template…", scope: "backup-patch", enabled: IN_BACKUP },
  { id: "backup-export-prst", label: "Export for Valeton editor (.prst)…", scope: "backup-patch", enabled: IN_BACKUP },
  // selection
  { id: "backup-selection", label: "Back up selected", scope: "selection", enabled: (c) => c.size > 0 || "Nothing selected" },
  { id: "clear-selection", label: "Clear", scope: "selection", enabled: (c) => c.size > 0 || "Nothing selected" },
].map(Object.freeze));

/**
 * Planned, not built (U3): never in a menu; listed under More ▾ → What's
 * coming. Every one of them writes to the pedal, so each needs its own stage
 * approval (S3 and later) before it can appear in a menu.
 * @type {readonly {id: string, label: string, what: string}[]}
 */
export const PLANNED = Object.freeze([
  { id: "copy-selection", label: "Copy or move several patches", what: "copy or move several selected patches to consecutive slots, e.g. 36-A…C to 40" },
  { id: "restore", label: "Restore from a backup", what: "put patches from a backup back on the pedal" },
  { id: "template-apply", label: "Apply a template", what: "put a template on the pedal" },
].map(Object.freeze));
// Note: single-patch Copy, Move and Swap are built (S3.2 slice 1), and bank
// Copy, Move and Swap (slice 3), demo pedal only; the real pedal waits for its
// own hardware-approved write gate.

/**
 * The actions for a scope, with their state in this context.
 * @returns {{id: string, label: string, enabled: boolean, reason: string|null}[]}
 */
export function actionsFor(scope, ctx = {}) {
  return ACTIONS.filter((a) => a.scope === scope).map((a) => {
    const r = a.enabled(ctx);
    return { id: a.id, label: a.label, enabled: r === true, reason: r === true ? null : r };
  });
}
