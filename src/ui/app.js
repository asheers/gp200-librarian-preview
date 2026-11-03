// GP200 Librarian UI. Three places (UI-1): Pedal | Templates | Backups, each
// showing only its own actions (src/core/places.js).
// Phase 3 S1: the bank-card librarian view (read side);
// Phase 2 (kept, in "Test tools (bank 60)", More ▾ since UI-4): read everything; copy one patch into the
// scratch bank 60 (60-A..60-D) with confirmation, before-image, read-back
// verification and Undo.
// Connect -> read all 256 slots -> show them by bank -> select -> back up,
// or copy, move or swap a patch. The device's output is wrapped in the write
// guard (src/core/write-guard.js): no code here can write a slot outside the
// permit of the operation the user confirmed, whatever the UI does.
//
// SPDX-License-Identifier: GPL-3.0-only

import { buildBackup, buildFullLibrarianBackup, buildTemplatesZip } from "../core/backup.js";
import { compareBackups, formatCompareReport, loadBackup } from "../core/compare.js";
import { CopyError, describePlan, executeWrite, prepareCopy, prepareUndo } from "../core/copy.js";
import { journalZip, planJournalZip } from "../core/journal.js";
import { confirmPlan, executePlan } from "../core/executor.js";
import { buildPlan, formatPreview, previewPlan, STATE_REFUSAL } from "../core/plan.js";
import { writeRefused } from "../core/state-evidence.js"; // V4: the picker's lock (read only; the planner still refuses)
import { GP200 } from "../core/device.js";
import { actionsFor, PLANNED } from "../core/actions.js";
import { openSource, prstForSlot } from "../core/backup-source.js";
import { compareLines, compareMark, compareReportText, compareWithLive, describeCounts } from "../core/compare-live.js";
import { backupSelectedLabel, describeBackupChoice } from "../core/backup-confirm.js";
import { buildBankView, duplicateGroup, setActiveSlot } from "../core/bank-view.js";
import { compareSnapshots, formatSnapshotCompare, isComplete, readAll, slotInfo, snapshotVerdicts } from "../core/library.js";
import { interpretQuery, stepMatch } from "../core/search.js";
import { fileDestination, moreItems, placeOf, regionVisible, tabOf } from "../core/places.js";
import { Logger, LogView } from "../core/log.js";
import { normalizedKey } from "../core/match.js";
import { NAME_ALLOWED_DESCRIPTION, NAME_LEN, validateName } from "../core/names.js";
import { displayName, exportFileName, exportPrst, irNamDependencies, isPrst } from "../core/patch.js";
import { openGp200, webMidiAvailable } from "../core/midi.js";
import { Selection } from "../core/selection.js";
import { skeletonBytes } from "../core/skeleton.js";
import { bankSlots, labelToSlot, slotToDisplayLabel } from "../core/slots.js";
import { sha256Hex } from "../core/sha256.js";
import { patchSummary } from "../core/summary.js";
import {
  createTemplate, duplicateTemplate, importTemplates, isLossy, parseTemplateFile, PROVENANCE, provenanceText, renameTemplate, setTemplateNotes,
  templateFile, templatesFromLoaded, templatesMatching,
} from "../core/templates.js";
import { classifyDumpDiff } from "../core/volatile.js";
import { toHex } from "../core/sysex.js";
import { isWritableSlot, SCRATCH_SLOTS, WRITABLE_SLOTS } from "../core/write-guard.js";
import { APP_NAME, APP_VERSION, BUILD } from "../version.js";
import { DB_VERSION, inspectDb, librarianStores, readStorageSnapshot, setStorageGate } from "./store-idb.js";
import { checkUnfinished, formatRecoverySummary, writeClearance } from "../core/operations.js";
import { buildRecoveryPlan, checkOperation, OUTCOMES, RecoveryError, RECOVERY_WRITES, resolveOperation, runRecovery } from "../core/recovery.js";
import { buildUndoPlan, checkUndo, findUndoable, runUndo, UndoError } from "../core/undo.js";
import { realPedalAllows, realPedalSourceOk, realPedalUndoable } from "../core/real-pedal.js";
import { LOCK_NAMES, OWNERSHIP_TEXT, OwnershipError, PedalOwnership, requestWakeLock } from "../core/ownership.js";
import { storageCopyZip, upgradeNotice } from "../core/storage-upgrade.js";
import { askChoice, askDestination, askText, showInfo } from "./dialogs.js";
import { renderTemplateDetails, renderTemplateList } from "./templates-panel.js";
import { createBankGrid } from "./bank-grid.js";
import { createBankMap } from "./bank-map.js";
import { applyLogUpdate, toggleLogLine } from "./log-panel.js";
import { openMenu } from "./menus.js";
import { renderSummary } from "./summary-panel.js";
import { describeSave, saveFile } from "./save-file.js";
import { describeFolderSave, FOLDER_DIALOG_ID, FOLDER_KEY, folderPermission, renewPermission, saveToFolder } from "./backup-folder.js";
import { beforeImageVerified } from "../core/before-image-gate.js";
import { integrityOf, integrityOk, verifyFollowUps } from "../core/read-integrity.js";
import { buildDemoEvidence, classifyHistoryEntry, historyForFullBackup } from "../core/history.js";

const DEMO = new URLSearchParams(location.search).has("demo");
/** What a backup is compared with (Stop D wording): in demo mode the simulated pedal, never "your pedal". */
const COMPARED_WITH = DEMO ? "demo pedal" : "your pedal";
const skeleton = skeletonBytes();
const $ = (id) => document.getElementById(id);

const state = {
  device: null,
  midi: null, // {inputName, outputName, access}
  connected: false,
  busy: false,
  cancel: false,
  snapshots: [], // every read this session, oldest first
  lastReadCompare: "",
  lastFileCompare: "",
  undo: null, // {dest, before, after, sourceSlot} from the last copy that sent a write (legacy Test tools)
  engineUndo: null, // S3.2 slice 4: the one operations-store record findUndoable() currently offers, or null
  writeMarks: new Map(), // slot -> "written" | "write-failed"
  autoConfirm: false, // demo switch only
};
// O2: the demo pedal and the real pedal never share storage (history, templates, settings).
const stores = librarianStores({ demo: DEMO });
const journal = stores.journal;
setStorageGate(storageGate());
/**
 * The operations store. In the demo only, a simulated crash (&crash, S3.1 review) makes it refuse
 * every later write, as a dead tab would; the real pedal's store is used as it is.
 */
const demoCrash = { armed: null, crashed: false };
const operationsStore = !DEMO ? stores.operations : {
  save: (r) => (demoCrash.crashed ? Promise.reject(new Error("demo: the tab has crashed")) : stores.operations.save(r)),
  update: (id, p) => (demoCrash.crashed ? Promise.reject(new Error("demo: the tab has crashed")) : stores.operations.update(id, p)),
  all: () => stores.operations.all(),
};

/**
 * S3.0 (R2/R3): the one-way storage update is announced BEFORE the real database is first opened at
 * a newer version. Nothing opens the database until this resolves (store-idb.js). It is read without
 * upgrading to offer a copy (a record only: there is no import). "Not now" rejects: storage stays
 * unavailable on this page and a pedal write fails closed at the journal.
 */
async function storageGate() {
  if (DEMO) return; // the demo has its own database; nothing to announce
  let existing = null;
  try {
    existing = await inspectDb(stores.dbName);
  } catch {
    existing = null;
  }
  if (existing === null) log.info("Browser storage: this browser cannot say which version is stored; opening it normally");
  const notice = upgradeNotice(existing, DB_VERSION);
  if (!notice) return;
  log.info(`Browser storage: version ${notice.from} found; this version needs ${notice.to} (one-way). Asking first.`, { keep: true });
  for (;;) {
    const go = await askChoice({
      title: notice.title, message: notice.lines,
      choices: [
        { value: "copy", label: "Save a copy of the current storage…", primary: true, focus: true },
        { value: "update", label: "Update storage now" },
        { value: "later", label: "Not now" },
      ],
    });
    if (go === "copy") {
      try {
        const snap = await readStorageSnapshot(stores.dbName);
        const z = storageCopyZip(snap, { app: `${APP_NAME} ${APP_VERSION}` });
        const r = await saveConfirmed("Browser storage copy", z.bytes, z.fileName, { ...ZIP, description: "GP200 Librarian browser storage copy" });
        setStatus(describeSave("Browser storage copy", r), saveKind(r));
      } catch (e) {
        log.error(`Browser storage copy failed: ${e.message}`);
        setStatus(`Browser storage copy NOT saved: ${e.message}`, "err");
      }
      continue;
    }
    if (go === "update") {
      log.info(`Browser storage: update ${notice.from} -> ${notice.to} chosen by the user`, { keep: true });
      return;
    }
    log.warn("Browser storage: update postponed; templates and history are unavailable on this page, and nothing can be written to the pedal");
    setStatus("Browser storage not updated: templates and history are unavailable, and nothing can be written to the pedal. Reload the page to update.", "err");
    throw new Error("the browser storage update was postponed (reload the page to update)");
  }
}
/** The demo evidence index for classifying unmarked (pre-O2) history, built on first use. */
let demoEvidence = null;
async function getDemoEvidence() {
  if (!demoEvidence) {
    const { realisticDemoDumps } = await import("../dev/demo-patches.js");
    demoEvidence = buildDemoEvidence(realisticDemoDumps(skeleton));
  }
  return demoEvidence;
}
const selection = new Selection();

// ---- log -------------------------------------------------------------------
// The panel shows at most LOG_LIMITS.SCREEN_LINES lines and is updated in
// batches (at most about 4 times a second), never once per line: an unbounded,
// per-line panel caused W1's slow reads (R1). The full bounded log is in "Save log".
// A plain timer, not requestAnimationFrame: rAF stops in background tabs, and the
// panel must still catch up there. Screen lines are SHORT (LogView/formatScreen):
// H0 showed that 1,000 full lines (about 875,000 characters) still slowed reads.
const logEl = $("log");
const LOG_PANEL_INTERVAL_MS = 250;
let logFlushTimer = null;
const log = new Logger({
  onAppend: (e) => {
    if (e.level === "ERROR") $("logbox").open = true;
    if (logFlushTimer === null) logFlushTimer = setTimeout(flushLogPanel, LOG_PANEL_INTERVAL_MS);
  },
});
const logView = new LogView(log);

function flushLogPanel() {
  logFlushTimer = null;
  applyLogUpdate(logEl, logView.sync(), document);
  const s = log.stats();
  $("log-count").textContent = `(${s.total}${s.total > logView.count ? `; last ${logView.count} shown` : ""})`;
}

// ---- library view (Phase 3 S1) --------------------------------------------
// The bank view (src/core/bank-view.js) is rebuilt only when the data
// changes (a read, a write, the active slot); selection and search only
// re-render it.
const MAP_KEY = "gp200-librarian.showBankMap"; // redesign V1: per-viewer layout conveniences
const PANEL_KEY = "gp200-librarian.hidePatchPanel";
const stored = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage unavailable: the default layout
  }
};
const ui = {
  view: buildBankView(null),
  search: null, // searchNames() result
  goto: null, // the slot the find field names (U8), or null
  badSlot: false, // the find field holds a slot-shaped label that is out of range
  onlyMatching: false,
  focus: null, // the slot last clicked, or the current search match
  selectMode: false, // touch: each tap toggles
  summarySlot: null, // the slot the summary shows
  summaryOpen: false, // the drawer / sheet (below 1280 px)
  group: null, // Set of slots: a highlighted duplicate group
  tab: "pedal", // the place: "pedal" | "templates" | "backups" (src/core/places.js)
  backupSub: "patches", // inside a Full Librarian backup: "patches" | "templates" | "history"
  scroll: {}, // per tab: the page scroll position to return to
  logShown: false, // the log panel (More ▾ → Show log)
  testToolsShown: false, // the bank-60 test tools (More ▾ → Test tools), Pedal tab only
  mode: "live", // the bank view's source: "live" or "backup" (the read-only Backup Browser)
  backupSource: null, // the open backup (src/core/backup-source.js), read only
  diffOnly: false, // the open backup: show only the banks that differ from the pedal
  compareLogged: null, // "file sha:read number" of the comparison last written to the log
  bannerDetails: false, // the open backup's Details (format, checksums, date)
  mapShown: stored(MAP_KEY) !== "0", // the bank map (on unless hidden)
  panelHidden: stored(PANEL_KEY) === "1", // wide screens: the patch panel opens over the banks instead of docking
};
let grid = null;
let bankMap = null;
let seenBanks = null;

function latest() {
  return state.snapshots[state.snapshots.length - 1] ?? null;
}

/** The live pedal's view model (stored aside while a backup is shown). */
const liveView = () => (ui.mode === "live" ? ui.view : viewState.live.view);

/** Rebuild the model from the latest read, then render. */
function refreshView() {
  const live = buildBankView(latest(), { activeSlot: state.device?.activeSlot ?? null, writable: isWritableSlot });
  if (ui.mode === "backup") {
    // A backup is on screen: update the live view in the background, leave the backup as shown.
    viewState.live = { ...viewState.live, view: live, group: null };
    ui.compare = computeCompare(); // a new live read: compare with it (automatic; no pedal access)
    renderModeChrome();
    renderGrid();
    return;
  }
  ui.group = null; // the data changed: any highlighted group is out of date
  ui.view = live;
  runQuery();
  renderSearchBar();
  renderGrid();
}

function renderGrid() {
  grid.render(ui.view, {
    selected: selection.slots, search: ui.search, onlyMatching: ui.onlyMatching, focus: ui.focus,
    marks: ui.mode === "live" ? state.writeMarks : new Map(), group: ui.group,
    absentText: ui.mode === "backup" ? "not in this backup" : "—",
    compare: ui.mode === "backup" && ui.compare ? ui.compare.result.slots.map(compareMark) : null,
    // U-H3-3: in a backup, the tiles and bank notes describe the BACKUP; the marks describe the pedal now.
    unusedNote: ui.mode === "backup" ? "all unused in this backup" : "all unused",
    sourceLabel: ui.mode === "backup" ? "In this backup" : null,
    diffOnly: ui.mode === "backup" && !!ui.compare && ui.diffOnly,
  });
  bankMap.render(ui.view, selection.slots);
  renderSelection();
  renderSummaryPanel();
}

/** Redesign V1: show or hide the bank map, and dock or hide the patch panel (wide screens). Layout only. */
function setLayout(key, value) {
  ui[key] = value;
  try {
    localStorage.setItem(key === "mapShown" ? MAP_KEY : PANEL_KEY, value ? "1" : "0");
  } catch {
    // a per-viewer convenience only
  }
  if (key === "panelHidden") ui.summaryOpen = false; // docking or undocking starts with the drawer closed
  applyLayout();
  renderSummaryPanel();
}

function applyLayout() {
  $("bank-map").hidden = !ui.mapShown;
  $("btn-map").setAttribute("aria-pressed", ui.mapShown ? "true" : "false");
  $("btn-panel").setAttribute("aria-pressed", ui.panelHidden ? "false" : "true");
  document.querySelector(".lib").classList.toggle("map-off", !ui.mapShown);
  document.body.classList.toggle("panel-undocked", !docked());
  watchBanks();
}

const MAP_SIDE = window.matchMedia("(min-width: 900px)");
/**
 * The map marks the banks on screen only while it sits beside them. On narrower screens it is a strip that scrolls
 * away, so the marks would show nothing, and on a phone they cost scrolling smoothness (measured, V2).
 */
function watchBanks() {
  seenBanks.disconnect();
  const on = MAP_SIDE.matches && ui.mapShown;
  for (let b = 1; b < grid.cards.length; b++) {
    if (on) seenBanks.observe(grid.cards[b]);
    else bankMap.cells[b].classList.remove("in-view");
  }
}

/** The bank map: go to a bank's card. */
function goToBank(bank) {
  const card = document.querySelector(`.card[data-bank="${bank}"]`);
  card.scrollIntoView({ block: "start" });
  card.classList.remove("flash");
  void card.offsetWidth; // restart the highlight
  card.classList.add("flash");
}

function renderSelection() {
  const list = selection.list();
  const n = list.length;
  let text = "Nothing selected";
  if (n === 1) text = `Selected: ${slotToDisplayLabel(list[0])}`;
  else if (n > 1 && n <= 6) text = `${n} selected: ${list.map(slotToDisplayLabel).join(", ")}`;
  else if (n > 6) text = `${n} selected (${slotToDisplayLabel(list[0])} … ${slotToDisplayLabel(list[n - 1])})`;
  $("selinfo").textContent = ui.selectMode ? `Select mode: tap patches to add or remove them. ${text}.` : text;
  $("selbar").hidden = n === 0 && !ui.selectMode;
  $("btn-clear-sel").disabled = n === 0;
  updateButtons();
}

function onTile(slot, e) {
  if (ui.selectMode) selection.toggle(slot);
  else if (e.type === "keydown") selection.click(slot, { ctrl: true, shift: e.shiftKey });
  else selection.click(slot, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
  ui.focus = slot;
  renderGrid();
  // A plain click or tap shows the summary (docked on wide screens, a drawer or sheet otherwise);
  // select mode and Ctrl/Shift multi-selection do not pop it open.
  if (!ui.selectMode && !(e.ctrlKey || e.metaKey || e.shiftKey)) openSummary(slot);
  else if (docked()) {
    ui.summarySlot = slot;
    renderSummaryPanel();
  }
}

/** Touch-friendly selection: in select mode each tap adds or removes a patch. */
function setSelectMode(on) {
  ui.selectMode = on;
  $("btn-select-mode").setAttribute("aria-pressed", on ? "true" : "false");
  $("btn-select-mode").textContent = on ? "Done selecting" : "Select";
  renderGrid();
}

function onLongPress(slot) {
  if (!ui.selectMode) setSelectMode(true);
  selection.toggle(slot);
  ui.focus = slot;
  renderGrid();
}

function onBankCheck(bank) {
  selection.toggleBank(bank);
  renderGrid();
}

const WIDE = window.matchMedia("(min-width: 1280px)");
const docked = () => WIDE.matches && !ui.panelHidden;
/** V3: the empty patch panel says what it is for. */
const PANEL_EMPTY = ["Click a patch to see it here, with Copy, Move and Swap.",
  "Ctrl-click or Shift-click to select several: the selection bar backs them up."];

function renderSummaryPanel() {
  const slot = ui.summarySlot;
  if (ui.mode === "backup") {
    renderBackupSummary(slot);
  } else {
    const s = slot === null ? null : patchSummary(ui.view, latest(), slot);
    if (s?.read && !ui.view.slots[slot].unused) {
      const m = crossMatches(ui.view.slots[slot].nkey, { exclude: "live" }); // within the pedal, DUP shows the group
      if (m.length) s.matchText = `Same patch also: ${m.join("; ")}.`;
    }
    if (s?.read) s.exactHint = exactHint(slot);
    renderSummary($("summary-body"), s, actionsFor("patch", { read: slot !== null && ui.view.slots[slot].read, connected: state.connected, unused: slot !== null && ui.view.slots[slot].unused, demo: DEMO, slot }),
      (id) => doAction(id, "patch", slot), onGroup, { empty: PANEL_EMPTY, kinds: slot === null ? [] : [...new Set(ui.view.slots[slot].irNam.map((d) => d.kind))] });
  }
  $("summary").classList.toggle("open", ui.summaryOpen && slot !== null);
  $("sum-title").textContent = slot === null ? "Patch" : `Patch · ${slotToDisplayLabel(slot)}`; // V3 decision 1
}

/** A2: on narrow screens a tap outside the summary closes it (a tap on another patch shows that one instead). */
function onOutsideSummary(e) {
  if (!ui.summaryOpen || docked() || !gridShown()) return;
  const t = e.target;
  if (!(t instanceof Element) || t.closest("#summary, .tile, .menu, dialog")) return;
  closeSummary();
}

/** Highlight a duplicate group. */
function highlightGroup(slots) {
  ui.group = new Set(slots);
  renderGrid();
  setStatus(`Duplicate group: ${slots.map(slotToDisplayLabel).join(", ")} hold the same patch content. Esc clears the highlight.`);
}

function clearGroup() {
  if (!ui.group) return false;
  ui.group = null;
  renderGrid();
  return true;
}

function onDup(slot) {
  highlightGroup(duplicateGroup(ui.view, slot));
  ui.focus = slot;
  openSummary(slot);
}

function onGroup(how, slots) {
  if (how === "select") {
    selection.set(slots);
    renderGrid();
  } else {
    highlightGroup(slots);
  }
}

/** B2: where the exact backup of one patch is. */
function exactHint(slot) {
  const l = slotToDisplayLabel(slot);
  return selection.size === 1 && selection.has(slot)
    ? `Exact backup of this patch (.zip): use "Back up ${l} (exact)…" in the selection bar.`
    : `Exact backup of this patch (.zip): select it, then use "Back up ${l} (exact)…" in the selection bar.`;
}

function openSummary(slot) {
  ui.summarySlot = slot;
  ui.summaryOpen = true;
  renderSummaryPanel();
}

function closeSummary() {
  ui.summaryOpen = false;
  renderSummaryPanel();
}

function onMenu(kind, id, anchor) {
  if (ui.mode === "backup") {
    onBackupMenu(kind, id, anchor);
    return;
  }
  if (kind === "patch") {
    const s = ui.view.slots[id];
    openMenu(anchor, `${s.label}${s.read ? ` · ${s.unused ? "unused" : s.name || "(no name)"}` : ""}`,
      actionsFor("patch", { read: s.read, connected: state.connected, unused: s.unused, demo: DEMO, slot: id }), (a) => doAction(a, "patch", id));
  } else {
    const b = ui.view.banks[id - 1];
    openMenu(anchor, `Bank ${id}`, actionsFor("bank", { anyRead: b.anyRead, connected: state.connected, demo: DEMO, bank: id, writableBanks: WRITABLE_BANKS }),
      (a) => doAction(a, "bank", id));
  }
}

/** Run an action from a menu or the summary. No action writes to the pedal (src/core/actions.js). */
function doAction(id, kind, target) {
  switch (id) {
    case "summary":
      ui.focus = target;
      renderGrid();
      openSummary(target);
      break;
    case "export-prst":
      exportLivePrst(target);
      break;
    case "save-template":
      saveLiveAsTemplate(target);
      break;
    case "select-bank":
      selection.clickBank(target);
      renderGrid();
      break;
    case "backup-bank":
      backup(bankSlots(target));
      break;
    case "copy-to":
    case "move-to":
    case "swap-with":
      startOperation(id, [target]);
      break;
    case "rename":
      startRename(target);
      break;
    case "clear":
      if (!state.busy && state.device && state.connected) runOperation({ kind: "clear", slot: target }); // the preview is the confirmation
      break;
    case "copy-bank-to":
    case "move-bank-to":
    case "swap-bank-with":
      startBankOperation(id, target);
      break;
    default:
      log.warn(`Action "${id}" is not available in this version`);
  }
}

/** The find field (U8): a name search, plus Go to slot when the text is a slot label. */
function runQuery() {
  const q = interpretQuery(ui.view, $("search").value);
  ui.search = q.search;
  ui.goto = q.goto;
  ui.badSlot = q.badSlot;
}

function applySearch() {
  runQuery();
  if (ui.focus !== null && ui.search.active && !ui.search.matches.includes(ui.focus)) ui.focus = null;
  renderSearchBar();
  renderGrid();
}

function renderSearchBar() {
  const r = ui.search;
  const n = r?.active ? r.matches.length : 0;
  const names = !r?.active ? "" : n === 0 ? "No matching names"
    : `${n} match${n === 1 ? "" : "es"}`;
  // A slot-shaped label out of range is said plainly, next to the field (not as an error elsewhere).
  $("search-count").textContent = ui.badSlot ? `Not a slot: banks are 1–64, positions A–D (e.g. 36-A). ${names}` : names;
  $("btn-match-prev").hidden = n === 0;
  $("btn-match-next").hidden = n === 0;
  $("only-matching-wrap").hidden = !r?.active;
  const go = $("btn-goto");
  go.hidden = ui.goto === null || ui.goto === undefined;
  if (!go.hidden) go.textContent = `Go to ${slotToDisplayLabel(ui.goto)}`;
  go.title = go.hidden ? "" : "Enter";
}

/** Bring a slot into view and focus its tile. */
function showSlot(slot) {
  ui.focus = slot;
  renderGrid();
  const t = grid.tiles[slot];
  t.scrollIntoView({ block: "center", behavior: "smooth" });
  t.focus({ preventScroll: true });
}

/** Step to the next (dir 1) or previous (dir -1) search match. */
function stepSearch(dir) {
  const next = stepMatch(ui.search ?? { matches: [] }, ui.focus, dir);
  if (next !== null) showSlot(next);
}

/** Go to the slot typed in the find field (U8): select it and bring it into view. */
function goToSlot() {
  const slot = ui.goto;
  if (slot === null || slot === undefined) return;
  selection.click(slot, {});
  showSlot(slot);
  setStatus(`${slotToDisplayLabel(slot)}: ${ui.view.slots[slot].read ? ui.view.slots[slot].name || "(no name)" : "not read yet"}`);
}

// ---- status ----------------------------------------------------------------
function setConn(stateName, text, detail = "") {
  const pill = $("conn-pill");
  pill.dataset.state = stateName;
  pill.textContent = text;
  $("conn-detail").textContent = detail;
}

/** "Pedal on 36-A" when known (recorded only; it never changes what the app does in S0). */
function renderActiveSlot(a) {
  $("active-slot").textContent = !state.device ? "" : a
    ? `· pedal on ${slotToDisplayLabel(a.slot)}${a.external ? " (changed on the pedal)" : ""}`
    : "· pedal on: unknown";
  setActiveSlot(liveView(), a ?? null); // the ▶ marker; no re-analysis
  if (grid) renderGrid();
}

/**
 * The status line, the same on every tab. An error is shown plainly, with
 * Details (the log, on request) and a "Problem" marker in the sticky tabs, so
 * it is seen even when the page is scrolled. The log never opens by itself.
 */
function setStatus(text, kind = "") {
  const s = $("status");
  s.textContent = text;
  s.className = `status ${kind}`;
  const err = kind === "err";
  $("btn-status-details").hidden = !err;
  $("btn-problem").hidden = !err;
  $("btn-problem").title = err ? text : "";
}

/** Show the log (More ▾ → Show log) with the latest problems in view. */
function showLogDetails() {
  ui.logShown = true;
  renderPlaces();
  $("logbox").open = true;
  flushLogPanel();
  $("logbox").scrollIntoView({ block: "start" });
}

/** V2 status strip: the latest read, in plain words (no read numbers, brief 3.5). Messages stay in the status line. */
function renderStrip(snap) {
  const n = snap ? snap.dumps.filter(Boolean).length : 0;
  const el = $("strip-read");
  el.textContent = !snap ? "Not read yet" : `${n}/256 read`;
  if (!snap) return;
  const when = document.createElement("span");
  when.className = "strip-when";
  when.textContent = ` at ${new Date(snap.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (${(snap.elapsedMs / 1000).toFixed(1)} s)`;
  el.append(when);
}

/**
 * V2: the write notice as a button. A click (on phones, where only its shield shows) opens the full notice,
 * built from the button's own text and explanation, so the two can never differ.
 */
function toggleGuard(open = $("guard-pop").hidden) {
  const btn = $("btn-guard");
  const pop = $("guard-pop");
  if (open && !pop.firstChild) {
    const p = (cls, text) => { const e = document.createElement("p"); e.className = cls; e.textContent = text; return e; };
    pop.append(p("guard-head", btn.querySelector("strong").textContent), p("guard-sub", btn.querySelector("span").textContent), p("guard-why", btn.title));
  }
  pop.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

function setProgress(done, total) {
  $("progress").hidden = total === 0;
  $("progress-fill").style.width = total ? `${(100 * done) / total}%` : "0";
}

function updateButtons() {
  const snap = latest();
  renderStrip(snap);
  // The pedal's state for styling and the browser checks: off | busy | ready.
  document.body.dataset.pedal = !state.connected ? "off" : state.busy ? "busy" : "ready";
  $("btn-connect").disabled = state.busy || state.connected;
  $("btn-connect").hidden = state.connected; // U10: Connect until connected; then the status pill says it
  $("btn-backup").disabled = state.busy || !snap || !isComplete(snap);
  $("btn-backup-sel").disabled = state.busy || !snap || selection.size === 0;
  $("btn-backup-sel").textContent = backupSelectedLabel(selection.list()); // B2: "Back up 36-A (exact)…"
  // S3.2: Copy / Move / Swap the selected patches; demo pedal only, live pedal only.
  for (const b of ["btn-sel-copy", "btn-sel-move", "btn-sel-swap"]) {
    $(b).disabled = !DEMO || ui.mode !== "live" || state.busy || !state.connected || selection.size === 0;
    $(b).title = !DEMO ? "Demo mode only, for now" : "";
    $(b).hidden = selection.size < 2; // V4 Option A: one patch's actions are in the patch panel; the bar keeps Back up and Clear
  }
  $("btn-cancel").hidden = !state.busy;
  // S3.1 slice 6: Check and recover reads the pedal, so it needs the connection (and is idle-only).
  $("btn-recovery-check").disabled = state.busy || !state.connected;
  $("btn-recovery-check").title = state.connected ? "" : "Connect first: the pedal is read before anything is decided";
  const one = selection.size === 1 ? selection.list()[0] : null;
  // While a backup is shown the Scratch tools are disabled: their selection is the live one.
  $("btn-copy").disabled = ui.mode !== "live" || state.busy || !state.connected || !snap || one === null;
  $("btn-undo").disabled = ui.mode !== "live" || state.busy || !state.connected || !state.undo;
  renderUndo();
  // S3.2 slice 4: Undo of the latest Copy/Move/Swap (patch or bank). E1: on the real pedal, state.engineUndo
  // is only ever a single-patch Copy, Move or Swap (refreshEngineUndo).
  $("btn-engine-undo").disabled = ui.mode !== "live" || state.busy || !state.connected || !state.engineUndo;
  renderEngineUndo();
  $("copy-source").textContent = one === null
    ? (selection.size ? "Select exactly one patch to copy" : "Select one patch to copy")
    : `${slotToDisplayLabel(one)} "${slotInfo(snap, one).name ?? "?"}"`;
}

/**
 * Contextual Undo (UI-4, brief 3.6): on the Pedal tab, worded for the operation,
 * and hidden when there is nothing to undo. Only the most recent copy can be undone.
 */
function renderUndo() {
  const u = state.undo;
  $("undo-bar").hidden = !u;
  const btn = $("btn-undo");
  btn.textContent = u ? `Undo copy to ${slotToDisplayLabel(u.dest)}` : "Undo last copy";
  if (!u) return;
  const was = u.before ? displayName(u.before) : "";
  $("undo-text").textContent = `Your last copy changed ${slotToDisplayLabel(u.dest)}. Undo puts back what was there before` +
    (was ? ` ("${was}")` : "") + "." + (!state.connected ? " Connect first." : state.busy ? " Wait for the current operation to finish." : "");
}

/**
 * S3.2 slice 4: contextual Undo for a Copy/Move/Swap (one patch, several, or a whole bank), separate
 * from the legacy bar above. Hidden when there is nothing to undo; worded for the operation. Only the
 * single most recent operation can be undone (findUndoable: not a redo, no multi-level History yet).
 */
function renderEngineUndo() {
  const r = state.engineUndo;
  $("engine-undo-bar").hidden = !r;
  const btn = $("btn-engine-undo");
  btn.textContent = r ? `Undo: ${r.action ?? r.title ?? "last operation"}` : "Undo";
  if (!r) return;
  $("engine-undo-text").textContent = `Your last operation: ${r.action ?? r.title}. Undo puts back what every slot it wrote held before, ` +
    "if nothing has changed since." + (!state.connected ? " Connect first." : state.busy ? " Wait for the current operation to finish." : "");
}

/** S3.2 slice 4: refresh the latest-undoable record from the operations store. E1: on the real pedal, only
 *  a verified single-patch Copy, Move, Swap or Rename made by the engine (realPedalUndoable). */
async function refreshEngineUndo() {
  try {
    const r = findUndoable(await operationsStore.all());
    state.engineUndo = DEMO || realPedalUndoable(r) ? r : null;
  } catch {
    state.engineUndo = null; // fails closed: an unreadable store simply offers no Undo, never a stale one
  }
  updateButtons();
}

// ---- connect & read --------------------------------------------------------
// S3.1 slice 5: one tab controls the pedal. The connection lock is taken before any MIDI
// port is opened and held until disconnect; the browser drops it if the tab closes or
// crashes. Losing it is treated as a disconnect: the guard's permit is revoked at once.
const ownership = new PedalOwnership({
  locks: globalThis.navigator?.locks, names: LOCK_NAMES[stores.pedalKind], log,
  onLost: () => {
    disconnected();
    setStatus(OWNERSHIP_TEXT.lost, "err");
  },
});

async function connect() {
  state.busy = true;
  updateButtons();
  setConn("busy", "Connecting…");
  try {
    await ownership.acquire();
  } catch (e) {
    const msg = e instanceof OwnershipError ? e.message : `could not take control of the pedal: ${e.message}`;
    log.warn(`Connect refused: ${msg}`);
    setConn("err", "Not connected", e.code === "busy" ? "Another tab has the pedal" : "");
    setStatus(msg, "err");
    state.busy = false;
    updateButtons();
    return;
  }
  try {
    let io;
    if (DEMO) {
      const { FakePedal } = await import("../dev/fake-pedal.js");
      const { realisticDemoDumps } = await import("../dev/demo-patches.js");
      // &drift: the second read of 10-B returns one changed byte at a read-volatile position
      // (tail block entry 0 +6): RAW DUMP differs, PATCH CONTENT identical.
      // &drift=content: the changed byte is patch content (effect block 0, param 0) instead.
      const driftParam = new URLSearchParams(location.search).get("drift");
      const drift = driftParam !== null;
      const faults = (slot, n, chunks) => {
        if (!drift || slot !== 37 || n < 2) return chunks;
        // As a dump offset: file 0x466 (tail entry 0 +6), or file 0xAC (effect block 0, param 0).
        const at = (driftParam === "content" ? 0xac : 1126) - 0x28;
        const ci = Math.floor(at / 185);
        const c = Uint8Array.from(chunks[ci]);
        c[13 + 2 * (at - ci * 185) + 1] ^= 0x01; // low nibble
        return chunks.map((x, i) => (i === ci ? c : x));
      };
      const dumps = realisticDemoDumps(skeleton);
      // S3.1 review (&keep): the demo pedal keeps what was written to it across reloads of this tab, like a
      // real pedal does, so an interrupted operation can be checked after a "restart". Demo only.
      if (new URLSearchParams(location.search).has("keep")) demoKeep(dumps);
      const pedal = new FakePedal({ dumps, replyDelayMs: 1, faults });
      const send = pedal.output.send;
      pedal.output.send = (d) => { if (demoCrash.crashed) throw new Error("demo: the tab has crashed"); return send(d); };
      io = { input: pedal.input, output: pedal.output, inputName: "Demo pedal", outputName: "Demo pedal", access: null };
      state.demoPedal = pedal;
      globalThis.__gp200Demo = { pedal }; // demo only: lets the browser checks count what reached the (fake) pedal
      log.warn("DEMO MODE: simulated pedal with invented patches");
    } else {
      io = await openGp200(log);
      io.access.onstatechange = (e) => {
        const p = e.port;
        if (state.connected && (p.name === io.inputName || p.name === io.outputName) && p.state === "disconnected") {
          log.warn(`MIDI port "${p.name}" disconnected`);
          disconnected();
        }
      };
    }
    state.midi = io;
    state.device = new GP200({ input: io.input, output: io.output, log, onActiveSlot: renderActiveSlot });
    renderActiveSlot(null);
    await state.device.connect();
    state.connected = true;
    setConn("on", DEMO ? "Demo pedal" : "Connected", DEMO ? "" : io.inputName);
  } catch (e) {
    log.error(`Connect failed: ${e.message}`);
    ownership.release();
    setConn("err", "Not connected");
    setStatus(e.message, "err");
    state.busy = false;
    updateButtons();
    return;
  }
  state.busy = false;
  await readAllSlots();
}

function disconnected() {
  state.connected = false;
  state.device?.close(); // revokes any write permit
  ownership.release();
  state.device = null;
  state.cancel = true;
  renderActiveSlot(null);
  setConn("err", "Disconnected", "Reconnect the pedal and click Connect");
  updateButtons();
}

async function readAllSlots() {
  if (!state.device || state.busy) return;
  state.busy = true;
  state.cancel = false;
  updateButtons();
  const readNumber = state.snapshots.length + 1;
  setConn("busy", "Reading…", state.midi?.inputName ?? "");
  setProgress(0, 256);
  setStatus("Reading the pedal: all 256 patches…");
  let snap;
  try {
    snap = await readAll(state.device, {
      log, readNumber,
      onProgress: ({ done, total, slot }) => {
        setProgress(done, total);
        if (done % 8 === 0 || done === total) setStatus(`Reading the pedal: ${done} of ${total} (${slotToDisplayLabel(slot)})`);
      },
      isCancelled: () => state.cancel,
    });
  } catch (e) {
    log.error(`Read #${readNumber} failed: ${e.message}`);
    setStatus(`Reading the pedal failed: ${e.message}`, "err");
    state.busy = false;
    setProgress(0, 0);
    if (state.connected) setConn("on", DEMO ? "Demo pedal" : "Connected", state.midi?.inputName ?? "");
    updateButtons();
    return;
  }
  state.snapshots.push(snap);
  state.busy = false;
  setProgress(0, 0);
  if (state.connected) setConn("on", DEMO ? "Demo pedal" : "Connected", state.midi?.inputName ?? "");
  refreshView();

  const got = snap.dumps.filter(Boolean).length;
  const time = new Date(snap.startedAt).toLocaleTimeString();
  if (isComplete(snap)) {
    setStatus(`All 256 patches read at ${time} (${(snap.elapsedMs / 1000).toFixed(1)} s` +
      (snap.retried ? `; ${snap.retried} needed a second attempt` : "") + ")." +
      (snap.defaultCheck?.status === "absent" ? ` ${snap.defaultCheck.text}` : ""), "ok"); // design 7.3: said plainly when it matters
  } else {
    const why = snap.cancelled ? "stopped" : `${snap.errors.size} slot(s) could not be read`;
    setStatus(`Reading incomplete at ${time}: ${got} of 256 patches read (${why}).`, "err");
  }
  showReadCompare();
  updateButtons();
}

function showReadCompare() {
  const n = state.snapshots.length;
  if (n < 2) return;
  const a = state.snapshots[n - 2];
  const b = state.snapshots[n - 1];
  const rep = compareSnapshots(a, b);
  const text = formatSnapshotCompare(rep, a, b);
  state.lastReadCompare = text;
  const [rawVerdict, contentVerdict, ...stateVerdicts] = snapshotVerdicts(rep);
  const vs = `Read #${b.readNumber} vs read #${a.readNumber}`;
  // The log gets both verdicts, the volatile summary, and every patch-content difference;
  // the full byte list (volatile ones too) is in the panel and in "Save report".
  log.info(`${vs}: ${rawVerdict}; ${contentVerdict} ` +
    `(${rep.identical} identical, ${rep.differing.length} different, ${rep.unreadable.length} unreadable)`, { keep: true });
  for (const line of stateVerdicts) {
    if (line.startsWith("FINDING")) log.warn(`${vs}: ${line}`);
    else log.info(`${vs}: ${line}`, { keep: true });
  }
  if (rep.volatileBytes) {
    log.info(`${vs}: read-volatile differences: ` +
      rep.volatileSummary.map(([cls, bytes, slots]) => `${cls}: ${bytes} byte(s) in ${slots} slot(s)`).join("; "));
  }
  if (!rep.contentMatch) {
    for (const u of rep.unreadable) log.warn(`${vs}: ${slotToDisplayLabel(u.slot)} not readable in both reads`);
    for (const d of rep.differing) {
      if (d.lenA !== d.lenB) log.warn(`${vs}: ${slotToDisplayLabel(d.slot)} dump lengths differ, ${d.lenA} vs ${d.lenB}`);
      for (const x of d.content) {
        log.warn(`${vs}: PATCH CONTENT ${slotToDisplayLabel(d.slot)} file 0x${x.off.toString(16)}: ` +
          `${x.a?.toString(16) ?? "--"} -> ${x.b?.toString(16) ?? "--"} ${x.what}`);
      }
    }
  }
  const box = $("read-compare");
  box.hidden = false;
  box.className = `result ${rep.contentMatch ? "match" : "diff"}`;
  const technical = rep.rawMatch
    ? `${vs}: ${rawVerdict}, ${contentVerdict}. All 256 slots identical byte for byte (${rep.bytesCompared.toLocaleString()} bytes).`
    : rep.contentMatch
      ? `${vs}: ${contentVerdict.split(" (")[0]}. ${rawVerdict}: every other differing byte is at a documented ` +
        "read-volatile position (listed below)." + (stateVerdicts.length ? ` ${stateVerdicts.join(" ")}` : "")
      : `${vs}: ${contentVerdict}. ${rawVerdict}. Please save this report.`;
  // U-H3-2: a short headline in plain words; the technical report under Details (open only when something differs).
  // HS-3 fix: only patch-content (or length) differences and unreadable slots count; read-volatile and
  // state-dependent bytes differ in every slot on every read and are not a patch reading differently.
  const odd = [...rep.differing.filter((d) => d.content.length || d.lenA !== d.lenB).map((d) => d.slot), ...rep.unreadable.map((u) => u.slot)];
  $("read-compare-title").textContent = readCompareHeadline(rep, odd, stateVerdicts.length > 0);
  $("read-compare-details").open = !rep.contentMatch;
  $("read-compare-text").textContent = `${technical}\n\n${text}`;
}

/** The read-compare headline (U-H3-2): what a guitarist needs to know, without byte talk. */
function readCompareHeadline(rep, oddSlots, pedalDependent) {
  if (rep.contentMatch) {
    return "Read again: all your patches are the same as last time." +
      (pedalDependent ? " A few stored values follow the patch the pedal is on; that is expected (see Details)." : "");
  }
  const list = oddSlots.slice(0, 6).map(slotToDisplayLabel).join(", ") + (oddSlots.length > 6 ? ", …" : "");
  return `Read again: ${oddSlots.length} patch${oddSlots.length === 1 ? "" : "es"} read differently from last time (${list}). Please save this report.`;
}

// ---- backup ----------------------------------------------------------------
// Download links are NOT withdrawn on a timer: the browser may hold a download
// (a "multiple downloads" prompt, a save dialog, a scan) for longer, and a
// withdrawn link can never complete (H0, 2026-10-08). A link is withdrawn only
// when the same kind of download is made again (the log) or the page closes.
const liveDownloadUrls = new Set();
window.addEventListener("pagehide", () => {
  for (const url of liveDownloadUrls) URL.revokeObjectURL(url);
  liveDownloadUrls.clear();
});

/** Start a download of `blob`; `replaces` is the previous URL of the same kind, withdrawn now. */
function downloadBlob(fileName, blob, replaces = null) {
  if (replaces) {
    URL.revokeObjectURL(replaces);
    liveDownloadUrls.delete(replaces);
  }
  const url = URL.createObjectURL(blob);
  liveDownloadUrls.add(url);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  return url;
}

const ZIP = { mime: "application/zip", ext: ".zip" };
const TXT = { mime: "text/plain", ext: ".txt" };

/**
 * Save a file through the save dialog and confirm it on disk (save-file.js);
 * the old download is only the fallback. A failed attempt is retried on the
 * same file automatically (logged as WARN only); if the save still fails, the
 * user is offered "Try saving again" (a new save dialog) unless `offerRetry`
 * is false (the before-image has its own fail-closed dialog). Logs and returns
 * the outcome.
 * @returns {Promise<import("./save-file.js").SaveResult>}
 */
async function saveConfirmed(what, bytes, fileName, { mime, ext, description, fallback = (n, blob) => downloadBlob(n, blob), offerRetry = true }) {
  const onAttemptFailed = (a) => log.warn(`${what}: save attempt ${a.attempt} of ${a.of} (${a.name}) failed at the ${a.step} step` +
    `${a.errorName ? ` (${a.errorName})` : ""}: ${a.error}` +
    (a.retryInMs != null ? `; retrying the same file in ${a.retryInMs / 1000} s` : a.unusable ? `; not retried: ${a.unusable}` : ""));
  for (let dialogs = 1; ; dialogs++) {
    const r = await saveFile(bytes, fileName, { description, mime, ext, fallback, onAttemptFailed });
    const line = describeSave(what, r);
    if (r.status === "confirmed") log.info(line, { keep: true });
    else if (r.status === "failed") log.error(line);
    else log.warn(line);
    if (r.status !== "failed" || !offerRetry) return r;
    const go = await askChoice({
      title: `${what} not saved`,
      message: [line, "Try again with a new save dialog. Choosing a different folder (for example one under C:\\GP 200) may help."],
      choices: [{ value: "retry", label: "Try saving again", primary: true, focus: true }, { value: "close", label: "Close" }],
    });
    if (go !== "retry") return r;
    log.info(`${what}: "Try saving again" chosen (save dialog ${dialogs + 1})`);
  }
}

const saveKind = (r) => (r.status === "confirmed" ? "ok" : r.status === "unconfirmed" ? "" : "err");

/**
 * Read integrity (HS-3 follow-up): data from a read session with a timeout is used only after the slot read
 * right after each timeout has been re-read and found identical (core/read-integrity.js). Fails closed: not
 * connected, a failed re-read or a difference means NO; a failed session stays failed (read the pedal again).
 * @returns {Promise<boolean>} true when the session's data may be used
 */
async function ensureReadIntegrity(snap, what, { quiet = false } = {}) {
  let i = integrityOf(snap);
  if (i.status === "unverified") {
    if (!state.device || !state.connected || state.busy) {
      if (!quiet) setStatus(`${what} NOT made: ${i.text}, which needs the pedal connected and idle. Nothing was saved.`, "err");
      return false;
    }
    state.busy = true;
    updateButtons();
    setStatus(`${what}: ${i.text}…`);
    try {
      i = await verifyFollowUps(state.device, snap, { log });
    } finally {
      state.busy = false;
      updateButtons();
    }
  }
  if (i.status === "clean" || i.status === "verified") return true;
  if (!quiet) setStatus(`${what} NOT made: ${i.text}. Nothing was saved. Read the pedal again (More ▾), then try again.`, "err");
  return false;
}

async function backup(slots) {
  const snap = latest();
  if (!snap) return;
  if (!(await ensureReadIntegrity(snap, "Backup"))) return;
  const b = buildBackup(snap, slots, {
    skeleton, portName: state.midi?.inputName ?? null, identityReply: state.device?.identityReply ?? null, demo: DEMO,
  });
  if (!b.included.length) {
    setStatus("Nothing to back up: none of those slots were read.", "err");
    return;
  }
  const lv = liveView();
  if (!(await confirmBackup(b.included.map((s) => ({ slot: s, name: slotNameText(lv.slots[s]) })), { missing: b.missing, missingWhy: "could not be read" }))) {
    setStatus("Backup cancelled. Nothing was saved.");
    return;
  }
  log.info(`Backup ${b.fileName}: ${b.included.length} slot(s) from read #${snap.readNumber}` +
    (b.missing.length ? `; NOT included (unreadable): ${b.missing.map(slotToDisplayLabel).join(", ")}` : ""));
  const r = await saveConfirmed("Backup", b.bytes, b.fileName, { ...ZIP, description: "GP200 Librarian backup" });
  setStatus(`${describeSave("Backup", r)} (${b.included.length} patch${b.included.length === 1 ? "" : "es"})` +
    (b.missing.length ? `. WARNING: ${b.missing.length} unreadable slot(s) are missing from it.` : "."),
  b.missing.length ? "err" : saveKind(r));
}

/** A patch's name for lists: its name, "unused", or "(no name)". */
const slotNameText = (v) => (!v?.read ? "(not read)" : v.unused ? "unused" : v.name || "(no name)");

/** B3: say which patches go into the file, and that it is an exact Librarian .zip, before the save dialog. */
async function confirmBackup(included, opts) {
  const c = describeBackupChoice(included, opts);
  const go = await askChoice({
    title: c.title, message: c.lines,
    choices: [{ value: "save", label: c.ok, primary: true, focus: true }, { value: "cancel", label: "Cancel" }],
  });
  return go === "save";
}

/** 0.7.1: the backup folder's handle, or null (none set, or storage not available). */
async function backupFolder() {
  try {
    return (await stores.settings.get(FOLDER_KEY)) ?? null;
  } catch {
    return null;
  }
}

/** The before-image saved into the backup folder (0.7.1), or null when no folder is set. */
async function saveToBackupFolder(label, z) {
  const dir = await backupFolder();
  if (!dir) return null;
  const r = await saveToFolder(dir, z.bytes, z.fileName, { ...ZIP, description: "GP200 Librarian before-image",
    onAttemptFailed: (a) => log.warn(`${label}: automatic save attempt ${a.attempt} of ${a.of} (${a.name}) failed at the ${a.step} step: ${a.error}`) });
  const line = describeFolderSave(label, r);
  if (r.status === "confirmed") {
    log.info(line, { keep: true });
    setStatus(line, "ok");
  } else log.warn(line);
  return r;
}

const folderNote = (saved) => (saved?.method === "folder" ? ` Before-image saved and verified: ${saved.folder}\\${saved.name}.` : "");

/**
 * The before-image file of an engine write (Copy, Move, Swap, Undo, recovery): the backup folder first
 * (0.7.1), then the save dialog as before. Fails closed: null (nothing may be written) unless the file
 * was saved AND verified (beforeImageVerified); the user may only try saving again.
 */
async function saveOperationBeforeImage(what, plan, z) {
  const label = `Before-image for ${what}`;
  const saveIt = () => saveConfirmed(label, z.bytes, z.fileName, { ...ZIP, description: "GP200 Librarian before-image", offerRetry: false });
  let saved = await saveToBackupFolder(label, z);
  if (!beforeImageVerified(saved, z.bytes)) saved = await saveIt();
  while (!beforeImageVerified(saved, z.bytes)) {
    const choice = await askBeforeImageRetry(plan.steps.map((s) => s.label).join(", "), describeSave(label, saved));
    if (choice !== "retry") { setStatus(`${what}: cancelled. Nothing was written (no verified before-image file).`); return null; }
    saved = await saveIt();
  }
  return saved;
}

/** More ▾ → Backup folder… (0.7.1): choose, change or stop using the automatic before-image folder. */
async function showBackupFolder() {
  const dir = await backupFolder();
  const perm = dir ? await folderPermission(dir) : null;
  const now = !dir ? "No backup folder is set: each change to the pedal asks where to save its before-image."
    : perm === "granted" ? `Folder: ${dir.name}. Ready: before-images are saved here automatically.`
      : `Folder: ${dir.name}. Needs permission again (${perm}). Allow access now, or the browser asks at the next change.`;
  const own = !dir ? [{ value: "choose", label: "Choose folder…", primary: true, focus: true }]
    : [...(perm === "granted" ? [] : [{ value: "allow", label: "Allow access", primary: true, focus: true }]),
      { value: "choose", label: "Change folder…" }, { value: "stop", label: "Stop using this folder" }];
  const go = await askChoice({
    title: "Backup folder",
    message: [now,
      "Before every Copy, Move, Swap, Undo or recovery write, its before-image file is saved in this folder, then read back and checked. " +
      "If that fails, the save dialog opens as before. Nothing is written to the pedal without a verified before-image.",
      "Existing files are never replaced. The browser shows only the folder's name, not its full path. A folder such as C:\\GP 200\\Backups works well."],
    choices: [...own, { value: "close", label: "Close" }],
  });
  try {
    if (go === "choose") {
      if (typeof globalThis.showDirectoryPicker !== "function") { setStatus("This browser cannot keep a backup folder. Use Chrome or Edge.", "err"); return; }
      let h;
      try {
        h = await globalThis.showDirectoryPicker({ id: FOLDER_DIALOG_ID, mode: "readwrite" });
      } catch (e) {
        if (e?.name !== "AbortError") setStatus(`Backup folder NOT set: ${e?.message ?? e}`, "err");
        return;
      }
      await stores.settings.set(FOLDER_KEY, h);
      log.info(`Backup folder set: ${h.name}`, { keep: true });
      setStatus(`Backup folder set: ${h.name}. Before-images are saved there automatically.`, "ok");
    } else if (go === "allow") {
      const p = await renewPermission(dir);
      setStatus(p === "granted" ? `Backup folder ${dir.name}: access allowed.`
        : `Backup folder ${dir.name}: access not allowed (${p}). The save dialog is used instead.`, p === "granted" ? "ok" : "err");
    } else if (go === "stop") {
      await stores.settings.set(FOLDER_KEY, null);
      log.info("Backup folder no longer used", { keep: true });
      setStatus("Backup folder no longer used: each change asks where to save its before-image. No file was deleted.");
    }
  } catch (e) {
    setStatus(`Backup folder: the setting could not be saved (${e?.message ?? e})`, "err");
  }
}

/**
 * The before-image file was not saved and verified: nothing can be written
 * (fail closed, O1 2026-10-17). The user may only try saving again.
 * @returns {Promise<"retry"|"cancel">} "cancel" unless the user picks "Try saving again"
 */
function askBeforeImageRetry(slotLabel, saveLine) {
  $("nofile-why").textContent = saveLine;
  $("nofile-slot").textContent = slotLabel;
  const dlg = $("dlg-nofile");
  const form = dlg.querySelector("form");
  return new Promise((resolve) => {
    // Resolve once, as soon as the user chooses (as dialogs.js does): on the form's submit and
    // on Esc, with close as the fallback; headless Edge can hold back the close event.
    // Anything but "Try saving again" is "cancel": nothing is written.
    const end = (value) => {
      form.removeEventListener("submit", onSubmit);
      dlg.removeEventListener("cancel", onCancel);
      dlg.removeEventListener("close", onClose);
      if (dlg.open) dlg.close(value);
      resolve(value === "retry" ? "retry" : "cancel");
    };
    const onSubmit = (e) => { e.preventDefault(); end(e.submitter?.value ?? ""); };
    const onCancel = (e) => { e.preventDefault(); end(""); };
    const onClose = () => end(dlg.returnValue);
    form.addEventListener("submit", onSubmit);
    dlg.addEventListener("cancel", onCancel);
    dlg.addEventListener("close", onClose);
    dlg.returnValue = "";
    dlg.showModal();
    $("btn-nofile-cancel").focus();
  });
}

// ---- copy to scratch / undo (Phase 2) ------------------------------------------

/** Show the plan; resolve true only if the user ticks the overwrite box and clicks the write button. */
function askConfirm(plan) {
  const { title, lines } = describePlan(plan);
  const d = slotToDisplayLabel(plan.dest.slot);
  $("write-title").textContent = title;
  $("write-lines").replaceChildren(...lines.map((l) => Object.assign(document.createElement("li"), { textContent: l })));
  $("write-ack-text").textContent = `I understand that ${d} "${plan.dest.name}" will be overwritten.`;
  const ack = $("chk-write-ack");
  const go = $("btn-write-go");
  ack.checked = false;
  go.disabled = true;
  go.textContent = plan.op === "copy" ? `Overwrite ${d} now` : `Restore ${d} now`;
  const dlg = $("dlg-write");
  return new Promise((resolve) => {
    const onAck = () => { go.disabled = !ack.checked; };
    const onGo = () => { if (ack.checked) dlg.close("go"); };
    const onClose = () => {
      ack.removeEventListener("change", onAck);
      go.removeEventListener("click", onGo);
      dlg.removeEventListener("close", onClose);
      resolve(dlg.returnValue === "go" && ack.checked);
    };
    ack.addEventListener("change", onAck);
    go.addEventListener("click", onGo);
    dlg.addEventListener("close", onClose);
    dlg.returnValue = "";
    dlg.showModal();
  });
}

/** After a write, the grid shows what the pedal now holds (from the read-back). */
function updateSnapshotSlot(slot, dump) {
  const snap = latest();
  if (!snap || !dump) return;
  snap.dumps[slot] = Uint8Array.from(dump);
  snap.edited = [...new Set([...(snap.edited ?? []), slot])];
}

async function startCopy() {
  if (state.busy || !state.device || selection.size !== 1) return;
  const source = selection.list()[0];
  const dest = Number($("sel-dest").value);
  await runWrite(`Copy ${slotToDisplayLabel(source)} -> ${slotToDisplayLabel(dest)}`,
    () => prepareCopy(state.device, source, dest, { log }), [dest]);
}

async function startUndo() {
  if (state.busy || !state.device || !state.undo) return;
  await runWrite(`Undo on ${slotToDisplayLabel(state.undo.dest)}`, () => prepareUndo(state.device, state.undo, { log }), [state.undo.dest]);
}

const STEP_TEXT = {
  journal: "saving the before-image",
  recheck: "checking nothing changed since you confirmed",
  write: "WRITING (about 2 s; leave the pedal alone)",
  verify: "reading back to verify",
  "end-state": "end-state check",
};

async function runWrite(what, prepare, slots) {
  state.busy = true;
  updateButtons();
  // S3.1 slice 6: an unfinished operation blocks its slots until Check and recover resolves it;
  // an unreadable operation history blocks every write (fail closed).
  const clear = await writeClearance(operationsStore, journal, slots);
  if (!clear.ok) {
    log.warn(`${what}: refused: ${clear.message}`);
    setStatus(`${what}: ${clear.message}`, "err");
    state.busy = false;
    updateButtons();
    return;
  }
  setStatus(`${what}: reading the slots involved…`);
  let plan;
  try {
    plan = await prepare();
  } catch (e) {
    state.busy = false;
    updateButtons();
    const msg = e instanceof CopyError ? e.message : `could not prepare: ${e.message}`;
    log.warn(`${what}: ${msg}`);
    setStatus(`${what}: ${msg}`, "err");
    return;
  }
  const confirmed = DEMO && state.autoConfirm ? true : await askConfirm(plan);
  if (!confirmed) {
    log.info(`${what}: cancelled at the confirmation; nothing written`);
    setStatus(`${what}: cancelled. Nothing was written.`);
    state.busy = false;
    updateButtons();
    return;
  }
  const d = slotToDisplayLabel(plan.dest.slot);
  log.info(`${what}: confirmed by the user: ${describePlan(plan).title}`);
  // The before-image file comes first, before anything but reads is sent. It FAILS CLOSED
  // (O1, 2026-10-17): nothing is written unless the file was saved and verified on disk
  // (read back, size and SHA-256 of these exact bytes; beforeImageVerified). The IndexedDB
  // journal (executeWrite) stays the second, independent gate. Only the demo pedal's
  // auto-confirm switch (DEMO: the fake pedal, never MIDI) skips the save dialog.
  const z = journalZip(plan, { skeleton });
  const demoAuto = DEMO && state.autoConfirm;
  const saveBeforeImage = () => saveConfirmed(`Before-image of ${d}`, z.bytes, z.fileName, { ...ZIP, description: "GP200 Librarian before-image", offerRetry: false });
  let saved = demoAuto
    ? (downloadBlob(z.fileName, new Blob([z.bytes], { type: ZIP.mime })), { status: "unconfirmed", method: "download", name: z.fileName, bytes: z.bytes.length })
    : await saveBeforeImage();
  // Not verified: the user may try saving again (a new save dialog), or (default) write nothing.
  while (!demoAuto && !beforeImageVerified(saved, z.bytes)) {
    const choice = await askBeforeImageRetry(d, describeSave(`Before-image of ${d}`, saved));
    if (choice === "retry") {
      saved = await saveBeforeImage();
      continue;
    }
    log.info(`${what}: not written: the before-image file was not saved and verified`);
    setStatus(`${what}: cancelled. Nothing was written (no verified before-image file).`);
    state.busy = false;
    updateButtons();
    return;
  }
  if (!demoAuto && !beforeImageVerified(saved, z.bytes)) throw new Error("before-image gate: unreachable"); // fail closed
  // S3.1 slice 5: the operation lock (only the tab that controls the pedal), then the screen
  // wake lock. The wake lock is only a convenience: its failure is shown and changes nothing else.
  let operation;
  try {
    operation = await ownership.beginOperation();
  } catch (e) {
    log.warn(`${what}: not written: ${e.message}`);
    setStatus(`${what}: ${e.message} Nothing was written.`, "err");
    state.busy = false;
    updateButtons();
    return;
  }
  const wake = await requestWakeLock(globalThis.navigator?.wakeLock, log);
  const wakeNote = wake.held ? "" : ` ${OWNERSHIP_TEXT.wakeUnavailable}`;
  let result;
  try {
    result = await executeWrite(state.device, plan, {
      journal, log, onStep: (step) => setStatus(`${what}: ${STEP_TEXT[step] ?? step}…${wakeNote}`),
    });
  } catch (e) {
    state.busy = false;
    updateButtons();
    const msg = e instanceof CopyError ? e.message : `failed: ${e.message}`;
    log.error(`${what}: ${msg}`);
    setStatus(`${what}: ${msg}`, "err");
    showWriteResult({ aborted: msg, what });
    return;
  } finally {
    operation.end();
    await wake.release();
  }
  if (result.verify?.readBack) updateSnapshotSlot(plan.dest.slot, result.verify.readBack);
  state.writeMarks.set(plan.dest.slot, result.ok ? "written" : "write-failed");
  if (plan.op === "copy") state.undo = result.undo?.after ? result.undo : null;
  else if (result.ok) state.undo = null; // the original is back
  state.busy = false;
  refreshView();
  showWriteResult({ result, what });
  setStatus(result.ok ? `${what}: VERIFIED.` : `${what}: NOT VERIFIED. See the red panel and the log.`, result.ok ? "ok" : "err");
}

function showWriteResult({ result = null, aborted = null, what }) {
  const box = $("write-result");
  box.hidden = false;
  const L = [];
  // U-H3-2: a short headline; the technical detail under Details (open when it did not verify).
  if (aborted) {
    box.className = "result diff";
    $("write-result-title").textContent = `${what}: stopped before writing. ${aborted}`;
  } else {
    const p = result.plan;
    const d = slotToDisplayLabel(p.dest.slot);
    box.className = `result ${result.ok ? "match" : "diff"}`;
    $("write-result-title").textContent = result.ok
      ? (p.op === "copy"
        ? `Copied ${slotToDisplayLabel(p.source.slot)} "${p.source.name}" to ${d}, and checked it on the pedal.`
        : `${d} is back to "${p.write.name}", checked on the pedal.`)
      : `NOT VERIFIED: the ${p.op} to ${d} could NOT be confirmed. Do not assume it worked.`;
    L.push(result.ok ? `VERIFIED: ${d} was read back and checked (PATCH CONTENT).` : `NOT VERIFIED: the ${p.op} to ${d}.`);
    L.push(describePlan(p).title);
    if (result.error) L.push(`The write failed part-way: ${result.error}`);
    if (result.verify) {
      const v = result.verify;
      L.push(`Read-back: ${v.ok ? "PATCH CONTENT identical to the expected patch" : "PATCH CONTENT DIFFERENT"} ` +
        `(${v.reads} read(s)${v.matchedLate ? ", matched only on a re-read" : ""}${v.ok ? "" : `, ${v.consistency}`}).`);
      if (v.diff) {
        L.push(`Read-volatile differences (documented, not patch content): ${v.diff.volatile.length} byte(s).`);
        for (const x of v.diff.content) {
          L.push(`  PATCH CONTENT file 0x${x.off.toString(16)} ${x.what}: expected ${x.a?.toString(16)}, read ${x.b?.toString(16)}`);
        }
      }
    }
    if (result.endState) {
      const src = result.endState.sourceUnchanged;
      L.push(`End state: source ${src === null ? "n/a" : src ? "unchanged" : "CHANGED"}, ` +
        `${d} ${result.endState.destVerified ? "still verifies" : "does NOT verify"}.`);
      for (const pr of result.endState.problems) L.push(`  ${pr}`);
    }
    if (p.op === "copy" && state.undo) L.push(`Undo is available: it restores ${d} to "${p.dest.name}".`);
  }
  $("write-result-text").textContent = L.join("\n");
  $("write-result-details").hidden = !L.length;
  $("write-result-details").open = !aborted && !result.ok;
}

// ---- Backup Browser (Phase 3 S2): strictly read-only -------------------------
// A backup is shown in the same bank layout, clearly marked as a backup. It is
// read into memory once; the app holds no writable handle to the file, and
// every export makes a NEW file. Nothing here reads from or writes to the
// pedal: a backup is itself the immutable source (decision 2). Restore to
// the pedal is planned (More ▾ → What's coming), not in any menu.
const viewState = { live: null, backup: null }; // the view not on screen, kept aside

const freshCtx = (view) => ({ view, search: null, focus: null, summarySlot: null, summaryOpen: false, group: null, sel: [], anchor: null, compare: null });

function captureCtx() {
  return {
    view: ui.view, search: ui.search, focus: ui.focus, summarySlot: ui.summarySlot, summaryOpen: ui.summaryOpen, group: ui.group,
    sel: [...selection.slots], anchor: selection.anchor, compare: ui.compare,
  };
}

function applyCtx(c) {
  Object.assign(ui, { view: c.view, search: c.search, focus: c.focus, summarySlot: c.summarySlot, summaryOpen: c.summaryOpen, group: c.group,
    compare: c.compare ?? null });
  selection.slots = new Set(c.sel);
  selection.anchor = c.anchor;
}

/** Switch the bank view between the live pedal and the open backup. Each keeps its own selection, search focus and summary. */
function showMode(mode) {
  if (mode === ui.mode || (mode === "backup" && !viewState.backup)) return;
  viewState[ui.mode] = captureCtx();
  ui.mode = mode;
  applyCtx(viewState[mode]);
  viewState[mode] = mode === "live" ? null : viewState[mode];
  if (mode === "backup") ui.compare = computeCompare(); // the latest complete read, if any (U6: never a pedal read)
  if (ui.selectMode) setSelectMode(false);
  runQuery();
  renderSearchBar();
  renderGrid();
}

// ---- the three places (UI-1) -------------------------------------------------
const currentPlace = () => placeOf({ tab: ui.tab, backupOpen: !!ui.backupSource, sub: ui.backupSub, hasArchive: !!ui.backupSource?.archive });
/** The bank grid (and its keyboard shortcuts) is on screen. */
const gridShown = () => regionVisible("banks", currentPlace());

/** Go to a tab. Only an explicit choice of the user does this; no action switches tabs on its own. */
function showTab(tab) {
  if (tab === ui.tab) return;
  ui.scroll[ui.tab] = window.scrollY;
  ui.tab = tab;
  if (tab === "pedal") showMode("live");
  else if (tab === "backups" && ui.backupSource) showMode("backup");
  if (ui.selectMode) setSelectMode(false);
  if (tab === "templates") void loadTemplates().then(renderTemplates);
  renderModeChrome();
  window.scrollTo(0, ui.scroll[tab] ?? 0);
}

function setBackupSub(sub) {
  if (sub === ui.backupSub) return;
  ui.backupSub = sub;
  if (ui.selectMode) setSelectMode(false);
  renderModeChrome();
}

/** Show the regions the current place owns, hide the others (src/core/places.js). */
function renderPlaces() {
  const place = currentPlace();
  for (const el of document.querySelectorAll("[data-region]")) el.classList.toggle("place-hidden", !regionVisible(el.dataset.region, place));
  for (const t of ["pedal", "templates", "backups"]) $(`tab-${t}`).setAttribute("aria-selected", ui.tab === t ? "true" : "false");
  $("tab-templates").textContent = tplUi.list.length ? `Templates (${tplUi.list.length})` : "Templates";
  // "Backups (1 open)"; on phones "Backups (1)", so the tabs stay on one row.
  const tb = $("tab-backups");
  tb.textContent = "Backups";
  if (ui.backupSource) {
    const n = Object.assign(document.createElement("span"), { textContent: " (1" });
    n.append(Object.assign(document.createElement("span"), { className: "open-word", textContent: " open" }), ")");
    tb.append(n);
  }
  document.body.classList.toggle("view-backup", ui.tab === "backups" && !!ui.backupSource);
  $("logbox").hidden = !ui.logShown;
  $("btn-strip-log").setAttribute("aria-expanded", ui.logShown ? "true" : "false");
  $("scratch").hidden = !ui.testToolsShown;
}

/** Show or hide the bank-60 test tools (More ▾, Pedal tab only). */
function setTestTools(on) {
  ui.testToolsShown = on;
  renderPlaces();
  if (on) $("scratch").scrollIntoView({ block: "nearest" });
}

function renderModeChrome() {
  const src = ui.backupSource;
  const banner = $("backup-banner");
  banner.replaceChildren();
  if (src) {
    const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text });
    const small = (id, text, onClick, title = "") => {
      const b = el("button", "small", text);
      b.type = "button";
      b.id = id;
      if (title) b.title = title;
      b.addEventListener("click", onClick);
      return b;
    };
    // A3: one line says what this is; the comparison is the next line; the file's details are on request.
    const head = el("div", "bb-head", "");
    const kind = src.archive ? "Full backup" : src.type === "prst-file" ? ".prst file" : "Backup";
    const det = small("btn-bb-details", ui.bannerDetails ? "Details ▾" : "Details ▸", () => { ui.bannerDetails = !ui.bannerDetails; renderModeChrome(); },
      "The file's format, checksums, date and read number");
    det.classList.add("bb-link");
    det.setAttribute("aria-expanded", ui.bannerDetails ? "true" : "false");
    const another = small("btn-open-another", "", () => $("open-backup-file").click(), "Open another backup or .prst file");
    another.append(el("span", "", "Open"), el("span", "wide-only", " another file"), "…");
    head.append(el("strong", "bb-title", `${kind}: ${src.fileName}`), el("span", "bb-note", "not your pedal · read only"), det,
      another, small("btn-close-backup", "Close", closeBackup, "Close this backup (the file is not changed)"));
    banner.append(head);
    // The comparison with the pedal (U6): made automatically from the latest complete read of this
    // session. It never reads the pedal or sends anything to it; without a complete read it only says so.
    const cmp = el("div", "bb-compare", "");
    const counts = el("span", "bb-counts", ui.compare ? `Compared with ${COMPARED_WITH}: ${describeCounts(ui.compare.result.counts)}.` : compareUnavailableText());
    counts.id = "compare-counts";
    cmp.append(counts);
    if (ui.compare) {
      const lab = el("label", "bb-diff-only", "");
      const chk = Object.assign(document.createElement("input"), { type: "checkbox", id: "chk-diff-only", checked: ui.diffOnly });
      chk.addEventListener("change", () => setDiffOnly(chk.checked));
      lab.append(chk, " Show only differences");
      cmp.append(lab, small("btn-save-compare", "Save report", () => saveConfirmed("Comparison report",
        new TextEncoder().encode(`${compareReportText(ui.compare.result)}\n`), "gp200-librarian_backup-vs-live.txt", { ...TXT, description: "Report" })));
    }
    banner.append(cmp);
    // A Full Librarian backup: its parts are visible sub-tabs (no hidden "What's inside").
    if (src.archive) {
      const subs = el("div", "bb-subtabs", "");
      subs.setAttribute("role", "tablist");
      const n = { patches: src.slotCount, templates: src.archive.templates.length, history: src.archive.journal.length };
      for (const [sub, label] of [["patches", "Patches"], ["templates", "Templates"], ["history", "History"]]) {
        const b = small(`bsub-${sub}`, `${label} (${n[sub]})`, () => setBackupSub(sub));
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", ui.backupSub === sub ? "true" : "false");
        subs.append(b);
      }
      banner.append(subs);
    }
    // Technical details, on request (Details on the first line): the file's format, checksums, date and read number.
    const d = el("div", "bb-details", "");
    d.id = "bb-details";
    d.hidden = !ui.bannerDetails;
    const when = src.startedAt ? new Date(src.startedAt).toLocaleString() : "date unknown";
    for (const line of [
      src.infoText,
      `${src.readNumber ? `Read #${src.readNumber}, ` : ""}${when} · ${src.slotCount} slot(s)`,
      src.lossySlots ? `${src.lossySlots} slot(s) from .prst files: not exact (the .prst format zeroes a few stored values).` : "",
      ui.compare ? (DEMO ? `Compared with read #${ui.compare.liveRead} of the demo pedal (simulated, not your GP-200) in this session.`
        : `Compared with read #${ui.compare.liveRead} of your pedal in this session.`) : "",
      "Nothing here is written to the pedal or to the file.",
    ].filter(Boolean)) d.append(el("div", "bb-sub", line));
    banner.append(d);
  }
  renderBackupParts();
  renderPlaces();
  updateButtons();
}

/** Why there is no comparison yet (never a reason to talk to the pedal: U6). */
function compareUnavailableText() {
  if (!state.connected) return `Connect on the Pedal tab to compare this backup with ${COMPARED_WITH}.`;
  if (state.busy) return `The comparison with ${COMPARED_WITH} appears when the current read has finished.`;
  return "A complete read of the pedal is needed to compare (Pedal tab: More ▾ → Read pedal again).";
}

/** Show only the banks where the backup differs from the pedal. */
function setDiffOnly(on) {
  ui.diffOnly = on;
  renderGrid();
}

/** The Templates and History parts of an open Full Librarian backup (read only). */
function renderBackupParts() {
  const a = ui.backupSource?.archive;
  const tplRoot = $("backup-templates");
  const histRoot = $("backup-history");
  tplRoot.replaceChildren();
  histRoot.replaceChildren();
  if (!a) return;
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text });
  // Templates: listed, and imported only on request. Existing templates are never overwritten.
  tplRoot.append(el("h3", "", `Templates in this backup (${a.templates.length})`));
  tplRoot.append(el("p", "hint", "Import adds them to your templates in this browser. Templates you already have are never overwritten."));
  if (a.templates.length) {
    const imp = el("button", "primary", `Import into my templates (${a.templates.length})…`);
    imp.type = "button";
    imp.id = "btn-import-archive";
    imp.addEventListener("click", importArchiveTemplates);
    tplRoot.append(imp);
  }
  const tl = el("ul", "info-list", "");
  for (const t of a.templates) tl.append(el("li", "", `${t.name} · patch "${t.derived.patchName}" · ${isLossy(t) ? "from a .prst file (not exact)" : "exact"}`));
  if (!a.templates.length) tl.append(el("li", "", "(none)"));
  tplRoot.append(tl);
  // History: the archived journal. A record only: never Undo, never imported.
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : "?");
  histRoot.append(el("h3", "", `History in this backup (${a.journal.length})`));
  histRoot.append(el("p", "hint", "Past operations, for the record. Not used for Undo, and never imported."));
  const hl = el("ul", "info-list", "");
  const line = (j) => `${when(j.createdAt)} · ${j.op} · ${j.dest?.label ?? "?"}${j.source ? ` from ${j.source.label}` : ""} · ${j.state ?? ""}`;
  for (const j of a.journal) hl.append(el("li", "", line(j)));
  if (!a.journal.length) hl.append(el("li", "", "(none)"));
  histRoot.append(hl);
  if (!a.journal.length) return;
  // O2: where each entry came from. A short "demo" tag on the line; the evidence under Details.
  const src = ui.backupSource;
  void getDemoEvidence().then((ev) => {
    if (ui.backupSource !== src || !hl.isConnected) return; // re-rendered, or another backup opened meanwhile
    const cls = a.journal.map((j) => classifyHistoryEntry(j, ev));
    [...hl.children].forEach((li, i) => {
      if (!cls[i].tag) return;
      li.append(" · ", el("span", "badge history-demo", cls[i].tag));
      li.dataset.provenance = cls[i].provenance;
    });
    const det = el("details", "history-provenance", "");
    det.append(el("summary", "", "Details: where each entry came from"));
    const dl = el("ul", "info-list", "");
    a.journal.forEach((j, i) => dl.append(el("li", "", `${line(j)}: ${cls[i].detail}`)));
    det.append(dl);
    histRoot.append(det);
  });
}

/**
 * Compare the open backup with the latest complete live read (U6): no pedal access, ever; it uses the read
 * already made. Null without a complete read. Must be called while the backup is on screen (ui.view).
 */
function computeCompare() {
  const live = latest();
  if (ui.mode !== "backup" || !live || !isComplete(live) || !ui.backupSource) return null;
  const c = { liveRead: live.readNumber, result: compareWithLive(ui.backupSource, ui.view, live, liveView()) };
  const key = `${ui.backupSource.fileSha256}:${live.readNumber}`;
  if (ui.compareLogged !== key) {
    ui.compareLogged = key;
    log.info(`Backup Browser: ${ui.backupSource.fileName} vs live read #${live.readNumber} (automatic, no pedal access): ` +
      `${describeCounts(c.result.counts)}`, { keep: true });
  }
  return c;
}

/** Where else the same patch is (normalised key): the live pedal, the open backup, templates. */
function crossMatches(nkey, { exclude = null } = {}) {
  if (!nkey) return [];
  const out = [];
  if (exclude !== "live") for (const s of liveView().slots) if (s.read && !s.unused && s.nkey === nkey) out.push(`live ${s.label}`);
  const bview = ui.mode === "backup" ? ui.view : viewState.backup?.view;
  if (exclude !== "backup" && bview) for (const s of bview.slots) if (s.read && !s.unused && s.nkey === nkey) out.push(`backup ${s.label}`);
  for (const tpl of templatesMatching(tplUi.list, nkey)) out.push(`template "${tpl.name}"`);
  return out;
}

/** Open a backup .zip or a .prst file in the Backup Browser (read only). `dropped`: it came from a file drop. */
async function openBackupFile(file, { dropped = false } = {}) {
  let source;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    source = await openSource(bytes, file.name);
    source.fileSha256 = sha256Hex(bytes);
  } catch (e) {
    setStatus(`Could not open ${file.name}: ${e.message}`, "err");
    log.error(`Backup Browser: could not open ${file.name}: ${e.message}`);
    return;
  }
  const view = buildBankView(source, { writable: () => false });
  if (ui.mode === "backup") {
    ui.mode = "live"; // replace the open backup: go through live so the live context is kept
    applyCtx(viewState.live);
  }
  ui.backupSource = source;
  ui.backupSub = "patches";
  ui.diffOnly = false;
  viewState.backup = freshCtx(view);
  log.info(`Backup Browser: opened ${file.name} (${source.infoText}; ${source.slotCount} slot(s)); read only`, { keep: true });
  // Opened from the Backups tab (its own action) or dropped (routed here by type), so the backup is shown there.
  if (ui.tab !== "backups") ui.scroll[ui.tab] = window.scrollY;
  ui.tab = "backups";
  showMode("backup");
  renderModeChrome();
  window.scrollTo(0, 0);
  // A3: the banner says what it is and how it compares; the status line only says it was opened.
  setStatus(dropped ? `Dropped file opened in Backups: ${file.name}.` : `Opened ${file.name}.`, "ok");
}

// ---- file drop (UI-2, U7): a file dropped anywhere goes to the tab that owns it ----
// A backup or .prst opens in Backups; a template file is imported in Templates.
// The status line says where it went. Nothing is written and nothing is sent to the pedal.
const anyDialogOpen = () => !!document.querySelector("dialog[open]");
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");

function initDrop() {
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = anyDialogOpen() || state.busy ? "none" : "copy";
    document.body.classList.add("dropping");
  });
  window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) document.body.classList.remove("dropping");
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // never let the browser navigate to the file
    document.body.classList.remove("dropping");
    void dropFiles([...e.dataTransfer.files]);
  });
}

async function dropFiles(files) {
  if (anyDialogOpen()) return;
  if (state.busy) {
    setStatus("Wait for the current operation to finish, then drop the file again. Nothing was opened.", "err");
    return;
  }
  if (files.length !== 1) {
    setStatus(`Drop one file at a time (${files.length} were dropped). Nothing was opened.`, "err");
    return;
  }
  const file = files[0];
  let kind = null;
  if (/\.zip$/i.test(file.name)) {
    try {
      kind = (await loadBackup(new Uint8Array(await file.arrayBuffer()), file.name)).info.kind;
    } catch (e) {
      log.error(`Dropped file ${file.name} could not be read: ${e.message}`);
      setStatus(`Could not open the dropped file ${file.name}: ${e.message}`, "err");
      return;
    }
  }
  const dest = fileDestination({ name: file.name, kind });
  log.info(`Dropped file ${file.name}${kind ? ` (${kind})` : ""}: ${dest ? `to ${dest}` : "not a file the Librarian opens"}`);
  if (dest === "backups") await openBackupFile(file, { dropped: true });
  else if (dest === "templates") {
    showTab("templates");
    await importTemplateFile(file, { dropped: true });
  } else {
    setStatus(`${file.name} is not a file the Librarian opens (a backup .zip, a .prst, or a template .json). Nothing was opened.`, "err");
  }
}

/** Close the open backup; the Backups tab then offers to open another. */
function closeBackup() {
  showMode("live");
  ui.backupSource = null;
  ui.backupSub = "patches";
  viewState.backup = null;
  renderModeChrome();
}

/** The backup as a snapshot-like object for the summary and for extraction (raw slots only for extraction). */
function backupSnap(src, { rawOnly = false } = {}) {
  return {
    readNumber: src.readNumber ?? 0, startedAt: src.startedAt, errors: new Map(), state: src.state,
    dumps: rawOnly ? src.dumps.map((d, s) => (src.provenance[s] === "raw" ? d : null)) : src.dumps,
  };
}

function renderBackupSummary(slot) {
  const src = ui.backupSource;
  if (slot === null || !src) {
    renderSummary($("summary-body"), null, [], () => {});
    return;
  }
  const s = patchSummary(ui.view, backupSnap(src), slot);
  s.writableText = "This is a backup: nothing here is written to the pedal.";
  if (src.provenance[slot] === "prst") s.notes.unshift("From a .prst file (normalised): a few stored values were zeroed by the file format, so this is not an exact copy.");
  if (!s.read) s.status = "Not in this backup.";
  // U-H3-3: two named lines, "In this backup" and "On the pedal now" (when there is a comparison).
  const r = ui.compare?.result.slots[slot] ?? null;
  s.compareLines = compareLines(ui.view.slots[slot], r ? liveView().slots[slot] : null, r, { pedal: DEMO ? "the demo pedal" : "the pedal" });
  const m = s.read && !ui.view.slots[slot].unused ? crossMatches(ui.view.slots[slot].nkey, { exclude: "backup" }) : [];
  if (m.length) s.matchText = `Same patch also: ${m.join("; ")}.`;
  const fromPrst = src.provenance[slot] === "prst";
  if (s.read) s.exactHint = fromPrst ? "This slot came from a .prst file, so there is no exact copy of it in this backup." : exactHint(slot);
  renderSummary($("summary-body"), s, actionsFor("backup-patch", { present: !!src.dumps[slot], fromPrst }),
    (id) => doBackupAction(id, slot), onGroup, { kinds: [...new Set(ui.view.slots[slot].irNam.map((d) => d.kind))] });
}

function onBackupMenu(kind, id, anchor) {
  const src = ui.backupSource;
  if (kind === "patch") {
    const s = ui.view.slots[id];
    openMenu(anchor, `Backup ${s.label}${s.read ? ` · ${s.unused ? "unused" : s.name || "(no name)"}` : " · not in this backup"}`,
      actionsFor("backup-patch", { present: !!src.dumps[id], fromPrst: src.provenance[id] === "prst" }), (a) => doBackupAction(a, id));
  } else {
    const b = ui.view.banks[id - 1];
    // The Backup Browser is read-only: no bank write actions.
    const read = actionsFor("bank", { anyRead: b.anyRead }).filter((a) => a.id === "select-bank" || a.id === "backup-bank");
    openMenu(anchor, `Backup bank ${id}`, read, (a) => {
      if (a === "select-bank") doAction(a, "bank", id);
      else if (a === "backup-bank") extractFromBackup(bankSlots(id));
    });
  }
}

async function doBackupAction(id, slot) {
  const src = ui.backupSource;
  const label = slotToDisplayLabel(slot);
  const dump = src?.dumps[slot];
  switch (id) {
    case "backup-summary":
      ui.focus = slot;
      renderGrid();
      openSummary(slot);
      break;
    case "backup-export-prst":
      // The backup is the source: no pedal read (decision 2).
      await savePrst(prstForSlot(src, slot, skeleton), exportFileName(slot, dump), dump);
      break;
    case "backup-save-template":
      await saveAsTemplate({
        dump, defaultName: displayName(dump) || label,
        provenance: src.provenance[slot] === "prst" ? PROVENANCE.PRST : PROVENANCE.BACKUP,
        origin: {
          from: "backup", slot, label, backupFile: src.fileName, backupSha256: src.fileSha256,
          backupFormat: src.info.format, backupKind: src.info.kind, readNumber: src.readNumber, readAt: src.startedAt,
        },
      });
      break;
    default:
      log.warn(`Action "${id}" is not available in the Backup Browser`);
  }
}

/** A new selection backup made from the open backup's raw dumps (the original file is never touched). */
async function extractFromBackup(slots) {
  const src = ui.backupSource;
  const raw = slots.filter((s) => src.provenance[s] === "raw");
  const skipped = slots.length - raw.length;
  if (!raw.length) {
    setStatus("Nothing to back up: none of those slots has an exact copy in this backup (.prst only). Use Export for Valeton editor (.prst) instead.", "err");
    return;
  }
  const skippedSlots = slots.filter((s) => src.provenance[s] !== "raw");
  if (!(await confirmBackup(raw.map((s) => ({ slot: s, name: slotNameText(ui.view.slots[s]) })),
    { missing: skippedSlots, missingWhy: "no exact copy in this backup" }))) {
    setStatus("Backup cancelled. Nothing was saved.");
    return;
  }
  const b = buildBackup(backupSnap(src, { rawOnly: true }), raw, {
    skeleton, source: { backupFile: src.fileName, backupSha256: src.fileSha256, slots: raw.map(slotToDisplayLabel) },
  });
  log.info(`Backup Browser: new selection backup of ${raw.length} slot(s) from ${src.fileName}`);
  const r = await saveConfirmed("Backup (from the backup)", b.bytes, b.fileName, { ...ZIP, description: "GP200 Librarian backup" });
  setStatus(`${describeSave("Backup (from the backup)", r)}${skipped ? `. ${skipped} slot(s) not included (no exact copy in this backup)` : ""}.`, saveKind(r));
}

// ---- Full Librarian backup (Phase 3 S2) ----------------------------------------
/** Everything the Librarian owns: the latest complete read + templates + journal (archive) + settings. */
async function backupFull() {
  const snap = latest();
  if (!snap || !isComplete(snap)) {
    setStatus("Back up… needs a complete read of all 256 patches. Connect first, or read the pedal again (More ▾).", "err");
    return;
  }
  if (!(await ensureReadIntegrity(snap, "Backup"))) return;
  await loadTemplates();
  let journalEntries = [];
  try {
    journalEntries = await journal.all();
  } catch (e) {
    log.warn(`Full Librarian backup: the journal could not be read (${e.message}); it is not included`);
  }
  let stored = [];
  try {
    stored = (await stores.settings.all()).filter((x) => x.key !== FOLDER_KEY); // 0.7.1: a folder handle is not portable
  } catch {
    // settings are a convenience
  }
  // O2: a real pedal's backup holds real history only; demo entries (marked, or by evidence) stay in the
  // browser but are left out of the file, and listed in its info.json.
  const hist = historyForFullBackup(journalEntries, await getDemoEvidence(), { demo: DEMO });
  for (const x of hist.excluded) log.warn(`Full Librarian backup: journal entry ${x.id} (${x.op} ${x.dest}, ${x.createdAt}) left out: ${x.detail}`);
  journalEntries = hist.journal;
  let b;
  try {
    b = buildFullLibrarianBackup(snap, {
      skeleton, portName: state.midi?.inputName ?? null, identityReply: state.device?.identityReply ?? null, demo: DEMO,
      templateFiles: tplUi.list.map((t) => ({ id: t.id, bytes: templateFile(t).bytes })), journal: journalEntries,
      journalNotes: { pedalKind: stores.pedalKind, counts: hist.counts, excluded: hist.excluded },
      settings: { stored }, // V2: no longer the banks 1-32 setting (removed); older backups that carry it load unchanged
    });
  } catch (e) {
    setStatus(`Backup NOT made: ${e.message}`, "err");
    return;
  }
  log.info(`Full Librarian backup ${b.fileName}: read #${snap.readNumber}, ${tplUi.list.length} template(s), ` +
    `${journalEntries.length} journal entr${journalEntries.length === 1 ? "y" : "ies"} (archive)`, { keep: true });
  const r = await saveConfirmed("Backup", b.bytes, b.fileName, { ...ZIP, description: "GP200 Librarian full backup" });
  setStatus(`${describeSave("Backup", r)} (all 256 patches, ${tplUi.list.length} template${tplUi.list.length === 1 ? "" : "s"}, ` +
    `${journalEntries.length} history entr${journalEntries.length === 1 ? "y" : "ies"}` +
    `${hist.excluded.length ? `; ${hist.excluded.length} demo entr${hist.excluded.length === 1 ? "y" : "ies"} left out` : ""}).`, saveKind(r));
}

async function importArchiveTemplates() {
  const a = ui.backupSource?.archive;
  if (!a?.templates.length) return;
  const go = await askChoice({
    title: `Import ${a.templates.length} template(s)?`,
    message: [`From ${ui.backupSource.fileName}. Templates already here are never overwritten; a template with the same id but different content is added as a copy.`,
      "Only templates are imported. The history is not."],
    choices: [{ value: "import", label: "Import templates", primary: true, focus: true }, { value: "cancel", label: "Cancel" }],
  });
  if (go !== "import") return;
  const r = await importTemplates(templateStore, a.templates);
  log.info(`Imported templates from ${ui.backupSource.fileName}: ${r.added.length} added, ${r.skipped.length} already present, ${r.copied.length} copies`, { keep: true });
  setStatus(`Templates from ${ui.backupSource.fileName}: ${r.added.length} added, ${r.skipped.length} already present` +
    (r.copied.length ? `, ${r.copied.length} added as copies` : "") + ".", "ok");
  await loadTemplates();
}

// ---- templates and .prst export (Phase 3 S2) ----------------------------------
// Nothing here writes to the pedal. A LIVE patch is re-read (one read request)
// before it becomes a template or a .prst (decision 2); a backup or an existing
// template never causes a pedal read.
const templateStore = stores.templates;
const tplUi = { list: [], selectedId: null };
const PRST = { mime: "application/octet-stream", ext: ".prst" };

async function loadTemplates() {
  try {
    tplUi.list = await templateStore.all();
  } catch (e) {
    log.warn(`Templates could not be loaded from this browser's storage (${e.message})`);
    tplUi.list = [];
    // R3: say it plainly (e.g. an older tab blocks the update); "postponed" already has its own status.
    if (!/postponed/.test(e.message)) setStatus(`This browser's Librarian storage could not be opened: ${e.message}. Then reload this page.`, "err");
  }
  renderPlaces(); // the Templates tab shows the count
}

/**
 * S3.1: at start-up, list operations that did not finish (operations store,
 * plus the Phase 2 journal read-only). Read only: nothing is resumed, undone,
 * retried or written, to the browser's storage or to the pedal. A storage
 * failure is shown, never taken as "nothing unfinished".
 */
async function checkUnfinishedOperations() {
  const r = await checkUnfinished(operationsStore, journal);
  const box = $("recovery");
  if (!r.ok) {
    if (/postponed/.test(r.error)) return; // "Not now": the status line already says storage is unavailable
    log.error(`Start-up check: ${r.error}`);
    box.hidden = false;
    $("recovery-title").textContent = "Could not check for unfinished operations.";
    $("recovery-note").textContent = "This browser's Librarian storage could not be read, so an operation that was interrupted earlier " +
      "cannot be ruled out. Nothing has been written. Reload the page; if this stays, read the pedal and compare it with a backup.";
    $("recovery-text").textContent = r.error;
    renderPlaces();
    return;
  }
  log.info(`Start-up check: ${r.unfinished.length} unfinished operation(s) among ${r.counts.operations} operation record(s) and ` +
    `${r.counts.legacy} Phase 2 journal entr${r.counts.legacy === 1 ? "y" : "ies"} (read only; nothing resumed or written)`, { keep: true });
  if (!r.unfinished.length) {
    box.hidden = true;
    return;
  }
  recovery.unfinished = r.unfinished;
  for (const s of r.summaries) log.warn(formatRecoverySummary(s));
  const first = r.summaries[0];
  box.hidden = false;
  $("recovery-title").textContent = r.summaries.length === 1 ? first.headline
    : `${r.summaries.length} operations did not finish. The most recent: ${first.action}.`;
  $("recovery-note").textContent = [
    ...(r.summaries.length === 1 ? first.lines.slice(0, 2) : []),
    "Nothing will be resumed, undone or written automatically. These slots are blocked for new writes until you use " +
      "Check and recover (connect first).",
  ].join(" ");
  $("recovery-text").textContent = r.summaries.map(formatRecoverySummary).join("\n\n");
  $("recovery-details").open = r.summaries.some((s) => s.unknown.length || s.damaged);
  renderPlaces();
}

/** S3.1 slice 6: the unfinished operations last found, newest first. */
const recovery = { unfinished: [] };

/**
 * Check and recover the most recent unfinished operation: re-read its slots
 * (reads only, under the operation lock), show what was found, and record a
 * decision only if the user makes one. Nothing is written to the pedal.
 */
async function checkAndRecover() {
  const record = recovery.unfinished[0];
  if (!record || state.busy) return;
  if (!state.device || !state.connected) {
    setStatus("Check and recover: connect first. The pedal is read before anything is decided.", "err");
    return;
  }
  state.busy = true;
  updateButtons();
  setStatus(`Check and recover: reading the slots of ${record.action ?? "the operation"}…`);
  let check;
  try {
    check = await checkOperation(state.device, record, { ownership, log });
  } catch (e) {
    state.busy = false;
    updateButtons();
    setStatus(`Check and recover: ${e.message}`, "err");
    return;
  }
  state.busy = false;
  updateButtons();
  $("recovery-title").textContent = `Checked: ${check.action}`;
  $("recovery-note").textContent = check.lines[0];
  $("recovery-text").textContent = [...check.lines, "", "What you can do:",
    ...check.proposals.map((p) => `  ${p.available ? "•" : "–"} ${p.label}${p.available ? "" : " (not available yet)"}: ${p.why}`)].join("\n");
  $("recovery-details").open = true;
  const choices = check.proposals.filter((p) => p.available && p.id !== "leave")
    .map((p) => ({ value: p.id, label: p.label }));
  choices.push({ value: "leave", label: "Leave it unresolved for now", focus: true });
  const pick = await askChoice({ title: `Check and recover: ${check.action}`, message: [...check.lines, ...check.proposals
    .filter((p) => !p.available).map((p) => `${p.label}: ${p.why}`)], choices });
  if (!pick || pick === "leave") {
    setStatus("Check and recover: left unresolved. Nothing was written; these slots stay blocked for new writes.");
    return;
  }
  if (RECOVERY_WRITES[pick]) {
    await recoveryWrite(record, check, pick);
    return;
  }
  let acknowledge = false;
  if (check.heldOnlyInBackup.length) {
    const names = check.heldOnlyInBackup.map((h) => `"${h.name}" (from ${h.label})`).join(", ");
    acknowledge = (await askChoice({ title: "Not found in the affected slots", message: [`${names}: not found in the affected slots; ` +
      "it may exist elsewhere on the pedal. It stays in this operation's record and its before-image file. Nothing is deleted.",
    "Accept the pedal as it is now? This is recorded as \"accepted current state\", not as completed."],
    choices: [{ value: "yes", label: `I understand: accept it` }, { value: "no", label: "Cancel", focus: true }] })) === "yes";
    if (!acknowledge) {
      setStatus("Check and recover: cancelled. Nothing was recorded or written.");
      return;
    }
  }
  state.busy = true;
  updateButtons();
  try {
    await resolveOperation(state.device, operationsStore, record, check, { decision: pick, acknowledgeBackupOnly: acknowledge, ownership, log });
    setStatus(`Check and recover: "${OUTCOMES[pick]}" recorded for ${check.action}. Nothing was written to the pedal.`, "ok");
  } catch (e) {
    setStatus(`Check and recover: ${e instanceof RecoveryError ? e.message : `failed: ${e.message}`}`, "err");
  } finally {
    state.busy = false;
    updateButtons();
  }
  await checkUnfinishedOperations();
}

/**
 * S3.1 slice 7: a recovery write (Put everything back / Finish the operation).
 * Preview of every slot, explicit confirmation (and the tick box when a real
 * patch is replaced), a fresh before-image file confirmed on disk (fails
 * closed), then the normal executor with every gate. Never retried.
 */
async function recoveryWrite(record, check, kind) {
  const what = `${RECOVERY_WRITES[kind]}: ${check.action}`;
  let leaveOut = [];
  const unexpected = check.slots.filter((s) => s.written && s.found === "unexpected");
  if (kind === "put-back" && unexpected.length) {
    const keep = await askChoice({ title: "Slots with unexpected contents", message: [
      `${unexpected.map((s) => `${s.label} (now ${s.now})`).join(", ")} ${unexpected.length === 1 ? "holds" : "hold"} neither the original nor ` +
        "the planned patch. Put back overwrites them with their original; you can leave them as they are instead."],
    choices: [{ value: "leave", label: "Leave them as they are", focus: true }, { value: "include", label: "Put them back too" }] });
    if (!keep) { setStatus(`${what}: cancelled. Nothing was written.`); return; }
    if (keep === "leave") leaveOut = unexpected.map((s) => s.slot);
  }
  let plan;
  try {
    plan = buildRecoveryPlan(record, check, kind, { leaveOut });
  } catch (e) {
    setStatus(`${what}: ${e.message}`, "err");
    return;
  }
  const preview = previewPlan(plan);
  // The tick box is IN the preview: its write button stays disabled until ticked (askChoice `tick`).
  const go = await askChoice({ title: preview.headline, message: formatPreview({ ...preview, tickBox: null }).split("\n").slice(2),
    tick: preview.tickBox,
    choices: [{ value: "go", label: preview.confirmLabel, write: true }, { value: "cancel", label: "Cancel", focus: true }] });
  if (go !== "go") { setStatus(`${what}: cancelled. Nothing was written.`); return; }
  const confirmation = confirmPlan(plan, { confirmed: true, tickBoxAccepted: !!preview.tickBox });
  // A fresh before-image of these slots AS THEY ARE NOW, confirmed on disk. Fails closed.
  const z = planJournalZip(plan, { skeleton, title: what });
  const saved = await saveOperationBeforeImage(what, plan, z);
  if (!saved) return;
  const hooks = demoCrashHooks(); // demo only (&crash): a second interruption, during the recovery
  state.busy = true;
  updateButtons();
  let out;
  try {
    out = await runRecovery(state.device, plan, {
      store: operationsStore, history: journal, confirmation, beforeImage: { bytes: z.bytes, saved }, ownership, log,
      wakeLock: globalThis.navigator?.wakeLock,
      onProgress: (e) => { hooks.onProgress(e); if (e.phase === "step") setStatus(`${what}: step ${e.step + 1} of ${plan.steps.length}…`); },
    });
  } catch (e) {
    if (!demoCrash.crashed) setStatus(`${what}: ${e.message}`, "err");
    state.busy = false;
    updateButtons();
    return;
  }
  for (const s of out.result.steps) if (s.readBack) updateSnapshotSlot(s.slot, s.readBack);
  state.busy = false;
  refreshView();
  if (out.result.ok && out.resolution) setStatus(`${what}: done and verified. Recorded as "${out.resolution.outcome}".${folderNote(saved)}`, "ok");
  else if (out.result.ok) setStatus(`${what}: done and verified, but the decision could not be saved (${out.resolutionError}). Check it again.`, "err");
  else setStatus(`${what}: ${out.result.summary}. Nothing more was written; use Check and recover again.`, "err");
  await checkUnfinishedOperations();
  await refreshEngineUndo(); // a verified recovery write is itself a completed operation (S3.2 slice 4)
}

/**
 * A live slot's patch, re-read from the pedal now. If it differs from the
 * latest full read the user chooses (default: the fresh read). Null if not
 * possible or cancelled; then nothing is saved or exported.
 */
async function freshLiveDump(slot, what) {
  const label = slotToDisplayLabel(slot);
  if (!state.device || !state.connected) {
    setStatus(`${what}: connect first. A live patch is re-read before it is used.`, "err");
    return null;
  }
  if (state.busy) {
    setStatus(`${what}: wait for the current operation to finish.`, "err");
    return null;
  }
  state.busy = true;
  updateButtons();
  let fresh;
  try {
    fresh = (await state.device.readDump(slot)).decoded;
  } catch (e) {
    log.warn(`${what}: ${label} could not be re-read (${e.message})`);
    setStatus(`${what}: ${label} could not be re-read (${e.message}). Nothing was saved.`, "err");
    return null;
  } finally {
    state.busy = false;
    updateButtons();
  }
  log.info(`${what}: re-read ${label} from the pedal`);
  const snap = latest();
  const old = snap?.dumps[slot];
  if (old && !classifyDumpDiff(old, fresh).contentIdentical) {
    // The earlier version comes from the cached read: offered only if that read passes its integrity check.
    const earlierOk = await ensureReadIntegrity(snap, what, { quiet: true });
    const choice = await askChoice({
      title: `${label} has changed since the pedal was last read`,
      message: [`The patch in ${label} is not the same as when all patches were last read (it was probably edited on the pedal).`,
        earlierOk ? "Which version should be used?" : `The earlier version can not be used: ${integrityOf(snap).text}.`],
      choices: [{ value: "fresh", label: "Use it as it is now", primary: true, focus: true },
        ...(earlierOk ? [{ value: "latest", label: "Use the earlier version" }] : []), { value: "cancel", label: "Cancel" }],
    });
    if (choice === "latest" && !integrityOk(snap)) return null; // never an unverified or failed cached read
    if (choice === "latest") return { dump: Uint8Array.from(old), readNumber: snap.readNumber, readAt: snap.startedAt };
    if (choice !== "fresh") return null;
  }
  return { dump: fresh, readNumber: null, readAt: new Date().toISOString() };
}

/** Save `dump` as a template (asks for a name; warns about an identical template). No pedal access. */
async function saveAsTemplate({ dump, provenance, origin, defaultName }) {
  const name = await askText({
    title: "Save as Template", label: "Template name", value: defaultName,
    hint: `Source: ${provenanceText({ provenance })}. A template is kept by the Librarian, not on the pedal.`,
  });
  if (!name) return;
  await loadTemplates();
  const same = templatesMatching(tplUi.list, normalizedKey(dump));
  if (same.length) {
    const go = await askChoice({
      title: "This patch is already a template",
      message: `Identical to ${same.map((t) => `"${t.name}"`).join(", ")}. Save another copy anyway?`,
      choices: [{ value: "cancel", label: "Cancel", primary: true, focus: true }, { value: "save", label: "Save anyway" }],
    });
    if (go !== "save") return;
  }
  const t = createTemplate({ dump, name, provenance, origin: { ...origin, appVersion: APP_VERSION } });
  try {
    await templateStore.put(t);
  } catch (e) {
    setStatus(`Template NOT saved: ${e.message}`, "err");
    log.error(`Template "${name}" NOT saved: ${e.message}`);
    return;
  }
  await loadTemplates();
  log.info(`Template "${t.name}" saved (${t.provenance}, patch "${t.derived.patchName}")`, { keep: true });
  setStatus(`Template "${t.name}" saved: ${provenanceText(t)}.`, "ok");
}

/** Save a .prst file with confirmation, saying plainly that it is not an exact copy. */
async function savePrst(bytes, fileName, dump) {
  const r = await saveConfirmed("Export .prst", bytes, fileName, { ...PRST, description: "Valeton patch (.prst)" });
  const deps = irNamDependencies(dump);
  setStatus(`${describeSave("Export .prst", r)}. A .prst is Valeton's format and not an exact copy` +
    " (for an exact copy, select the patch and use Back up selected)." +
    (deps.length ? ` It refers to ${deps.map((d) => d.text).join(", ")} on this pedal; that data is not in the file.` : ""), saveKind(r));
}

async function exportLivePrst(slot) {
  const got = await freshLiveDump(slot, "Export .prst");
  if (got) await savePrst(exportPrst(got.dump, skeleton), exportFileName(slot, got.dump), got.dump);
}

async function saveLiveAsTemplate(slot) {
  const got = await freshLiveDump(slot, "Save as Template");
  if (!got) return;
  await saveAsTemplate({
    dump: got.dump, provenance: PROVENANCE.PEDAL, defaultName: displayName(got.dump) || slotToDisplayLabel(slot),
    origin: { from: "pedal", slot, label: slotToDisplayLabel(slot), readNumber: got.readNumber, readAt: got.readAt },
  });
}

// ---- the Templates panel ----
function templateMatches(t) {
  return crossMatches(t.derived.normalizedKey).filter((x) => !x.startsWith("template"));
}

function renderTemplates() {
  renderTemplateList($("tpl-list"), tplUi.list, {
    matches: templateMatches, selectedId: tplUi.selectedId,
    onOpen: (t) => { tplUi.selectedId = t.id; renderTemplates(); },
    onMenu: (t, anchor) => openMenu(anchor, `Template "${t.name}"`, actionsFor("template"), (id) => doTemplateAction(id, t)),
  });
  const t = tplUi.list.find((x) => x.id === tplUi.selectedId) ?? null;
  renderTemplateDetails($("tpl-details"), t, { matches: t ? templateMatches(t) : [] });
}

async function doTemplateAction(id, t) {
  try {
    if (id === "template-rename") {
      const name = await askText({ title: "Rename template", label: "Template name", value: t.name });
      if (name) await templateStore.put(renameTemplate(t, name));
    } else if (id === "template-notes") {
      const notes = await askText({ title: `Notes for "${t.name}"`, label: "Notes", value: t.notes, max: 500, ok: "Save notes" });
      if (notes !== null) await templateStore.put(setTemplateNotes(t, notes));
    } else if (id === "template-duplicate") {
      const d = duplicateTemplate(t);
      await templateStore.put(d);
      tplUi.selectedId = d.id;
    } else if (id === "template-export") {
      const f = templateFile(t);
      const r = await saveConfirmed(`Template "${t.name}"`, f.bytes, f.fileName, { mime: "application/json", ext: ".json", description: "GP200 Librarian template" });
      setStatus(describeSave(`Template "${t.name}"`, r), saveKind(r));
    } else if (id === "template-delete") {
      const go = await askChoice({
        title: `Delete template "${t.name}"?`, message: "This cannot be undone. Export it first if you may want it back.",
        choices: [{ value: "cancel", label: "Cancel", primary: true, focus: true }, { value: "delete", label: "Delete", write: true }],
      });
      if (go === "delete") {
        await templateStore.delete(t.id);
        log.info(`Template "${t.name}" deleted`, { keep: true });
        if (tplUi.selectedId === t.id) tplUi.selectedId = null;
      }
    }
  } catch (e) {
    setStatus(`Template: ${e.message}`, "err");
    log.error(`Template action ${id} failed: ${e.message}`);
  }
  await loadTemplates();
  renderTemplates();
}

async function exportAllTemplates() {
  await loadTemplates();
  if (!tplUi.list.length) {
    setStatus("No templates to export.");
    return;
  }
  const z = buildTemplatesZip(tplUi.list.map((t) => ({ id: t.id, bytes: templateFile(t).bytes })));
  const r = await saveConfirmed(`Templates (${tplUi.list.length})`, z.bytes, z.fileName, { ...ZIP, description: "GP200 Librarian templates" });
  setStatus(describeSave(`Templates (${tplUi.list.length})`, r), saveKind(r));
}

/** Import templates from a template file, a templates zip, a Full Librarian backup, or a .prst (marked lossy). */
async function importTemplateFile(file, { dropped = false } = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let records = [];
  try {
    if (/\.prst$/i.test(file.name)) {
      if (!isPrst(bytes)) throw new Error("not a 1224-byte .prst file");
      const dump = bytes.slice(0x28, 0x28 + 1176);
      const name = await askText({ title: "Import .prst as a template", label: "Template name", value: displayName(dump) || file.name,
        hint: "A .prst is Valeton's format and not an exact copy: this template will be marked \"not exact\", permanently." });
      if (!name) return;
      records = [createTemplate({ dump, name, provenance: PROVENANCE.PRST, origin: { from: "prst", fileName: file.name, appVersion: APP_VERSION } })];
    } else if (/\.zip$/i.test(file.name)) {
      const loaded = await loadBackup(bytes, file.name);
      if (!["templates", "full-librarian"].includes(loaded.info.kind)) {
        throw new Error("this is a backup of pedal patches, not of templates. Open it in the Backups tab to save patches from it as templates");
      }
      records = templatesFromLoaded(loaded);
    } else {
      records = [parseTemplateFile(bytes, file.name)];
    }
    const r = await importTemplates(templateStore, records);
    log.info(`Imported templates from ${file.name}: ${r.added.length} added, ${r.skipped.length} already present, ` +
      `${r.copied.length} added as copies (same id, different content)`, { keep: true });
    setStatus(`${dropped ? "Dropped file imported in Templates: " : "Templates from "}${file.name}: ${r.added.length} added, ` +
      `${r.skipped.length} already present` + (r.copied.length ? `, ${r.copied.length} added as copies` : "") + ".", "ok");
  } catch (e) {
    setStatus(`Could not import ${file.name}: ${e.message}`, "err");
    log.error(`Template import from ${file.name} failed: ${e.message}`);
  }
  await loadTemplates();
  renderTemplates();
}

// ---- compare backup files ----------------------------------------------------
async function runFileCompare() {
  const fa = $("cmp-a").files[0];
  const fb = $("cmp-b").files[0];
  const out = $("cmp-out");
  if (!fa || !fb) {
    out.textContent = "Pick two backup files first.";
    return;
  }
  out.textContent = "Comparing…";
  try {
    const A = await loadBackup(new Uint8Array(await fa.arrayBuffer()), fa.name);
    const B = await loadBackup(new Uint8Array(await fb.arrayBuffer()), fb.name);
    const text = formatCompareReport(compareBackups(A, B));
    state.lastFileCompare = text;
    out.textContent = text;
    $("btn-cmp-save").disabled = false;
    log.info(`Compared ${fa.name} with ${fb.name}: ${text.split("\n").slice(-2).join("; ")}`);
  } catch (e) {
    out.textContent = `Could not compare: ${e.message}`;
    log.error(`Backup compare failed: ${e.message}`);
  }
}

// ---- log file ----------------------------------------------------------------
async function saveLog() {
  const header = [
    `${APP_NAME} ${APP_VERSION}${DEMO ? " DEMO MODE" : ""}`,
    `Saved: ${new Date().toString()}`,
    `Browser: ${navigator.userAgent}`,
    `Page: ${location.href}`,
    `MIDI: ${state.midi ? `${state.midi.inputName} / ${state.midi.outputName}` : "not connected"}`,
    `Identity reply: ${state.device?.identityReply ? toHex(state.device.identityReply) : "none"}`,
    `Reads this session: ${state.snapshots.map((s) => `#${s.readNumber} ${s.startedAt} ${s.dumps.filter(Boolean).length}/256`).join("; ") || "none"}`,
  ];
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}_` +
    `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
  // Built from per-segment parts, encoded part by part: a large log never becomes one huge string.
  const enc = new TextEncoder();
  const parts = log.textParts(header).map((p) => enc.encode(p));
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  // Fallback download: the previous log's link is withdrawn only now (or when the page closes), never on a timer.
  const r = await saveConfirmed("Log", bytes, `gp200-librarian_log_${stamp}.txt`, {
    ...TXT, description: "GP200 Librarian log", fallback: (n, blob) => { lastLogUrl = downloadBlob(n, blob, lastLogUrl); },
  });
  setStatus(describeSave("Log", r), saveKind(r));
}
let lastLogUrl = null;

/** Show or hide the log (More ▾ → Show log, and the status strip's Log button). */
function toggleLog() {
  ui.logShown = !ui.logShown;
  renderPlaces();
  if (ui.logShown) {
    $("logbox").open = true;
    $("logbox").scrollIntoView({ block: "start" });
  }
}

// ---- More ▾ (UI-1): the rare actions of the current tab, then log and help ------
function openMore(anchor) {
  const items = moreItems(currentPlace(), { connected: state.connected, busy: state.busy, logShown: ui.logShown, testToolsShown: ui.testToolsShown });
  if (tabOf(currentPlace()) === "pedal") { // 0.7.1: added here, so src/core/places.js stays unchanged
    items.splice(items.findIndex((i) => i.id === "toggle-log"), 0,
      { id: "backup-folder", label: "Backup folder…", enabled: !state.busy, reason: state.busy ? "Wait for the current operation to finish" : null });
  }
  openMenu(anchor, "More", items, (id) => {
    if (id === "read-again") readAllSlots();
    else if (id === "test-tools") setTestTools(!ui.testToolsShown);
    else if (id === "backup-folder") showBackupFolder();
    else if (id === "compare-files") $("dlg-compare").showModal();
    else if (id === "toggle-log") toggleLog();
    else if (id === "save-log") saveLog();
    else if (id === "whats-coming") showWhatsComing();
    else if (id === "help") showHelp();
  });
}

/** More ▾ → What's coming (U3): planned actions are listed here, never in a menu. */
function showWhatsComing() {
  showInfo({
    title: "What's coming",
    sections: [
      { heading: "Planned, not available yet", lines: PLANNED.map((p) => `${p.label}: ${p.what}.`) },
      { heading: "Why not yet", lines: ["Each of these writes to the pedal. They arrive one stage at a time, each checked on the pedal before it is offered.",
        "Today the Librarian reads, backs up, compares and keeps templates. It never changes a patch on the pedal outside the bank-60 test tools."] },
    ],
  });
}

function showHelp() {
  showInfo({
    title: "GP200 Librarian: where things are",
    sections: [
      { heading: "Pedal", lines: ["Your GP-200 as it is now. Connect, then look through, select, search and back up its patches.",
        "Back up… saves everything (the 256 patches, your templates and the history) as one file. To back up only some patches, select them and use Back up selected.",
        "The find field searches patch names; type a slot such as 36-A and press Enter to go to it.",
        "Each patch has a ⋯ menu: summary, save as template, export."] },
      { heading: "Templates", lines: ["Complete patches kept by the Librarian in this browser, not on the pedal.",
        "Import and export them here."] },
      { heading: "Backups", lines: ["Open a backup file or a .prst file to look through it and compare it with your pedal. Read only.",
        "A full backup also shows its templates (to import) and its history (a record only)."] },
      { heading: "Dropping a file", lines: ["Drop a backup or .prst file onto the window to open it in Backups, or a template file to import it in Templates. Nothing is written to the pedal."] },
      { heading: "Undo", lines: ["After a change to the pedal -- a Test-tools copy, or a Copy, Move, Swap, Rename or Clear from a menu -- an Undo button " +
        "appears on the Pedal tab, saying what it undoes. Only the most recent change can be undone, and only while nothing else has " +
        "touched its slots since.", "On your GP-200 (not the demo), Copy, Move and Swap work on one patch at a time, between any slots, " +
        "Rename changes one patch's name in its own slot, Clear… puts the built-in default back in one slot, and a bank's menu copies, moves or swaps all four of its slots. " +
        "Several selected patches are demo mode only, for now."] },
      { heading: "More ▾", lines: ["Less common things: read the pedal again, compare two backup files, the log, and what's coming.",
        "Backup folder…, on the Pedal tab: choose a folder where each change's before-image file is saved automatically, without a save dialog.",
        "Test tools (bank 60), on the Pedal tab: a temporary development tool that copies one patch into bank 60 to check writing to the pedal."] },
    ],
  });
}

// ---- wiring ------------------------------------------------------------------
function init() {
  $("version").textContent = [APP_VERSION, BUILD.channel, BUILD.commit].filter(Boolean).join(" · ");
  if (BUILD.channel !== "LIVE") document.title = `${BUILD.channel} · ${document.title}`;
  $("demo-banner").hidden = !DEMO;
  if (DEMO) $("btn-connect").textContent = "Connect demo pedal";
  grid = createBankGrid({ low: $("banks-low"), high: $("banks-high"), onTile, onBankCheck, onMenu, onLongPress, onDup,
    onDrop, canDrag, dropInfo: (from, to) => ({ ok: Array.isArray(dropChoices(from, to)) }),
    // 0.9.1: auto-scroll edges: the band between the sticky tabs bar and the fixed status strip (tiles under them are hidden)
    dragEdges: () => ({ top: Math.max(0, $("place-tabs").getBoundingClientRect().bottom),
      bottom: Math.min(window.innerHeight, $("status-strip").getBoundingClientRect().top) }) });
  bankMap = createBankMap({ root: $("map-grid"), onBank: goToBank });
  $("btn-map").addEventListener("click", () => setLayout("mapShown", !ui.mapShown));
  $("btn-panel").addEventListener("click", () => setLayout("panelHidden", !ui.panelHidden));
  // V2: the map marks the banks on screen (only while it stays beside the banks; see watchBanks)
  seenBanks = new IntersectionObserver((es) => { for (const e of es) bankMap.cells[e.target.dataset.bank].classList.toggle("in-view", e.isIntersecting); });
  WIDE.addEventListener("change", applyLayout);
  MAP_SIDE.addEventListener("change", applyLayout);
  applyLayout();
  $("btn-strip-log").addEventListener("click", toggleLog);
  $("btn-guard").addEventListener("click", () => toggleGuard());
  document.addEventListener("pointerdown", (e) => { if (!$("guard-pop").hidden && !e.target.closest?.("#guard-pop, #btn-guard")) toggleGuard(false); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("guard-pop").hidden) toggleGuard(false); });
  $("btn-select-mode").addEventListener("click", () => setSelectMode(!ui.selectMode));
  $("btn-sum-close").addEventListener("click", closeSummary);
  document.addEventListener("pointerdown", onOutsideSummary, true);
  $("btn-backup").addEventListener("click", backupFull);
  $("btn-open-backup").addEventListener("click", () => $("open-backup-file").click());
  for (const t of ["pedal", "templates", "backups"]) $(`tab-${t}`).addEventListener("click", () => showTab(t));
  $("btn-more").addEventListener("click", (e) => openMore(e.currentTarget));
  $("open-backup-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) openBackupFile(file);
  });
  $("btn-tpl-export-all").addEventListener("click", exportAllTemplates);
  $("btn-tpl-import").addEventListener("click", () => $("tpl-import-file").click());
  $("tpl-import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) importTemplateFile(file);
  });
  loadTemplates();
  void checkUnfinishedOperations();
  void refreshEngineUndo();
  $("btn-recovery-close").addEventListener("click", () => { $("recovery").hidden = true; }); // hides only: resolves nothing
  $("btn-recovery-check").addEventListener("click", checkAndRecover);
  $("btn-engine-undo").addEventListener("click", engineUndo);
  navigator.storage?.persist?.().then((ok) => log.info(`Persistent browser storage ${ok ? "granted" : "not granted (templates could be cleared by the browser; export them)"}`))
    .catch(() => {});
  renderGrid();
  renderModeChrome(); // the Pedal tab, with only its own regions
  log.info(`${APP_NAME} ${APP_VERSION} ${BUILD.channel} ${BUILD.commit}${DEMO ? " (demo mode)" : ""}; ${navigator.userAgent}`);
  if (!DEMO && !webMidiAvailable()) {
    setStatus("This browser has no Web MIDI. Use Chrome or Edge on a computer (or open with ?demo to try the interface).", "err");
    $("btn-connect").disabled = true;
  }

  $("btn-connect").addEventListener("click", connect);
  $("btn-cancel").addEventListener("click", () => { state.cancel = true; });
  $("btn-status-details").addEventListener("click", showLogDetails);
  $("btn-problem").addEventListener("click", () => {
    $("status").scrollIntoView({ block: "center" });
    $("btn-status-details").focus({ preventScroll: true });
  });
  $("btn-compare-files").addEventListener("click", () => $("dlg-compare").showModal());
  initDrop();
  $("btn-backup-sel").addEventListener("click", () => (ui.mode === "backup" ? extractFromBackup(selection.list()) : backup(selection.list())));
  $("btn-clear-sel").addEventListener("click", () => { selection.clear(); renderGrid(); });
  $("btn-sel-copy").addEventListener("click", () => startOperation("copy-to", selection.list()));
  $("btn-sel-move").addEventListener("click", () => startOperation("move-to", selection.list()));
  $("btn-sel-swap").addEventListener("click", () => startOperation("swap-with", selection.list()));
  $("search").addEventListener("input", applySearch);
  $("search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // A slot label goes to that slot; otherwise Enter steps through the name matches.
      if (ui.goto !== null && ui.goto !== undefined && !e.shiftKey) goToSlot();
      else stepSearch(e.shiftKey ? -1 : 1);
    }
  });
  $("btn-goto").addEventListener("click", goToSlot);
  $("btn-match-next").addEventListener("click", () => stepSearch(1));
  $("btn-match-prev").addEventListener("click", () => stepSearch(-1));
  $("chk-only-matching").addEventListener("change", (e) => {
    ui.onlyMatching = e.target.checked;
    renderGrid();
  });
  $("chk-debug").addEventListener("change", (e) => { log.debugEnabled = e.target.checked; });
  $("btn-save-log").addEventListener("click", saveLog);
  logEl.addEventListener("click", (e) => toggleLogLine(e.target.closest?.("span")));
  $("btn-copy-problems").addEventListener("click", async () => {
    const text = log.problemsText();
    if (!text) {
      setStatus("No warnings or errors to copy.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`Copied ${text.split("\n").length} warning/error line(s) in full to the clipboard.`, "ok");
    } catch (e) {
      setStatus(`Could not copy to the clipboard (${e.message}). Save log contains them in full.`, "err");
    }
  });
  $("btn-read-compare-close").addEventListener("click", () => { $("read-compare").hidden = true; });
  $("btn-read-compare-save").addEventListener("click", () => saveConfirmed("Read-compare report",
    new TextEncoder().encode(state.lastReadCompare + "\n"), "gp200-librarian_read-compare.txt", { ...TXT, description: "Report" }));
  $("sel-dest").replaceChildren(...SCRATCH_SLOTS.map((slot) => Object.assign(document.createElement("option"), {
    value: String(slot), textContent: slotToDisplayLabel(slot),
  })));
  $("btn-copy").addEventListener("click", startCopy);
  $("btn-undo").addEventListener("click", startUndo);
  $("btn-write-result-close").addEventListener("click", () => { $("write-result").hidden = true; });
  $("btn-scratch-close").addEventListener("click", () => setTestTools(false));
  $("btn-cmp-run").addEventListener("click", runFileCompare);
  $("btn-cmp-save").addEventListener("click", () => saveConfirmed("Backup-compare report",
    new TextEncoder().encode(state.lastFileCompare + "\n"), "gp200-librarian_backup-compare.txt", { ...TXT, description: "Report" }));
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || $("dlg-compare").open || $("dlg-write").open || $("dlg-nofile").open || !gridShown()) return;
    if (e.key === "Escape" && ui.summaryOpen && !docked()) {
      closeSummary();
      return;
    }
    if (e.key === "Escape" && clearGroup()) return;
    if (e.key === "Escape") {
      selection.clear();
      if (ui.selectMode) setSelectMode(false);
      else renderGrid();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); selection.selectAll(); renderGrid(); }
  });
  updateButtons();
  if (DEMO) void demoScript(new URLSearchParams(location.search));
}

// ---- S3.1 end-of-stage review: demo-only switches (never in real mode) ----------------------
const DEMO_KEEP_KEY = "gp200-librarian-demo-pedal";

/** &keep: restore this tab's demo-pedal writes and keep recording them (sessionStorage; demo only). */
function demoKeep(dumps) {
  if (!DEMO) return;
  let kept = {};
  try { kept = JSON.parse(sessionStorage.getItem(DEMO_KEEP_KEY) ?? "{}"); } catch { kept = {}; }
  for (const [slot, bytes] of Object.entries(kept)) dumps.set(Number(slot), Uint8Array.from(bytes));
  if (Object.keys(kept).length) log.warn(`DEMO: the demo pedal keeps ${Object.keys(kept).length} slot(s) written earlier in this tab (&keep)`);
  const set = dumps.set.bind(dumps);
  dumps.set = (slot, dump) => {
    set(slot, dump);
    try {
      kept[slot] = Array.from(dump);
      sessionStorage.setItem(DEMO_KEEP_KEY, JSON.stringify(kept));
    } catch { /* demo convenience only */ }
    return dumps;
  };
}

/** &crash=upload-N | before-N: the next operation "crashes" the tab right after its Nth upload lands, or before step N. */
function demoArmCrash(spec) {
  const m = /^(upload|before)-(\d+)$/.exec(spec ?? "");
  if (!DEMO || !m) return;
  demoCrash.armed = { when: m[1], n: Number(m[2]) };
  log.warn(`DEMO: a crash is armed for the next operation (${spec})`);
}

/** Hooks for one executor run: they "crash" the tab when the armed moment comes. */
function demoCrashHooks() {
  const a = DEMO ? demoCrash.armed : null;
  if (!a) return { onProgress: () => {} };
  demoCrash.armed = null;
  const crash = (what) => {
    demoCrash.crashed = true; // from now on nothing reaches the demo pedal or the store, as in a dead tab
    log.warn(`DEMO: simulated crash ${what}; reloading`);
    const u = new URL(location.href);
    u.searchParams.delete("op");
    u.searchParams.delete("crash");
    location.replace(u.toString());
  };
  if (a.when === "upload") {
    let k = 0;
    state.demoPedal.onStore = () => {
      if (++k === a.n) crash(`after upload ${a.n} landed`);
      return undefined;
    };
  }
  return {
    onProgress: (e) => {
      if (a.when === "before" && e.phase === "step" && e.step === a.n - 1) {
        crash(`before step ${a.n}`);
        throw new Error("demo: the tab has crashed");
      }
    },
  };
}

/**
 * &op=copy:140-236 | move:236-237 | swap:237-238: one operation through the S3.1 engine on the demo
 * pedal, with the normal preview, confirmation, before-image file and executor (every gate).
 * Demo only: the S3.2 interface will offer these operations; this switch is for the S3.1 review.
 */
async function demoOperation(spec) {
  const m = /^(copy|move|swap|bank-copy|bank-move|bank-swap):(\d+)-(\d+)$/.exec(spec ?? "");
  if (!DEMO || !m || !state.device) return;
  const [kind, a, b] = [m[1], Number(m[2]), Number(m[3])];
  // bank-…:36-60 names banks (S3.2 slice 3); the planner refuses what the write zone does not allow.
  await runOperation(kind.startsWith("bank-") ? { kind, fromBank: a, toBank: b } : kind === "swap" ? { kind, a: [a], b } : { kind, from: [a], to: b });
}

/**
 * S3.2: Copy to… / Move to… / Swap with… for one patch (its menu) or the selected patches (the
 * selection bar: to consecutive slots from the chosen one). The destination is chosen in a
 * dialog that shows, as you type, what is there now. DEMO PEDAL ONLY: the real pedal waits for
 * its own hardware-approved gate (the controls are disabled there too).
 */
async function startOperation(id, sources, to = null) {
  if (!DEMO && (sources.length !== 1 || !realPedalSourceOk(id, sources[0]))) { // 0.6.0: one patch, any slot
    setStatus("On your GP-200, Copy, Move and Swap work on one patch at a time; several patches are demo mode only, for now.", "err");
    return;
  }
  if (state.busy || !state.device || !state.connected || !sources.length) return;
  const kind = { "copy-to": "copy", "move-to": "move", "swap-with": "swap" }[id];
  const verb = kind[0].toUpperCase() + kind.slice(1);
  const what = sources.length === 1 ? slotToDisplayLabel(sources[0]) : `${sources.length} patches (${slotRange(sources)})`;
  // V5 Lite: a drop already names the destination; it goes through the same validation as a typed one.
  const dropped = to === null ? null : describeDestination(kind, sources, slotToDisplayLabel(to));
  if (dropped && !dropped.ok) { setStatus(`${verb} ${what} to ${slotToDisplayLabel(to)}: ${dropped.text} Nothing was written.`, "err"); return; }
  const typed = dropped ? slotToDisplayLabel(to) : await askDestination({
    title: `${verb} ${what} ${kind === "swap" ? "with…" : "to…"}`,
    hint: (sources.length > 1 ? "Type the first slot; the others follow in order. " : "") +
      (kind === "swap" ? "The patches change places." : kind === "move" ? "The selected slots will be empty afterwards." : "The selected slots are not changed."),
    describe: (text) => describeDestination(kind, sources, text),
    ok: "Continue",
    picker: destinationPicker("slot", sources.length),
  });
  if (typed === null) return;
  const start = labelToSlot(typed);
  // The plan and its preview re-check everything.
  await runOperation(kind === "swap" ? { kind: "swap", a: sources, b: start } : { kind, from: sources, to: start });
}

/** V5 Lite: a mouse drag may start only on the live pedal, connected and idle. Real pedal since 0.9.0 (dropChoices,
 *  startOperation and runOperation apply the real-pedal policy). */
const canDrag = () => ui.mode === "live" && state.connected && !!state.device && !state.busy;

/**
 * V5 Lite: what the drop chooser offers for one patch dropped on another (docs/PHASE3_S3_BRIEF.md §3.2), or the
 * reason nothing is offered. Only the patch actions the registry enables (so the real-pedal policy applies).
 * Occupied destination: Swap first (it loses nothing), then Move and Copy. Unused destination: Move, Copy (no Swap).
 * Unused source onto a patch: Swap only (it moves that patch here). Two unused slots: nothing to do.
 */
function dropChoices(from, to) {
  const [a, b] = [ui.view?.slots?.[from], ui.view?.slots?.[to]];
  if (from === to || !a || !b) return "That is the same slot.";
  if (!a.read || !b.read) return "Read the pedal first: both slots must have been read.";
  const snap = latest();
  if (writeRefused(from, snap?.dumps[from] ?? null) || writeRefused(to, snap?.dumps[to] ?? null)) return STATE_REFUSAL;
  if (a.unused && b.unused) return "Both slots are unused: there is nothing to do.";
  const ok = new Set(actionsFor("patch", { read: true, connected: state.connected, demo: DEMO, slot: from })
    .filter((x) => x.enabled).map((x) => x.id));
  const [la, lb] = [a.label, b.label];
  const nb = `"${b.name || "(no name)"}"`;
  const all = a.unused ? [{ id: "swap-with", label: "Swap", text: `Swap: ${la} ⇄ ${lb}: ${nb} moves to ${la}; ${lb} becomes unused.` }]
    : [
      ...(b.unused ? [] : [{ id: "swap-with", label: "Swap", text: `Swap: ${la} ⇄ ${lb}: both patches kept.` }]),
      { id: "move-to", label: "Move", text: b.unused ? `Move: ${la} → ${lb}; ${la} becomes unused.` : `Move: ${lb} ${nb} is replaced; ${la} becomes unused.` },
      { id: "copy-to", label: "Copy", text: b.unused ? `Copy: ${la} → ${lb}; ${la} stays.` : `Copy: ${lb} ${nb} is replaced; ${la} stays.` },
    ];
  const offered = all.filter((c) => ok.has(c.id));
  return offered.length ? offered : "Copy, Move and Swap are not available here.";
}

/** V5 Lite: a patch dropped on another opens the chooser. The drop itself never writes; a choice runs startOperation. */
async function onDrop(from, to) {
  if (!canDrag()) return;
  const choices = dropChoices(from, to);
  const name = (s) => { const v = ui.view.slots[s]; return `${v.label}${v.unused ? " (unused)" : ` "${v.name || "(no name)"}"`}`; };
  log.info(`Drag: ${slotToDisplayLabel(from)} dropped on ${slotToDisplayLabel(to)}`);
  if (!Array.isArray(choices)) { setStatus(`${name(from)} on ${name(to)}: ${choices} Nothing was written.`, "err"); return; }
  const pick = await askChoice({
    title: `Drop ${name(from)} on ${name(to)}?`,
    message: [...choices.map((c) => c.text), "Nothing is written yet: the next step shows exactly what will change."],
    choices: [...choices.map((c, i) => ({ value: c.id, label: c.label, focus: i === 0 })), { value: "cancel", label: "Cancel" }],
  });
  if (!pick || pick === "cancel") { log.info("Drag: cancelled, nothing written"); return; }
  await startOperation(pick, [from], to);
}

/**
 * S3.3: Rename…, one patch, from its menu. Same destination-selector dialog shape as Copy/Move/
 * Swap, repurposed for a name instead of a slot. Real pedal since 0.8.0 (realPedalAllows in runOperation).
 */
async function startRename(slot) {
  if (state.busy || !state.device || !state.connected) return;
  const current = ui.view.slots[slot]?.name ?? "";
  const typed = await askDestination({
    title: `Rename ${slotToDisplayLabel(slot)}…`,
    field: "New name", placeholder: "e.g. Lead Tone",
    hint: `Up to ${NAME_LEN} characters: ${NAME_ALLOWED_DESCRIPTION}. Current name: "${current}".`,
    describe: (text) => describeRename(current, text),
    ok: "Continue",
  });
  if (typed === null) return;
  await runOperation({ kind: "rename", slot, name: typed });
}

/** What the rename dialog says about a typed name: usable or not, against the current name. */
function describeRename(current, text) {
  if (!text) return { ok: false, text: "Type a new name, up to 16 characters." };
  try {
    validateName(text);
  } catch (e) {
    return { ok: false, text: e.message };
  }
  if (text === current) return { ok: false, text: "That is the current name; nothing to change." };
  return { ok: true, text: `${text.length}/${NAME_LEN} characters.` };
}

/** E1: the first line of every real-pedal Copy/Move/Swap and Undo preview. */

/** Banks the write zone covers in full (all 64 since 0.6.0): what bank operations can write (S3.2 slice 3). */
const WRITABLE_BANKS = [...new Set(WRITABLE_SLOTS.map((s) => Math.floor(s / 4) + 1))].filter((b) => bankSlots(b).every(isWritableSlot));

/**
 * S3.2 slice 3: Copy bank to… / Move bank to… / Swap with bank… from a bank's menu. All four
 * positions, A-D, unused slots included, through the same runOperation as one patch. Real pedal
 * since 0.10.0 (runOperation's realPedalAllows still checks it). A bank Move or Swap writes both
 * banks; the menu, the selector and the planner all follow the write zone.
 */
async function startBankOperation(id, fromBank) {
  if (state.busy || !state.device || !state.connected) return;
  const kind = { "copy-bank-to": "copy", "move-bank-to": "move", "swap-bank-with": "swap" }[id];
  const verb = kind[0].toUpperCase() + kind.slice(1);
  const typed = await askDestination({
    title: kind === "swap" ? `Swap bank ${fromBank} with…` : `${verb} bank ${fromBank} to…`,
    field: "Destination bank", placeholder: "e.g. 60",
    hint: "All four slots, A to D, unused ones included. " + (kind === "copy" ? `Bank ${fromBank} is not changed.`
      : kind === "move" ? `Bank ${fromBank} will be unused afterwards.` : "The two banks change places."),
    describe: (text) => describeBankDestination(kind, fromBank, text),
    ok: "Continue",
    picker: destinationPicker("bank"),
  });
  if (typed === null) return;
  await runOperation({ kind: `bank-${kind}`, fromBank, toBank: parseBank(typed) });
}

/**
 * V4: what the visual picker shows, from the latest read. It only fills the destination field; the field's own
 * validation and the plan decide. Protected = the existing write-refusal list (by slot or by content), shown with a lock.
 */
function destinationPicker(mode, count = 1) {
  const snap = latest();
  return {
    mode, count, lockText: STATE_REFUSAL,
    slots: (bank) => bankSlots(bank).map((slot) => {
      const v = ui.view.slots[slot];
      return { slot, label: slotToDisplayLabel(slot), kind: !v?.read ? "unread" : v.unused ? "unused" : "real",
        name: v?.name || "(no name)", locked: writeRefused(slot, snap?.dumps[slot] ?? null) };
    }),
    parse: (text) => {
      if (mode === "bank") { const b = parseBank(text); return b === null ? null : { bank: b, slot: null }; }
      try { const slot = labelToSlot(text); return { bank: Math.floor(slot / 4) + 1, slot }; } catch { return null; }
    },
  };
}

/** "60" or "bank 60" -> 60; anything else -> null. */
function parseBank(text) {
  const m = /^(?:bank\s*)?(\d{1,2})$/i.exec(text.trim());
  const b = m ? Number(m[1]) : NaN;
  return b >= 1 && b <= 64 ? b : null;
}

/** What the bank selector says about a typed bank: usable or not, and what its four slots hold now. */
function describeBankDestination(kind, fromBank, text) {
  if (!text) return { ok: false, text: "Type a bank number, e.g. 60." };
  const to = parseBank(text);
  if (to === null) return { ok: false, text: `"${text}" is not a bank (banks are 1 to 64).` };
  if (to === fromBank) return { ok: false, text: "That is the same bank." };
  const writes = kind === "copy" ? bankSlots(to) : [...bankSlots(fromBank), ...bankSlots(to)];
  const ok = writes.every(isWritableSlot);
  const why = ok ? "" : " Not writable.";
  return { ok, text: `Now: ${slotsNow(bankSlots(to))}.${why}` };
}

const slotRange = (slots) => (slots.length === 1 ? slotToDisplayLabel(slots[0])
  : `${slotToDisplayLabel(slots[0])}…${slotToDisplayLabel(slots[slots.length - 1])}`);

/**
 * What the destination selector says about a typed first slot: usable or not, and what the
 * destination slots hold now (latest read). The plan re-checks everything from fresh reads.
 */
function describeDestination(kind, sources, text) {
  if (!text) return { ok: false, text: "Type a slot, e.g. 40-A." };
  let start;
  try { start = labelToSlot(text); } catch { return { ok: false, text: `"${text}" is not a slot (e.g. 40-A).` }; }
  const dests = sources.map((_, i) => start + i);
  if (dests.at(-1) > 255) return { ok: false, text: `${sources.length} patches starting at ${slotToDisplayLabel(start)} would run past 64-D.` };
  if (dests.every((d, i) => d === sources[i])) return { ok: false, text: "That is the same slot." };
  if (kind === "swap" && dests.some((d) => sources.includes(d))) return { ok: false, text: "Swap slots must be outside the selection." };
  const ok = dests.every(isWritableSlot);
  return { ok, text: `Now: ${slotsNow(dests)}.${ok ? "" : " Not writable."}` };
}

/** "60-A unused, 60-B "Lead"" from the latest read. */
const slotsNow = (slots) => slots.map((d) => {
  const t = ui.view?.slots?.[d];
  return `${slotToDisplayLabel(d)} ${!t?.read ? "not read yet" : t.unused ? "unused" : `"${t.name || "(no name)"}"`}`;
}).join(", ");

/**
 * One operation through the S3.1 engine: write clearance, fresh reads, plan, Now → After
 * preview, confirmation (and the tick box if a real patch is replaced), the before-image file
 * confirmed on disk, then the executor with every gate. Demo pedal only (S3.2).
 * `op` is the planner's operation: {kind: "copy"|"move", from, to}, {kind: "swap", a, b}, or
 * {kind: "bank-copy"|"bank-move"|"bank-swap", fromBank, toBank} (slice 3).
 */
async function runOperation(op) {
  if (!state.device) return;
  if (!DEMO && !realPedalAllows(op)) { // 0.6.0: one patch, Copy, Move or Swap, between any two slots; 0.8.0: Rename; 0.10.0: banks; 0.11.0: Clear
    log.warn(`Refused on the real pedal (only one-patch Copy, Move, Swap, Rename and Clear, and bank Copy, Move and Swap are enabled): ${JSON.stringify(op)}`);
    setStatus("Refused: on your GP-200 only Copy, Move, Swap, Rename and Clear of one patch, and bank Copy, Move and Swap, are enabled. Nothing was written.", "err");
    return;
  }
  const bank = op.kind.startsWith("bank-");
  const kind = bank ? op.kind.slice(5) : op.kind;
  const arrow = kind === "swap" ? "⇄" : "→";
  let sources, dests, what;
  try {
    if (op.kind === "rename") {
      sources = dests = [op.slot];
      what = `Rename ${slotToDisplayLabel(op.slot)} to "${op.name}"`;
    } else if (op.kind === "clear") {
      sources = dests = [op.slot];
      what = `Clear ${slotToDisplayLabel(op.slot)}`;
    } else {
      sources = bank ? bankSlots(op.fromBank) : op.kind === "swap" ? op.a : op.from;
      const start = op.kind === "swap" ? op.b : op.to;
      dests = bank ? bankSlots(op.toBank) : sources.map((_, i) => start + i);
      what = `${kind[0].toUpperCase()}${kind.slice(1)} ` + (bank ? `bank ${op.fromBank} ${arrow} bank ${op.toBank}` : `${slotRange(sources)} ${arrow} ${slotRange(dests)}`);
    }
  } catch (e) {
    setStatus(`${kind}: ${e.message}`, "err");
    return;
  }
  // As the Test tools do: an unfinished operation blocks its slots before anything is read or previewed.
  const writes = kind === "copy" || kind === "rename" || kind === "clear" ? dests : [...sources, ...dests];
  const clear = await writeClearance(operationsStore, journal, writes);
  if (!clear.ok) {
    setStatus(`${what}: ${clear.message}`, "err");
    return;
  }
  let plan;
  try {
    const dumps = new Map();
    for (const slot of new Set([...sources, ...dests].filter((s) => s >= 0 && s <= 255))) {
      dumps.set(slot, (await state.device.readDump(slot)).decoded); // fresh reads of every slot involved
    }
    plan = buildPlan(op, dumps, { moveClearAllowed: !!latest()?.defaultCheck?.moveClearAllowed, log });
  } catch (e) {
    setStatus(`${what}: ${e.message}`, "err");
    return;
  }
  const preview = previewPlan(plan);
  // The tick box is IN the preview: its write button stays disabled until ticked (askChoice `tick`).
  const go = await askChoice({ title: preview.headline, message: formatPreview({ ...preview, tickBox: null }).split("\n").slice(2),
    tick: preview.tickBox,
    choices: [{ value: "go", label: preview.confirmLabel, write: true }, { value: "cancel", label: "Cancel", focus: true }] });
  if (go !== "go") { setStatus(`${what}: cancelled. Nothing was written.`); return; }
  const confirmation = confirmPlan(plan, { confirmed: true, tickBoxAccepted: !!preview.tickBox });
  const z = planJournalZip(plan, { skeleton, title: what });
  const saved = await saveOperationBeforeImage(what, plan, z);
  if (!saved) return;
  const hooks = demoCrashHooks();
  state.busy = true;
  updateButtons();
  let result;
  try {
    result = await executePlan(state.device, plan, {
      confirmation, beforeImage: { bytes: z.bytes, saved }, journal: operationsStore, history: journal, log, ownership,
      wakeLock: globalThis.navigator?.wakeLock,
      onProgress: (e) => { hooks.onProgress(e); if (e.phase === "step") setStatus(`${what}: step ${e.step + 1} of ${plan.steps.length}…`); },
    });
  } catch (e) {
    state.busy = false;
    updateButtons();
    if (!demoCrash.crashed) setStatus(`${what}: ${e.message}`, "err");
    return;
  }
  for (const st of result.steps) if (st.readBack) updateSnapshotSlot(st.slot, st.readBack);
  state.busy = false;
  refreshView();
  setStatus(result.ok ? `${what}: done and verified.${folderNote(saved)}` : `${what}: ${result.summary}. ${result.stopReason?.message ?? ""}`, result.ok ? "ok" : "err");
  await checkUnfinishedOperations();
  await refreshEngineUndo();
}

/**
 * S3.2 slice 4: single-level Undo of the most recent, successfully completed operation (one
 * patch, several, or a whole bank). DEMO PEDAL ONLY. Fresh read-and-classify of every affected
 * slot (checkUndo); refused outright, writing nothing, unless every slot is exactly as that
 * operation left it. Then the normal sequence: a Now → After preview (with the tick box if a
 * real patch would be replaced), a fresh before-image file confirmed on disk, and the normal
 * executor with every gate (ownership, operation lock, write clearance, journal, permit,
 * per-step verification, end-state check). Never the legacy Test tools' Undo, and never retried.
 */
async function engineUndo() {
  if (state.busy || !state.device || !state.connected || !state.engineUndo) return;
  const record = state.engineUndo;
  if (!DEMO && !realPedalUndoable(record)) { // E1: refreshEngineUndo never offers anything else; checked again here
    setStatus("Refused: on your GP-200 only the Undo of a one-patch Copy, Move, Swap or Rename is enabled. Nothing was written.", "err");
    return;
  }
  const what = `Undo: ${record.action ?? record.title ?? "last operation"}`;
  // As every other write does: an unfinished operation blocks its slots before anything is read.
  const writes = (Array.isArray(record.steps) ? record.steps : []).map((s) => s.slot).filter(Number.isInteger);
  const clear = await writeClearance(operationsStore, journal, writes);
  if (!clear.ok) {
    setStatus(`${what}: ${clear.message}`, "err");
    return;
  }
  state.busy = true;
  updateButtons();
  let plan;
  try {
    const check = await checkUndo(state.device, record, { ownership, log });
    plan = buildUndoPlan(record, check);
  } catch (e) {
    state.busy = false;
    updateButtons();
    setStatus(`${what}: ${e instanceof UndoError ? e.message : `failed: ${e.message}`}`, "err");
    return;
  }
  state.busy = false;
  updateButtons();
  const preview = plan.preview;
  const go = await askChoice({ title: preview.headline, message: formatPreview({ ...preview, tickBox: null }).split("\n").slice(2),
    tick: preview.tickBox,
    choices: [{ value: "go", label: preview.confirmLabel, write: true }, { value: "cancel", label: "Cancel", focus: true }] });
  if (go !== "go") { setStatus(`${what}: cancelled. Nothing was written.`); return; }
  const confirmation = confirmPlan(plan, { confirmed: true, tickBoxAccepted: !!preview.tickBox });
  const z = planJournalZip(plan, { skeleton, title: what });
  const saved = await saveOperationBeforeImage(what, plan, z);
  if (!saved) return;
  const hooks = demoCrashHooks();
  state.busy = true;
  updateButtons();
  let result;
  try {
    result = await runUndo(state.device, plan, {
      confirmation, beforeImage: { bytes: z.bytes, saved }, journal: operationsStore, history: journal, log, ownership,
      wakeLock: globalThis.navigator?.wakeLock,
      onProgress: (e) => { hooks.onProgress(e); if (e.phase === "step") setStatus(`${what}: step ${e.step + 1} of ${plan.steps.length}…`); },
    });
  } catch (e) {
    state.busy = false;
    updateButtons();
    if (!demoCrash.crashed) setStatus(`${what}: ${e.message}`, "err");
    return;
  }
  for (const st of result.steps) if (st.readBack) updateSnapshotSlot(st.slot, st.readBack);
  state.busy = false;
  refreshView();
  setStatus(result.ok ? `${what}: done and verified.${folderNote(saved)}` : `${what}: ${result.summary}. ${result.stopReason?.message ?? ""}`, result.ok ? "ok" : "err");
  await checkUnfinishedOperations();
  await refreshEngineUndo();
}

/** Demo-only switches for checking the interface without a pedal:
 *  &auto connect at once, &reread read twice, &sel=36 select bank 36,
 *  &democopy=140-236 copy slot 140 to 236 with the confirmation accepted
 *  automatically (demo pedal only), &demoundo then undo it,
 *  &foot=140 then press the demo pedal's footswitch to slot 140,
 *  S3.1 review: &op=copy:140-236 | move:236-237 | swap:237-238 (or bank-copy:36-60 | bank-move:… |
 *  bank-swap:…, banks, S3.2 slice 3) runs one operation through the
 *  S3.1 engine (preview, confirmation, before-image, executor); &crash=upload-N | before-N
 *  simulates the tab crashing during the next operation (or recovery); &keep keeps the demo
 *  pedal's contents across reloads in this tab,
 *  &debug switch debug logging on first. */
async function demoScript(p) {
  if (!p.has("auto")) return;
  if (p.has("debug")) {
    $("chk-debug").checked = true;
    log.debugEnabled = true;
  }
  await connect();
  if (p.has("reread")) await readAllSlots();
  if (p.get("sel")) {
    selection.clickBank(Number(p.get("sel")));
    renderGrid();
  }
  const dc = /^(\d+)-(\d+)$/.exec(p.get("democopy") ?? "");
  if (dc) {
    state.autoConfirm = true;
    selection.click(Number(dc[1]), {});
    $("sel-dest").value = dc[2];
    renderGrid();
    await startCopy();
    if (p.has("demoundo")) await startUndo();
    state.autoConfirm = false;
  }
  if (p.get("foot")) state.demoPedal?.pressFootswitch(Number(p.get("foot")));
  // S3.1 review: &crash arms a simulated crash for the next operation; &op runs one operation.
  if (p.get("crash")) demoArmCrash(p.get("crash"));
  if (p.get("op")) await demoOperation(p.get("op"));
}

init();
