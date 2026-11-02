// The operation journal: before any write, the destination's before-image
// (its raw 1176-byte dump) is saved here, and executeWrite (copy.js) refuses
// to write if saving fails. The browser stores it in IndexedDB
// (src/ui/store-idb.js); tests use MemoryJournal. journalZip() builds the
// download the UI offers before the write.
//
// SPDX-License-Identifier: GPL-3.0-only

import { APP_NAME, APP_VERSION } from "../version.js";
import { rawEntryName } from "./backup.js";
import { exportFileName, exportPrst } from "./patch.js";
import { slotToLabel } from "./slots.js";
import { createZip } from "./zip.js";

/** In-memory journal with the same interface as the IndexedDB one. */
export class MemoryJournal {
  constructor({ failSave = false } = {}) {
    this.entries = [];
    this.failSave = failSave;
  }

  async save(entry) {
    if (this.failSave) throw new Error("journal unavailable (test)");
    this.entries.push(structuredClone({ ...entry, id: this.entries.length + 1 }));
    return this.entries.length;
  }

  async update(id, patch) {
    const e = this.entries[id - 1];
    if (!e) throw new Error(`no journal entry ${id}`);
    Object.assign(e, structuredClone(patch));
  }

  async all() {
    return structuredClone(this.entries);
  }
}

const pad = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/**
 * A zip holding the destination's before-image as a raw dump and a .prst
 * (so tools/compare-backups.js can compare it with a full backup), plus the
 * patch about to be written under write/ and a description.
 * @param {import("./copy.js").CopyPlan} plan
 */
export function journalZip(plan, { skeleton, now = new Date() }) {
  const dest = plan.dest.slot;
  const before = plan.dest.before;
  const info = {
    app: `${APP_NAME} ${APP_VERSION}`,
    createdAt: now.toISOString(),
    op: plan.op,
    dest: { slot: dest, label: slotToLabel(dest), name: plan.dest.name, raw: rawEntryName(dest), prst: exportFileName(dest, before) },
    source: plan.source && { slot: plan.source.slot, label: slotToLabel(plan.source.slot), name: plan.source.name },
    writing: { name: plan.write.name, raw: `write/${slotToLabel(dest)}.bin` },
    note: "raw/ and the .prst hold the destination exactly as it was read before the write (the before-image). " +
      "write/ holds the patch bytes that were about to be written.",
  };
  const bytes = createZip([
    { name: exportFileName(dest, before), data: exportPrst(before, skeleton) },
    { name: rawEntryName(dest), data: Uint8Array.from(before) },
    { name: info.writing.raw, data: Uint8Array.from(plan.write.dump) },
    { name: "journal.json", data: new TextEncoder().encode(JSON.stringify(info, null, 2) + "\n") },
  ], now);
  return { fileName: `gp200-librarian_before-${plan.op}_${slotToLabel(dest)}_${stamp(now)}.zip`, bytes };
}

/**
 * The before-image zip for a multi-step plan (S3.1, plan.js): every input
 * slot's before-image as a raw dump and a .prst, every step's content under
 * write/, and plan.json describing the steps in order. The executor checks
 * that a confirmed save of this file holds exactly these before-images.
 * @param {import("./plan.js").Plan} plan
 */
export function planJournalZip(plan, { skeleton, title, now = new Date() }) {
  const info = {
    app: `${APP_NAME} ${APP_VERSION}`,
    createdAt: now.toISOString(),
    op: plan.kind,
    title,
    inputs: plan.inputs.map((i) => ({ slot: i.slot, label: slotToLabel(i.slot), name: i.name, unused: i.unused, raw: rawEntryName(i.slot) })),
    steps: plan.steps.map((s) => ({ step: s.index + 1, slot: s.slot, label: slotToLabel(s.slot), why: s.why, transform: s.transform,
      from: s.from, raw: `write/${slotToLabel(s.slot)}.bin` })),
    note: "raw/ and the .prst files hold every slot of the operation exactly as it was read before writing (the before-images). " +
      "write/ holds what each step was about to write.",
  };
  const bytes = createZip([
    ...plan.inputs.flatMap((i) => [
      { name: exportFileName(i.slot, i.dumpAtConfirm), data: exportPrst(i.dumpAtConfirm, skeleton) },
      { name: rawEntryName(i.slot), data: Uint8Array.from(i.dumpAtConfirm) },
    ]),
    ...plan.steps.map((s) => ({ name: `write/${slotToLabel(s.slot)}.bin`, data: Uint8Array.from(s.content) })),
    { name: "plan.json", data: new TextEncoder().encode(JSON.stringify(info, null, 2) + "\n") },
  ], now);
  const where = plan.steps.map((s) => slotToLabel(s.slot)).join("-");
  return { fileName: `gp200-librarian_before-${plan.kind}_${where}_${stamp(now)}.zip`, bytes };
}
