// Automatic before-image saving into a folder the user chose once (0.7.1, approved 2026-11-02).
//
// The folder's handle is kept in the settings store; a write saves its before-image ZIP there
// without a save dialog. The bytes go through saveFile() unchanged (write, read back, size and
// SHA-256, the same automatic retries), so the result passes the same fail-closed gate
// (beforeImageVerified) as a dialog save. Anything short of a confirmed save returns "failed"
// and the caller falls back to the save dialog. An existing file is never overwritten: a free
// name is found first, and only a file this attempt created is removed after a failure.
// No DOM code, so it is tested in Node with a fake folder.
//
// SPDX-License-Identifier: GPL-3.0-only

import { saveFile } from "./save-file.js";

/** Settings-store key of the folder handle. Left out of Full Librarian backups. */
export const FOLDER_KEY = "beforeImageFolder";
/** The folder dialog's id: Chrome opens it where it was last used. */
export const FOLDER_DIALOG_ID = "gp200-librarian-backup-folder";

const RW = { mode: "readwrite" };

/** "granted", "prompt", "denied", or "unavailable" when the handle cannot be asked. */
export async function folderPermission(dir) {
  try {
    return await dir.queryPermission(RW);
  } catch {
    return "unavailable";
  }
}

/**
 * Ask for write access again (Chrome may offer "Allow on every visit"). Needs a user click.
 * @returns {Promise<string>} the permission afterwards
 */
export async function renewPermission(dir) {
  try {
    return await dir.requestPermission(RW);
  } catch {
    return "unavailable";
  }
}

/**
 * What the write preview says about the before-image, so the user knows before confirming whether a
 * Save dialog will come. `dir` is the chosen folder or null; `permission` is folderPermission(dir).
 */
export function beforeImageDestination(dir, permission) {
  if (!dir) return "Before-image: a Save dialog opens after you confirm. Nothing is written until the file is saved.";
  if (permission === "granted") return `Before-image: saved automatically to the folder ${dir.name}, with no Save dialog. Confirming starts the write.`;
  return `Before-image: saved to the folder ${dir.name} if the browser allows it; otherwise a Save dialog opens. Nothing is written until the file is saved.`;
}

async function exists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    if (e?.name === "NotFoundError") return false;
    throw e; // a missing folder, no permission, ...: not a free name
  }
}

/** `name`, or `name_2.zip`, `name_3.zip`, ... the first that is not in the folder. */
export async function freeName(dir, name, max = 99) {
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; n <= max; n++) {
    const candidate = n === 1 ? name : `${base}_${n}${ext}`;
    if (!(await exists(dir, candidate))) return candidate;
  }
  throw new Error(`no free file name for ${name} in the folder`);
}

/**
 * Save `bytes` into the folder and confirm it on disk.
 * @param {FileSystemDirectoryHandle} dir
 * @param {{renew?: boolean}} opts renew: ask for permission if it must be renewed (only right after a click)
 * @returns {Promise<import("./save-file.js").SaveResult & {folder: string}>} "confirmed" (method "folder") or "failed"
 */
export async function saveToFolder(dir, bytes, fileName, { description, mime, ext, renew = true, onAttemptFailed, retryDelaysMs, sleep } = {}) {
  const folder = dir?.name ?? "(unknown folder)";
  const fail = (step, e) => ({ status: "failed", method: "folder", folder, step, errorName: e?.name ?? null,
    error: `the backup folder "${folder}" could not be used at the ${step} step${e?.name ? ` (${e.name})` : ""}: ${e?.message ?? e}` });
  let p = await folderPermission(dir);
  if (p === "prompt" && renew) p = await renewPermission(dir);
  if (p !== "granted") return fail("permission", { name: null, message: `write permission is "${p}"` });
  let name, handle;
  try {
    name = await freeName(dir, fileName);
    handle = await dir.getFileHandle(name, { create: true });
  } catch (e) {
    return fail("create", e);
  }
  const r = await saveFile(bytes, name, {
    description, mime, ext, picker: async () => handle, onAttemptFailed, retryDelaysMs, sleep,
    fallback: () => { throw new Error("unreachable: a picker is given"); },
  });
  if (r.status === "confirmed") return { ...r, method: "folder", folder };
  // The name was free, so this file is ours and holds no verified copy: remove it. Nothing else is touched.
  let cleanup = "";
  try {
    await dir.removeEntry(name);
  } catch (e) {
    cleanup = `; the incomplete file ${name} could not be removed (${e?.name ?? "Error"})`;
  }
  return { ...r, method: "folder", folder, error: `${r.error ?? "not saved"}${cleanup}` };
}

/** One line for the status and the log. */
export const describeFolderSave = (what, r) => r.status === "confirmed"
  ? `${what} saved and verified: ${r.folder}\\${r.name}, ${r.bytes.toLocaleString("en-US")} bytes (read back, SHA-256 matches)`
  : `${what}: automatic save failed (${r.error}); using the save dialog`;
