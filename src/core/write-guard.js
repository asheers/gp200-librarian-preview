// Phase 2 outgoing-message guard: the ONLY way any code in this app can send
// MIDI. It replaces Phase 1's read-only guard, deliberately and visibly.
//
// WRITABLE SLOTS. Phase 2 confined writes to the scratch bank 60 (2026-10-07).
// 0.6.0 (approved by Alan and Archie, 2026-11-01, after Slice A passed on
// hardware) widens the whitelist to all 256 slots, deliberately and visibly:
// WRITABLE_SLOTS below is the whole whitelist. It is not configurable at run
// time, and nothing in the UI can change it: changing it means editing this
// file, which tests/write-guard.test.js pins. What one operation may write is
// narrowed by the per-plan permit below: only the slots of the plan the user
// confirmed. SCRATCH_SLOTS (bank 60) remains only as the Test tools' bank
// (copy.js), never as the guard's whitelist.
//
// Allowed, each checked byte for byte against our own builders in sysex.js:
//   identity query                    any time
//   read request                      any slot 0-255 (reads change nothing)
//   enter editor mode                 needed before the pedal accepts uploads
//   preset change                     only inside a permitted write (below)
//   flash upload                      only inside a permitted write, and only
//                                     through sendUpload(): exactly one
//                                     complete 7-chunk image whose three slot
//                                     fields (inner header x2, file 0x2E) all
//                                     name the same slot
// Refused with WriteGuardViolation, before anything reaches the port:
// everything else, including any upload chunk sent on its own, a second
// image in one call (bulk), Studio's native patch move (its frame shares
// the preset change's 12 08 command bytes) and move commit, save-commit,
// live parameter edits, name/author writes, program and control changes,
// and anything sent while an upload is in progress.
//
// THE PER-PLAN PERMIT (S3.1, approved 2026-10-18: D-P1 ... D-P3;
// docs/S3_1_GUARD_PERMIT_PROPOSAL.md). It only NARROWS the whitelist above:
//   beginPermit(slots)     the slots one operation may write. Refused if any
//                          is outside WRITABLE_SLOTS, the list is empty or
//                          repeats a slot, or a permit is already active (no
//                          nesting). Returns a private handle; end() revokes it.
//   beginWrite(handle, s)  one write to s, which must be in the permit, under
//                          the active handle (no other code can use it).
//                          The write must then follow the CLI pacing exactly:
//                            preset change to s ^ 1 (the park; D-P2: only as
//                            the first message of this write), upload to s,
//                            preset change to s;
//                          anything else is refused.
//   endWrite()             ends the write; ending it before its last preset
//                          change revokes the permit.
// Uploads and preset changes with no active permit and write are refused
// (D-P1). The permit is revoked by end(), revokePermit() (the device calls it
// on disconnect), any refused message, an upload that breaks off, or a write
// ended part-way. Identity, reads and editor mode are unchanged.
//
// SPDX-License-Identifier: GPL-3.0-only

import { labelToSlot, slotToDisplayLabel } from "./slots.js";
import {
  buildEnterEditorMode, buildIdentityQuery, parseUploadChunks, presetChangeSlot, readRequestSlot, sameBytes, toHex,
  UPLOAD_CONTENT_FILE_START, UPLOAD_HEADER_LEN,
} from "./sysex.js";

/** The ONLY slots any write or preset change may target: all 256 (0.6.0). Each operation's permit narrows it. */
export const WRITABLE_SLOTS = Object.freeze(Array.from({ length: 256 }, (_, i) => i));
const WRITABLE = new Set(WRITABLE_SLOTS);

export function isWritableSlot(slot) {
  return WRITABLE.has(slot);
}

/** The Test tools' bank (copy.js; D2, 2026-11-01): 60-A..60-D. Not the guard's whitelist. */
export const SCRATCH_LABELS = Object.freeze(["60A", "60B", "60C", "60D"]);
export const SCRATCH_SLOTS = Object.freeze(SCRATCH_LABELS.map(labelToSlot));
const SCRATCH = new Set(SCRATCH_SLOTS);

export function isScratchSlot(slot) {
  return SCRATCH.has(slot);
}

/** Image index of file offset 0x2E (the slot-mirror byte the upload carries). */
const IMAGE_SLOT_MIRROR_2E = UPLOAD_HEADER_LEN + (0x2e - UPLOAD_CONTENT_FILE_START);
/** Image indices of file 0x34 and 0x90, which the protocol sends as 0xFF. */
const IMAGE_FF_INDICES = [UPLOAD_HEADER_LEN + (0x34 - UPLOAD_CONTENT_FILE_START), UPLOAD_HEADER_LEN + (0x90 - UPLOAD_CONTENT_FILE_START)];

export class WriteGuardViolation extends Error {
  constructor(what, msg) {
    const bytes = msg instanceof Uint8Array ? msg : new Uint8Array(0);
    super(`WRITE GUARD: refused ${what}` + (bytes.length
      ? ` (${bytes.length} byte(s): ${toHex(bytes.subarray(0, 24))}${bytes.length > 24 ? " ..." : ""})` : "") +
      ". Only the slots of a confirmed operation, one permitted write at a time, can be written.");
    this.name = "WriteGuardViolation";
  }
}

const IDENTITY = buildIdentityQuery();
const EDITOR_MODE = buildEnterEditorMode();

/**
 * Classify a single outgoing message. Upload chunks are never allowed on
 * their own (use checkUpload on a complete batch).
 * @returns {{kind: "identity"|"read"|"editor-mode"|"preset-change", slot?: number} | {kind: null, reason: string}}
 */
export function classifyOutgoing(msg) {
  if (!(msg instanceof Uint8Array)) return { kind: null, reason: "not a byte array" };
  if (sameBytes(msg, IDENTITY)) return { kind: "identity" };
  if (sameBytes(msg, EDITOR_MODE)) return { kind: "editor-mode" };
  const read = readRequestSlot(msg);
  if (read !== null) return { kind: "read", slot: read };
  const preset = presetChangeSlot(msg);
  if (preset !== null) {
    return isWritableSlot(preset) ? { kind: "preset-change", slot: preset }
      : { kind: null, reason: `a preset change to ${slotToDisplayLabel(preset)}, which is not a writable slot` };
  }
  return { kind: null, reason: "a message that is not on the allow-list" };
}

/**
 * Check a complete upload batch. Allowed only if it parses as exactly one
 * well-formed image (sysex.js parseUploadChunks), its inner header names a
 * writable slot, file 0x2E carries that same slot, and file 0x34/0x90 are 0xFF.
 * @returns {{ok: true, slot: number, image: Uint8Array} | {ok: false, reason: string}}
 */
export function checkUpload(chunks) {
  const p = parseUploadChunks(chunks);
  if (!p.ok) return { ok: false, reason: `a malformed upload: ${p.reason}` };
  if (!isWritableSlot(p.slot)) return { ok: false, reason: `an upload to ${slotToDisplayLabel(p.slot)}, which is not a writable slot` };
  if (p.image[IMAGE_SLOT_MIRROR_2E] !== p.slot) {
    return { ok: false, reason: `an upload whose file 0x2E (0x${p.image[IMAGE_SLOT_MIRROR_2E].toString(16)}) does not name its target slot` };
  }
  if (IMAGE_FF_INDICES.some((i) => p.image[i] !== 0xff)) return { ok: false, reason: "an upload whose file 0x34/0x90 are not 0xFF" };
  return { ok: true, slot: p.slot, image: p.image };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GUARDED = new WeakSet();
const isSlotNumber = (s) => Number.isInteger(s) && s >= 0 && s <= 255;
const slotText = (s) => (isSlotNumber(s) ? slotToDisplayLabel(s) : String(s));

/**
 * Wrap a MIDI output (anything with `send(Uint8Array)`) so that only allowed
 * messages ever reach it. The port itself is not exposed. Wrapping an
 * already-guarded output returns it unchanged.
 * @param {{send: (data: Uint8Array) => void}} port
 * @param {{onRefused?: (e: WriteGuardViolation) => void, onSent?: (kind: string, slot?: number) => void}} [opts]
 */
export function guardedOutput(port, { onRefused = () => {}, onSent = () => {} } = {}) {
  if (GUARDED.has(port)) return port;
  let uploading = false;
  let permit = null; // the active permit handle
  let write = null; // the permitted write in progress: {slot, phase: "start" | "parked" | "uploaded" | "selected"}
  const revoke = () => {
    permit = null;
    write = null;
  };
  const violation = (what, msg) => {
    const e = new WriteGuardViolation(what, msg);
    onRefused(e);
    return e;
  };
  // A refused message revokes any permit (fail closed).
  const refuse = (what, msg) => {
    revoke();
    throw violation(what, msg);
  };
  const send = (data) => {
    const msg = data instanceof Uint8Array ? data : Uint8Array.from(data ?? []);
    if (uploading) refuse("a message sent while an upload was in progress", msg);
    const c = classifyOutgoing(msg);
    if (!c.kind) refuse(c.reason, msg);
    if (c.kind === "preset-change") {
      const here = slotToDisplayLabel(c.slot);
      if (!permit || !write) refuse(`a preset change to ${here} with no permitted write in progress`, msg);
      if (write.phase === "start" && c.slot === (write.slot ^ 1)) write.phase = "parked";
      else if (write.phase === "uploaded" && c.slot === write.slot) write.phase = "selected";
      else refuse(`a preset change to ${here} that the permitted write to ${slotToDisplayLabel(write.slot)} does not need now`, msg);
    }
    port.send(msg);
    onSent(c.kind, c.slot);
  };
  /**
   * Send one complete upload (7 chunks) to the slot of the permitted write in
   * progress, `gapMs` apart. Checked as a whole BEFORE the first chunk is sent.
   */
  const sendUpload = async (chunks, { gapMs = 0 } = {}) => {
    // Check and send private copies, so the caller can't change a chunk between the check and the send.
    const copies = Array.isArray(chunks) ? chunks.map((x) => (x instanceof Uint8Array ? Uint8Array.from(x) : x)) : chunks;
    const first = copies?.[0] instanceof Uint8Array ? copies[0] : undefined;
    if (uploading) refuse("a second upload while one was in progress", first);
    const c = checkUpload(copies);
    if (!c.ok) refuse(c.reason, first);
    const to = slotToDisplayLabel(c.slot);
    if (!permit || !write) refuse(`an upload to ${to} with no permitted write in progress`, first);
    if (c.slot !== write.slot) refuse(`an upload to ${to} during the permitted write to ${slotToDisplayLabel(write.slot)}`, first);
    if (write.phase !== "parked") refuse(`an upload to ${to} that does not follow the park on its neighbouring slot`, first);
    uploading = true;
    let complete = false;
    try {
      for (const chunk of copies) {
        port.send(chunk);
        if (gapMs > 0) await sleep(gapMs);
      }
      complete = true;
    } finally {
      uploading = false;
      if (complete && write) write.phase = "uploaded";
      else revoke(); // broken off part-way, or revoked meanwhile: the slot's state is unknown
    }
    onSent("upload", c.slot);
    return c.slot;
  };
  /**
   * Start a permit for exactly `slots` (each writable). Sends nothing.
   * @returns {{slots: readonly number[], end: () => void}} the handle; only its holder can write
   */
  const beginPermit = (slots) => {
    const list = Array.isArray(slots) ? [...slots] : null;
    if (!list || !list.length) throw violation("a permit for no slots");
    if (list.some((s) => !isSlotNumber(s))) throw violation(`a permit for something that is not a slot (${list.map(slotText).join(", ")})`);
    if (new Set(list).size !== list.length) throw violation("a permit that lists a slot twice");
    const outside = list.filter((s) => !isWritableSlot(s));
    if (outside.length) throw violation(`a permit for ${outside.map(slotToDisplayLabel).join(", ")}, which is not writable`);
    if (permit) throw violation("a second permit while one is active");
    const handle = Object.freeze({
      slots: Object.freeze(list),
      end: () => {
        if (permit === handle) revoke();
      },
    });
    permit = handle;
    return handle;
  };
  /** Start one write to `slot` under the active permit `handle`. Sends nothing. */
  const beginWrite = (handle, slot) => {
    if (!handle || handle !== permit) throw violation(`a write to ${slotText(slot)} without the active permit`);
    if (uploading || write) throw violation(`a write to ${slotText(slot)} while another write is in progress`);
    if (!handle.slots.includes(slot)) throw violation(`a write to ${slotText(slot)}, which this permit does not cover`);
    write = { slot, phase: "start" };
  };
  /** End the write in progress. Ending it before its last preset change revokes the permit. */
  const endWrite = () => {
    if (write && write.phase !== "selected") revoke();
    write = null;
  };
  const out = Object.freeze({
    send, sendUpload, beginPermit, beginWrite, endWrite,
    revokePermit: revoke,
    hasPermit: () => permit !== null,
    writableSlots: WRITABLE_SLOTS,
  });
  GUARDED.add(out);
  return out;
}
