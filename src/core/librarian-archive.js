// Reading the librarian/ part of a Full Librarian backup (Phase 3 S2).
// No DOM code; no pedal access; no browser storage.
//
// Journal entries are HISTORICAL ARCHIVE DATA ONLY (approved 2026-10-08):
// they are returned deep-frozen and marked `archived: true`, for viewing.
// Nothing in the app writes them to the browser's journal or offers them as
// an Undo: an old before-image must never become a current Undo operation.
// Templates are returned as normal template records (their provenance kept),
// for an explicit "Import templates".
//
// SPDX-License-Identifier: GPL-3.0-only

import { templatesFromLoaded } from "./templates.js";

/**
 * @param {Awaited<ReturnType<import("./compare.js").loadBackup>>} loaded a verified format-2 full-librarian backup
 * @returns {{templates: object[], journal: object[], settings: object|null, info: object|null}}
 */
export function readLibrarianArchive(loaded) {
  if (loaded.info?.kind !== "full-librarian") throw new Error(`${loaded.fileName} is not a Full Librarian backup`);
  const entries = loaded.entries ?? new Map();
  const json = (name) => (entries.has(name) ? JSON.parse(new TextDecoder().decode(entries.get(name))) : null);
  const journal = [];
  for (const name of [...entries.keys()].filter((n) => /^librarian\/journal\/\d+\.json$/.test(n)).sort()) {
    const restore = (v) => {
      if (v && typeof v === "object" && !Array.isArray(v) && typeof v.$bin === "string" && Object.keys(v).length === 1) {
        const data = entries.get(v.$bin);
        if (!data) throw new Error(`${loaded.fileName}: ${v.$bin} is missing`);
        return Uint8Array.from(data);
      }
      if (Array.isArray(v)) return v.map(restore);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restore(x)]));
      return v;
    };
    // Typed arrays cannot be frozen; the record around them is, and nothing hands them to the write path.
    const e = restore(json(name));
    journal.push(deepFreezeRecord({ ...e, archived: true, archiveEntry: name }));
  }
  return { templates: templatesFromLoaded(loaded), journal, settings: json("librarian/settings.json"), info: json("librarian/info.json") };
}

/** Freeze a record and its plain objects (typed arrays are left as they are: they cannot be frozen). */
function deepFreezeRecord(o) {
  if (o instanceof Uint8Array || o === null || typeof o !== "object") return o;
  for (const v of Object.values(o)) deepFreezeRecord(v);
  return Object.freeze(o);
}
