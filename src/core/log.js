// Adapted from GP-200 Patch Manager Web (donpark2000/GP-200-Patch-Manager-Web,
// src/core/log.js @ ff618e7, GPL-3.0). See docs/ATTRIBUTION.md.
// SPDX-License-Identifier: GPL-3.0-only
//
// The app's debug log (on-screen panel + "save log"). Every line is timestamped
// relative to when the log started, like the CLI's --debug output. Debug
// lines (raw MIDI traffic) are only kept while debug is switched on.
//
// BOUNDED (Phase 3 S0, docs/PHASE3_DESIGN.md 12.1). W1's severe read slowdown
// came from an on-screen log that grew without limit (R1). So:
//   - entries are kept in segments of SEGMENT entries; when the main buffer
//     passes MAIN_BYTES (estimated) or MAIN_ENTRIES, the oldest WHOLE segment
//     is dropped, so an append costs the same however full the log is;
//   - MIDI traffic is stored as raw bytes and formatted only when a line is
//     shown or saved (log.midi());
//   - a PROTECTED tier keeps every WARN and ERROR, every write-audit entry
//     (outgoing messages other than reads) and every INFO summary logged with
//     { keep: true } (per-read times and verdicts), whatever debug traffic
//     does. It has its own bound: the first PROTECTED_HEAD entries plus the
//     newest, with a count of what was omitted in between;
//   - LogView (below) is the on-screen model. H0 (2026-10-08) showed that a
//     panel capped at 1,000 FULL lines (about 875,000 characters, mostly
//     full dump-chunk hex) still slowed reads, because the browser lays the
//     whole panel out again on every update. So the screen shows only the
//     last SCREEN_LINES entries, each shortened by formatScreen() to at most
//     SCREEN_LINE_CHARS characters (MIDI: the header and SCREEN_MIDI_BYTES
//     body bytes). The saved log keeps every entry in full.

import { describeMessage, toHex } from "./sysex.js";

export const LOG_LIMITS = Object.freeze({
  SEGMENT: 1000,
  MAIN_BYTES: 4 * 1024 * 1024,
  MAIN_ENTRIES: 40_000,
  PROTECTED_SEGMENT: 100,
  PROTECTED_BYTES: 1024 * 1024,
  PROTECTED_ENTRIES: 5000,
  PROTECTED_HEAD: 200,
  SCREEN_LINES: 200,
  SCREEN_LINE_CHARS: 160,
  SCREEN_MIDI_BYTES: 16,
});

const ENTRY_OVERHEAD = 64;

/** Estimated memory cost of one entry, in bytes. */
export function entryCost(e) {
  return ENTRY_OVERHEAD + (e.msg ? 2 * e.msg.length : 0) + (e.bytes ? e.bytes.length : 0) + (e.note ? 2 * e.note.length : 0);
}

/** Entries in segments; drops the oldest whole segment when over its limits. */
class SegmentedBuffer {
  constructor({ segment, maxBytes, maxEntries }) {
    this.segment = segment;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.clear();
  }

  clear() {
    this.segments = [{ entries: [], bytes: 0 }];
    this.bytes = 0;
    this.entries = 0;
    this.droppedEntries = 0;
    this.droppedBytes = 0;
  }

  push(e) {
    let last = this.segments[this.segments.length - 1];
    if (last.entries.length >= this.segment) {
      last = { entries: [], bytes: 0 };
      this.segments.push(last);
    }
    last.entries.push(e);
    last.bytes += e.cost;
    this.bytes += e.cost;
    this.entries++;
    while ((this.bytes > this.maxBytes || this.entries > this.maxEntries) && this.segments.length > 1) {
      const old = this.segments.shift();
      this.bytes -= old.bytes;
      this.entries -= old.entries.length;
      this.droppedEntries += old.entries.length;
      this.droppedBytes += old.bytes;
    }
  }

  *all() {
    for (const s of this.segments) yield* s.entries;
  }
}

export class Logger {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now] milliseconds clock
   * @param {(entry: object) => void} [opts.onAppend] called after every kept entry (cheap: do not format here)
   * @param {Partial<typeof LOG_LIMITS>} [opts.limits] tests only
   */
  constructor({ now = () => performance.now(), onAppend = () => {}, limits = {} } = {}) {
    this.now = now;
    this.onAppend = onAppend;
    this.limits = { ...LOG_LIMITS, ...limits };
    this.t0 = now();
    this.debugEnabled = false;
    this.lastError = null; // the last error's message, for "Report a problem"
    this.seq = 0;
    this.main = new SegmentedBuffer({ segment: this.limits.SEGMENT, maxBytes: this.limits.MAIN_BYTES, maxEntries: this.limits.MAIN_ENTRIES });
    this._resetProtected();
  }

  _resetProtected() {
    this.protectedHead = [];
    this.protectedTail = new SegmentedBuffer({
      segment: this.limits.PROTECTED_SEGMENT,
      maxBytes: Math.max(0, this.limits.PROTECTED_BYTES),
      maxEntries: Math.max(0, this.limits.PROTECTED_ENTRIES - this.limits.PROTECTED_HEAD),
    });
  }

  /** @param {{keep?: boolean}} [opts] keep: a summary (e.g. a read's time) that must survive rotation */
  info(msg, { keep = false } = {}) { this._add({ level: "INFO", msg: String(msg) }, keep); }
  warn(msg) { this._add({ level: "WARN", msg: String(msg) }, true); }
  error(msg) {
    this.lastError = String(msg);
    this._add({ level: "ERROR", msg: String(msg) }, true);
  }
  debug(msg) { if (this.debugEnabled) this._add({ level: "DEBUG", msg: String(msg) }); }

  /**
   * A MIDI message, kept as raw bytes and formatted only when shown or saved.
   * `audit: true` (outgoing messages other than reads: the write audit trail)
   * is always kept, in the protected tier, even with debug off. Other
   * messages are kept only while debug is on.
   * @param {"->"|"<-"} dir
   * @param {Uint8Array} bytes
   * @param {{note?: string, audit?: boolean}} [opts]
   */
  midi(dir, bytes, { note = "", audit = false } = {}) {
    if (!audit && !this.debugEnabled) return;
    this._add({ level: audit ? "AUDIT" : "DEBUG", dir, bytes: Uint8Array.from(bytes), note }, audit);
  }

  _add(e, protect = false) {
    e.t = this.now() - this.t0;
    e.seq = ++this.seq;
    e.cost = entryCost(e);
    this.main.push(e);
    if (protect) {
      if (this.protectedHead.length < this.limits.PROTECTED_HEAD) this.protectedHead.push(e);
      else this.protectedTail.push(e);
    }
    this.onAppend(e);
  }

  /** One entry as a line of text. */
  format(e) {
    const secs = (e.t / 1000).toFixed(3).padStart(8);
    const body = e.bytes ? `${e.dir} ${describeMessage(e.bytes)}${e.note ? ` [${e.note}]` : ""}` : e.msg;
    return `[+${secs}s] ${e.level.padEnd(5)} ${body}`;
  }

  /**
   * One entry as a SHORT line for the on-screen panel: at most SCREEN_LINE_CHARS
   * characters; a MIDI entry shows its header and the first SCREEN_MIDI_BYTES body bytes.
   */
  formatScreen(e) {
    const secs = (e.t / 1000).toFixed(3).padStart(8);
    let body = e.msg;
    if (e.bytes) {
      const b = e.bytes;
      const n = this.limits.SCREEN_MIDI_BYTES;
      const head = b.length > 10 ? `cmd=0x${b[8].toString(16).padStart(2, "0")} sub=0x${b[9].toString(16).padStart(2, "0")} ${b.length} bytes: ` : `${b.length} bytes: `;
      const data = b.length > 10 ? b.subarray(10, b.length - 1) : b;
      body = `${e.dir} ${head}${toHex(data.subarray(0, n))}${data.length > n ? " …" : ""}${e.note ? ` [${e.note}]` : ""}`;
    }
    const line = `[+${secs}s] ${e.level.padEnd(5)} ${body}`;
    const max = this.limits.SCREEN_LINE_CHARS;
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }

  /** Entries with seq > `afterSeq`, newest `max` of them, oldest first. */
  entriesSince(afterSeq, max = Infinity) {
    const out = [];
    for (let i = this.main.segments.length - 1; i >= 0 && out.length < max; i--) {
      const seg = this.main.segments[i].entries;
      for (let j = seg.length - 1; j >= 0 && out.length < max; j--) {
        if (seg[j].seq <= afterSeq) return out.reverse();
        out.push(seg[j]);
      }
    }
    return out.reverse();
  }

  /** Every kept main-buffer line (formats everything: for tests and small logs). */
  get lines() {
    return Array.from(this.main.all(), (e) => this.format(e));
  }

  /** Bounds and drop counts, for the saved log's header and for tests. */
  stats() {
    return {
      mainEntries: this.main.entries, mainBytes: this.main.bytes,
      droppedEntries: this.main.droppedEntries, droppedBytes: this.main.droppedBytes,
      protectedEntries: this.protectedHead.length + this.protectedTail.entries,
      protectedBytes: this.protectedHead.reduce((t, e) => t + e.cost, 0) + this.protectedTail.bytes,
      protectedOmitted: this.protectedTail.droppedEntries,
      total: this.seq,
    };
  }

  clear() {
    this.main.clear();
    this._resetProtected();
    this.lastError = null;
  }

  /**
   * The saved log as a list of text parts (one per segment), so a large log
   * becomes a Blob without first being joined into one huge string.
   */
  textParts(headerLines = []) {
    const s = this.stats();
    const parts = [[
      ...headerLines,
      `Log: ${s.total} entries this session; ${s.mainEntries} kept (about ${(s.mainBytes / 1048576).toFixed(1)} MB)` +
        (s.droppedEntries ? `; ${s.droppedEntries} older entries were dropped to keep the log bounded` : "") + ".",
      `Protected entries (warnings, errors, write audit, read summaries): ${s.protectedEntries} kept` +
        (s.protectedOmitted ? `; ${s.protectedOmitted} omitted between the first ${this.limits.PROTECTED_HEAD} and the newest` : "") + ".",
      "", "==== Protected: warnings, errors, write audit and read summaries ====", "",
    ].join("\n") + "\n"];
    const prot = [...this.protectedHead.map((e) => this.format(e))];
    if (this.protectedTail.droppedEntries) prot.push(`... ${this.protectedTail.droppedEntries} protected entries omitted ...`);
    for (const e of this.protectedTail.all()) prot.push(this.format(e));
    parts.push(prot.join("\n") + (prot.length ? "\n" : ""));
    parts.push(`\n==== Full log${s.droppedEntries ? ` (the first ${s.droppedEntries} entries were dropped)` : ""} ====\n\n`);
    for (const seg of this.main.segments) {
      if (seg.entries.length) parts.push(seg.entries.map((e) => this.format(e)).join("\n") + "\n");
    }
    return parts;
  }

  /** Every kept WARN and ERROR in full (the protected tier), for "Copy warnings and errors". */
  problemsText() {
    const keep = (e) => e.level === "WARN" || e.level === "ERROR";
    const lines = this.protectedHead.filter(keep).map((e) => this.format(e));
    if (this.protectedTail.droppedEntries) lines.push(`... ${this.protectedTail.droppedEntries} protected entries omitted ...`);
    for (const e of this.protectedTail.all()) if (keep(e)) lines.push(this.format(e));
    return lines.join("\n");
  }

  /** Full log text for "save log" (joins textParts; fine for tests and small logs). */
  text(headerLines = []) {
    return this.textParts(headerLines).join("");
  }
}

/**
 * The on-screen log panel's model (no DOM): at most `max` lines, each from
 * formatScreen() (short). sync() reports what the UI must append and how
 * many old lines it must remove. Full lines are only in the saved log.
 */
export class LogView {
  constructor(logger, max = logger.limits.SCREEN_LINES) {
    this.logger = logger;
    this.max = max;
    this.lastSeq = 0;
    this.count = 0; // lines currently on screen
    this.skipped = 0; // entries never shown because a batch exceeded `max`
  }

  /**
   * WARN and ERROR entries also carry `full` (their complete text) when the
   * screen line is shortened, so the panel can expand them on request.
   * @returns {{append: {line: string, level: string, full?: string}[], remove: number}}
   */
  sync() {
    const newest = this.logger.seq;
    if (newest === this.lastSeq) return { append: [], remove: 0 };
    const entries = this.logger.entriesSince(this.lastSeq, this.max);
    this.skipped += Math.max(0, newest - this.lastSeq - entries.length);
    this.lastSeq = newest;
    const append = entries.map((e) => {
      const line = this.logger.formatScreen(e);
      if (e.level !== "WARN" && e.level !== "ERROR") return { line, level: e.level };
      const full = this.logger.format(e);
      return full === line ? { line, level: e.level } : { line, level: e.level, full };
    });
    const remove = Math.max(0, this.count + append.length - this.max);
    this.count = this.count + append.length - remove;
    return { append, remove };
  }

  reset() {
    this.lastSeq = this.logger.seq;
    this.count = 0;
  }
}
