// Compare models (src/showdown.ts): a full-window view over the pages list, opened from the status line. The
// session's pages are the rows, the models compared the columns; each cell is one model's reading of one page,
// with its preview, and how far it is from the page's checked text. A cell opens the reading beside the scan.

import { diffWords } from "../../src/diff.ts";
import { t, uiLang } from "./i18n.ts";

interface Reading {
  at: number;
  secs: number;
  tokens?: number | null;
  tps?: number | null;
  finish: string;
  ok: boolean | null;
  err: string;
  pngs: string[];
  rev: number;
  unk: number;
  empty: boolean;
  outdated: boolean;
  score: number | null;
}
interface Cell {
  state: "none" | "queued" | "working" | "failed" | "done";
  failed: string;
  reading: Reading | null;
}
interface Contender {
  id: string;
  kind: "builtin" | "files" | "server";
  name: string;
  think: boolean;
  file: string;
  app: boolean;
  /** Its own instructions (null: Settings'). */
  prompt: string | null;
  /** Why it can't read now (its model's files are gone), or "". */
  gone: string;
  modelFile: string;
  mmprojFile: string;
  url: string;
  model: string;
  cells: Record<string, Cell>;
}
interface State {
  contenders: Contender[];
  pages: { id: string; checked: boolean; status: string }[];
  working: { contender: string; page: string; started: number } | null;
  queued: number;
  /** The engine or the model isn't downloaded: nothing is read until it is. */
  blocked: boolean;
  engine: { status: string; detail: string };
  /** Settings' instructions in one text: what a column's own start from. */
  instructions: string;
}
interface Deps {
  api: (path: string, body?: unknown) => Promise<any>;
  toast: (msg: string, ms?: number) => void;
  esc: (s: unknown) => string;
  mmss: (s: number) => string;
  /** The page's number in the list (1…). */
  pageNumber: (id: string) => number;
}

const $ = <T extends Element = HTMLElement>(s: string, el: ParentNode = document) => el.querySelector(s) as T;
let deps: Deps;
let sd: State | null = null;
let seen = -1;
let fetching = false;
let again = false;
let timer: ReturnType<typeof setInterval> | null = null;
/** The reading open in the detail view. */
let cur: { contender: string; page: string } | null = null;

/** A writing speed: "41 tok/s". */
const tps = (n: number) => t("sdTps", { n: Math.round(n) });
const pct = (d: number) =>
  new Intl.NumberFormat(uiLang(), { style: "percent", maximumFractionDigits: 1 }).format(d);

export function initShowdown(d: Deps) {
  deps = d;
  const view = $("#showdown");
  view.addEventListener("click", (e) => void onClick(e));
  view.addEventListener("close", () => {
    if (timer) clearInterval(timer);
    timer = null;
  });
  $("#sdCell").addEventListener("click", (e) => void onClick(e));
  $("#sdCell").addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === "ArrowRight" || k === "ArrowLeft") {
      e.preventDefault();
      const rtl = document.dir === "rtl";
      step((k === "ArrowRight") !== rtl ? 1 : -1);
    }
  });
  $("#sdAddDialog").addEventListener("click", (e) => void onClick(e));
  $("#sdAddDialog").addEventListener("change", () => addForm());
  $("#sdAddForm").addEventListener("submit", (e) => e.preventDefault()); // Enter in a field: not a reload
}

export function openShowdown() {
  const view = $<HTMLDialogElement>("#showdown");
  if (!view.open) view.showModal();
  seen = -1;
  void load();
  timer ??= setInterval(() => {
    if (sd?.working) draw(); // the seconds of the reading being made
  }, 1000);
}

/** The app's state changed (main.js render): read the showdown's again while the view is open. */
export function showdownChanged(version: number) {
  if (!$<HTMLDialogElement>("#showdown")?.open || version === seen) return;
  seen = version;
  void load();
}

async function load() {
  if (fetching) {
    again = true;
    return;
  }
  fetching = true;
  try {
    sd = (await fetch("/api/showdown").then((r) => r.json())) as State;
    draw();
    if ($<HTMLDialogElement>("#sdCell").open && cur) void drawCell();
  } catch {
    /* the app going away */
  }
  fetching = false;
  if (again) {
    again = false;
    void load();
  }
}

/** The cells to read for "Read missing": none yet, outdated, or failed (not the ones on their way). */
function missing(s: State) {
  let n = 0;
  for (const c of s.contenders.filter((x) => !x.gone))
    for (const p of s.pages) {
      const x = c.cells[p.id];
      if (x && (x.state === "none" || x.state === "failed" || (x.state === "done" && x.reading?.outdated)))
        n++;
    }
  return n;
}

interface Summary {
  score: number | null;
  scored: number;
  secs: number;
  /** Tokens a second, over the readings that know it (null: none). */
  tps: number | null;
  done: number;
  usable: number;
  unk: number;
  empty: number;
}
function summary(c: Contender, s: State): Summary | null {
  const done = s.pages.map((p) => c.cells[p.id]?.reading).filter((r): r is Reading => !!r);
  if (!done.length) return null;
  const scored = s.pages
    .filter((p) => p.checked)
    .map((p) => c.cells[p.id]?.reading?.score)
    .filter((x): x is number => typeof x === "number");
  return {
    score: scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null,
    scored: scored.length,
    secs: done.reduce((a, r) => a + r.secs, 0) / done.length,
    tps: (() => {
      const known = done.map((r) => r.tps).filter((x): x is number => typeof x === "number");
      return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
    })(),
    done: done.length,
    usable: done.filter((r) => r.ok && !r.empty).length,
    unk: done.reduce((a, r) => a + r.unk, 0),
    empty: done.filter((r) => r.empty).length,
  };
}

function draw() {
  const s = sd;
  if (!s) return;
  const { esc, mmss, pageNumber } = deps;
  const checked = s.pages.filter((p) => p.checked).length;
  $("#sdCounts").textContent =
    `${t("sessionPages", { n: s.pages.length })} · ${t("sessionChecked", { n: checked })}`;
  const left = s.queued + (s.working ? 1 : 0);
  const miss = missing(s);
  const read = $<HTMLButtonElement>("#sdRead");
  read.hidden = !miss;
  read.textContent = t("sdReadMissing", { n: miss });
  $("#sdStop").hidden = !left;
  const why = s.blocked ? t("sdBlocked") : s.engine.status === "starting" ? t("loadingModel") : "";
  $("#sdProgress").textContent = left
    ? t("sdLeft", { n: left }) + (why ? ` · ${why}` : "")
    : miss
      ? ""
      : t("sdAllRead");

  const sums = s.contenders.map((c) => summary(c, s));
  const scores = sums.map((x) => x?.score).filter((x): x is number => typeof x === "number");
  const best = scores.length > 1 ? Math.min(...scores) : null;
  const n = s.contenders.length;
  let h = `<div class="sd-grid" style="grid-template-columns: 150px repeat(${n}, minmax(210px, 1fr))">`;
  // the models
  h += `<div class="sd-corner"></div>`;
  for (const c of s.contenders)
    h += `<div class="sd-col">
      <div class="sd-name" title="${esc(c.file)}"><b dir="auto">${esc(c.name)}</b></div>
      <div class="sd-tags">
        <span class="tag${c.think ? " think" : ""}">${t(c.think ? "sdThinking" : "sdPlain")}</span>
        ${c.prompt ? `<span class="tag own" title="${esc(c.prompt.slice(0, 600))}">${t("sdOwnPrompt")}</span>` : ""}
        ${c.app ? `<span class="tag app">${t("sdYourModel")}</span>` : ""}
        ${c.gone ? `<span class="tag gone" title="${esc(c.gone)}">${t("sdGone")}</span>` : ""}
      </div>
      <div class="sd-acts">
        <button class="ghost small" data-sd="edit" data-c="${c.id}">${t("sdEdit")}</button>
        <button class="ghost small" data-sd="duplicate" data-c="${c.id}" title="${esc(t("sdDuplicateTitle"))}">${t("sdDuplicate")}</button>
        ${
          c.app
            ? ""
            : `<button class="ghost small" data-sd="use" data-c="${c.id}" title="${esc(t(c.prompt ? "sdUseComboTitle" : "sdUseTitle"))}">${t(c.prompt ? "sdUseCombo" : "sdUse")}</button>`
        }
        <button class="ghost small" data-sd="remove" data-c="${c.id}">${t("remove")}</button>
      </div>
    </div>`;
  // the scores
  h += `<div class="sd-corner note">${checked ? t("sdOver", { n: checked }) : ""}</div>`;
  s.contenders.forEach((c, i) => {
    const x = sums[i];
    if (!x) {
      h += `<div class="sd-sum none"><span class="note">${t("sdNotRead")}</span></div>`;
      return;
    }
    const top = best !== null && x.score === best;
    h += `<div class="sd-sum${top ? " best" : ""}">
      <div class="big">${x.score === null ? "–" : pct(x.score)}<small>${t("sdOff")}</small></div>
      <div class="kv"><span>${t("sdPerPage", { t: mmss(x.secs) })}${x.tps === null ? "" : ` · ${tps(x.tps)}`}</span>
        <span class="${x.usable === x.done ? "ok" : "warn"}">${t("sdUsable", { n: x.usable, d: x.done })}</span></div>
      <div class="kv"><span>${x.unk ? t("sdUnclear", { n: x.unk }) : ""}</span>
        ${x.empty ? `<span class="bad">${t("sdEmptyN", { n: x.empty })}</span>` : top ? `<span class="ok">${t("sdClosest")}</span>` : "<span></span>"}</div>
    </div>`;
  });
  // the pages
  for (const p of s.pages) {
    const pn = pageNumber(p.id);
    h += `<div class="sd-page">
      <div class="sd-pt"><b>${t("pageN", { n: pn })}</b>${
        p.checked
          ? `<span class="chip ok">${t("sdChecked")}</span>`
          : `<span class="chip">${t("sdNotChecked")}</span>`
      }</div>
      <img loading="lazy" src="/files/scans/${p.id}.jpg" alt="${esc(t("scanAlt"))}">
    </div>`;
    for (const c of s.contenders) h += cellHtml(c, p.id, p.checked, s);
  }
  h += `</div>`;
  if (!checked) h = `<p class="sd-hint">${t("sdNoChecked")}</p>` + h;
  h += `<p class="note sd-legend">${t("sdLegend")}</p>`;
  const body = $("#sdBody");
  if (body.dataset.html !== h) {
    body.innerHTML = h;
    body.dataset.html = h;
  }
}

function cellHtml(c: Contender, page: string, checked: boolean, s: State) {
  const { esc, mmss } = deps;
  const x = c.cells[page];
  if (!x) return `<div class="sd-cell"></div>`;
  const r = x.reading;
  const at = `data-c="${c.id}" data-p="${page}"`;
  if (x.state === "working") {
    const secs = s.working ? Date.now() / 1000 - s.working.started : 0;
    return `<div class="sd-cell sd-wait"><div class="pv empty"><span class="chip busy">${t("sdReading", { t: mmss(secs) })}</span>
      <button class="ghost small" data-sd="stopCell" ${at}>${t("sdStop")}</button></div></div>`;
  }
  if (x.state === "queued")
    return `<div class="sd-cell sd-wait"><div class="pv empty"><span class="chip${s.blocked ? " warn" : ""}"${
      s.blocked ? ` title="${esc(t("sdBlocked"))}"` : ""
    }>${t("sdQueued")}</span>
      <button class="ghost small" data-sd="stopCell" ${at}>${t("sdStop")}</button></div></div>`;
  if (x.state === "failed")
    return `<div class="sd-cell sd-wait"><div class="pv empty bad"><span title="${esc(x.failed)}">${t("sdFailed")}</span>
      <button class="ghost small" data-sd="readCell" ${at}>${t("readAgain")}</button></div></div>`;
  if (!r)
    return `<div class="sd-cell sd-wait"><div class="pv empty"><span class="note">${t("sdNotRead")}</span>
      <button class="ghost small" data-sd="readCell" ${at}>${t("sdRead")}</button></div></div>`;
  const pv = r.empty
    ? `<div class="pv empty bad">${t(r.finish === "length" ? "sdEmptyCut" : "sdEmpty")}</div>`
    : r.pngs.length
      ? `<div class="pv">${r.pngs
          .slice(0, 1)
          .map((f) => `<img loading="lazy" src="/files/${esc(f)}?r=${r.rev}" alt="${esc(t("renderedAlt"))}">`)
          .join("")}</div>`
      : `<div class="pv empty bad">${t("sdNoPreview")}</div>`;
  return `<div class="sd-cell" data-sd="open" ${at}>${pv}
    <div class="foot"><span>${mmss(r.secs)}</span>
      ${typeof r.tps === "number" ? `<span>${tps(r.tps)}</span>` : ""}
      ${r.empty ? "" : r.ok ? `<span class="ok">${t("sdCompiles")}</span>` : `<span class="bad" title="${esc(r.err)}">${t("sdError")}</span>`}
      ${r.unk ? `<span class="warn">${t("sdUnclear", { n: r.unk })}</span>` : ""}
      ${r.finish === "length" && !r.empty ? `<span class="warn">${t("sdCut")}</span>` : ""}
      ${r.score === null ? "" : `<span class="${checked ? "" : "muted"}" title="${checked ? "" : esc(t("sdNotScored"))}">${t("sdOffN", { p: pct(r.score) })}</span>`}
      ${r.outdated ? `<span class="chip warn" title="${esc(t("sdOutdatedTitle"))}">${t("sdOutdated")}</span>` : ""}
    </div></div>`;
}

// ---------------------------------------------------------------- one reading, beside the scan

async function drawCell() {
  if (!sd || !cur) return;
  const { esc, mmss, pageNumber } = deps;
  const c = sd.contenders.find((x) => x.id === cur!.contender);
  const p = sd.pages.find((x) => x.id === cur!.page);
  const r = c?.cells[cur.page]?.reading;
  if (!c || !p || !r) {
    $<HTMLDialogElement>("#sdCell").close();
    return;
  }
  $("#sdcTitle").textContent = `${t("pageN", { n: pageNumber(p.id) })} · ${c.name}`;
  $("#sdcTags").innerHTML =
    `<span class="tag${c.think ? " think" : ""}">${t(c.think ? "sdThinking" : "sdPlain")}</span>
    <span class="note">${[
      mmss(r.secs),
      typeof r.tokens === "number" ? t("sdTokens", { n: r.tokens }) : "",
      typeof r.tps === "number" ? tps(r.tps) : "",
      r.outdated ? t("sdOutdated") : "",
    ]
      .filter(Boolean)
      .join(" · ")}</span>`;
  $<HTMLImageElement>("#sdcScan").src = `/files/scans/${p.id}.jpg`;
  $("#sdcPreview").innerHTML = r.empty
    ? `<div class="pv empty bad">${t(r.finish === "length" ? "sdEmptyCut" : "sdEmpty")}</div>`
    : r.pngs.map((f) => `<img src="/files/${esc(f)}?r=${r.rev}" alt="${esc(t("renderedAlt"))}">`).join("") +
      (r.ok ? "" : `<pre class="sd-err">${esc(r.err)}</pre>`);
  $("#sdcKeep").hidden = p.status !== "done" || r.empty;
  const key = `${c.id}|${p.id}|${r.at}`;
  const box = $("#sdcText");
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const d = (await fetch(`/api/showdown/cell?c=${c.id}&p=${p.id}`).then((x) => x.json())) as {
    text: string;
    thinking: string;
    answer: string;
  };
  if (box.dataset.key !== key) return; // moved on meanwhile
  $("#sdcScore").textContent = r.score === null ? "" : t("sdOffN", { p: pct(r.score) });
  if (d.answer.trim()) {
    $("#sdcTextHead").textContent = t("sdAgainstYours");
    box.innerHTML = diffWords(d.answer, d.text)
      .map((x) =>
        x.op === "same"
          ? esc(x.text)
          : x.op === "add"
            ? `<ins>${esc(x.text)}</ins>`
            : `<del>${esc(x.text)}</del>`,
      )
      .join("");
  } else {
    $("#sdcTextHead").textContent = t("sdItsText");
    box.textContent = d.text;
  }
  const th = $<HTMLDetailsElement>("#sdcThinking");
  th.hidden = !d.thinking.trim();
  $("#sdcThinkingText").textContent = d.thinking;
}

function openCell(contender: string, page: string) {
  cur = { contender, page };
  $("#sdcText").dataset.key = "";
  const dlg = $<HTMLDialogElement>("#sdCell");
  if (!dlg.open) dlg.showModal();
  void drawCell();
}

/** The same page, read by the next (or previous) model that has read it. */
function step(by: number) {
  if (!sd || !cur) return;
  const list = sd.contenders.filter((c) => c.cells[cur!.page]?.reading);
  const i = list.findIndex((c) => c.id === cur!.contender);
  if (!list.length) return;
  const next = list[(i + by + list.length) % list.length];
  openCell(next.id, cur.page);
}

// ---------------------------------------------------------------- adding a model

const files = { model: "", mmproj: "" };
/** The column being edited ("" when adding one). */
let editing = "";
function openAdd(c?: Contender) {
  editing = c?.id ?? "";
  files.model = c?.modelFile ?? "";
  files.mmproj = c?.mmprojFile ?? "";
  const f = $<HTMLFormElement>("#sdAddForm");
  f.reset();
  $("#sdAddTitle").textContent = t(c ? "sdEditHead" : "sdAddHead");
  $("#sdAddGo").textContent = t(c ? "sdSave" : "sdAddOnly");
  $("#sdEditNote").hidden = !c;
  if (c) {
    $<HTMLInputElement>(`#sdAddForm input[name="kind"][value="${c.kind}"]`).checked = true;
    $<HTMLInputElement>("#sdUrl").value = c.url;
    $<HTMLInputElement>("#sdName").value = c.model;
    $<HTMLInputElement>("#sdThink").checked = c.think;
    $<HTMLInputElement>(
      `#sdAddForm input[name="sdPrompt"][value="${c.prompt ? "own" : "settings"}"]`,
    ).checked = true;
  }
  $<HTMLTextAreaElement>("#sdPromptText").value = c?.prompt ?? sd?.instructions ?? "";
  addForm();
  $<HTMLDialogElement>("#sdAddDialog").showModal();
}
function addForm() {
  const kind = ($<HTMLInputElement>('#sdAddForm input[name="kind"]:checked')?.value ??
    "builtin") as Contender["kind"];
  $("#sdAddFiles").hidden = kind !== "files";
  $("#sdAddServer").hidden = kind !== "server";
  $("#sdModelFile").textContent = files.model || t("sdNoFile");
  $("#sdMmprojFile").textContent = files.mmproj || t("sdNoFile");
  const own = $<HTMLInputElement>('#sdAddForm input[name="sdPrompt"]:checked')?.value === "own";
  $("#sdPromptBox").hidden = !own;
  const text = $<HTMLTextAreaElement>("#sdPromptText");
  if (own && !text.value.trim()) text.value = sd?.instructions ?? "";
  $("#sdAddErr").textContent = "";
}

async function onClick(e: Event) {
  const b = (e.target as Element).closest<HTMLElement>("[data-sd]");
  if (!b) return;
  const { api, toast } = deps;
  const act = b.dataset.sd;
  const c = b.dataset.c ?? "",
    p = b.dataset.p ?? "";
  try {
    if (act === "close") $<HTMLDialogElement>("#showdown").close();
    else if (act === "read") await api("/api/showdown/read", {});
    else if (act === "stop") await api("/api/showdown/stop");
    else if (act === "stopCell") await api("/api/showdown/stop", { contender: c, page: p });
    else if (act === "readCell") await api("/api/showdown/read", { cells: [{ contender: c, page: p }] });
    else if (act === "open") openCell(c, p);
    else if (act === "use") {
      const col = sd?.contenders.find((x) => x.id === c);
      if (col?.prompt && !confirm(t("sdConfirmUseCombo", { name: col.name }))) return;
      await api("/api/showdown/use", { id: c });
      toast(t(col?.prompt ? "sdUsedCombo" : "sdUsed", { name: col?.name ?? "" }));
    } else if (act === "edit") {
      const col = sd?.contenders.find((x) => x.id === c);
      if (col) openAdd(col);
    } else if (act === "duplicate") {
      // the copy, open to change what it should vary
      const r = await api("/api/showdown/duplicate", { id: c });
      await load();
      const col = sd?.contenders.find((x) => x.id === r.id);
      if (col) openAdd(col);
    } else if (act === "promptReset") $<HTMLTextAreaElement>("#sdPromptText").value = sd?.instructions ?? "";
    else if (act === "remove") {
      const name = sd?.contenders.find((x) => x.id === c)?.name ?? "";
      if (confirm(t("sdConfirmRemove", { name }))) await api("/api/showdown/remove", { id: c });
    } else if (act === "add") openAdd();
    else if (act === "cellClose") $<HTMLDialogElement>("#sdCell").close();
    else if (act === "prev") step(-1);
    else if (act === "next") step(1);
    else if (act === "again" && cur) {
      await api("/api/showdown/read", { cells: [cur] });
      $<HTMLDialogElement>("#sdCell").close();
    } else if (act === "keep" && cur) {
      const r = await api("/api/showdown/keep", { contender: cur.contender, page: cur.page });
      toast(t("sdKept", { v: r.version }), 4000);
    } else if (act === "choose") {
      const which = b.dataset.which as "model" | "mmproj";
      const r = await api("/api/showdown/choose", { which });
      if (r.file) files[which] = r.file;
      addForm();
    } else if (act === "addCancel") $<HTMLDialogElement>("#sdAddDialog").close();
    else if (act === "addGo") {
      const f = $<HTMLFormElement>("#sdAddForm");
      const kind = ($<HTMLInputElement>('input[name="kind"]:checked', f)?.value ??
        "builtin") as Contender["kind"];
      const val = (id: string) => $<HTMLInputElement>(id).value.trim();
      const own = $<HTMLInputElement>('input[name="sdPrompt"]:checked', f)?.value === "own";
      try {
        await api(editing ? "/api/showdown/edit" : "/api/showdown/add", {
          id: editing,
          prompt: own ? $<HTMLTextAreaElement>("#sdPromptText").value : undefined,
          kind,
          modelFile: files.model,
          mmprojFile: files.mmproj,
          url: val("#sdUrl"),
          name: val("#sdName"),
          apiKey: val("#sdKey"),
          think: $<HTMLInputElement>("#sdThink").checked,
        });
        $<HTMLDialogElement>("#sdAddDialog").close();
      } catch (err) {
        $("#sdAddErr").textContent = (err as Error).message;
      }
    }
  } catch (err) {
    toast((err as Error).message, 5000);
  }
}
