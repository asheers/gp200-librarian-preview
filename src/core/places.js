// The three places (UI simplification, stage UI-1): Pedal | Templates |
// Backups. Which screen regions each place shows, and what More ▾ offers
// there. No DOM code: the app maps regions to elements (data-region) and the
// tests check tab ownership here.
//
// Tab ownership (approved 2026-10-10): a tab shows only actions on the thing
// it represents; a tab never exposes an action whose target belongs to
// another tab, and nothing switches tabs silently before acting.
// Progressive disclosure: rare, technical and development-stage functions
// appear only when asked for (More ▾).
//
// SPDX-License-Identifier: GPL-3.0-only

export const TABS = Object.freeze(["pedal", "templates", "backups"]);
export const BACKUP_SUBS = Object.freeze(["patches", "templates", "history"]);

/**
 * The place on screen.
 * @param {{tab: string, backupOpen?: boolean, sub?: string, hasArchive?: boolean}} o
 * @returns {"pedal"|"templates"|"backups-empty"|"backups-patches"|"backups-templates"|"backups-history"}
 */
export function placeOf({ tab, backupOpen = false, sub = "patches", hasArchive = false }) {
  if (!TABS.includes(tab)) throw new RangeError(`unknown tab ${tab}`);
  if (tab !== "backups") return tab;
  if (!backupOpen) return "backups-empty";
  // Only a Full Librarian backup has Templates and History; anything else shows its patches.
  return `backups-${hasArchive && BACKUP_SUBS.includes(sub) ? sub : "patches"}`;
}

const BACKUP_OPEN = ["backups-patches", "backups-templates", "backups-history"];

/** Region -> the places that show it. Pedal actions live only on the Pedal tab. */
export const REGIONS = Object.freeze({
  "pedal-actions": ["pedal"], // Connect, Stop reading, backups of the pedal
  "read-compare": ["pedal"], // the result of reading the pedal again
  scratch: ["pedal"], // bank-60 test tools (temporary): only when opened from More ▾ (UI-4)
  recovery: ["pedal"], // S3.1: unfinished operations found at start-up (read only; about the live pedal)
  undo: ["pedal"], // Undo acts on the live pedal: Pedal tab only (brief 3.6), and only when there is something to undo
  "engine-undo": ["pedal"], // S3.2 slice 4: Undo of the latest Copy/Move/Swap (patch or bank); same ownership rule as "undo"
  "write-result": ["pedal"], // the result of a write
  findbar: ["pedal", "backups-patches"],
  selbar: ["pedal", "backups-patches"],
  banks: ["pedal", "backups-patches"],
  "templates-view": ["templates"],
  "backups-empty": ["backups-empty"],
  "backup-banner": BACKUP_OPEN,
  "backup-templates": ["backups-templates"],
  "backup-history": ["backups-history"],
});

/** Whether `region` is shown in `place`. Unknown regions throw: every region must be declared here. */
export function regionVisible(region, place) {
  const p = REGIONS[region];
  if (!p) throw new RangeError(`unknown region ${region}`);
  return p.includes(place);
}

/**
 * Where a dropped file goes (UI-2, U7): a backup or a .prst opens in Backups; a
 * template file or a templates zip is imported in Templates. `kind` is the
 * zip's backup kind (compare.js loadBackup), null for other files. Null: not a
 * file the Librarian opens. Dropping never writes a file or sends anything to
 * the pedal.
 * @param {{name: string, kind?: string|null}} f
 * @returns {"backups"|"templates"|null}
 */
export function fileDestination({ name, kind = null }) {
  const n = String(name ?? "").toLowerCase();
  if (n.endsWith(".prst")) return "backups";
  if (n.endsWith(".json")) return "templates";
  if (!n.endsWith(".zip")) return null;
  if (kind === "templates") return "templates";
  return ["pedal", "selection", "full-librarian", "foreign"].includes(kind) ? "backups" : null;
}

/** The tab a place belongs to. */
export const tabOf = (place) => (place.startsWith("backups") ? "backups" : place);

/**
 * More ▾ for a place: the rare actions of that tab, then the general ones (log, What's coming, help).
 * @param {string} place
 * @param {{connected?: boolean, busy?: boolean, logShown?: boolean, testToolsShown?: boolean}} ctx
 * @returns {{id: string, label: string, enabled: boolean, reason: string|null}[]}
 */
export function moreItems(place, { connected = false, busy = false, logShown = false, testToolsShown = false } = {}) {
  const item = (id, label, ok = true) => ({ id, label, enabled: ok === true, reason: ok === true ? null : ok });
  const own = [];
  const tab = tabOf(place);
  if (tab === "pedal") {
    own.push(item("read-again", "Read pedal again", busy ? "Wait for the current operation to finish" : connected || "Connect first"));
    // Development scaffolding (brief section 4): out of the main screen, removable whole when S3 replaces it.
    own.push(item("test-tools", testToolsShown ? "Hide test tools (bank 60)" : "Test tools (bank 60)"));
  }
  if (tab === "backups") own.push(item("compare-files", "Compare two backup files…"));
  return [
    ...own,
    item("toggle-log", logShown ? "Hide log" : "Show log"),
    item("save-log", "Save log"),
    item("whats-coming", "What's coming"),
    item("help", "Help"),
  ];
}
