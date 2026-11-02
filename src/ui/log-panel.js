// Applies a LogView update (src/core/log.js) to the on-screen log panel.
// Kept apart from app.js so tests can check, with a minimal stand-in for
// the DOM, that the panel never holds more than LOG_LIMITS.SCREEN_LINES
// lines or more than SCREEN_LINES x SCREEN_LINE_CHARS characters (H0
// remediation, 2026-10-08).
//
// WARN and ERROR lines whose screen text is shortened are expandable: the full
// text is kept on the node as a JS property (not in the DOM), and a click
// toggles between short and full (toggleLogLine). So browser error messages
// are never lost to the shortening, and the panel stays small unless the user
// expands a line.
//
// SPDX-License-Identifier: GPL-3.0-only

/**
 * @param {{firstChild: any, append: (...nodes: any[]) => void}} el the panel element
 * @param {{append: {line: string, level: string, full?: string}[], remove: number}} update from LogView.sync()
 * @param {{createElement: (tag: string) => any}} doc
 */
export function applyLogUpdate(el, { append, remove }, doc) {
  for (let i = 0; i < remove && el.firstChild; i++) el.firstChild.remove();
  if (!append.length) return;
  const nodes = append.map(({ line, level, full }) => {
    const span = doc.createElement("span");
    span.className = full ? `${level} expandable` : level;
    span.textContent = line + "\n";
    if (full) {
      span.logShort = line;
      span.logFull = full;
      span.title = "Click to show the full text (Copy warnings and errors copies them all)";
    }
    return span;
  });
  el.append(...nodes);
}

/** Toggle an expandable line between its short and full text. Returns true if it was expandable. */
export function toggleLogLine(span) {
  if (!span?.logFull) return false;
  const expanded = span.textContent === span.logFull + "\n";
  span.textContent = (expanded ? span.logShort : span.logFull) + "\n";
  return true;
}
