// Backup files. One .zip holds, for every slot included:
//   <label>_<name>.prst   donpark's normalized export (byte-identical to what
//                         GP-200 Patch Manager CLI/Web export for the same dump),
//                         importable by Valeton's editor and other tools
//   raw/<label>.bin       the raw 1176-byte dump exactly as the pedal sent it,
//                         the true byte-for-byte record (normalization zeroes
//                         a few bytes the pedal really does store)
//   manifest.json         what was read, when, from which port, and any gaps
//
// Format 2 (Phase 3 S0): the manifest also says which KIND of backup this is
// ("pedal": all 256 slots; "selection": some), records the read's state
// observation (the six evidenced values and signature, and the active slot
// when known; src/core/state-evidence.js) and holds a SHA-256 of every other
// entry, which loadBackup() (compare.js) verifies. Format 1 files still load.
//
// SPDX-License-Identifier: GPL-3.0-only

import { exportFileName, exportPrst, extractNameField, irNamDependencies } from "./patch.js";
import { sha256Hex } from "./sha256.js";
import { slotToLabel, TOTAL_SLOTS } from "./slots.js";
import { toHex } from "./sysex.js";
import { createZip } from "./zip.js";
import { APP_NAME, APP_VERSION } from "../version.js";

export const BACKUP_FORMAT = "gp200-librarian-backup/2";
export const BACKUP_FORMAT_V1 = "gp200-librarian-backup/1";
export const BACKUP_KINDS = Object.freeze(["pedal", "selection", "templates", "full-librarian"]);

const pad = (n) => String(n).padStart(2, "0");

function stamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function rawEntryName(slot) {
  return `raw/${slotToLabel(slot)}.bin`;
}

/**
 * Build a backup zip of `slots` from a snapshot.
 * @param {import("./library.js").Snapshot} snapshot
 * @param {number[]} slots in slot order
 * @param {object} opts
 * @param {Uint8Array} opts.skeleton
 * @param {Date} [opts.now]
 * @param {string} [opts.portName]
 * @param {Uint8Array|null} [opts.identityReply]
 * @param {boolean} [opts.demo]
 * @returns {{fileName: string, bytes: Uint8Array, included: number[], missing: number[]}}
 */
export function buildBackup(snapshot, slots, {
  skeleton, now = new Date(), portName = null, identityReply = null, demo = false, source = null, kindOverride = null, extraEntries = [], librarian = null,
}) {
  const entries = [];
  const raws = [];
  const included = [];
  const missing = [];
  const manifestSlots = [];
  for (const slot of slots) {
    const dump = snapshot.dumps[slot];
    if (!dump) {
      missing.push(slot);
      continue;
    }
    included.push(slot);
    const fileName = exportFileName(slot, dump);
    entries.push({ name: fileName, data: exportPrst(dump, skeleton) });
    raws.push({ name: rawEntryName(slot), data: Uint8Array.from(dump) });
    manifestSlots.push({
      slot, label: slotToLabel(slot), name: extractNameField(dump), prst: fileName, raw: rawEntryName(slot),
      rawLength: dump.length, irNam: irNamDependencies(dump).map((d) => d.text),
    });
  }
  const all = slots.length === TOTAL_SLOTS && slots.every((s, i) => s === i);
  const kind = kindOverride ?? (all && missing.length === 0 ? "pedal" : "selection");
  const observed = snapshot.state ?? null;
  const range = all ? "all" : included.length
    ? `${slotToLabel(included[0])}-${slotToLabel(included[included.length - 1])}` : "empty";
  const manifest = {
    format: BACKUP_FORMAT,
    kind,
    // Set when the patches were taken from another backup file (Backup Browser), not from the pedal.
    ...(source ? { source } : {}),
    app: `${APP_NAME} ${APP_VERSION}`,
    createdAt: now.toISOString(),
    demo,
    readNumber: snapshot.readNumber,
    readStartedAt: snapshot.startedAt,
    portName,
    identityReplyHex: identityReply ? toHex(identityReply) : null,
    slotsRequested: slots.length,
    slotsIncluded: included.length,
    state: observed && {
      signature: observed.signature, complete: observed.complete, applicable: observed.applicable, recognised: observed.recognised,
      finding: observed.finding,
      values: observed.values.map((v) => ({ label: v.label, fileOffset: `0x${v.fileOff.toString(16)}`, value: v.value, evidencedPatch: v.evidencedPatch })),
      activeSlot: observed.activeSlot, activeSlotAtStart: snapshot.activeSlotAtStart ?? null,
      note: "Recorded as observed (docs/PHASE3_DESIGN.md section 8). The active slot is recorded only.",
    },
    missing: missing.map((s) => ({ slot: s, label: slotToLabel(s), reason: snapshot.errors.get(s) ?? "not read" })),
    notes: [
      "*.prst: donpark-compatible normalized export (export-only fields zeroed, checksum recomputed).",
      "raw/*.bin: raw 1176-byte dumps exactly as received; file offset = dump offset + 0x28.",
      "User-IR/SnapTone (NAM) references are slot numbers only; the IR/NAM content is not in this backup.",
    ],
    slots: manifestSlots,
  };
  if (librarian) manifest.librarian = librarian;
  manifest.sha256 = Object.fromEntries([...entries, ...raws, ...extraEntries].map((e) => [e.name, sha256Hex(e.data)]));
  const zipEntries = [
    ...entries, ...raws, ...extraEntries,
    { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n") },
  ];
  const prefix = demo ? "gp200-librarian-DEMO" : "gp200-librarian";
  return {
    fileName: `${prefix}_${kind}_${range}_read${snapshot.readNumber}_${stamp(now)}.zip`,
    kind,
    bytes: createZip(zipEntries, now),
    included,
    missing,
  };
}

/**
 * Several templates as one zip (format 2, kind "templates"): templates/<id>.json
 * (each exactly a single-template file, src/core/templates.js) plus a manifest
 * with a SHA-256 of every entry.
 */
export function buildTemplatesZip(files, { now = new Date() } = {}) {
  const entries = files.map((f) => ({ name: `templates/${f.id}.json`, data: f.bytes }));
  const manifest = {
    format: BACKUP_FORMAT, kind: "templates", app: `${APP_NAME} ${APP_VERSION}`, createdAt: now.toISOString(),
    templates: files.length, sha256: Object.fromEntries(entries.map((e) => [e.name, sha256Hex(e.data)])),
  };
  return {
    fileName: `gp200-librarian_templates_${stamp(now)}.zip`,
    bytes: createZip([...entries, { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n") }], now),
  };
}

/**
 * Full Librarian backup (Phase 3 S2; format 2, kind "full-librarian"): a
 * complete Pedal backup of one complete read (the same top-level entries, so
 * every existing tool still reads it) PLUS everything the Librarian owns:
 *   librarian/templates/<id>.json        every template (single-template file format)
 *   librarian/journal/<n>.json (+ .bin)  every journal entry, as an ARCHIVE ONLY
 *   librarian/settings.json              per-browser settings
 *   librarian/info.json                  counts and notes
 * The journal is archived for the record and is never re-imported as a current
 * Undo/history (approved 2026-10-08; src/core/librarian-archive.js).
 * O2 (2026-10-18): `journal` is already filtered (core/history.js
 * historyForFullBackup); `journalNotes` records whose history it is and any
 * entries left out of the file, in info.json and the manifest.
 * @param {{templateFiles: {id: string, bytes: Uint8Array}[], journal: object[], settings: object,
 *   journalNotes?: {pedalKind: "real"|"demo", counts: object, excluded: object[]}|null}} librarianData
 */
export function buildFullLibrarianBackup(snapshot, { skeleton, now = new Date(), portName = null, identityReply = null, demo = false, templateFiles = [], journal = [], settings = {}, journalNotes = null }) {
  const all = Array.from({ length: TOTAL_SLOTS }, (_, i) => i);
  const missing = all.filter((s) => !snapshot.dumps[s]);
  if (snapshot.cancelled || missing.length) {
    throw new Error(`a Full Librarian backup needs a complete read of all 256 slots (${missing.length} missing). Re-read the pedal first`);
  }
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o, null, 2) + "\n");
  const extra = templateFiles.map((f) => ({ name: `librarian/templates/${f.id}.json`, data: f.bytes }));
  journal.forEach((entry, i) => {
    const n = String(i + 1).padStart(4, "0");
    const bins = [];
    // Byte arrays (before-images, read-backs) become separate .bin entries, referenced from the JSON.
    const strip = (v, path) => {
      if (v instanceof Uint8Array) {
        const name = `librarian/journal/${n}/${path || "data"}.bin`;
        bins.push({ name, data: Uint8Array.from(v) });
        return { $bin: name };
      }
      if (Array.isArray(v)) return v.map((x, j) => strip(x, `${path}.${j}`));
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x, path ? `${path}.${k}` : k)]));
      return v;
    };
    extra.push({ name: `librarian/journal/${n}.json`, data: enc(strip(entry, "")) }, ...bins);
  });
  const info = {
    app: `${APP_NAME} ${APP_VERSION}`, createdAt: now.toISOString(), templates: templateFiles.length, journalEntries: journal.length,
    ...(journalNotes ? { journalPedalKind: journalNotes.pedalKind, journalCounts: journalNotes.counts, journalExcluded: journalNotes.excluded } : {}),
    notes: [
      "The top level is a complete Pedal backup of one read (raw/*.bin exact; *.prst normalised).",
      "librarian/templates: every Librarian template, one file each (the single-template export format).",
      "librarian/journal: the browser's operation journal, ARCHIVED FOR THE RECORD ONLY. It is never imported as a current Undo or history.",
      ...(journalNotes ? [journalNotes.pedalKind === "demo"
        ? "This is the DEMO pedal's history (simulated pedal)."
        : "Real pedal history only: demo entries are left out of this file (journalExcluded) but stay in the browser."] : []),
    ],
  };
  extra.push({ name: "librarian/settings.json", data: enc(settings) }, { name: "librarian/info.json", data: enc(info) });
  return buildBackup(snapshot, all, {
    skeleton, now, portName, identityReply, demo, kindOverride: "full-librarian", extraEntries: extra,
    librarian: { templates: templateFiles.length, journalEntries: journal.length, journalIsArchiveOnly: true,
      ...(journalNotes ? { journalPedalKind: journalNotes.pedalKind, journalExcluded: journalNotes.excluded.length } : {}) },
  });
}
