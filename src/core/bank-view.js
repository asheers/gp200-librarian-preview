// The librarian's view of the pedal (Phase 3 S1): what each bank and slot
// shows, derived from one snapshot. No DOM code; the UI renders this model.
//
// Per slot, all from bytes we already trust:
//   - the default class from defaults.js (content-based, name included);
//   - badges: IR / NAM (model codes), STATE (the slot holds one of the six
//     evidenced patches, by content fingerprint; state-evidence.js), DUP
//     (patch content identical to another real slot);
//   - whether this version may write it (`writable`: the write guard's
//     whitelist). Not writable means "writes not enabled yet", not that the
//     patch is locked; the UI marks only the writable zone, not every slot.
//   - whether it is the active slot, when known.
//
// SPDX-License-Identifier: GPL-3.0-only

import { classifyDefault } from "./defaults.js";
import { contentKey, normalizedKey } from "./match.js";
import { displayName, irNamDependencies } from "./patch.js";
import { bankSlots, BANKS, slotToDisplayLabel, TOTAL_SLOTS } from "./slots.js";
import { evidenceFingerprint, STATE_EVIDENCE } from "./state-evidence.js";

export { contentKey } from "./match.js";

/** Banks shown without asking: 33-64. Banks 1-32 start collapsed (they stay writable when writes are enabled). */
export const FIRST_OPEN_BANK = 33;

/** Which of the six evidenced patches (if any) this dump is, by content fingerprint. */
export function evidencedAs(dump, register = STATE_EVIDENCE) {
  return register.find((e) => evidenceFingerprint(dump, e.fileOff) === e.fingerprint) ?? null;
}

// Per-dump analysis is cached by the dump object: hashing every slot costs
// about 140 ms on the user's pedal data, so a re-render (selection, search,
// active slot) must not repeat it, and a rebuild after a one-slot write only
// analyses that slot. A cached entry is reused only for the same slot,
// register and provenance (the default class depends on the slot fields).
//
// Provenance "prst" (S2: content from a .prst, normalised by the format):
// classified with the normalised comparison, and never claimed as an
// evidenced (pedal-dependent) patch, since the normalisation breaks the
// evidence fingerprint.
const analysisCache = new WeakMap();

function analyse(dump, slot, register, fromPrst) {
  const hit = analysisCache.get(dump);
  if (hit && hit.slot === slot && hit.register === register && hit.fromPrst === fromPrst) return hit;
  const d = classifyDefault(dump, slot, { normalized: fromPrst });
  const ev = fromPrst ? null : evidencedAs(dump, register);
  const a = {
    slot, register, fromPrst, cls: d.cls, unused: d.unused, namedLikeDefault: d.namedLikeDefault, name: displayName(dump),
    irNam: irNamDependencies(dump), state: ev ? { label: ev.label, fileOff: ev.fileOff } : null,
    key: d.unused ? null : contentKey(dump), nkey: normalizedKey(dump),
  };
  analysisCache.set(dump, a);
  return a;
}

/** Update only the active-slot flags of a built view (cheap; no re-analysis). */
export function setActiveSlot(view, activeSlot) {
  for (const s of view.slots) s.active = activeSlot?.slot === s.slot;
  return view;
}

/**
 * @param {{dumps: (Uint8Array|null)[], errors?: Map<number,string>, provenance?: ("raw"|"prst"|null)[]}|null} snapshot
 *   a live read, or a backup source (src/core/backup-source.js)
 * @param {{activeSlot?: {slot: number}|null, writable?: (slot: number) => boolean, register?: object[]}} [opts]
 */
export function buildBankView(snapshot, { activeSlot = null, writable = () => false, register = STATE_EVIDENCE } = {}) {
  const slots = [];
  for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
    const dump = snapshot?.dumps?.[slot] ?? null;
    const base = { slot, label: slotToDisplayLabel(slot), writable: !!writable(slot), active: activeSlot?.slot === slot };
    if (!dump) {
      slots.push({ ...base, read: false, error: snapshot?.errors?.get?.(slot) ?? null, name: null, cls: null, unused: false,
        namedLikeDefault: false, irNam: [], state: null, dupOf: [], key: null, nkey: null, fromPrst: false });
      continue;
    }
    const fromPrst = snapshot?.provenance?.[slot] === "prst";
    const a = analyse(dump, slot, register, fromPrst);
    slots.push({
      ...base, read: true, error: null, name: a.name, cls: a.cls, unused: a.unused, namedLikeDefault: a.namedLikeDefault,
      irNam: a.irNam, state: a.state, dupOf: [], key: a.key, nkey: a.nkey, fromPrst,
    });
  }
  // Duplicates among real (non-default) slots only: unused slots are all alike by design.
  const byKey = new Map();
  for (const s of slots) if (s.key) byKey.set(s.key, [...(byKey.get(s.key) ?? []), s.slot]);
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const slot of group) slots[slot].dupOf = group.filter((x) => x !== slot);
  }
  const banks = [];
  for (let bank = 1; bank <= BANKS; bank++) {
    const members = bankSlots(bank);
    banks.push({
      bank, slots: members,
      allUnused: members.every((s) => slots[s].read && slots[s].unused),
      anyRead: members.some((s) => slots[s].read),
      hiddenByDefault: bank < FIRST_OPEN_BANK,
      writable: members.some((s) => slots[s].writable),
    });
  }
  const count = (f) => slots.filter(f).length;
  return {
    slots, banks,
    counts: {
      read: count((s) => s.read), unused: count((s) => s.unused), real: count((s) => s.read && !s.unused),
      renamedDefault: count((s) => s.cls === "renamed-default"), editedDefault: count((s) => s.cls === "edited-default"),
      state: count((s) => s.state), dup: count((s) => s.dupOf.length > 0),
      realInHiddenBanks: count((s) => s.read && !s.unused && s.slot < (FIRST_OPEN_BANK - 1) * 4),
    },
  };
}

/** The whole duplicate group a slot belongs to, in slot order (just [slot] if it has no duplicate). */
export function duplicateGroup(view, slot) {
  return [slot, ...view.slots[slot].dupOf].sort((a, b) => a - b);
}

/** Short tile text for a slot's class (the summary gives the full explanation). */
export function classLabel(s) {
  if (!s.read) return s.error ? "read failed" : "";
  switch (s.cls) {
    case "default": return "unused";
    case "renamed-default": return "renamed default";
    case "edited-default": return "edited default";
    case "unverified": return "unverified";
    default: return s.namedLikeDefault ? "named like the default" : "";
  }
}
