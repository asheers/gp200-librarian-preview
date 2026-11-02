// A backup (or a single .prst file) as a READ-ONLY source for the Backup
// Browser (Phase 3 S2). No DOM code.
//
// Immutability: everything kept is a COPY. readZip() returns views into the
// file's buffer for stored entries; this module copies each one, so nothing
// the Browser does can alter the bytes it was given, and the file itself is
// never written (the app holds no writable handle to it).
//
// Per slot it keeps the patch content (a 1176-byte dump) and its provenance:
//   "raw"   the backup's raw/<slot>.bin (lossless);
//   "prst"  only a .prst was present (donpark's backups, single .prst files):
//           the content region of the file, which the .prst format normalised
//           (45 bytes zeroed). The original .prst bytes are kept so an export
//           passes them through unchanged.
//
// SPDX-License-Identifier: GPL-3.0-only

import { describeBackupInfo, loadBackup } from "./compare.js";
import { readLibrarianArchive } from "./librarian-archive.js";
import { CONTENT_FILE_START, exportPrst, isPrst } from "./patch.js";
import { slotToDisplayLabel, TOTAL_SLOTS } from "./slots.js";
import { observeState } from "./state-evidence.js";
import { EXPECTED_DUMP_LEN } from "./sysex.js";

const prstContent = (prst) => Uint8Array.from(prst.subarray(CONTENT_FILE_START, CONTENT_FILE_START + EXPECTED_DUMP_LEN));

/**
 * @typedef {{type: "backup"|"prst-file", fileName: string, info: object, infoText: string, manifest: object|null,
 *   dumps: (Uint8Array|null)[], provenance: ("raw"|"prst"|null)[], prstFiles: (Uint8Array|null)[],
 *   errors: Map<number,string>, readNumber: number|null, startedAt: string|null, state: object,
 *   slotCount: number, lossySlots: number}} BackupSource
 */

/** Build a source from loadBackup() output (copies every byte it keeps). */
export function sourceFromLoaded(loaded) {
  const dumps = new Array(TOTAL_SLOTS).fill(null);
  const provenance = new Array(TOTAL_SLOTS).fill(null);
  const prstFiles = new Array(TOTAL_SLOTS).fill(null);
  for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
    const raw = loaded.raw.get(slot);
    const p = loaded.prst.get(slot);
    if (p && isPrst(p.data)) prstFiles[slot] = Uint8Array.from(p.data);
    if (raw && raw.length === EXPECTED_DUMP_LEN) {
      dumps[slot] = Uint8Array.from(raw);
      provenance[slot] = "raw";
    } else if (p && isPrst(p.data)) {
      dumps[slot] = prstContent(p.data);
      provenance[slot] = "prst";
    }
  }
  const m = loaded.manifest;
  const rawDumps = Array.from({ length: TOTAL_SLOTS }, (_, s) => (provenance[s] === "raw" ? dumps[s] : null));
  return {
    type: "backup", fileName: loaded.fileName, info: loaded.info, infoText: describeBackupInfo(loaded.info), manifest: m,
    dumps, provenance, prstFiles, errors: new Map(),
    readNumber: m?.readNumber ?? null, startedAt: m?.readStartedAt ?? m?.createdAt ?? null,
    // The six-byte observation only from raw dumps (a .prst breaks the evidence fingerprint).
    state: observeState(rawDumps, { activeSlot: m?.state?.activeSlot ?? null }),
    slotCount: dumps.filter(Boolean).length,
    lossySlots: provenance.filter((p) => p === "prst").length,
    // A Full Librarian backup's librarian/ part: templates (importable on request) and the
    // journal as frozen archive records (never a current Undo).
    archive: loaded.info?.kind === "full-librarian" ? readLibrarianArchive(loaded) : null,
  };
}

/**
 * A single .prst file as a one-slot source, placed at the slot it records
 * (file 0x34, which the .prst format keeps), or 1-A if that is out of range.
 */
export function sourceFromPrstFile(bytes, fileName) {
  if (!isPrst(bytes)) throw new Error(`${fileName}: not a 1224-byte .prst file`);
  const recorded = bytes[0x34];
  const slot = recorded < TOTAL_SLOTS ? recorded : 0;
  const dumps = new Array(TOTAL_SLOTS).fill(null);
  const provenance = new Array(TOTAL_SLOTS).fill(null);
  const prstFiles = new Array(TOTAL_SLOTS).fill(null);
  dumps[slot] = prstContent(bytes);
  provenance[slot] = "prst";
  prstFiles[slot] = Uint8Array.from(bytes);
  return {
    type: "prst-file", fileName, info: { format: "prst", version: null, kind: "prst-file", checksums: "none", verifiedEntries: 0 },
    infoText: `a single .prst file (recorded slot ${slotToDisplayLabel(slot)}; normalised by the format)`,
    manifest: null, dumps, provenance, prstFiles, errors: new Map(), readNumber: null, startedAt: null,
    state: observeState(new Array(TOTAL_SLOTS).fill(null)), slotCount: 1, lossySlots: 1,
  };
}

/**
 * The .prst for one slot of a source: a slot that came from a .prst is passed
 * through unchanged (byte for byte); a raw dump is exported with exportPrst()
 * (skeleton overlay + donpark's normalisation). Never touches the pedal.
 */
export function prstForSlot(source, slot, skeleton) {
  const dump = source.dumps[slot];
  if (!dump) throw new Error(`${slotToDisplayLabel(slot)} is not in this ${source.type === "backup" ? "backup" : "file"}`);
  if (source.provenance[slot] === "prst" && source.prstFiles[slot]) return Uint8Array.from(source.prstFiles[slot]);
  return exportPrst(dump, skeleton);
}

/** Open a .zip backup or a single .prst file as a source. */
export async function openSource(bytes, fileName) {
  if (/\.prst$/i.test(fileName) || isPrst(bytes)) return sourceFromPrstFile(bytes, fileName);
  return sourceFromLoaded(await loadBackup(bytes, fileName));
}
