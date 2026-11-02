// Adapted from GP-200 Patch Manager Web (donpark2000/GP-200-Patch-Manager-Web,
// src/core/unzip.js @ ff618e7, GPL-3.0). See docs/ATTRIBUTION.md.
// SPDX-License-Identifier: GPL-3.0-only
//
// Minimal ZIP reader (stored and deflated entries) for both the browser and
// Node: reads the central directory and inflates with DecompressionStream,
// which Chrome, Edge, and Node 18+ all provide. Handles this app's own zips
// and the CLI's (Python zipfile, deflated).

import { crc32 } from "./zip.js";

/** @returns {Promise<Map<string, Uint8Array>>} entry name -> contents, in archive order */
export async function readZip(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error(`bad zip central directory entry ${n}`);
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const nameBytes = u8.subarray(p + 46, p + 46 + nameLen);
    // Unflagged names are cp437 in theory; Python only leaves ASCII names
    // unflagged, and ASCII is the same in every encoding involved.
    const name = flags & 0x0800 ? new TextDecoder().decode(nameBytes) : String.fromCharCode(...nameBytes);
    const dataStart = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = u8.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = Uint8Array.from(raw);
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`${name}: unsupported zip compression method ${method}`);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC mismatch (damaged zip?)`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
