// The before-image file gate (O1, approved 2026-10-17): mandatory before-image
// saving fails closed. A pedal write may go ahead only when the before-image
// file was saved through the save dialog AND confirmed on disk: read back,
// with the size and SHA-256 of exactly the bytes we meant to save. A download
// that cannot be confirmed, a cancelled or failed save, or a confirmation for
// different bytes all keep the gate shut. There is no "write anyway".
// (The IndexedDB journal in copy.js stays the second, independent gate.)
//
// SPDX-License-Identifier: GPL-3.0-only

import { sha256Hex } from "./sha256.js";

/**
 * @param {{status: string, bytes?: number, sha256?: string}|null|undefined} saved a saveFile() result
 * @param {Uint8Array} bytes the before-image file's bytes
 * @returns {boolean} true only for a confirmed save of exactly these bytes
 */
export function beforeImageVerified(saved, bytes) {
  return !!saved && saved.status === "confirmed" && saved.bytes === bytes.length &&
    typeof saved.sha256 === "string" && saved.sha256 === sha256Hex(bytes);
}
