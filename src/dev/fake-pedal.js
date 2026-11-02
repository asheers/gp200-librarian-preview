// A simulated GP-200 for tests and the browser demo mode (?demo).
//
// Reads mirror the real pedal (donpark DEV_JOURNAL 2026-10-02, and our own
// hardware run 2026-10-07): 7 chunks `12 18 09 offLo offHi <nibbles> F7` at
// decoded offsets 0, 185, ... 1110, giving a 1176-byte dump. Replies arrive
// asynchronously, like Web MIDI.
//
// Writes behave like the real pedal as far as it is documented:
//   - "enter editor mode" (11 12) is required; without it a complete upload
//     is silently discarded (donpark PROTOCOL.md section 2);
//   - an upload is 7 chunks forming one image whose inner header names the
//     slot; the pedal stores dump bytes 6.. from the image, keeps the 0x28-
//     0x2D stamp, writes its own slot number into file 0x2E/0x34/0x90 and
//     stores 0x00 at the dead bytes 0x43/0x9F;
//   - a preset change (12 08) makes a slot active, and the pedal answers
//     with an unsolicited echo: the same 30-byte frame (W1 log, 2026-10-07);
//   - pressFootswitch(slot) simulates the player changing patch on the pedal
//     (the same echo, unprompted);
//   - after a stored upload, an unsolicited 30-byte 12 08 notice whose body
//     starts 00 00 00 01 00 02 (W1 log; meaning unconfirmed). It is not a
//     slot change.
// The fake pedal deliberately accepts writes to ANY slot, like the real one:
// keeping writes inside the scratch bank is the write guard's job, and tests
// use this to show the guard is what stops them.
//
// Fault injection for tests: `faults` (read replies), `liveNoise` (tail
// +6/+7 and dead-byte noise on every read, as seen on hardware), `onStore`
// (change or drop what an upload stores), `activeSlotWriteIsNoop` (GP200
// Studio's unconfirmed report), and `ignoreEditorMode`.
// Anything it does not understand is recorded in `unexpected`.
//
// Read-side structure follows GP-200 Patch Manager Web's
// tests/helpers/fake-pedal.js (donpark2000, @ ff618e7, GPL-3.0). The write
// side is our own. See docs/ATTRIBUTION.md.
//
// SPDX-License-Identifier: GPL-3.0-only

import {
  buildEnterEditorMode, buildIdentityQuery, chunkOffset, CMD_RESPONSE, HEADER, isSysex, parseUploadChunks, presetChangeSlot,
  readRequestSlot, sameBytes, SUB_DUMP_CHUNK, SUB_IDENTITY_REPLY, SUB_PRESET_CHANGE, SUB_UPLOAD_CHUNK, UPLOAD_CHUNK_COUNT, UPLOAD_CHUNK_RAW,
  UPLOAD_HEADER_LEN,
} from "../core/sysex.js";

const READ_CHUNK_RAW = 185;
const IDENTITY = buildIdentityQuery();
const EDITOR_MODE = buildEnterEditorMode();

export function nibbleEncode(data) {
  const out = new Uint8Array(data.length * 2);
  for (let i = 0; i < data.length; i++) {
    out[2 * i] = (data[i] >> 4) & 0x0f;
    out[2 * i + 1] = data[i] & 0x0f;
  }
  return out;
}

/** Small deterministic PRNG, so noisy tests are repeatable. */
function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

export class FakePedal {
  /**
   * @param {object} [opts]
   * @param {Map<number, Uint8Array>} [opts.dumps] slot -> 1176-byte dump
   * @param {Uint8Array} [opts.defaultDump]
   * @param {(slot: number, readNumber: number, chunks: Uint8Array[]) => Uint8Array[]|void} [opts.faults]
   * @param {boolean|number} [opts.liveNoise] true or a seed: tail +6/+7 change on every read; dead bytes sometimes noisy
   * @param {(slot: number, stored: Uint8Array, image: Uint8Array) => Uint8Array|null|void} [opts.onStore]
   *   may return a different dump to store, or null to discard the write silently
   * @param {boolean} [opts.activeSlotWriteIsNoop]
   * @param {boolean} [opts.ignoreEditorMode] accept uploads without editor mode
   * @param {boolean} [opts.answerIdentity]
   * @param {number} [opts.replyDelayMs]
   * @param {boolean} [opts.echoPresetChanges] send the unsolicited echo and after-upload notice (default true)
   */
  constructor({
    dumps = new Map(), defaultDump, faults = null, liveNoise = false, onStore = null, activeSlotWriteIsNoop = false,
    ignoreEditorMode = false, answerIdentity = true, replyDelayMs = 0, echoPresetChanges = true,
  } = {}) {
    this.echoPresetChanges = echoPresetChanges;
    this.dumps = dumps;
    this.defaultDump = defaultDump;
    this.faults = faults;
    this.noise = liveNoise ? prng(liveNoise === true ? 2026 : liveNoise) : null;
    this.onStore = onStore;
    this.activeSlotWriteIsNoop = activeSlotWriteIsNoop;
    this.ignoreEditorMode = ignoreEditorMode;
    this.answerIdentity = answerIdentity;
    this.replyDelayMs = replyDelayMs;
    this.editorMode = false;
    this.activeSlot = null;
    this.reads = new Map(); // slot -> number of read requests
    this.received = []; // every message received
    this.events = []; // {kind, slot?} in order: identity, read, editor-mode, preset-change, upload-stored, upload-discarded
    this.unexpected = []; // anything not understood
    this.pendingUpload = [];
    this.input = { onmidimessage: null };
    this.output = { send: (data) => this._receive(Uint8Array.from(data)) };
  }

  dumpOf(slot) {
    return this.dumps.get(slot) ?? this.defaultDump;
  }

  /** Slots whose stored dump was changed by an upload. */
  get writtenSlots() {
    return this.events.filter((e) => e.kind === "upload-stored").map((e) => e.slot);
  }

  // Always asynchronous, like Web MIDI: a microtask with no delay (fast tests), else a timer.
  _emit(msg) {
    const deliver = () => this.input.onmidimessage?.({ data: msg });
    if (this.replyDelayMs > 0) setTimeout(deliver, this.replyDelayMs);
    else queueMicrotask(deliver);
  }

  _receive(msg) {
    this.received.push(msg);
    const isUploadChunk = isSysex(msg, CMD_RESPONSE, SUB_UPLOAD_CHUNK);
    if (!isUploadChunk && this.pendingUpload.length) {
      this.unexpected.push(...this.pendingUpload); // an incomplete upload, interrupted
      this.pendingUpload = [];
    }
    if (sameBytes(msg, IDENTITY)) {
      this.events.push({ kind: "identity" });
      if (this.answerIdentity) this._emit(Uint8Array.from([...HEADER, CMD_RESPONSE, SUB_IDENTITY_REPLY, 0, 0, 0, 0, 0x01, 0x02, 0, 0, 0xf7]));
      return;
    }
    if (sameBytes(msg, EDITOR_MODE)) {
      this.events.push({ kind: "editor-mode" });
      this.editorMode = true;
      return;
    }
    const readSlot = readRequestSlot(msg);
    if (readSlot !== null) {
      this.events.push({ kind: "read", slot: readSlot });
      this._answerRead(readSlot);
      return;
    }
    const preset = presetChangeSlot(msg);
    if (preset !== null) {
      this.events.push({ kind: "preset-change", slot: preset });
      this.activeSlot = preset;
      if (this.echoPresetChanges) this._emit(Uint8Array.from(msg));
      return;
    }
    if (isUploadChunk) {
      this.pendingUpload.push(msg);
      if (chunkOffset(msg) === (UPLOAD_CHUNK_COUNT - 1) * UPLOAD_CHUNK_RAW) this._finishUpload();
      return;
    }
    this.unexpected.push(msg);
  }

  _answerRead(slot) {
    const n = (this.reads.get(slot) ?? 0) + 1;
    this.reads.set(slot, n);
    let dump = this.dumpOf(slot);
    if (this.noise) {
      dump = Uint8Array.from(dump);
      for (let q = 0; q < 8; q++) {
        dump[1120 - 0x28 + q * 12 + 6] = Math.floor(this.noise() * 256);
        dump[1120 - 0x28 + q * 12 + 7] = this.noise() < 0.5 ? 0x37 : 0xb7;
      }
      if (this.noise() < 0.15) dump[0x9f - 0x28] = 0xb7;
      if (this.noise() < 0.05) dump[0x43 - 0x28] = 0x37;
    }
    let chunks = FakePedal.dumpChunks(dump);
    if (this.faults) chunks = this.faults(slot, n, chunks) ?? chunks;
    for (const c of chunks) this._emit(c);
  }

  _finishUpload() {
    const chunks = this.pendingUpload;
    this.pendingUpload = [];
    const p = parseUploadChunks(chunks);
    if (!p.ok) {
      this.unexpected.push(...chunks);
      this.events.push({ kind: "upload-malformed", reason: p.reason });
      return;
    }
    const slot = p.slot;
    if (!this.editorMode && !this.ignoreEditorMode) {
      this.events.push({ kind: "upload-discarded", slot, reason: "not in editor mode" });
      return;
    }
    if (this.activeSlotWriteIsNoop && this.activeSlot === slot) {
      this.events.push({ kind: "upload-discarded", slot, reason: "active slot" });
      return;
    }
    const old = this.dumpOf(slot);
    let stored = Uint8Array.from(old);
    stored.set(p.image.subarray(UPLOAD_HEADER_LEN), 6); // dump bytes 6.. = file 0x2E..
    for (const off of [0x2e, 0x34, 0x90]) stored[off - 0x28] = slot; // the pedal's own slot fields
    for (const off of [0x43, 0x9f]) stored[off - 0x28] = 0; // dead bytes always store 0x00
    if (this.onStore) {
      const r = this.onStore(slot, stored, p.image);
      if (r === null) {
        this.events.push({ kind: "upload-discarded", slot, reason: "onStore" });
        return;
      }
      if (r) stored = r;
    }
    this.dumps.set(slot, stored);
    this.events.push({ kind: "upload-stored", slot });
    if (this.echoPresetChanges) this._emit(FakePedal.uploadNotice());
  }

  /** The player switches patch on the pedal: active slot changes, and the pedal sends its echo. */
  pressFootswitch(slot) {
    this.activeSlot = slot;
    this.events.push({ kind: "footswitch", slot });
    this._emit(FakePedal.presetEcho(slot));
  }

  /** The 30-byte preset change frame the pedal sends for `slot` (W1 log). */
  static presetEcho(slot) {
    return Uint8Array.from([...HEADER, CMD_RESPONSE, SUB_PRESET_CHANGE, 0, 0, 0, 0, 8, 1, 0, 0, 4, 0, 0, 0, 0, 0, 0,
      (slot >> 4) & 0x0f, slot & 0x0f, 0, 0, 0xf7]);
  }

  /** The unsolicited 30-byte notice seen about 0.5-0.9 s after each upload (W1 log). */
  static uploadNotice() {
    return Uint8Array.from([...HEADER, CMD_RESPONSE, SUB_PRESET_CHANGE, 0, 0, 0, 1, 0, 2, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xf7]);
  }

  /** Split a dump into cmd=0x12 sub=0x18 reply chunks, as the real pedal does. */
  static dumpChunks(dump) {
    const chunks = [];
    for (let off = 0; off < dump.length; off += READ_CHUNK_RAW) {
      const nib = nibbleEncode(dump.subarray(off, off + READ_CHUNK_RAW));
      chunks.push(Uint8Array.from([...HEADER, CMD_RESPONSE, SUB_DUMP_CHUNK, 0x09, off & 0x7f, (off >> 7) & 0x7f, ...nib, 0xf7]));
    }
    return chunks;
  }
}
