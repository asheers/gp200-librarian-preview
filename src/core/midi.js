// Web MIDI access: the only module that calls navigator.requestMIDIAccess.
// It hands out the GP-200's input and a GUARDED output (write-guard.js: reads
// anywhere, writes only to the slots of a confirmed operation, any of the 256);
// the raw MIDIOutput port never leaves this module.
//
// SysEx access needs a secure context (https:// or http://localhost) and the
// user's permission, which the browser asks for once.
//
// SPDX-License-Identifier: GPL-3.0-only

import { findGp200Ports } from "./device.js";
import { guardedOutput } from "./write-guard.js";

export function webMidiAvailable() {
  return typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function";
}

/**
 * Ask for MIDI access and find the GP-200.
 * @param {import("./log.js").Logger} log
 * @returns {Promise<{input: MIDIInput, output: {send: Function}, inputName: string, outputName: string,
 *   access: MIDIAccess, allPorts: string[]}>}
 */
export async function openGp200(log) {
  if (!webMidiAvailable()) {
    throw new Error("This browser has no Web MIDI. Use Chrome or Edge on a computer.");
  }
  if (typeof isSecureContext !== "undefined" && !isSecureContext) {
    throw new Error("Web MIDI needs a secure page: open the app from its https:// address, or from http://localhost (npm start), not a plain http address.");
  }
  let access;
  try {
    access = await navigator.requestMIDIAccess({ sysex: true });
  } catch (e) {
    throw new Error(`MIDI access was refused (${e.name ?? e}). Allow MIDI / SysEx for this page in the browser's site settings and try again.`);
  }
  const ins = [...access.inputs.values()];
  const outs = [...access.outputs.values()];
  const allPorts = [...ins.map((p) => `in: ${p.name}`), ...outs.map((p) => `out: ${p.name}`)];
  log.info(`MIDI ports seen: ${allPorts.length ? allPorts.join("; ") : "(none)"}`);
  const [input] = findGp200Ports(ins);
  const [rawOutput] = findGp200Ports(outs);
  if (!input || !rawOutput) {
    throw new Error("No GP-200 found. Check the USB cable and that the pedal is on, then click Connect again.");
  }
  await input.open?.();
  await rawOutput.open?.();
  log.info(`Using input "${input.name}" and output "${rawOutput.name}" (output guarded: writes only to the slots of a confirmed operation, any of the 256)`);
  const output = guardedOutput(rawOutput, { onRefused: (e) => log.error(e.message) });
  return { input, output, inputName: input.name, outputName: rawOutput.name, access, allPorts };
}
