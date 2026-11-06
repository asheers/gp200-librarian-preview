// Small reusable dialogs (Phase 3 S2): a text prompt and a choice. Built on
// <dialog>; the safe choice is the focused default, so Enter never does the
// risky thing. No write imports.
//
// SPDX-License-Identifier: GPL-3.0-only

function make(title) {
  const dlg = document.createElement("dialog");
  const form = document.createElement("form");
  form.method = "dialog";
  form.className = "dlg";
  const h = document.createElement("h2");
  h.textContent = title;
  form.append(h);
  dlg.append(form);
  document.body.append(dlg);
  return { dlg, form };
}

function actions(form, buttons) {
  const bar = document.createElement("div");
  bar.className = "dlg-actions";
  const els = buttons.map((b) => {
    const e = document.createElement("button");
    e.value = b.value;
    e.textContent = b.label;
    if (b.primary) e.className = "primary";
    if (b.write) e.className = "write";
    bar.append(e);
    return e;
  });
  form.append(bar);
  return els;
}

/**
 * Resolve exactly once, as soon as the user chooses. Not only on "close": the
 * browser queues a dialog's close event on the page's rendering cycle, and in
 * a page that is not rendering (seen in headless Edge, 2026-10-08) that event
 * never came, so a chosen button was silently ignored. The form's submit
 * event (with the clicked button) and Esc's cancel event fire at once; close
 * stays as a fallback.
 */
const finish = (dlg, resolve, map) => {
  let done = false;
  const end = (value) => {
    if (done) return;
    done = true;
    if (dlg.open) dlg.close(value);
    dlg.remove();
    resolve(map(value));
  };
  dlg.querySelector("form")?.addEventListener("submit", (e) => {
    e.preventDefault(); // we close it ourselves, now
    end(e.submitter?.value ?? "");
  });
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    end("");
  });
  dlg.addEventListener("close", () => end(dlg.returnValue), { once: true });
};

/**
 * Ask for a short text. Resolves with the trimmed text, or null if cancelled.
 * @param {{title: string, label: string, value?: string, max?: number, hint?: string, ok?: string}} o
 */
export function askText({ title, label, value = "", max = 64, hint = "", ok = "Save" }) {
  const { dlg, form } = make(title);
  const lab = document.createElement("label");
  lab.textContent = label;
  const input = document.createElement("input");
  input.className = "dlg-input";
  input.maxLength = max;
  input.value = value;
  lab.append(input);
  form.append(lab);
  if (hint) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = hint;
    form.append(p);
  }
  const [okBtn] = actions(form, [{ value: "ok", label: ok, primary: true }, { value: "cancel", label: "Cancel" }]);
  const sync = () => { okBtn.disabled = !input.value.trim(); };
  input.addEventListener("input", sync);
  sync();
  return new Promise((resolve) => {
    finish(dlg, resolve, (v) => (v === "ok" && input.value.trim() ? input.value.trim() : null));
    dlg.showModal();
    input.select();
  });
}

/**
 * Ask for a destination slot (S3.2: Copy to… / Move to… / Swap with…). A
 * clear destination selector: as the user types a slot label, `describe`
 * says whether it is usable and what is there now, shown live. Resolves with
 * the typed text (not a slot number; the caller parses and re-validates it,
 * because the pedal may have changed), or null if cancelled. A bank operation
 * asks for a bank instead (`field`, `placeholder`).
 * @param {{title: string, hint?: string, describe: (text: string) => {ok: boolean, text: string}, ok?: string,
 *   field?: string, placeholder?: string}} o
 */
/**
 * V4: the visual destination picker (docs/REDESIGN_V4_SCOPE.md). It only ever FILLS the dialog's field (`fill`), so a
 * picked destination is validated exactly like a typed one (`describe`) and nothing after Continue changes. A slot the
 * validation refuses is greyed out with the validation's own words; a protected slot (`locked`, from the existing
 * refusal list) shows a lock and `lockText` and cannot be picked; the planner still makes the real refusal.
 * @param {{mode: "slot"|"bank", count?: number, lockText: string,
 *   slots: (bank: number) => {slot: number, label: string, kind: "real"|"unused"|"unread", name: string, locked: boolean}[],
 *   parse: (text: string) => {bank: number, slot: number|null}|null}} p
 * @param {(text: string) => {ok: boolean, text: string}} describe the dialog's own validation
 * @param {(text: string) => void} fill puts a label into the field and re-validates
 */
function buildPicker(p, describe, fill) {
  const count = p.count ?? 1;
  const el = document.createElement("div");
  el.className = `picker picker-${p.mode}`;
  const banks = document.createElement("div");
  banks.className = "pick-banks";
  banks.setAttribute("role", "group");
  banks.setAttribute("aria-label", "Banks");
  const slotsEl = document.createElement("div");
  slotsEl.className = "pick-slots";
  const note = document.createElement("p");
  note.className = "hint pick-note";
  el.append(banks);
  if (p.mode === "slot") el.append(slotsEl, note);
  const span = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; };
  let bank = null;
  let picked = new Set();
  const bankBtns = [];
  for (let b = 1; b <= 64; b++) {
    const info = p.slots(b);
    const btn = document.createElement("button");
    btn.type = "button"; // never submits: Enter and the dialog's own buttons behave as before
    btn.className = "pick-bank";
    btn.dataset.bank = b;
    const pips = span("pips", "");
    for (const s of info) pips.append(Object.assign(document.createElement("i"), { className: s.locked ? "locked" : s.kind }));
    btn.append(span("pb-no", String(b)), pips);
    if (info.some((s) => s.locked)) btn.append(span("pb-lock", "🔒"));
    btn.setAttribute("aria-label", `Bank ${b}: ${info.map((s) => `${s.label} ${s.locked ? "locked for verification safety" : s.kind === "unused" ? "unused" : s.kind === "unread" ? "not read" : s.name}`).join(", ")}`);
    if (p.mode === "bank") {
      const r = describe(String(b));
      btn.disabled = !r.ok;
      if (!r.ok) btn.title = r.text;
    }
    btn.addEventListener("click", () => {
      if (p.mode === "bank") fill(String(b));
      else { bank = b; renderSlots(); markBanks(); }
    });
    bankBtns[b] = btn;
    banks.append(btn);
  }
  const markBanks = () => { for (let b = 1; b <= 64; b++) bankBtns[b].setAttribute("aria-pressed", b === bank ? "true" : "false"); };
  function renderSlots() {
    slotsEl.replaceChildren();
    if (bank === null) {
      slotsEl.append(span("hint pick-empty", "Choose a bank above, or type a slot."));
      return;
    }
    for (const s of p.slots(bank)) {
      const r = describe(s.label);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `pick-slot ${s.kind}${s.locked ? " locked" : ""}${picked.has(s.slot) ? " picked" : ""}`;
      btn.dataset.slot = s.slot;
      btn.append(span("ps-label", s.label), span("ps-name", s.kind === "unused" ? "Unused" : s.kind === "unread" ? "Not read yet" : s.name));
      if (s.locked) btn.append(span("ps-why", "🔒 Locked"));
      else if (!r.ok) btn.append(span("ps-why", r.short ?? r.text));
      btn.disabled = s.locked || !r.ok;
      btn.title = s.locked ? p.lockText : r.ok ? "" : r.text;
      btn.setAttribute("aria-label", `${s.label}: ${btn.querySelector(".ps-name").textContent}${s.locked ? ". Locked: " + p.lockText : r.ok ? "" : `. ${r.text}`}`);
      btn.addEventListener("click", () => fill(s.label));
      slotsEl.append(btn);
    }
  }
  /** Follow the field: select the bank it names and mark the slots that would be written. */
  function follow(text) {
    const r = p.parse(text);
    picked = new Set();
    if (r) {
      bank = r.bank;
      if (r.slot !== null) for (let i = 0; i < count && r.slot + i < 256; i++) picked.add(r.slot + i); // past 64-D: the validation says so
    }
    markBanks();
    if (p.mode === "slot") {
      renderSlots();
      const lockedPick = r?.slot !== null && r && [...picked].some((s) => p.slots(Math.floor(s / 4) + 1)[s % 4]?.locked);
      note.textContent = lockedPick ? `🔒 Locked: ${p.lockText}` : "";
    }
  }
  return { el, follow };
}

export function askDestination({ title, hint = "", describe, ok = "Continue", field = "Destination slot", placeholder = "e.g. 40-A", picker = null }) {
  const { dlg, form } = make(title);
  const lab = document.createElement("label");
  lab.textContent = field;
  const input = document.createElement("input");
  input.className = "dlg-input";
  input.placeholder = placeholder;
  input.autocomplete = "off";
  lab.append(input);
  form.append(lab);
  const info = document.createElement("p");
  info.className = "hint dest-info";
  form.append(info);
  if (hint) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = hint;
    form.append(p);
  }
  const pick = picker ? buildPicker(picker, describe, (text) => { input.value = text; sync(); }) : null;
  if (pick) form.append(pick.el);
  const [okBtn] = actions(form, [{ value: "ok", label: ok, primary: true }, { value: "cancel", label: "Cancel" }]);
  const sync = () => {
    const r = describe(input.value.trim());
    info.textContent = r.text;
    info.classList.toggle("dest-bad", !r.ok);
    okBtn.disabled = !r.ok;
    pick?.follow(input.value.trim()); // V4: the picker follows what is typed
  };
  input.addEventListener("input", sync);
  sync();
  return new Promise((resolve) => {
    finish(dlg, resolve, (v) => (v === "ok" ? input.value.trim() : null));
    dlg.showModal();
    input.focus();
  });
}

/**
 * Ask the user to choose. Resolves with the chosen value, or null (Esc / cancel).
 * The choice marked `focus` (or the first) has the focus.
 * `tick` (a sentence, e.g. "I understand 60-C "Lead" will be replaced."): a checkbox in the
 * dialog; every `write` choice stays disabled until it is ticked, and is never returned unticked.
 * @param {{title: string, message: string|{pre: string}|(string|{pre: string})[], tick?: string|null,
 *   choices: {value: string, label: string, primary?: boolean, write?: boolean, focus?: boolean}[]}} o
 */
export function askChoice({ title, message, choices, tick = null }) {
  const { dlg, form } = make(title);
  for (const line of [].concat(message)) {
    // { pre: text }: a long Now → After table, in aligned columns, scrolling so the buttons stay within reach.
    const p = document.createElement(line?.pre ? "pre" : "p");
    p.textContent = line?.pre ?? line;
    form.append(p);
  }
  let box = null;
  if (tick) {
    const lab = document.createElement("label");
    lab.className = "dlg-tick";
    box = document.createElement("input");
    box.type = "checkbox";
    lab.append(box, ` ${tick}`);
    form.append(lab);
  }
  const els = actions(form, choices);
  const writes = els.filter((_, i) => choices[i].write);
  const sync = () => { for (const e of writes) e.disabled = !!box && !box.checked; };
  box?.addEventListener("change", sync);
  sync();
  const ticked = (v) => !box || box.checked || !choices.find((c) => c.value === v)?.write;
  return new Promise((resolve) => {
    finish(dlg, resolve, (v) => (choices.some((c) => c.value === v) && ticked(v) ? v : null));
    dlg.showModal();
    (els[choices.findIndex((c) => c.focus)] ?? els[0]).focus();
  });
}

/**
 * Show read-only information in sections. Resolves when closed.
 * @param {{title: string, sections: {heading: string, note?: string, lines: string[]}[]}} o
 */
export function showInfo({ title, sections }) {
  const { dlg, form } = make(title);
  dlg.classList.add("dlg-wide");
  for (const s of sections) {
    const h = document.createElement("h3");
    h.textContent = s.heading;
    form.append(h);
    if (s.note) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = s.note;
      form.append(p);
    }
    const ul = document.createElement("ul");
    ul.className = "info-list";
    for (const line of s.lines.length ? s.lines : ["(none)"]) {
      const li = document.createElement("li");
      li.textContent = line;
      ul.append(li);
    }
    form.append(ul);
  }
  actions(form, [{ value: "close", label: "Close", primary: true }]);
  return new Promise((resolve) => {
    finish(dlg, resolve, () => undefined);
    dlg.showModal();
  });
}
