// Patch Templates (Phase 3 S2): Librarian-owned complete patches, separate
// from the 256 pedal slots. No DOM code; no pedal access. Creating, renaming,
// exporting and importing a template never touches the pedal; applying one to
// the pedal is a write and belongs to a later stage.
//
// Provenance (approved 2026-10-08) is one of:
//   lossless-pedal   from the live pedal (after a fresh one-slot read)
//   lossless-backup  from a backup's raw dump
//   lossy-prst       from a .prst file, or a backup slot that only had a .prst
// "Lossy" is DERIVED from the provenance, never stored separately, so it
// cannot drift. A template file's SHA-256 covers the whole canonical record
// (provenance included), so a lossy template cannot be edited into a
// lossless one. The payload is immutable once saved; only the name and notes
// change. Phase 4 may add other kinds ("block"); "patch" handlers never
// assume more.
//
// SPDX-License-Identifier: GPL-3.0-only

import { contentKey, normalizedKey } from "./match.js";
import { displayName, irNamDependencies, safeFilename } from "./patch.js";
import { sha256Hex } from "./sha256.js";
import { EXPECTED_DUMP_LEN } from "./sysex.js";

export const TEMPLATE_FILE_FORMAT = "gp200-librarian-template/1";
export const PAYLOAD_FORMAT = "gp200-dump-1176";
export const PROVENANCE = Object.freeze({ PEDAL: "lossless-pedal", BACKUP: "lossless-backup", PRST: "lossy-prst" });
const PROVENANCES = Object.values(PROVENANCE);
export const NAME_MAX = 64;

export class TemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = "TemplateError";
  }
}

export const isLossy = (t) => t.provenance === PROVENANCE.PRST;

/** Plain-English source, for lists and summaries. */
export function provenanceText(t) {
  switch (t.provenance) {
    case PROVENANCE.PEDAL: return "exact, from the pedal";
    case PROVENANCE.BACKUP: return "exact, from a backup";
    default: return "from a .prst file (not exact: the .prst format zeroes a few stored values)";
  }
}

function checkName(name) {
  const n = String(name ?? "").trim();
  if (!n) throw new TemplateError("a template needs a name");
  if (n.length > NAME_MAX) throw new TemplateError(`a template name can be at most ${NAME_MAX} characters`);
  return n;
}

function derive(bytes) {
  return { patchName: displayName(bytes), irNam: irNamDependencies(bytes).map((d) => d.text), contentKey: contentKey(bytes), normalizedKey: normalizedKey(bytes) };
}

const newId = () => globalThis.crypto.randomUUID();

/**
 * @param {{dump: Uint8Array, name: string, notes?: string, provenance: string, origin?: object, now?: Date, id?: string}} o
 */
export function createTemplate({ dump, name, notes = "", provenance, origin = {}, now = new Date(), id = newId() }) {
  if (!(dump instanceof Uint8Array) || dump.length !== EXPECTED_DUMP_LEN) {
    throw new TemplateError(`a template needs a complete ${EXPECTED_DUMP_LEN}-byte patch, got ${dump?.length ?? "none"}`);
  }
  if (!PROVENANCES.includes(provenance)) throw new TemplateError(`unknown template source "${provenance}"`);
  const bytes = Uint8Array.from(dump);
  const at = now.toISOString();
  return {
    id, schema: 1, kind: "patch", name: checkName(name), notes: String(notes ?? ""), createdAt: at, updatedAt: at,
    provenance, origin: { ...origin }, payload: { format: PAYLOAD_FORMAT, bytes }, derived: derive(bytes),
  };
}

export function renameTemplate(t, name, now = new Date()) {
  return { ...t, name: checkName(name), updatedAt: now.toISOString() };
}

export function setTemplateNotes(t, notes, now = new Date()) {
  return { ...t, notes: String(notes ?? ""), updatedAt: now.toISOString() };
}

/** A new template with the same payload and provenance (and a new id). */
export function duplicateTemplate(t, { id = newId(), now = new Date(), name = `${t.name} (copy)` } = {}) {
  return createTemplate({
    dump: t.payload.bytes, name: name.slice(0, NAME_MAX), notes: t.notes, provenance: t.provenance,
    origin: { ...t.origin, duplicatedFrom: t.id }, now, id,
  });
}

// ---- files ---------------------------------------------------------------

/** JSON with keys sorted at every level, so the same record always hashes the same. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The template as it is written to a file (payload as base64; no derived fields). */
function fileTemplate(t) {
  return {
    id: t.id, schema: t.schema, kind: t.kind, name: t.name, notes: t.notes, createdAt: t.createdAt, updatedAt: t.updatedAt,
    provenance: t.provenance, origin: t.origin, payload: { format: t.payload.format, bytes: b64(t.payload.bytes) },
  };
}

/** One template as a .gp200template.json file. */
export function templateFile(t) {
  const template = fileTemplate(t);
  const doc = { format: TEMPLATE_FILE_FORMAT, template, lossy: isLossy(t), sha256: sha256Hex(new TextEncoder().encode(canonical(template))) };
  return { fileName: `${safeFilename(t.name)}.gp200template.json`, bytes: new TextEncoder().encode(JSON.stringify(doc, null, 2) + "\n") };
}

/** Parse and check a template file (bytes or an already-parsed object). Throws TemplateError. */
export function parseTemplateFile(input, label = "template file") {
  let doc;
  try {
    doc = input instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(input)) : input;
  } catch {
    throw new TemplateError(`${label}: not a template file (not JSON)`);
  }
  if (doc?.format !== TEMPLATE_FILE_FORMAT) throw new TemplateError(`${label}: not a GP200 Librarian template file`);
  const t = doc.template;
  if (t?.schema !== 1 || t?.kind !== "patch") throw new TemplateError(`${label}: unsupported template (schema ${t?.schema}, kind ${t?.kind})`);
  if (sha256Hex(new TextEncoder().encode(canonical(t))) !== doc.sha256) throw new TemplateError(`${label}: damaged or edited (SHA-256 does not match)`);
  if (!PROVENANCES.includes(t.provenance)) throw new TemplateError(`${label}: unknown template source "${t.provenance}"`);
  if (doc.lossy !== (t.provenance === PROVENANCE.PRST)) throw new TemplateError(`${label}: its lossy flag does not match its source`);
  if (t.payload?.format !== PAYLOAD_FORMAT) throw new TemplateError(`${label}: unknown payload format`);
  let bytes;
  try {
    bytes = unb64(t.payload.bytes);
  } catch {
    throw new TemplateError(`${label}: payload is not valid base64`);
  }
  if (bytes.length !== EXPECTED_DUMP_LEN) throw new TemplateError(`${label}: payload is ${bytes.length} bytes, expected ${EXPECTED_DUMP_LEN}`);
  return {
    id: t.id, schema: 1, kind: "patch", name: checkName(t.name), notes: String(t.notes ?? ""), createdAt: t.createdAt, updatedAt: t.updatedAt,
    provenance: t.provenance, origin: { ...(t.origin ?? {}) }, payload: { format: PAYLOAD_FORMAT, bytes }, derived: derive(bytes),
  };
}

const samePayload = (a, b) => a.provenance === b.provenance && a.payload.bytes.length === b.payload.bytes.length &&
  a.payload.bytes.every((x, i) => x === b.payload.bytes[i]);

/**
 * Import templates into a store. An existing id is never overwritten: the same
 * payload is skipped; a different payload is imported as a copy with a new id.
 * Provenance is kept as it is (a lossy template stays lossy).
 */
export async function importTemplates(store, records, { newIdFn = newId } = {}) {
  const added = [];
  const skipped = [];
  const copied = [];
  for (const r of records) {
    const existing = await store.get(r.id);
    if (!existing) {
      await store.put(r);
      added.push(r.id);
    } else if (samePayload(existing, r)) {
      skipped.push(r.id);
    } else {
      const copy = { ...r, id: newIdFn(), origin: { ...r.origin, importedFromId: r.id } };
      await store.put(copy);
      copied.push(copy.id);
    }
  }
  return { added, skipped, copied };
}

/** Templates whose content (normalised key) is the same as `key`. */
export function templatesMatching(all, key, exceptId = null) {
  return all.filter((t) => t.derived.normalizedKey === key && t.id !== exceptId);
}

/** In-memory store with the same interface as the browser's IndexedDB store (tests). */
export class MemoryTemplateStore {
  constructor() {
    this.map = new Map();
  }

  async all() {
    return [...this.map.values()].map((t) => structuredClone(t)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id) {
    const t = this.map.get(id);
    return t ? structuredClone(t) : null;
  }

  async put(t) {
    this.map.set(t.id, structuredClone(t));
  }

  async delete(id) {
    this.map.delete(id);
  }
}

/**
 * Template files inside a loaded zip (loadBackup() output): templates/*.json
 * (a templates zip) or librarian/templates/*.json (a Full Librarian backup).
 * The zip's checksums were already verified by loadBackup (format 2).
 */
export function templatesFromLoaded(loaded) {
  const out = [];
  for (const [name, data] of loaded.entries ?? []) {
    if (/^(librarian\/)?templates\/[^/]+\.json$/.test(name)) out.push(parseTemplateFile(Uint8Array.from(data), name));
  }
  return out;
}
