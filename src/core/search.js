// Search (Phase 3 S1): patch NAMES only, case-insensitive substring. It
// never matches slot labels, effects or parameters. Since UI-2 (U8) the same
// field also goes to a slot: text that is a slot label ("36-A") offers Go to
// that slot (interpretQuery); the name search still runs. No DOM code.
//
// SPDX-License-Identifier: GPL-3.0-only

import { labelToSlot } from "./slots.js";
import { FIRST_OPEN_BANK } from "./bank-view.js";

/**
 * @param {ReturnType<import("./bank-view.js").buildBankView>} view
 * @param {string} query
 * @returns {{query: string, active: boolean, matches: number[], hiddenMatches: number, banks: Set<number>}}
 *   matches in slot order; hiddenMatches = matches in banks 1-32; banks = banks holding a match
 */
export function searchNames(view, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return { query: q, active: false, matches: [], hiddenMatches: 0, banks: new Set() };
  const matches = view.slots.filter((s) => s.read && (s.name ?? "").toLowerCase().includes(q)).map((s) => s.slot);
  return {
    query: q, active: true, matches,
    hiddenMatches: matches.filter((s) => Math.floor(s / 4) + 1 < FIRST_OPEN_BANK).length,
    banks: new Set(matches.map((s) => Math.floor(s / 4) + 1)),
  };
}

/** The next (or previous) match after `current`, wrapping; null if none. */
export function stepMatch(result, current, dir = 1) {
  const m = result.matches;
  if (!m.length) return null;
  if (current === null || current === undefined) return dir > 0 ? m[0] : m[m.length - 1];
  if (dir > 0) return m.find((s) => s > current) ?? m[0];
  return [...m].reverse().find((s) => s < current) ?? m[m.length - 1];
}

/** "Go to slot": "36-A", "36a", " 36 A " -> slot; anything else -> null. */
export function parseGoTo(text) {
  const t = String(text ?? "").trim().replace(/\s+/g, "");
  if (!t) return null;
  try {
    return labelToSlot(t);
  } catch {
    return null;
  }
}

/** Text shaped like a slot label ("36-A", "99z", "12 b"), valid or not. */
export function looksLikeSlot(text) {
  return /^\d{1,3}\s*-?\s*[a-z]$/i.test(String(text ?? "").trim());
}

/**
 * One field for both purposes (U8): the name search, plus Go to slot when the
 * text is a slot label. A slot-shaped label that is out of range is reported
 * (badSlot), never guessed.
 * @returns {{search: ReturnType<typeof searchNames>, goto: number|null, badSlot: boolean}}
 */
export function interpretQuery(view, text) {
  const goto = parseGoTo(text);
  return { search: searchNames(view, text), goto, badSlot: goto === null && looksLikeSlot(text) };
}
