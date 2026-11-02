// The browser's IndexedDB stores: database "gp200-librarian" for the real
// pedal, and (from version 3, S3.0 O2) a separate database
// "gp200-librarian-demo" for the demo pedal (?demo), so demo operations,
// templates and settings can never reach the real history or a real Full
// Librarian backup. A page uses exactly one of them (librarianStores).
//
// Version 1 (Phase 2): store "journal", the operation journal. The same
// interface as MemoryJournal in src/core/journal.js. If IndexedDB is
// unavailable, save() rejects, and copy.js then refuses to write (the
// before-image must be saved first).
// Version 2 (Phase 3 S2): adds "templates" (key: id) and "settings" (key:
// key). The upgrade ONLY creates stores that are missing: the journal and
// its entries are left exactly as they were (tools/check-s2.js pins this).
//
// Version 3 (O2, 2026-10-18): no store or data changes. The version number
// alone fences out pages of older versions: a pre-O2 page (which wrote demo
// operations into the real journal) can no longer open the database
// (VersionError), so its writes abort with nothing written. Existing entries
// are never rewritten; new ones get `pedalKind`, stamped here, never by the
// caller. An open connection closes itself when a newer version asks.
//
// Version 4 (S3.1, 2026-10-18): adds "operations" (key: id, auto), one record
// per multi-step operation (src/core/executor.js; read side in
// src/core/operations.js). Again the upgrade ONLY creates the missing store:
// journal, templates and settings are not touched, and the Phase 2 journal is
// never copied or rewritten (it is shown read-only as legacy operations). A
// version-3 page (0.4.5 and earlier) can no longer open the database.
//
// Archived journal entries from a Full Librarian backup are NEVER written
// here (approved 2026-10-08): they are historical records only and must not
// become a current Undo. This module has no import function for them.
//
// SPDX-License-Identifier: GPL-3.0-only

/** The database for each pedal kind. */
export const DB_NAMES = Object.freeze({ real: "gp200-librarian", demo: "gp200-librarian-demo" });
export const DB_VERSION = 4;
const SAVE_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const dbPromises = new Map();

// S3.0 (R2/R3): nothing opens a database until the page's gate resolves. The app
// sets it at start-up: resolved at once, or after the user has seen the one-way
// update notice and chosen "Update storage now". A rejected gate (e.g. "Not now")
// makes every store call reject, so a pedal write fails closed at the journal.
let gate = Promise.resolve();
/** @param {Promise<void>} p */
export function setStorageGate(p) {
  gate = p;
  gate.catch(() => {}); // rejections surface through the store calls
}

/**
 * What the browser has stored under `name`, WITHOUT opening (and so without upgrading or creating) it.
 * @returns {Promise<{exists: boolean, version: number|null}|null>} null when the browser cannot tell
 */
export async function inspectDb(name) {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return null;
  const list = await indexedDB.databases();
  const hit = list.find((d) => d.name === name);
  return hit ? { exists: true, version: hit.version ?? null } : { exists: false, version: null };
}

/**
 * Every record of an EXISTING database, read at its current version (no version is
 * requested, so nothing is upgraded). For the copy offered before the update only.
 * @returns {Promise<{name: string, version: number, stores: Record<string, object[]>}>}
 */
export function readStorageSnapshot(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name); // no version: open as it is
    req.onupgradeneeded = () => { req.transaction.abort(); }; // it did not exist: create nothing
    req.onerror = () => reject(req.error ?? new Error(`${name} could not be read`));
    req.onsuccess = () => {
      const db = req.result;
      const names = [...db.objectStoreNames];
      const out = { name, version: db.version, stores: {} };
      if (!names.length) { db.close(); resolve(out); return; }
      const t = db.transaction(names, "readonly");
      for (const n of names) {
        const q = t.objectStore(n).getAll();
        q.onsuccess = () => { out.stores[n] = q.result; };
      }
      t.oncomplete = () => { db.close(); resolve(out); };
      t.onerror = () => { db.close(); reject(t.error); };
    };
  });
}

/** Open (and if needed upgrade) a database once per page, after the gate. */
function openDb(name) {
  if (dbPromises.has(name)) return dbPromises.get(name);
  const p = gate.then(() => new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("this browser has no IndexedDB"));
      return;
    }
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("journal")) db.createObjectStore("journal", { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains("templates")) db.createObjectStore("templates", { keyPath: "id" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("operations")) db.createObjectStore("operations", { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromises.delete(name); }; // let a newer version upgrade
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onblocked = () => reject(new Error("IndexedDB is blocked by another tab (close other GP200 Librarian tabs, including older versions)"));
  }));
  dbPromises.set(name, p);
  p.catch(() => { if (dbPromises.get(name) === p) dbPromises.delete(name); });
  return p;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error ?? new Error("IndexedDB transaction failed"));
    t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
    fn(t.objectStore(store), (r) => { result = r; });
  });
}

const request = (name, store, mode, make) => openDb(name).then((db) => tx(db, store, mode, (s, done) => {
  const req = make(s);
  if (req) req.onsuccess = () => done(req.result);
}));

export class IdbJournal {
  /**
   * @param {string} name the database (DB_NAMES)
   * @param {"real"|"demo"} pedalKind stamped on every new entry
   */
  constructor(name, pedalKind) {
    if (DB_NAMES[pedalKind] !== name) throw new Error(`journal: ${pedalKind} entries belong in ${DB_NAMES[pedalKind]}, not ${name}`);
    this.name = name;
    this.pedalKind = pedalKind;
  }

  /**
   * Resolves with the new entry's id only once the transaction has committed.
   * Rejects after SAVE_TIMEOUT_MS, so a stuck database aborts the write
   * (copy.js: nothing is written without a saved before-image) instead of hanging.
   */
  async save(entry) {
    return withTimeout(request(this.name, "journal", "readwrite", (s) => s.add({ ...entry, pedalKind: this.pedalKind, savedAt: new Date().toISOString() })),
      SAVE_TIMEOUT_MS, "saving to IndexedDB timed out");
  }

  async update(id, patch) {
    const { pedalKind, ...rest } = patch; // the marker is the store's, never changed by an update
    patch = rest;
    const db = await openDb(this.name);
    await tx(db, "journal", "readwrite", (store) => {
      const req = store.get(id);
      req.onsuccess = () => {
        if (req.result) store.put({ ...req.result, ...patch, updatedAt: new Date().toISOString() });
      };
    });
  }

  /** Every entry, oldest first (for the log, support and the Full Librarian backup). */
  async all() {
    return request(this.name, "journal", "readonly", (s) => s.getAll());
  }
}

/**
 * The operations journal (S3.1): one record per operation, the same interface
 * as MemoryOperationStore in src/core/operations.js. save() resolves only once
 * committed; save() and update() time out, so a stuck database stops an
 * operation (executor.js) instead of hanging it. The store stamps pedalKind.
 */
export class IdbOperationStore {
  /**
   * @param {string} name the database (DB_NAMES)
   * @param {"real"|"demo"} pedalKind stamped on every new record
   */
  constructor(name, pedalKind) {
    if (DB_NAMES[pedalKind] !== name) throw new Error(`operations: ${pedalKind} records belong in ${DB_NAMES[pedalKind]}, not ${name}`);
    this.name = name;
    this.pedalKind = pedalKind;
  }

  async save(record) {
    return withTimeout(request(this.name, "operations", "readwrite", (s) => s.add({ ...record, pedalKind: this.pedalKind, savedAt: new Date().toISOString() })),
      SAVE_TIMEOUT_MS, "saving the operation record timed out");
  }

  async update(id, patch) {
    const { pedalKind, ...rest } = patch; // the marker is the store's, never changed by an update
    void pedalKind;
    const done = openDb(this.name).then((db) => tx(db, "operations", "readwrite", (store) => {
      const req = store.get(id);
      req.onsuccess = () => {
        if (!req.result) throw new Error(`no operation record ${id}`);
        store.put({ ...req.result, ...rest, updatedAt: new Date().toISOString() });
      };
    }));
    await withTimeout(done, SAVE_TIMEOUT_MS, "updating the operation record timed out");
  }

  /** Every record, oldest first. */
  async all() {
    return (await request(this.name, "operations", "readonly", (s) => s.getAll())) ?? [];
  }
}

/** Templates (same interface as MemoryTemplateStore in src/core/templates.js). */
export class IdbTemplateStore {
  constructor(name) {
    this.name = name;
  }

  async all() {
    const list = (await request(this.name, "templates", "readonly", (s) => s.getAll())) ?? [];
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id) {
    return (await request(this.name, "templates", "readonly", (s) => s.get(id))) ?? null;
  }

  async put(t) {
    await withTimeout(request(this.name, "templates", "readwrite", (s) => s.put(t)), SAVE_TIMEOUT_MS, "saving the template timed out");
  }

  async delete(id) {
    await request(this.name, "templates", "readwrite", (s) => s.delete(id));
  }
}

/** Small per-browser settings: {key, value}. */
export class IdbSettings {
  constructor(name) {
    this.name = name;
  }

  async get(key) {
    return (await request(this.name, "settings", "readonly", (s) => s.get(key)))?.value;
  }

  async set(key, value) {
    await request(this.name, "settings", "readwrite", (s) => s.put({ key, value }));
  }

  async all() {
    return (await request(this.name, "settings", "readonly", (s) => s.getAll())) ?? [];
  }
}

/**
 * The stores for this page: the demo pedal's database for ?demo, the real
 * pedal's otherwise. Called once, at start-up.
 * @param {{demo: boolean}} o
 */
export function librarianStores({ demo }) {
  const pedalKind = demo ? "demo" : "real";
  const name = DB_NAMES[pedalKind];
  return {
    pedalKind, dbName: name, journal: new IdbJournal(name, pedalKind), operations: new IdbOperationStore(name, pedalKind),
    templates: new IdbTemplateStore(name), settings: new IdbSettings(name),
  };
}
