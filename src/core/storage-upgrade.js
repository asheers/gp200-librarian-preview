// Advance warning for the one-way browser-storage update (S3.0, R2/R3;
// approved 2026-10-18). No DOM code; no browser storage.
//
// Version 3 of the real database (O2) cannot be opened by 0.4.1 or earlier,
// version 4 (S3.1, operations) not by 0.4.5 or earlier, and IndexedDB cannot
// be downgraded. So, before the real database is first
// opened at a newer version, the app (src/ui/app.js) says so, asks the user
// to close other GP200 Librarian tabs, and offers to save a COPY of the
// current storage, read without upgrading it. The copy is a record only: the
// app has no import for it, so it adds no second migration path. The update
// itself changes no data (store-idb.js).
//
// SPDX-License-Identifier: GPL-3.0-only

import { createZip } from "./zip.js";

/**
 * The notice to show before the update, or null when there is nothing to warn about.
 * @param {{exists: boolean, version: number|null}|null} existing what the browser says is stored (null: unknown)
 * @param {number} target the version this app opens
 * @returns {{title: string, lines: string[], from: number, to: number}|null}
 */
export function upgradeNotice(existing, target) {
  if (!existing?.exists || typeof existing.version !== "number" || existing.version >= target) return null;
  // What the update is for, by the version it starts from (3 -> 4: the operations journal, S3.1).
  const why = existing.version >= 3
    ? "This version adds a record of multi-step operations (such as Move and Swap), so that one interrupted part-way " +
      "can be found again when the Librarian next starts. To do that it updates this browser's storage " +
      "(your history, templates and settings). Nothing in them is changed or removed."
    : "This version keeps the real pedal's history apart from the demo's. To do that it updates this browser's storage " +
      "(your history, templates and settings). Nothing in them is changed or removed.";
  return {
    from: existing.version, to: target,
    title: "Update this browser's Librarian storage?",
    lines: [
      why,
      "The update is one way: older versions of the Librarian will not be able to use this browser's storage afterwards.",
      "Before you update: close every other GP200 Librarian tab or window (older versions especially), and save a copy of " +
        "the current storage if you want a record of it. A Full Librarian backup (Back up…) is also a good idea once connected.",
      "\"Not now\" changes nothing: templates and history are then unavailable on this page, and nothing can be written " +
        "to the pedal, until you reload and update.",
    ],
  };
}

const b64 = (u8) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};

/** JSON with byte arrays as {"$base64": "..."}. */
function encodeRecords(v) {
  if (v instanceof Uint8Array) return { $base64: b64(v) };
  if (Array.isArray(v)) return v.map(encodeRecords);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeRecords(x)]));
  return v;
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * A zip copy of the browser storage as it is now (before the update): one JSON file per store.
 * @param {{name: string, version: number, stores: Record<string, object[]>}} snapshot
 * @param {{app: string, now?: Date}} o
 * @returns {{fileName: string, bytes: Uint8Array}}
 */
export function storageCopyZip(snapshot, { app, now = new Date() }) {
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o, null, 2) + "\n");
  const counts = Object.fromEntries(Object.entries(snapshot.stores).map(([k, v]) => [k, v.length]));
  const entries = Object.entries(snapshot.stores).map(([store, records]) => ({ name: `${store}.json`, data: enc(encodeRecords(records)) }));
  entries.push({
    name: "README.json",
    data: enc({
      what: "A copy of the GP200 Librarian browser storage, saved before the one-way update.",
      database: snapshot.name, version: snapshot.version, counts, savedBy: app, savedAt: now.toISOString(),
      note: "A record only. The app never imports this file. Byte arrays are stored as {\"$base64\": ...}.",
    }),
  });
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return { fileName: `gp200-librarian_browser-storage_v${snapshot.version}_${stamp}.zip`, bytes: createZip(entries, now) };
}
