// Read-session integrity after a timeout (H-S3.0 HS-3 follow-up; approved
// 2026-10-18). No DOM code.
//
// Read chunks carry no slot number. Settling after a timeout (device.js
// READ_SETTLE) discards late replies, but a reply later than the settling
// cannot be told apart from the next slot's. So readAll records, for every
// slot whose read needed a retry or failed, the NEXT slot it read (a
// "follow-up"); the session is then "unverified". Before a backup, template
// or export uses data from such a session, every follow-up slot is re-read
// independently and must have identical PATCH CONTENT (classifyDumpDiff:
// read-volatile bytes excused, nothing else). A failure is permanent for that
// session (fail closed): only a new full read gives usable data again.
//
// SPDX-License-Identifier: GPL-3.0-only

import { slotToDisplayLabel } from "./slots.js";
import { classifyDumpDiff } from "./volatile.js";

/**
 * The session's integrity state.
 * @param {object|null} snapshot a readAll() result
 * @returns {{status: "clean"|"unverified"|"verified"|"failed", text: string, followUps: {slot: number, after: number}[]}}
 */
export function integrityOf(snapshot) {
  const followUps = snapshot?.followUps ?? [];
  if (snapshot?.integrity) return { ...snapshot.integrity, followUps };
  return followUps.length
    ? { status: "unverified", followUps, text: `this read had a timeout; ${followUps.map((f) => slotToDisplayLabel(f.slot)).join(", ")} must be re-read to check it` }
    : { status: "clean", followUps, text: "" };
}

/** True when data from this session may be used for a backup, template or export. */
export const integrityOk = (snapshot) => ["clean", "verified"].includes(integrityOf(snapshot).status);

/**
 * Re-read every follow-up slot and compare its patch content with the session's dump. Records the
 * result on the snapshot (snapshot.integrity). A "failed" or "verified" session is never re-checked.
 * @param {import("./device.js").GP200} device
 * @param {object} snapshot a readAll() result
 * @param {{log: import("./log.js").Logger}} o
 */
export async function verifyFollowUps(device, snapshot, { log }) {
  const now = integrityOf(snapshot);
  if (now.status !== "unverified") return now;
  const checked = [];
  const failed = [];
  for (const { slot, after } of now.followUps) {
    const label = slotToDisplayLabel(slot);
    const old = snapshot.dumps[slot];
    if (!old) continue; // not in the session: nothing of it can be used
    let fresh;
    try {
      fresh = (await device.readDump(slot)).decoded;
    } catch (e) {
      failed.push({ slot, after, why: `${label} could not be re-read (${e.message})` });
      continue;
    }
    const c = classifyDumpDiff(old, fresh);
    if (c.contentIdentical) checked.push(slot);
    else failed.push({ slot, after, why: `${label} (read right after ${slotToDisplayLabel(after)}'s timeout) has ${c.content.length} patch-content byte(s) different on a re-read` });
  }
  snapshot.integrity = failed.length
    ? { status: "failed", checked, failed, text: `read #${snapshot.readNumber} is not consistent: ${failed.map((f) => f.why).join("; ")}` }
    : { status: "verified", checked, failed: [], text: `read #${snapshot.readNumber}: ${checked.map(slotToDisplayLabel).join(", ")} re-read after the timeout and identical` };
  if (failed.length) log.error(`Read integrity: ${snapshot.integrity.text}. Data from this read is not used; read the pedal again`);
  else log.info(`Read integrity: ${snapshot.integrity.text}`, { keep: true });
  return integrityOf(snapshot);
}
