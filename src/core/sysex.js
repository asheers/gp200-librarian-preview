// GP-200 SysEx message building and parsing.
//
// Phase 2 (scratch-bank copy + Undo). This is the ONLY module that builds
// outgoing messages, and it builds exactly five kinds: the identity query, the
// slot read request, "enter editor mode", the preset change and the
// flash-chunk upload. Building a message does not send it: every outgoing
// message passes through write-guard.js, which refuses any write, upload or
// preset change whose slot is not in the scratch bank (60-A..60-D).
//
// Adapted from GP-200 Patch Manager Web (donpark2000/GP-200-Patch-Manager-Web,
// src/core/sysex.js @ ff618e7, GPL-3.0), which ports the CLI's gp200.py.
// Credit there: the message formats were reverse-engineered by Kabir S.
// Tamari's GP200 Studio (github.com/kabir0st/gp200-studio, GPL-3.0) from USB
// captures of Valeton's own editor; the upload addressing (target slot in the
// 14-byte inner header, fixed outer byte 0x09) was found by donpark after
// Studio-style writes were silently discarded. See docs/ATTRIBUTION.md.
//
// SPDX-License-Identifier: GPL-3.0-only

export const HEADER = [0xf0, 0x21, 0x25, 0x7e, 0x47, 0x50, 0x2d, 0x32];

export const CMD_REQUEST = 0x11;
export const CMD_RESPONSE = 0x12;
export const SUB_IDENTITY_QUERY = 0x04;
export const SUB_READ_REQUEST = 0x10;
export const SUB_DUMP_CHUNK = 0x18; // reply to a read request
export const SUB_IDENTITY_REPLY = 0x08; // reply to the identity query
export const SUB_EDITOR_MODE = 0x12; // cmd 0x11: enter editor mode, no reply
export const SUB_PRESET_CHANGE = 0x08; // cmd 0x12: select the active preset
export const SUB_UPLOAD_CHUNK = 0x20; // cmd 0x12: one flash-upload chunk
export const UPLOAD_OUTER_BYTE = 0x09; // fixed; the slot is in the inner header

/** A full-dump read always arrives as 7 chunks (hardware-confirmed by donpark). */
export const DUMP_CHUNK_COUNT = 7;
/** Decoded length of a real dump: 7 chunks of 185 bytes, the last one 66 (donpark, firmware 1.8.0). */
export const EXPECTED_DUMP_LEN = 1176;
/** header(8) + cmd + sub + outer byte + 2 offset bytes */
export const CHUNK_PAYLOAD_START = 13;
export const READ_REQUEST_LEN = 46;
export const PRESET_CHANGE_LEN = 30;

/** Like the CLI: masks each nibble to 4 bits and ignores an odd trailing byte. */
export function nibbleDecode(data) {
  const out = new Uint8Array(Math.floor(data.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = ((data[2 * i] & 0x0f) << 4) | (data[2 * i + 1] & 0x0f);
  }
  return out;
}

/** Full-dump read request for one slot (0-255). The slot appears nibble-encoded three times. */
export function buildReadRequest(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 255) throw new RangeError(`slot ${slot} out of range 0-255`);
  const sh = (slot >> 4) & 0x0f;
  const sl = slot & 0x0f;
  return Uint8Array.from([
    ...HEADER,
    CMD_REQUEST, SUB_READ_REQUEST,
    0, 0, 0, 0, 0, 0, 0, 0,
    0x04, 0, 0, 0,
    0x01, 0,
    0,
    sh, sl,
    0, 0, 0,
    0x01, 0,
    0, 0,
    0x04, 0, 0,
    sh, sl,
    0, 0,
    sh, sl,
    0, 0,
    0xf7,
  ]);
}

/** Sent once at connect. Only the reply's arrival matters; it does not carry the firmware version. */
export function buildIdentityQuery() {
  return Uint8Array.from([...HEADER, CMD_REQUEST, SUB_IDENTITY_QUERY, 0, 0, 0, 0, 0x01, 0x02, 0, 0, 0, 0, 0, 0xf7]);
}

/**
 * "Enter editor mode". The pedal silently discards uploads unless this was
 * sent on the connection (donpark PROTOCOL.md section 2). Reads don't need it.
 */
export function buildEnterEditorMode() {
  return Uint8Array.from([...HEADER, CMD_REQUEST, SUB_EDITOR_MODE, 0, 0, 0, 0xf7]);
}

/**
 * Switch the pedal's active preset to `slot`. Sent after an upload, it loads
 * the freshly written flash copy (donpark: gp200.py write_slot). It CHANGES
 * THE PATCH THE PLAYER IS USING.
 */
export function buildPresetChange(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 255) throw new RangeError(`slot ${slot} out of range 0-255`);
  return Uint8Array.from([
    ...HEADER,
    CMD_RESPONSE, SUB_PRESET_CHANGE,
    0, 0, 0, 0,
    0x08, 0x01,
    0, 0,
    0x04, 0, 0, 0,
    0, 0, 0,
    (slot >> 4) & 0x0f, slot & 0x0f,
    0, 0,
    0xf7,
  ]);
}

// ---- Flash-chunk upload --------------------------------------------------
// Upload image = 14-byte inner header naming the target slot twice, then
// file bytes 0x2E..0x4BF (dump bytes 6..1175): 1184 bytes in all, sent as 7
// chunks of 183 raw bytes (the last 86), each `12 20 09 offLo offHi
// <nibbles> F7`. There is no ACK and no checksum; only a read-back proves a
// write landed.

/** File offset where the upload content starts (dump offset 6). */
export const UPLOAD_CONTENT_FILE_START = 0x2e;
export const UPLOAD_HEADER_LEN = 14;
export const UPLOAD_IMAGE_LEN = 1184;
export const UPLOAD_CHUNK_RAW = 183;
export const UPLOAD_CHUNK_COUNT = 7;
/** Image indices that name the target slot: the two inner-header bytes. */
export const UPLOAD_HEADER_SLOT_INDICES = Object.freeze([6, 12]);

/** The 14-byte inner header for `slot`. */
export function uploadHeader(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 255) throw new RangeError(`slot ${slot} out of range 0-255`);
  return Uint8Array.of(0x00, 0x00, 0x04, 0x00, 0x01, 0x00, slot, 0x00, 0x01, 0x00, 0x04, 0x00, slot, 0x00);
}

/** Split a 1184-byte upload image into its 7 cmd=0x12 sub=0x20 messages. */
export function buildUploadChunks(image) {
  if (!(image instanceof Uint8Array) || image.length !== UPLOAD_IMAGE_LEN) {
    throw new RangeError(`upload image must be ${UPLOAD_IMAGE_LEN} bytes, got ${image?.length}`);
  }
  const chunks = [];
  for (let off = 0; off < image.length; off += UPLOAD_CHUNK_RAW) {
    const part = image.subarray(off, off + UPLOAD_CHUNK_RAW);
    const msg = new Uint8Array(CHUNK_PAYLOAD_START + part.length * 2 + 1);
    msg.set([...HEADER, CMD_RESPONSE, SUB_UPLOAD_CHUNK, UPLOAD_OUTER_BYTE, off & 0x7f, (off >> 7) & 0x7f]);
    for (let i = 0; i < part.length; i++) {
      msg[CHUNK_PAYLOAD_START + 2 * i] = (part[i] >> 4) & 0x0f;
      msg[CHUNK_PAYLOAD_START + 2 * i + 1] = part[i] & 0x0f;
    }
    msg[msg.length - 1] = 0xf7;
    chunks.push(msg);
  }
  return chunks;
}

/**
 * Strictly parse a complete upload: exactly 7 well-formed chunks, in order,
 * at offsets 0, 183, ... 1098, forming one 1184-byte image whose inner header
 * names one slot. Used by the write guard (to decide) and the fake pedal.
 * @returns {{ok: true, image: Uint8Array, slot: number} | {ok: false, reason: string}}
 */
export function parseUploadChunks(chunks) {
  const fail = (reason) => ({ ok: false, reason });
  if (!Array.isArray(chunks)) return fail("not a list of chunks");
  if (chunks.length !== UPLOAD_CHUNK_COUNT) return fail(`expected exactly ${UPLOAD_CHUNK_COUNT} chunks, got ${chunks.length}`);
  const image = new Uint8Array(UPLOAD_IMAGE_LEN);
  for (let i = 0; i < chunks.length; i++) {
    const msg = chunks[i];
    if (!(msg instanceof Uint8Array)) return fail(`chunk ${i} is not bytes`);
    if (!isSysex(msg, CMD_RESPONSE, SUB_UPLOAD_CHUNK)) return fail(`chunk ${i} is not an upload chunk (12 20)`);
    if (msg[10] !== UPLOAD_OUTER_BYTE) return fail(`chunk ${i} outer byte is 0x${msg[10].toString(16)}, not 0x09`);
    if (msg[msg.length - 1] !== 0xf7) return fail(`chunk ${i} has no closing F7`);
    const off = i * UPLOAD_CHUNK_RAW;
    if (msg[11] > 0x7f || msg[12] > 0x7f || chunkOffset(msg) !== off) return fail(`chunk ${i} offset is not ${off}`);
    const raw = Math.min(UPLOAD_CHUNK_RAW, UPLOAD_IMAGE_LEN - off);
    const payload = chunkPayload(msg);
    if (payload.length !== raw * 2) return fail(`chunk ${i} carries ${payload.length} nibbles, expected ${raw * 2}`);
    if (payload.some((b) => b > 0x0f)) return fail(`chunk ${i} has a non-nibble byte`);
    image.set(nibbleDecode(payload), off);
  }
  const slot = image[UPLOAD_HEADER_SLOT_INDICES[0]];
  const header = uploadHeader(slot);
  for (let i = 0; i < UPLOAD_HEADER_LEN; i++) {
    if (image[i] !== header[i]) return fail(`inner header byte ${i} is 0x${image[i].toString(16)}, expected 0x${header[i].toString(16)}`);
  }
  return { ok: true, image, slot };
}

/** If `msg` is exactly a preset change, its slot; else null. */
export function presetChangeSlot(msg) {
  if (!(msg instanceof Uint8Array) || !isSysex(msg, CMD_RESPONSE, SUB_PRESET_CHANGE) || msg.length !== PRESET_CHANGE_LEN) return null;
  if (msg[25] > 0x0f || msg[26] > 0x0f) return null;
  const slot = (msg[25] << 4) | msg[26];
  const expected = buildPresetChange(slot);
  for (let i = 0; i < expected.length; i++) if (msg[i] !== expected[i]) return null;
  return slot;
}

/** If `msg` is exactly a read request, its slot; else null. */
export function readRequestSlot(msg) {
  if (!(msg instanceof Uint8Array) || msg.length !== READ_REQUEST_LEN || msg[25] > 0x0f || msg[26] > 0x0f) return null;
  const slot = (msg[25] << 4) | msg[26];
  const expected = buildReadRequest(slot);
  for (let i = 0; i < expected.length; i++) if (msg[i] !== expected[i]) return null;
  return slot;
}

/** True if `a` and `b` hold the same bytes. */
export function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function hasHeader(msg) {
  if (msg.length < HEADER.length) return false;
  for (let i = 0; i < HEADER.length; i++) if (msg[i] !== HEADER[i]) return false;
  return true;
}

export function isSysex(msg, cmd, sub) {
  return msg.length > 10 && hasHeader(msg) && msg[8] === cmd && msg[9] === sub;
}

/** A dump chunk's position, 7 bits per byte. */
export function chunkOffset(msg) {
  return (msg[11] & 0x7f) | ((msg[12] & 0x7f) << 7);
}

export function chunkPayload(msg) {
  return msg.subarray(CHUNK_PAYLOAD_START, msg.length - 1);
}

/** Order chunks by offset, join their nibble payloads, decode. */
export function assembleChunks(chunks) {
  const ordered = [...chunks].sort((a, b) => chunkOffset(a) - chunkOffset(b));
  const parts = ordered.map(chunkPayload);
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    joined.set(p, pos);
    pos += p.length;
  }
  return nibbleDecode(joined);
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

/** One-line description of a message for the debug log. Dump chunks are shown in full. */
export function describeMessage(msg) {
  const n = msg.length;
  if (n > 10 && hasHeader(msg)) {
    const cmd = msg[8];
    const sub = msg[9];
    const body = msg.subarray(10, n - 1);
    const tag = `GP-200 sysex cmd=0x${hex2(cmd)} sub=0x${hex2(sub)} ${n} bytes`;
    if (cmd === CMD_RESPONSE && sub === SUB_DUMP_CHUNK) return `${tag} body: ${toHex(body)}`;
    const more = body.length > 24 ? ` ...(+${body.length - 24} more)` : "";
    return `${tag} body: ${toHex(body.subarray(0, 24))}${more}`;
  }
  const more = n > 32 ? ` ...(+${n - 32} more)` : "";
  return `non-GP-200 or malformed, ${n} bytes: ${toHex(msg.subarray(0, 32))}${more}`;
}

function hex2(b) {
  return b.toString(16).toUpperCase().padStart(2, "0");
}
