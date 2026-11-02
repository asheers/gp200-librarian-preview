// Phase 3 S3.1 (slice 5): one tab controls the pedal, and a screen wake lock
// during operations. No DOM code: the browser's lock manager
// (navigator.locks, the Web Locks API) and wake lock (navigator.wakeLock)
// are passed in, so tests can use Node's own lock manager or a fake one.
//
// Two exclusive locks per pedal kind (real and demo are separate pedals):
//   CONNECTION  "gp200-librarian-pedal[-demo]": taken before the MIDI port is
//               opened, held while connected, released on disconnect. A
//               second tab cannot connect (reads included: two tabs reading
//               the same port would take each other's replies).
//   OPERATION   "gp200-librarian-operation[-demo]": taken when an operation
//               begins, only by the tab that holds the connection, released
//               when it ends, whatever the outcome.
// The browser releases a tab's locks when the tab closes, reloads or
// crashes, so a dead tab never blocks the pedal. A lock can be lost while
// held (another context requests it with `steal`); the holder is told at once
// (onLost) and must stop. Nothing in this app steals.
//
// FAILS CLOSED: no lock manager, a refused request or a lost lock means "not
// the owner", and an operation does not start or does not continue.
//
// The wake lock is only a convenience (the screen stays on during a long
// plan). Its failure is reported and never changes what is written or
// checked; it is requested after every gate has passed.
//
// SPDX-License-Identifier: GPL-3.0-only

export const LOCK_NAMES = Object.freeze({
  real: Object.freeze({ connection: "gp200-librarian-pedal", operation: "gp200-librarian-operation" }),
  demo: Object.freeze({ connection: "gp200-librarian-pedal-demo", operation: "gp200-librarian-operation-demo" }),
});

export const OWNERSHIP_TEXT = Object.freeze({
  busy: "Another GP200 Librarian tab is using the pedal. Disconnect or close that tab, then try again.",
  unsupported: "This browser cannot make sure that only one tab uses the pedal, so the Librarian will not connect. Use Chrome or Edge.",
  lost: "This tab lost control of the pedal. Nothing more will be written; any operation in progress stopped before its next step.",
  operationBusy: "Another operation is already running. Wait for it to finish.",
  notConnected: "This tab does not control the pedal (connect first).",
  wakeUnavailable: "The screen may turn off during this operation (this browser did not keep it on). Keep this window active until it finishes.",
});

export class OwnershipError extends Error {
  /** @param {"busy"|"unsupported"|"lost"|"operation-busy"|"not-owner"|"error"} code */
  constructor(code, message) {
    super(message);
    this.name = "OwnershipError";
    this.code = code;
  }
}

/**
 * Hold one exclusive lock until release(). Resolves with a holder, or null if
 * the lock is held elsewhere. Rejects (OwnershipError) when the browser has no
 * lock manager or the request fails.
 */
async function holdLock(locks, name, onLost) {
  if (!locks || typeof locks.request !== "function") throw new OwnershipError("unsupported", OWNERSHIP_TEXT.unsupported);
  let releaseFn = null;
  const holder = { held: false, release: () => { releaseFn?.(); } };
  const granted = await new Promise((resolve, reject) => {
    let answered = false;
    const done = locks.request(name, { mode: "exclusive", ifAvailable: true }, (lock) => {
      answered = true;
      if (!lock) {
        resolve(false);
        return undefined;
      }
      holder.held = true;
      resolve(true);
      return new Promise((r) => { releaseFn = r; }); // held until release()
    });
    done.then(() => { holder.held = false; }, (e) => {
      const wasHeld = holder.held;
      holder.held = false;
      if (wasHeld) onLost(e); // taken from us (e.g. stolen) while we held it
      else if (!answered) reject(new OwnershipError("error", `the browser refused the pedal lock (${e?.message ?? e})`));
    });
  });
  return granted ? holder : null;
}

/**
 * This tab's ownership of the pedal.
 * @param {{locks: object|null|undefined, names: {connection: string, operation: string}, log?: object, onLost?: (why: string) => void}} o
 */
export class PedalOwnership {
  constructor({ locks, names, log = null, onLost = () => {} }) {
    this.locks = locks;
    this.names = names;
    this.log = log;
    this.onLost = onLost;
    this.connection = null;
    this.operation = null;
    this.lost = false;
    this._listeners = new Set();
  }

  /** Call `fn(why)` once if control is lost; returns an unsubscribe function. */
  whenLost(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** True while this tab holds the connection lock and has not lost it. */
  get held() {
    return !!this.connection?.held && !this.lost;
  }

  /** Take the connection lock (before the MIDI port is opened). Throws OwnershipError: busy / unsupported / error. */
  async acquire() {
    if (this.held) return;
    this.lost = false;
    const h = await holdLock(this.locks, this.names.connection, (e) => this._lost(`the connection lock was taken (${e?.name ?? e})`));
    if (!h) {
      this.log?.warn(`Pedal lock "${this.names.connection}" is held by another tab: not connecting`);
      throw new OwnershipError("busy", OWNERSHIP_TEXT.busy);
    }
    this.connection = h;
    this.log?.info(`This tab now controls the pedal (lock "${this.names.connection}")`);
  }

  /** Give up control (disconnect). Ends any operation too. */
  release() {
    this.operation?.release();
    this.operation = null;
    if (this.connection) {
      this.connection.release();
      this.connection = null;
      this.log?.info(`Pedal lock "${this.names.connection}" released`);
    }
  }

  /** Throws unless this tab controls the pedal. */
  assertHeld() {
    if (this.lost) throw new OwnershipError("lost", OWNERSHIP_TEXT.lost);
    if (!this.held) throw new OwnershipError("not-owner", OWNERSHIP_TEXT.notConnected);
  }

  /**
   * Begin an operation: needs the connection lock, then takes the operation
   * lock. @returns {Promise<{end: () => void, readonly held: boolean}>}
   * end() releases it (idempotent); `held` turns false if either lock is lost.
   */
  async beginOperation() {
    this.assertHeld();
    if (this.operation) throw new OwnershipError("operation-busy", OWNERSHIP_TEXT.operationBusy);
    const h = await holdLock(this.locks, this.names.operation, (e) => this._lost(`the operation lock was taken (${e?.name ?? e})`));
    if (!h) throw new OwnershipError("operation-busy", OWNERSHIP_TEXT.operationBusy);
    if (!this.held) { // lost while we waited
      h.release();
      throw new OwnershipError("lost", OWNERSHIP_TEXT.lost);
    }
    this.operation = h;
    const self = this;
    return {
      get held() { return h.held && self.held; },
      end() {
        h.release();
        if (self.operation === h) self.operation = null;
      },
    };
  }

  _lost(why) {
    if (this.lost) return;
    this.lost = true;
    this.log?.error(`Lost control of the pedal: ${why}`);
    this.operation?.release();
    this.operation = null;
    this.connection?.release();
    this.connection = null;
    for (const fn of [...this._listeners]) {
      try { fn(why); } catch (e) { this.log?.error(`while handling the lost pedal lock: ${e.message}`); }
    }
    this.onLost(why);
  }
}

/**
 * Ask for a screen wake lock (navigator.wakeLock). Never throws: a failure
 * is returned, to be shown, and changes nothing else.
 * @returns {Promise<{held: boolean, reason: string|null, release: () => Promise<void>}>}
 */
export async function requestWakeLock(wakeLock, log = null) {
  const none = (reason) => {
    log?.warn(`Screen wake lock not available: ${reason}`);
    return { held: false, reason, release: async () => {} };
  };
  if (!wakeLock || typeof wakeLock.request !== "function") return none("this browser has no screen wake lock");
  let sentinel;
  try {
    sentinel = await wakeLock.request("screen");
  } catch (e) {
    return none(`${e?.name ?? "Error"}: ${e?.message ?? e}`);
  }
  const state = { held: true, reason: null };
  sentinel.addEventListener?.("release", () => {
    if (state.held) log?.warn("Screen wake lock ended early (the window was hidden?); the operation continues");
    state.held = false;
  });
  log?.info("Screen wake lock on for this operation");
  return {
    get held() { return state.held; },
    get reason() { return state.reason; },
    release: async () => {
      if (!state.held) return;
      state.held = false;
      try { await sentinel.release(); } catch { /* already released */ }
    },
  };
}
