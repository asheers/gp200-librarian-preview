// Talking to the pedal over a MIDI input/output pair.
//
// Transport-agnostic: `input` needs an `onmidimessage` property and `output`
// a `send(Uint8Array)` method -- real Web MIDI ports in the browser, or the
// fake pedal in tests and demo mode. The output is ALWAYS wrapped in the
// write guard here (write-guard.js), whatever it is given: reads of any slot,
// but uploads and preset changes only inside a permitted write, for the slots
// of the operation the user confirmed (any of the 256 since 0.6.0).
//
// Active slot (Phase 3 S0): recorded, never inferred. It is "unknown" at
// connect (the identity reply carries no slot). It becomes known when this
// app sends a preset change, and when the pedal sends its unsolicited preset
// change echo. On the user's GP-200 (W1 log, 2026-10-07) that echo is byte
// for byte the same 30-byte frame as our own preset change, for our changes
// and for a footswitch press alike, so presetChangeSlot() recognises it
// exactly. Anything else (the after-upload 12 08 notice, the 46-byte 12 10
// state message) is not a slot change. Tracking sends nothing.
//
// Connect sends only the identity query. "Enter editor mode" is sent only
// when the first write of a connection is about to happen (reads work
// without it; uploads are silently discarded without it).
//
// writeImage() is one upload with the CLI's conservative pacing (donpark's
// gp200.py write_slot @ c3fe41f): park on the neighbouring slot, upload with
// 40 ms between chunks, settle 1 s, preset change to the written slot, 300 ms.
// It does not verify: the caller (copy.js) reads back and compares.
//
// Adapted from GP-200 Patch Manager Web (donpark2000, src/core/device.js
// @ ff618e7, GPL-3.0): the request/response collector, read retry, dump
// sanity checks, and the write pacing (CLI_WRITE_TIMING, sendUpload,
// selectSlot). See docs/ATTRIBUTION.md.
//
// SPDX-License-Identifier: GPL-3.0-only

import {
  assembleChunks,
  buildEnterEditorMode,
  buildIdentityQuery,
  buildPresetChange,
  buildReadRequest,
  buildUploadChunks,
  chunkOffset,
  chunkPayload,
  CMD_RESPONSE,
  describeMessage,
  DUMP_CHUNK_COUNT,
  isSysex,
  presetChangeSlot,
  readRequestSlot,
  sameBytes,
  SUB_DUMP_CHUNK,
  SUB_IDENTITY_REPLY,
  toHex,
  UPLOAD_HEADER_SLOT_INDICES,
} from "./sysex.js";
import { MIN_DUMP_LEN } from "./patch.js";
import { guardedOutput } from "./write-guard.js";
import { slotToDisplayLabel } from "./slots.js";

const IDENTITY_QUERY = buildIdentityQuery();

export const READ_TIMEOUT_MS = 2000;
export const READ_ATTEMPTS = 3;
export const IDENTITY_TIMEOUT_MS = 1000;

/**
 * Settling after a timeout (H-S3.0 HS-3, 2026-10-18; approved fix). Read
 * chunks do not say which slot they belong to, and after a timeout the pedal
 * may still answer the abandoned request. In HS-3 a late chunk of 1-A (whose
 * first attempt timed out) was taken into the next read, 1-B, as its chunk 2.
 * So after a request times out, nothing new is sent until the input has been
 * quiet for `quietMs`: every reply that arrives meanwhile is discarded (and
 * restarts the quiet time), up to `maxMs`. This happens before the retry AND
 * once more after the recovered read, before the next request, because late
 * replies can trail behind a successful retry. It cannot bound how late the
 * pedal may answer (see docs/H_S3_0_CHECK.md, HS-3 finding).
 */
export const READ_SETTLE = Object.freeze({ quietMs: 500, maxMs: 5000 });

/**
 * The CLI's write pacing (donpark gp200.py write_slot; Web CLI_WRITE_TIMING):
 * 40 ms between chunks, 1 s settle, preset change, 300 ms. Proven to keep
 * every byte, the pedal-managed ones included. editorModeMs is the pause
 * donpark's connect() leaves after "enter editor mode".
 */
export const CLI_WRITE_TIMING = Object.freeze({ chunkGapMs: 40, settleMs: 1000, presetChangeMs: 300, editorModeMs: 100 });

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** A write the device refused before sending anything (bad image address, no editor mode). */
export class WriteRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "WriteRefused";
  }
}

export class ReadError extends Error {
  constructor(slot, reason) {
    super(`couldn't read ${slotToDisplayLabel(slot)}: ${reason}`);
    this.name = "ReadError";
    this.slot = slot;
    this.reason = reason;
  }
}

/** Sanity checks on one complete read. Returns a list of problems (empty = OK). */
export function checkDump(chunks, decoded) {
  const problems = [];
  for (const msg of chunks) {
    const payload = chunkPayload(msg);
    const at = `chunk at offset ${chunkOffset(msg)}`;
    if (msg[msg.length - 1] !== 0xf7) problems.push(`${at} has no closing F7`);
    if (payload.length % 2 !== 0) problems.push(`${at} has an odd payload length (${payload.length})`);
    const bad = payload.findIndex((b) => b > 0x0f);
    if (bad !== -1) problems.push(`${at} has a non-nibble byte 0x${payload[bad].toString(16)} at +${bad}`);
  }
  if (decoded.length < MIN_DUMP_LEN) {
    problems.push(`dump is only ${decoded.length} bytes (need at least ${MIN_DUMP_LEN})`);
  }
  return problems;
}

export class GP200 {
  /**
   * @param {object} opts
   * @param {{onmidimessage: any}} opts.input
   * @param {{send: (data: Uint8Array) => void}} opts.output wrapped in the write guard
   * @param {import("./log.js").Logger} opts.log
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.attempts]
   * @param {typeof CLI_WRITE_TIMING} [opts.timing] write pacing (tests pass zeros)
   * @param {(active: ActiveSlot) => void} [opts.onActiveSlot] called when the known active slot changes
   * @param {{quietMs: number, maxMs: number}} [opts.settle] settling after a timeout (READ_SETTLE; tests pass small values)
   * @typedef {{slot: number, how: "sent"|"echo", external: boolean, at: number}} ActiveSlot
   */
  constructor({
    input, output, log, timeoutMs = READ_TIMEOUT_MS, attempts = READ_ATTEMPTS, timing = CLI_WRITE_TIMING, onActiveSlot = () => {},
    settle = READ_SETTLE,
  }) {
    this.input = input;
    this.output = guardedOutput(output, { onRefused: (e) => log.error(e.message) });
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.attempts = attempts;
    this.timing = timing;
    this.editorMode = false; // sent "enter editor mode" on this connection
    this.identityReply = null;
    /** @type {ActiveSlot|null} null = unknown */
    this.activeSlot = null;
    this.lastSentPreset = null; // the slot of the last preset change this app sent
    this.externalPresetChanges = 0; // echoes naming a slot this app did not just select
    this.onActiveSlot = onActiveSlot;
    this._waiter = null;
    this.settle = settle;
    /** "none" | "pending" (a request timed out) | "after-recovery" (the request after a settle succeeded) */
    this._settleState = "none";
    this._quarantine = null; // while settling: {last, discarded}
    this.lateDiscarded = 0; // replies discarded while settling, this connection
    this.input.onmidimessage = (e) => this._onMessage(e.data);
  }

  close() {
    this.output.revokePermit(); // a disconnect ends any write permit
    this.input.onmidimessage = null;
    if (this._waiter) this._finish(this._waiter);
  }

  /** Identity query only (connect never sends editor mode). The reply is logged whole. */
  async connect() {
    const reply = await this._request(buildIdentityQuery(), SUB_IDENTITY_REPLY, 1, IDENTITY_TIMEOUT_MS);
    if (reply.length) {
      this.identityReply = reply[0];
      this.log.info(`Pedal answered the identity query: ${toHex(reply[0])}`, { keep: true });
    } else {
      this.log.warn("No identity reply within the timeout; continuing anyway (reads don't need it)");
    }
    return this.identityReply;
  }

  /**
   * Read one slot's full dump, retrying a timed-out or malformed read.
   * @returns {Promise<{decoded: Uint8Array, chunks: Uint8Array[], attempt: number, ms: number}>}
   * @throws {ReadError} after `attempts` failed tries
   */
  async readDump(slot) {
    const label = slotToDisplayLabel(slot);
    let reason = "";
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const r = await this.readOnce(slot);
      if (r.ok) {
        this.log.debug(`${label}: read OK on attempt ${attempt}, ${r.decoded.length} bytes in ${r.ms.toFixed(0)} ms`);
        return { decoded: r.decoded, chunks: r.chunks, attempt, ms: r.ms };
      }
      reason = r.reason;
      this.log.warn(`${label}: read attempt ${attempt} of ${this.attempts} ${reason}`);
    }
    throw new ReadError(slot, reason);
  }

  /** One read attempt, no retries. */
  async readOnce(slot, timeoutMs = this.timeoutMs) {
    const started = performance.now();
    const chunks = await this._request(buildReadRequest(slot), SUB_DUMP_CHUNK, DUMP_CHUNK_COUNT, timeoutMs);
    const ms = performance.now() - started;
    if (chunks.conflict !== undefined) {
      return { ok: false, reason: `received two different chunks for offset ${chunks.conflict} (a late reply from another request?)`, ms };
    }
    if (chunks.length < DUMP_CHUNK_COUNT) {
      return { ok: false, reason: `timed out with ${chunks.length} of ${DUMP_CHUNK_COUNT} chunks`, ms };
    }
    const decoded = assembleChunks(chunks);
    const problems = checkDump(chunks, decoded);
    if (problems.length) return { ok: false, reason: `failed sanity check: ${problems.join("; ")}`, ms };
    return { ok: true, decoded, chunks, ms };
  }

  // ---- write primitives (permitted slots only: the guard refuses anything else) ----

  /** Send "enter editor mode" once per connection, then pause. */
  async enterEditorMode() {
    if (this.editorMode) return;
    this.log.info("Sending \"enter editor mode\" (needed before the pedal accepts a write)");
    this._send(buildEnterEditorMode());
    this.editorMode = true;
    await sleep(this.timing.editorModeMs);
  }

  /** Preset change to `slot`, then `presetChangeMs`. Changes the patch the player is using. */
  async selectSlot(slot) {
    this.log.info(`Preset change to ${slotToDisplayLabel(slot)}`);
    this._send(buildPresetChange(slot));
    this.lastSentPreset = slot;
    this._setActive({ slot, how: "sent", external: false });
    await sleep(this.timing.presetChangeMs);
  }

  /**
   * Start the guard's per-plan permit for exactly these slots (S3.1). The
   * returned handle is the only way to write; end() revokes it.
   */
  beginPermit(slots) {
    return this.output.beginPermit(slots);
  }

  /** Start the guard's capture permit for exactly these slots (capture.js); end() revokes it. */
  beginCapture(slots) {
    return this.output.beginCapture(slots);
  }

  /**
   * Upload one 1184-byte image (built by copy.js) to `slot` with the CLI's
   * pacing: park on slot^1 (writing the active slot may be a no-op; slot^1
   * stays in the same bank),
   * upload, settle, preset change to `slot`. No verification here.
   * Needs the active permit covering `slot` (guard, D-P1). A guard or device
   * refusal (WriteGuardViolation, WriteRefused) means no upload was sent; any
   * failure once the upload has been sent is a plain Error (state unknown).
   * @param {{permit?: {slots: readonly number[], end: () => void}}} [o]
   * @returns {Promise<{uploadMs: number, totalMs: number}>}
   */
  async writeImage(slot, image, { permit } = {}) {
    if (!this.editorMode) throw new WriteRefused("write attempted before \"enter editor mode\" was sent; nothing was sent");
    const label = slotToDisplayLabel(slot);
    // The image must be addressed to `slot` (both inner-header bytes) before anything is sent.
    if (image?.[UPLOAD_HEADER_SLOT_INDICES[0]] !== slot || image?.[UPLOAD_HEADER_SLOT_INDICES[1]] !== slot) {
      throw new WriteRefused(`the upload image is not addressed to ${label}; nothing was sent`);
    }
    this.output.beginWrite(permit, slot); // refused unless the active permit covers `slot`; sends nothing
    let uploaded = false;
    try {
      const t0 = performance.now();
      await this.selectSlot(slot ^ 1); // park
      const chunks = buildUploadChunks(image);
      this.log.info(`Uploading to ${label}: ${chunks.length} chunks, ${this.timing.chunkGapMs} ms apart`);
      const t1 = performance.now();
      const sentTo = await this.output.sendUpload(chunks, { gapMs: this.timing.chunkGapMs });
      uploaded = true;
      const uploadMs = performance.now() - t1;
      // Write audit: kept in the log's protected tier, debug on or off. Logged once actually sent.
      for (const c of chunks) this.log.midi("->", c, { audit: true, note: `upload chunk to ${label}` });
      if (sentTo !== slot) throw new Error(`upload went to ${slotToDisplayLabel(sentTo)}, expected ${label}`);
      await sleep(this.timing.settleMs);
      await this.selectSlot(slot);
      return { uploadMs, totalMs: performance.now() - t0 };
    } catch (e) {
      // After the upload, nothing may be reported as "refused before sending".
      if (uploaded) throw new Error(`after the upload to ${label}: ${e.message}`);
      throw e;
    } finally {
      this.output.endWrite();
    }
  }

  /** Send one message through the guard. Anything but a read or the identity query is write audit. */
  _send(msg) {
    this.output.send(msg);
    const audit = readRequestSlot(msg) === null && !sameBytes(msg, IDENTITY_QUERY);
    this.log.midi("->", msg, { audit });
  }

  /** Send `msg`, then collect `want` distinct-offset replies with the given
   *  sub-command. Resolves with whatever arrived when complete or timed out. */
  async _request(msg, sub, want, timeoutMs = this.timeoutMs) {
    if (this._waiter || this._quarantine) throw new Error("another request is already in progress");
    let afterSettle = false;
    if (this._settleState !== "none") {
      afterSettle = this._settleState === "pending";
      this._settleState = "none";
      await this._settle();
    }
    return new Promise((resolve, reject) => {
      const w = { sub, want, chunks: [], offsets: new Set(), other: 0, resolve, afterSettle };
      w.timer = setTimeout(() => {
        this.log.debug(`(timed out after ${timeoutMs} ms: ${w.chunks.length}/${want} matched, ${w.other} other message(s))`);
        this._settleState = "pending"; // the pedal may still answer: settle before anything else is sent
        this._finish(w);
      }, timeoutMs);
      this._waiter = w;
      try {
        this._send(msg);
      } catch (e) {
        clearTimeout(w.timer);
        this._waiter = null;
        reject(e);
      }
    });
  }

  _finish(w) {
    clearTimeout(w.timer);
    if (this._waiter === w) this._waiter = null;
    // A request that followed a settle and succeeded: late replies to the timed-out request can still
    // trail behind it, so settle once more before the next request.
    if (w.afterSettle && w.chunks.length === w.want && w.conflict === undefined && this._settleState === "none") this._settleState = "after-recovery";
    if (w.conflict !== undefined) w.chunks.conflict = w.conflict;
    w.resolve(w.chunks);
  }

  /** Discard every reply until the input has been quiet for settle.quietMs (at most settle.maxMs). */
  _settle() {
    const { quietMs, maxMs } = this.settle;
    if (!(quietMs > 0)) return Promise.resolve();
    const started = performance.now();
    const q = { last: started, discarded: 0 };
    this._quarantine = q;
    return new Promise((resolve) => {
      const tick = () => {
        const now = performance.now();
        if (now - q.last >= quietMs || now - started >= maxMs) {
          this._quarantine = null;
          this.lateDiscarded += q.discarded;
          const ms = Math.round(now - started);
          if (now - started >= maxMs && now - q.last < quietMs) {
            this.log.warn(`Late replies were still arriving after ${ms} ms of settling (${q.discarded} discarded); continuing`);
          } else if (q.discarded) {
            this.log.warn(`Settled after a timeout: ${q.discarded} late repl${q.discarded === 1 ? "y" : "ies"} discarded in ${ms} ms`);
          } else {
            this.log.debug(`(settled after a timeout: nothing late arrived in ${ms} ms)`);
          }
          resolve();
          return;
        }
        setTimeout(tick, Math.max(1, Math.min(quietMs - (now - q.last), maxMs - (now - started))));
      };
      setTimeout(tick, quietMs);
    });
  }

  _setActive(a) {
    const prev = this.activeSlot;
    this.activeSlot = { ...a, at: performance.now() };
    if (!prev || prev.slot !== a.slot || prev.how !== a.how) this.onActiveSlot(this.activeSlot);
  }

  /** The pedal's preset change echo: record the slot it names. */
  _onPresetEcho(slot) {
    const external = slot !== this.lastSentPreset;
    // A later echo of a different slot means the player changed patch on the pedal.
    this.lastSentPreset = null;
    if (external) {
      this.externalPresetChanges++;
      this.log.info(`The pedal reports it is now on ${slotToDisplayLabel(slot)} (changed on the pedal, not by this app)`, { keep: true });
    } else {
      this.log.debug(`The pedal confirmed the preset change to ${slotToDisplayLabel(slot)}`);
    }
    this._setActive({ slot, how: "echo", external });
  }

  _onMessage(data) {
    const msg = data instanceof Uint8Array ? data : Uint8Array.from(data);
    if (msg.length === 0) return;
    const echo = presetChangeSlot(msg);
    if (echo !== null) this._onPresetEcho(echo);
    if (msg[0] !== 0xf0) {
      this.log.midi("<-", msg, { note: "non-sysex" });
      return;
    }
    if (msg[msg.length - 1] !== 0xf7) {
      // Web MIDI should deliver each SysEx message whole; this is a tripwire.
      this.log.warn(`<- SysEx message without a closing F7 (${msg.length} bytes): ${describeMessage(msg)}`);
    }
    const q = this._quarantine;
    if (q) {
      // Settling after a timeout: whatever arrives now belongs to an abandoned request. Discard it.
      q.discarded++;
      q.last = performance.now();
      this.log.midi("<-", msg, { note: "late reply while settling after a timeout -- discarded" });
      return;
    }
    const w = this._waiter;
    if (!w) {
      this.log.midi("<-", msg, { note: "unsolicited -- ignored" });
      return;
    }
    if (!(msg.length > 12 && isSysex(msg, CMD_RESPONSE, w.sub))) {
      w.other++;
      this.log.midi("<-", msg, { note: "not the reply we're waiting for" });
      return;
    }
    const off = chunkOffset(msg);
    if (w.offsets.has(off)) {
      const first = w.chunks.find((c) => chunkOffset(c) === off);
      if (first.length !== msg.length || first.some((b, i) => b !== msg[i])) {
        // Two DIFFERENT chunks for one position (HS-3 follow-up): one of them belongs to another request.
        // The attempt fails (readOnce retries it), after settling.
        this.log.warn(`<- two different chunks for offset ${off} in one read: the attempt is rejected (a late reply from another request?)`);
        w.conflict = off;
        this._settleState = "pending";
        this._finish(w);
        return;
      }
      this.log.midi("<-", msg, { note: `duplicate offset ${off} -- ignored` });
      return;
    }
    w.offsets.add(off);
    w.chunks.push(msg);
    if (this.log.debugEnabled) this.log.midi("<-", msg, { note: `MATCH ${w.chunks.length}/${w.want}` });
    if (w.chunks.length === w.want) this._finish(w);
  }
}

/** Pick the GP-200's ports: names containing both "gp" and "200". */
export function findGp200Ports(ports) {
  return [...ports].filter((p) => /gp/i.test(p.name ?? "") && /200/.test(p.name ?? ""));
}
