// Saving files the app can CONFIRM were written (approved 2026-10-08).
//
// In H0, Chrome accepted our downloads but never wrote them: the downloads
// stayed "in progress" with no target file until Chrome was shut down, and
// the app could not tell. Backups, logs and before-images are safety files,
// so where the browser has the File System Access API (Chrome, Edge) they
// are saved through its save dialog instead: the app writes the file itself,
// then reads it back from disk and checks its size and SHA-256 against what
// it meant to write. Only then is the save reported as confirmed. A close()
// that completes is never taken as proof on its own.
//
// Where the API is missing, the old download is used as a fallback and is
// reported as "started, cannot be confirmed", never as saved.
//
// A failure names the step (create, write, close, read-back, verify) and the
// error's name, in full. Seen twice in the user's Chrome 154 (O1, 2026-10-08
// and 2026-10-16): close() failed with InvalidStateError ("... the state had
// changed since it was read from disk"), leaving a 0-byte file; the next save
// worked. In Chromium that error is any failure of the final move of the swap
// file onto the target (docs/O1_SAVE_DIAGNOSTIC.md). So (O1 fix, approved
// 2026-10-17) a failed attempt is retried automatically on the SAME file, up
// to twice (after 0.5 s and 2 s), while the handle is still usable; every
// attempt is verified by reading back. The dialog has a stable id, so it
// opens in the folder last chosen.
//
// SPDX-License-Identifier: GPL-3.0-only

import { sha256Hex } from "../core/sha256.js";

/** The save dialog's id: Chrome remembers the last folder chosen for it (O1, Q3). */
export const SAVE_DIALOG_ID = "gp200-librarian-save";
/** Waits before the automatic retries (O1, approved 2026-10-17). */
export const RETRY_DELAYS_MS = [500, 2000];
/** Errors after which the handle cannot be written again: no automatic retry. */
const UNUSABLE_ERRORS = new Set(["NotAllowedError", "SecurityError", "NotFoundError", "TypeMismatchError"]);

/**
 * @typedef {{step: string, errorName: string|null, error: string}} SaveFailure
 * @typedef {{status: "confirmed", method: "picker", name: string, bytes: number, sha256: string, attempts: number, failures: SaveFailure[]}
 *   | {status: "cancelled", method: "picker"}
 *   | {status: "failed", method: "picker", error: string, step?: string, errorName?: string|null, name?: string,
 *      attempts?: number, failures?: SaveFailure[], unusable?: string|null}
 *   | {status: "unconfirmed", method: "download", name: string, bytes: number}} SaveResult
 */

/**
 * One attempt: write `bytes` to the handle, then read the file back and check it.
 * @returns {Promise<{ok: true, bytes: number, sha256: string} | ({ok: false} & SaveFailure)>}
 */
async function writeOnce(handle, bytes, expected) {
  const name = handle.name;
  let step = "create";
  try {
    const w = await handle.createWritable();
    step = "write";
    try {
      await w.write(bytes);
    } catch (e) {
      await w.abort?.().catch(() => {}); // release the temporary swap file
      throw e;
    }
    step = "close";
    await w.close(); // the file on disk is replaced only now
  } catch (e) {
    const errorName = e?.name ?? "Error";
    return {
      ok: false, step, errorName,
      error: `writing ${name} failed at the ${step} step (${errorName}): ${e?.message ?? e}. ` +
        `${name} may be left empty or incomplete on disk; it is not a valid copy`,
    };
  }
  let written;
  try {
    written = new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch (e) {
    return { ok: false, step: "read-back", errorName: e?.name ?? "Error",
      error: `${name} could not be read back to confirm it (${e?.name ?? "Error"}): ${e?.message ?? e}` };
  }
  if (written.length !== bytes.length) {
    return { ok: false, step: "verify", errorName: null, error: `${name} holds ${written.length} bytes, expected ${bytes.length}` };
  }
  const got = sha256Hex(written);
  if (got !== expected) return { ok: false, step: "verify", errorName: null, error: `${name} does not match what was written (SHA-256)` };
  return { ok: true, bytes: written.length, sha256: got };
}

/** Why the handle cannot take another attempt, or null if it can. */
async function unusableReason(handle, failure) {
  if (failure.errorName && UNUSABLE_ERRORS.has(failure.errorName)) return `${failure.errorName}: the file can no longer be written`;
  if (typeof handle.queryPermission !== "function") return null;
  try {
    const p = await handle.queryPermission({ mode: "readwrite" });
    return p === "granted" ? null : `write permission is "${p}"`;
  } catch (e) {
    return `the file handle cannot be queried (${e?.name ?? "Error"})`;
  }
}

/**
 * Save `bytes` as a file.
 * @param {Uint8Array} bytes
 * @param {string} suggestedName
 * @param {object} opts
 * @param {string} opts.description e.g. "GP200 Librarian backup"
 * @param {string} opts.mime e.g. "application/zip"
 * @param {string} opts.ext e.g. ".zip"
 * @param {(fileName: string, blob: Blob) => void} opts.fallback the old download
 * @param {Function|null} [opts.picker] window.showSaveFilePicker (injectable for tests)
 * @param {(a: SaveFailure & {name: string, attempt: number, of: number, retryInMs: number|null, unusable: string|null}) => void} [opts.onAttemptFailed]
 *   called after each failed attempt (for the log)
 * @param {number[]} [opts.retryDelaysMs] waits before each automatic retry
 * @param {(ms: number) => Promise<void>} [opts.sleep] injectable for tests
 * @returns {Promise<SaveResult>}
 */
export async function saveFile(bytes, suggestedName, {
  description, mime, ext, fallback, picker = globalThis.showSaveFilePicker ?? null,
  onAttemptFailed = () => {}, retryDelaysMs = RETRY_DELAYS_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (typeof picker !== "function") {
    fallback(suggestedName, new Blob([bytes], { type: mime }));
    return { status: "unconfirmed", method: "download", name: suggestedName, bytes: bytes.length };
  }
  let handle;
  try {
    handle = await picker({ id: SAVE_DIALOG_ID, suggestedName, startIn: "downloads", types: [{ description, accept: { [mime]: [ext] } }] });
  } catch (e) {
    if (e?.name === "AbortError") return { status: "cancelled", method: "picker" };
    return { status: "failed", method: "picker", error: `could not open the save dialog: ${e?.message ?? e}` };
  }
  const expected = sha256Hex(bytes);
  const of = retryDelaysMs.length + 1;
  /** @type {SaveFailure[]} */
  const failures = [];
  let unusable = null;
  for (let attempt = 1; ; attempt++) {
    const r = await writeOnce(handle, bytes, expected);
    if (r.ok) return { status: "confirmed", method: "picker", name: handle.name, bytes: r.bytes, sha256: r.sha256, attempts: attempt, failures };
    const failure = { step: r.step, errorName: r.errorName, error: r.error };
    failures.push(failure);
    const last = attempt >= of;
    unusable = last ? null : await unusableReason(handle, failure);
    const retryInMs = last || unusable ? null : retryDelaysMs[attempt - 1];
    onAttemptFailed({ ...failure, name: handle.name, attempt, of, retryInMs, unusable });
    if (retryInMs == null) break;
    await sleep(retryInMs);
    unusable = await unusableReason(handle, { errorName: null });
    if (unusable) {
      onAttemptFailed({ step: "retry", errorName: null, error: `not retried: ${unusable}`, name: handle.name, attempt, of, retryInMs: null, unusable });
      break;
    }
  }
  const final = failures.at(-1);
  return { status: "failed", method: "picker", ...final, name: handle.name, attempts: failures.length, failures, unusable };
}

/** One line for the status bar and the log. */
export function describeSave(what, r) {
  switch (r.status) {
    case "confirmed": return `${what} saved and confirmed: ${r.name}, ${r.bytes.toLocaleString("en-US")} bytes (read back, SHA-256 matches` +
      `${r.attempts > 1 ? `; after ${r.attempts - 1} automatic retr${r.attempts === 2 ? "y" : "ies"}` : ""})`;
    case "cancelled": return `${what} NOT saved: the save dialog was cancelled`;
    case "failed": return `${what} NOT saved: ${r.error}` +
      (r.attempts > 1 ? ` (${r.attempts} attempts${r.unusable ? `; stopped: ${r.unusable}` : ""})` : r.unusable ? ` (not retried: ${r.unusable})` : "");
    default: return `${what} download started: ${r.name}, ${r.bytes.toLocaleString("en-US")} bytes. ` +
      "This browser cannot confirm the file was written; check your downloads";
  }
}
