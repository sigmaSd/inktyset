// Compare models (src/showdown.ts): a full-window view over the pages list, opened from the status line. The
// session's pages are the rows, the models compared the columns; each cell is one model's reading of one page,
// with its preview, and how far it is from the page's checked text. A cell opens the reading beside the scan.

import { diffWords } from "../../src/diff.ts";
import { meaningDiff } from "../../src/score.ts";
import type { EngineProfile, FitPreview } from "../../src/engine-profile.ts";
import { num, t, uiLang } from "./i18n.ts";

interface Reading {
  at: number;
  secs: number;
  tokens?: number | null;
  tps?: number | null;
  /** The prompt: its tokens read and the seconds that took (the rest of `secs` is the writing). */
  promptTokens?: number | null;
  promptSecs?: number | null;
  /** All the prompt's tokens, those the engine had kept from the reading before too. */
  inTokens?: number | null;
  finish: string;
  ok: boolean | null;
  err: string;
  pngs: string[];
  rev: number;
  unk: number;
  empty: boolean;
  outdated: boolean;
  /** How far what it read is from the user's text, the layout aside (null: the page isn't checked). */
  score: number | null;
  /** The same, the layout counted too: what they'd still change. */
  scoreAll: number | null;
  /** The checked text's formulas found exactly in the reading (null: the page isn't checked). */
  formulas: { right: number; of: number } | null;
  /** The pages it was shown first. */
  examples?: string[];
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
  /** How many checked pages it's shown first. */
  examples: number;
  /** How our engine is started for it (null: as for the app). */
  engine: EngineProfile | null;
  modelFile: string;
  mmprojFile: string;
  url: string;
  model: string;
  cells: Record<string, Cell>;
}
interface State {
  contenders: Contender[];
  /** `from`: the model the page's text started as a reading of ("" not known). */
  pages: { id: string; checked: boolean; status: string; from: string }[];
  /** `phase`: what the reading does now (null: its model loading). */
  working: { contender: string; page: string; started: number; phase: Phase | null } | null;
  queued: number;
  /** The engine or the model isn't downloaded: nothing is read until it is. */
  blocked: boolean;
  /** `holds`: the column whose model is in the engine ("" none). */
  engine: { status: string; detail: string; holds: string };
  /** Settings' instructions in one text: what a column's own start from. */
  instructions: string;
}
type Phase = "prompt" | "thinking" | "writing";
/** The reading being made, as it comes (src/showdown.ts live): the words only when asked for. */
interface Live {
  contender: string;
  page: string;
  phase: Phase;
  thinkTokens: number;
  textTokens: number;
  firstAt: number | null;
  thinking?: string;
  text?: string;
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
/** How far the reading being made is (asked each second while one is made); null: none, or not known yet. */
let live: Live | null = null;
/** The open cell is the reading being made: its words asked for, often (null: it isn't). */
let liveTimer: ReturnType<typeof setInterval> | null = null;

/** A writing speed: "41 tok/s". */
const tps = (n: number) => t("sdTps", { n: Math.round(n) });
/** One line of labels, each kept whole when the line wraps (the empty ones left out); nothing when all are. */
const line = (parts: string[]) => {
  const kept = parts.filter(Boolean).map((x) => (x.startsWith("<span") ? x : `<span>${x}</span>`));
  return kept.length ? `<div class="sd-line">${kept.join("")}</div>` : "";
};
/** "formulas exactly right: 24/26" ("" when there were none to find). */
const formulasRight = (f: { right: number; of: number } | null | undefined) =>
  f?.of ? t("sdFormulasRight", { n: f.right, d: f.of }) : "";
/** The prompt's reading: its tokens, its time and speed ("" when the engine didn't say). */
const promptDetail = (r: Reading, mmss: (s: number) => string) =>
  typeof r.promptSecs === "number" && typeof r.promptTokens === "number"
    ? t("sdPromptDetail", {
        n: r.promptTokens,
        t: mmss(r.promptSecs),
        s: Math.round(r.promptTokens / Math.max(r.promptSecs, 0.001)),
      })
    : "";
const pct = (d: number) =>
  new Intl.NumberFormat(uiLang(), { style: "percent", maximumFractionDigits: 1 }).format(d);
/** "10,864 tokens in · 1,052 out": the whole prompt, and all it wrote ("" when the engine didn't say). */
const inOut = (r: Reading) => {
  const i = r.inTokens ?? r.promptTokens;
  return typeof i === "number" && typeof r.tokens === "number" ? t("sdInOut", { i, o: r.tokens }) : "";
};
/** What the reading being made does now: "thinking", "writing"… (its model loading: null). */
const phaseWord = (p: Phase | null | undefined) =>
  p ? t(p === "prompt" ? "sdPhasePrompt" : p === "thinking" ? "sdPhaseThinking" : "sdPhaseWriting") : "";
/** How far it is: "412 tokens thought · 85 written · 14 tok/s" (the prompt: nothing yet). */
const liveCounts = (l: Live) => {
  const n = l.thinkTokens + l.textTokens;
  const secs = l.firstAt === null ? 0 : Date.now() / 1000 - l.firstAt;
  return [
    l.thinkTokens ? t("sdThoughtN", { n: l.thinkTokens }) : "",
    l.textTokens ? t("sdWrittenN", { n: l.textTokens }) : "",
    n > 1 && secs > 1 ? t("sdSpeed", { n: Math.round(n / secs) }) : "",
  ].filter(Boolean);
};

export function initShowdown(d: Deps) {
  deps = d;
  const view = $("#showdown");
  view.addEventListener("click", (e) => void onClick(e));
  view.addEventListener("close", () => {
    if (timer) clearInterval(timer);
    timer = null;
  });
  $("#sdCell").addEventListener("click", (e) => void onClick(e));
  $("#sdCell").addEventListener("close", () => stopLive());
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
  $("#sdExamples").addEventListener("input", () => clampExamples());
  // the engine options: where the model would go, again as they change
  $("#sdEngine").addEventListener("toggle", () => scheduleFit());
  $("#sdEngine").addEventListener("input", () => scheduleFit());
  $("#sdAddForm").addEventListener("submit", (e) => e.preventDefault()); // Enter in a field: not a reload
  $("#sdcEvery").addEventListener("change", () => drawText());
  addEventListener("resize", () => stickyRows()); // narrower columns: names on more lines
}

export function openShowdown() {
  const view = $<HTMLDialogElement>("#showdown");
  if (!view.open) view.showModal();
  seen = -1;
  void load();
  timer ??= setInterval(() => {
    if (!sd?.working) return;
    draw(); // the seconds of the reading being made
    if (!liveTimer) void fetchLive(false); // (the open cell asks for its words, and more often)
  }, 1000);
}

/** The app's state changed (main.js render): read the showdown's again while the view is open. */
export function showdownChanged(version: number) {
  if (!$<HTMLDialogElement>("#showdown")?.open || version === seen) return;
  seen = version;
  void load();
}

/** How far the reading being made is; with its words for the open cell (then drawn there). */
async function fetchLive(words: boolean) {
  try {
    live = (await fetch(`/api/showdown/live${words ? "?words=1" : ""}`).then((r) => r.json())) as Live | null;
  } catch {
    return; // the app going away
  }
  if (sd) status(sd, missing(sd));
  if (words) drawLive();
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
  /** The layout counted too. */
  scoreAll: number | null;
  /** How many checked pages' text started as this model's reading (its score is flattered there). */
  source: number;
  /** The checked pages' formulas found exactly, over all of them. */
  formulas: { right: number; of: number } | null;
  scored: number;
  secs: number;
  /** The prompt's seconds, over the readings that know it (null: none). */
  promptSecs: number | null;
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
  const checked = s.pages.filter((p) => p.checked).map((p) => c.cells[p.id]?.reading);
  const mean = (xs: (number | null | undefined)[]) => {
    const known = xs.filter((x): x is number => typeof x === "number");
    return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
  };
  const scored = checked.map((r) => r?.score).filter((x): x is number => typeof x === "number");
  return {
    score: mean(scored),
    scoreAll: mean(checked.map((r) => r?.scoreAll)),
    formulas: checked.reduce<{ right: number; of: number } | null>(
      (sum, r) =>
        r?.formulas
          ? { right: (sum?.right ?? 0) + r.formulas.right, of: (sum?.of ?? 0) + r.formulas.of }
          : sum,
      null,
    ),
    scored: scored.length,
    source: s.pages.filter((p) => p.checked && p.from && p.from === c.name).length,
    secs: done.reduce((a, r) => a + r.secs, 0) / done.length,
    promptSecs: (() => {
      const known = done.map((r) => r.promptSecs).filter((x): x is number => typeof x === "number");
      return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
    })(),
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
  status(s, miss);

  const sums = s.contenders.map((c) => summary(c, s));
  const scores = sums.map((x) => x?.score).filter((x): x is number => typeof x === "number");
  const best = scores.length > 1 ? Math.min(...scores) : null;
  const n = s.contenders.length;
  let h = `<div class="sd-grid" style="grid-template-columns: 150px repeat(${n}, minmax(210px, 1fr))">`;
  // the models
  h += `<div class="sd-corner sd-c1"></div>`;
  for (const c of s.contenders)
    h += `<div class="sd-col">
      <div class="sd-name" title="${esc(c.file)}"><b dir="auto">${esc(c.name)}</b></div>
      <div class="sd-tags">
        <span class="tag${c.think ? " think" : ""}">${t(c.think ? "sdThinking" : "sdPlain")}</span>
        ${c.prompt ? `<span class="tag own" title="${esc(c.prompt.slice(0, 600))}">${t("sdOwnPrompt")}</span>` : ""}
        ${usable(c) ? `<span class="tag examples">${t("sdExamplesTag", { n: usable(c) })}</span>` : ""}
        ${
          c.engine
            ? `<span class="tag engine" dir="ltr" title="${esc(t("sdEngine"))}">${engineSummary(c.engine)
                .map((o) => `<span>${esc(o)}</span>`)
                .join(" · ")}</span>`
            : ""
        }
        ${c.app ? `<span class="tag app">${t("sdYourModel")}</span>` : ""}
        ${c.gone ? `<span class="tag gone" title="${esc(c.gone)}">${t("sdGone")}</span>` : ""}
      </div>
      <div class="sd-acts">
        ${
          c.app
            ? ""
            : `<button class="small sd-use" data-sd="use" data-c="${c.id}" title="${esc(t(c.prompt ? "sdUseComboTitle" : "sdUseTitle"))}">${t(c.prompt ? "sdUseCombo" : "sdUse")}</button>`
        }
        <div class="sd-acts-row">
          <button class="ghost small" data-sd="edit" data-c="${c.id}">${t("sdEdit")}</button>
          <button class="ghost small" data-sd="duplicate" data-c="${c.id}" title="${esc(t("sdDuplicateTitle"))}">${t("sdDuplicate")}</button>
          <button class="ghost small sd-remove" data-sd="remove" data-c="${c.id}">${t("remove")}</button>
        </div>
      </div>
    </div>`;
  // the scores
  h += `<div class="sd-corner sd-c2 note">${checked ? t("sdOver", { n: checked }) : ""}</div>`;
  s.contenders.forEach((c, i) => {
    const x = sums[i];
    if (!x) {
      h += `<div class="sd-sum none"><span class="note">${t("sdNotRead")}</span></div>`;
      return;
    }
    const top = best !== null && x.score === best;
    h += `<div class="sd-sum${top ? " best" : ""}">
      <div class="big" title="${esc(t("sdOffContentTitle"))}">${x.score === null ? "–" : pct(x.score)}<small>${t("sdOff")}</small></div>
      ${line([
        x.scoreAll === null
          ? ""
          : `<span title="${esc(t("sdOffLayoutTitle"))}">${t("sdOffLayout", { p: pct(x.scoreAll) })}</span>`,
        formulasRight(x.formulas),
      ])}
      ${line([
        t("sdPerPage", { t: mmss(x.secs) }),
        x.promptSecs === null ? "" : t("sdPromptTime", { t: mmss(x.promptSecs) }),
        x.tps === null ? "" : tps(x.tps),
      ])}
      <div class="sd-chips">
        <span class="chip ${x.usable === x.done ? "ok" : "warn"}">${t("sdUsable", { n: x.usable, d: x.done })}</span>
        ${top ? `<span class="chip ok">${t("sdClosest")}</span>` : ""}
        ${x.empty ? `<span class="chip bad">${t("sdEmptyN", { n: x.empty })}</span>` : ""}
        ${x.unk ? `<span class="chip warn">${t("sdUnclear", { n: x.unk })}</span>` : ""}
        ${x.source ? `<span class="chip src" title="${esc(t("sdSourceTitle"))}">${t("sdSourceN", { n: x.source, d: x.scored })}</span>` : ""}
      </div>
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
  stickyRows();
}

/** The bar at the bottom: what is being read now and what waits; which model is loaded, the last reading made. */
function status(s: State, miss: number) {
  const { esc, mmss, pageNumber } = deps;
  const name = (id: string) => s.contenders.find((c) => c.id === id)?.name ?? "";
  const now: string[] = [];
  let busy = false;
  if (s.working) {
    busy = true;
    const model = name(s.working.contender);
    const page = pageNumber(s.working.page);
    const l = live?.contender === s.working.contender && live.page === s.working.page ? live : null;
    now.push(
      s.engine.status === "starting"
        ? t("sdStatusLoading", { m: model, p: page })
        : t("sdStatusReading", { m: model, p: page }),
      mmss(Date.now() / 1000 - s.working.started),
      phaseWord(s.working.phase),
      ...(l && s.working.phase ? liveCounts(l) : []),
    );
    if (s.queued) now.push(t("sdStatusMore", { n: s.queued }));
  } else if (s.queued) now.push(t("sdLeft", { n: s.queued }));
  else now.push(miss ? t("sdStatusMissing", { n: miss }) : t("sdAllRead"));
  if (s.blocked && (s.working || s.queued)) now.push(t("sdBlocked"));
  if (s.engine.status === "error" && s.engine.detail) now.push(s.engine.detail);
  // the last reading made, of all the columns
  let last: { c: Contender; page: string; r: Reading } | null = null;
  for (const c of s.contenders)
    for (const [page, cell] of Object.entries(c.cells))
      if (cell.reading && (!last || cell.reading.at > last.r.at)) last = { c, page, r: cell.reading };
  const ctx = [
    s.engine.holds ? t("sdStatusHolds", { m: name(s.engine.holds) }) : "",
    last
      ? t("sdStatusLast", { p: pageNumber(last.page), m: last.c.name, t: mmss(last.r.secs) }) +
        (last.r.score === null ? "" : ` · ${t("sdOffN", { p: pct(last.r.score) })}`)
      : "",
  ].filter(Boolean);
  $("#sdStatus").innerHTML =
    `<span class="sd-now${busy ? " busy" : ""}">${now.map((x) => `<span>${esc(x)}</span>`).join("")}</span>` +
    `<span class="sd-ctx">${ctx.map((x) => `<span>${esc(x)}</span>`).join("")}</span>`;
}

/** The scores stay right under the models' names when scrolling (style.css): how tall the names' row is now. */
function stickyRows() {
  const grid = $(".sd-grid");
  const col = $<HTMLElement>(".sd-col");
  if (grid && col) grid.style.setProperty("--sd-row1", `${col.offsetHeight}px`);
}

function cellHtml(c: Contender, page: string, checked: boolean, s: State) {
  const { esc, mmss } = deps;
  const x = c.cells[page];
  if (!x) return `<div class="sd-cell"></div>`;
  const r = x.reading;
  const at = `data-c="${c.id}" data-p="${page}"`;
  if (x.state === "working") {
    // opens to its words as they come
    const secs = s.working ? Date.now() / 1000 - s.working.started : 0;
    const what = phaseWord(s.working?.phase);
    return `<div class="sd-cell sd-wait sd-live" data-sd="open" ${at} title="${esc(t("sdWatchTitle"))}"><div class="pv empty"><span class="chip busy">${t("sdReading", { t: mmss(secs) })}</span>
      ${what ? `<span class="note">${esc(what)}</span>` : ""}
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
  const source = checked && s.pages.find((x) => x.id === page)?.from === c.name;
  return `<div class="sd-cell" data-sd="open" ${at}>${pv}
    <div class="foot">
      ${
        r.score === null
          ? ""
          : line([
              `<span class="sd-off${checked ? "" : " muted"}" title="${esc(checked ? [t("sdOffContentTitle"), formulasRight(r.formulas)].filter(Boolean).join("\n") : t("sdNotScored"))}">${t("sdOffN", { p: pct(r.score) })}</span>`,
              r.scoreAll === null
                ? ""
                : `<span class="sd-off${checked ? "" : " muted"}" title="${esc(t("sdOffLayoutTitle"))}">${t("sdOffLayout", { p: pct(r.scoreAll) })}</span>`,
            ])
      }
      ${line([
        mmss(r.secs),
        typeof r.promptSecs === "number"
          ? `<span title="${esc(promptDetail(r, mmss))}">${t("sdPromptTime", { t: mmss(r.promptSecs) })}</span>`
          : "",
        typeof r.tps === "number" ? tps(r.tps) : "",
      ])}
      ${line([inOut(r) ? `<span title="${esc(t("sdInOutTitle"))}">${inOut(r)}</span>` : ""])}
      <div class="sd-chips">
        ${r.empty ? "" : r.ok ? `<span class="chip ok">${t("sdCompiles")}</span>` : `<span class="chip bad" title="${esc(r.err)}">${t("sdError")}</span>`}
        ${r.unk ? `<span class="chip warn">${t("sdUnclear", { n: r.unk })}</span>` : ""}
        ${r.finish === "length" && !r.empty ? `<span class="chip warn">${t("sdCut")}</span>` : ""}
        ${r.outdated ? `<span class="chip warn" title="${esc(t("sdOutdatedTitle"))}">${t("sdOutdated")}</span>` : ""}
        ${source ? `<span class="chip src" title="${esc(t("sdSourceTitle"))}">${t("sdSource")}</span>` : ""}
      </div>
    </div></div>`;
}

// ---------------------------------------------------------------- one reading, beside the scan

async function drawCell() {
  if (!sd || !cur) return;
  const { esc, mmss, pageNumber } = deps;
  const c = sd.contenders.find((x) => x.id === cur!.contender);
  const p = sd.pages.find((x) => x.id === cur!.page);
  const cell = c?.cells[cur.page];
  const r = cell?.reading;
  const making = cell?.state === "working";
  if (!c || !p || (!r && !making)) {
    $<HTMLDialogElement>("#sdCell").close();
    return;
  }
  $("#sdcTitle").textContent = `${t("pageN", { n: pageNumber(p.id) })} · ${c.name}`;
  $<HTMLImageElement>("#sdcScan").src = `/files/scans/${p.id}.jpg`;
  $("#sdcStop").hidden = !making;
  $("[data-sd=again]", $("#sdCell")).hidden = making;
  if (making || !r) {
    // being read: its words as they come (drawLive), until it's done and drawn as any reading
    $("#sdcKeep").hidden = true;
    if (!liveTimer) {
      const box = $("#sdcText");
      box.dataset.key = "live";
      box.textContent = "";
      $("#sdcThinkingText").textContent = "";
      $<HTMLDetailsElement>("#sdcThinking").open = true;
      $("#sdcScore").textContent = "";
      $("#sdcEveryBox").hidden = true;
      $("#sdcPreview").innerHTML =
        `<div class="pv empty"><span class="note">${t("sdLivePreview")}</span></div>`;
      shown = null;
      liveTimer = setInterval(() => void fetchLive(true), 500);
      void fetchLive(true);
    }
    drawLive();
    return;
  }
  stopLive();
  $("#sdcTags").innerHTML =
    `<span class="tag${c.think ? " think" : ""}">${t(c.think ? "sdThinking" : "sdPlain")}</span>
    <span class="note">${[
      mmss(r.secs),
      promptDetail(r, mmss),
      // the prompt's tokens are said just before: all of them again only when some were kept from before
      typeof r.inTokens === "number" && r.inTokens !== r.promptTokens
        ? inOut(r)
        : typeof r.tokens === "number"
          ? t("sdTokens", { n: r.tokens })
          : "",
      typeof r.tps === "number" ? tps(r.tps) : "",
      r.examples?.length
        ? t("sdShownPages", { pages: r.examples.map((id) => t("pageN", { n: pageNumber(id) })).join(", ") })
        : "",
      r.outdated ? t("sdOutdated") : "",
    ]
      .filter(Boolean)
      .join(" · ")}</span>`;
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
  $("#sdcScore").textContent =
    r.score === null
      ? ""
      : [
          t("sdOffN", { p: pct(r.score) }),
          r.scoreAll === null ? "" : t("sdOffLayout", { p: pct(r.scoreAll) }),
          formulasRight(r.formulas),
        ]
          .filter(Boolean)
          .join(" · ");
  shown = d;
  $("#sdcEveryBox").hidden = !d.answer.trim();
  drawText();
  const th = $<HTMLDetailsElement>("#sdcThinking");
  th.hidden = !d.thinking.trim();
  $("#sdcThinkingText").textContent = d.thinking;
}

/** The open cell's reading as it comes: what it does, its thinking and text so far (kept scrolled to the end). */
function drawLive() {
  if (!sd || !cur || !liveTimer) return;
  const { esc, mmss } = deps;
  const c = sd.contenders.find((x) => x.id === cur!.contender);
  const w = sd.working?.contender === cur.contender && sd.working.page === cur.page ? sd.working : null;
  const l = live?.contender === cur.contender && live.page === cur.page ? live : null;
  const loading = !w?.phase;
  $("#sdcTags").innerHTML =
    `<span class="tag${c?.think ? " think" : ""}">${t(c?.think ? "sdThinking" : "sdPlain")}</span>
    <span class="note">${[
      w ? mmss(Date.now() / 1000 - w.started) : "",
      loading ? t("sdLiveLoading") : phaseWord(w?.phase),
      ...(l && !loading ? liveCounts(l) : []),
    ]
      .filter(Boolean)
      .map(esc)
      .join(" · ")}</span>`;
  $("#sdcTextHead").textContent = t("sdLiveHead");
  const box = $("#sdcText");
  const th = $<HTMLDetailsElement>("#sdcThinking");
  const thinking = l?.thinking ?? "";
  th.hidden = !thinking;
  const keep = (el: HTMLElement, text: string) => {
    if (el.textContent === text) return;
    // at the end (or near): kept there as words come; scrolled up to read: left there
    const pane = el.closest<HTMLElement>(".sdc-pane")!;
    const atEnd = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
    el.textContent = text;
    if (atEnd) pane.scrollTop = pane.scrollHeight;
  };
  box.closest(".sdc-pane")!.classList.add("live");
  keep($("#sdcThinkingText"), thinking);
  keep(
    box,
    l?.text || (loading ? t("sdLiveLoading") : l?.phase === "prompt" || !l ? t("sdLiveWaiting") : ""),
  );
  box.classList.toggle("waiting", !l?.text);
}

function stopLive() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
  $("#sdcText").classList.remove("waiting");
  $("#sdcText").closest(".sdc-pane")?.classList.remove("live");
  if ($("#sdcText").dataset.key === "live") $("#sdcText").dataset.key = "";
}

/** The reading open beside its scan, and the user's text it is compared with. */
let shown: { text: string; answer: string } | null = null;

/**
 * The reading's text, against the user's: what the score counts marked (src/score.ts meaningDiff, the layout
 * aside), or every difference, the layout too (the box under it).
 */
function drawText() {
  const box = $("#sdcText");
  if (!shown) return;
  if (!shown.answer.trim()) {
    $("#sdcTextHead").textContent = t("sdItsText");
    box.textContent = shown.text;
    return;
  }
  const { esc } = deps;
  $("#sdcTextHead").textContent = t("sdAgainstYours");
  const every = $<HTMLInputElement>("#sdcEvery").checked;
  box.innerHTML = (every ? diffWords(shown.answer, shown.text) : meaningDiff(shown.answer, shown.text))
    .map((x) =>
      x.op === "same"
        ? esc(x.text)
        : x.op === "add"
          ? `<ins>${esc(x.text)}</ins>`
          : `<del>${esc(x.text)}</del>`,
    )
    .join("");
}

function openCell(contender: string, page: string) {
  cur = { contender, page };
  $("#sdcText").dataset.key = "";
  $<HTMLDetailsElement>("#sdcThinking").open = false;
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
    $<HTMLInputElement>("#sdExamples").value = String(c.examples);
    const e = c.engine ?? {};
    $<HTMLInputElement>("#sdCtx").value = e.ctx ? String(e.ctx) : "";
    $<HTMLInputElement>("#sdUbatch").value = e.ubatch ? String(e.ubatch) : "";
    $<HTMLSelectElement>("#sdFlash").value = e.flashAttn ?? "";
    $<HTMLSelectElement>("#sdKvType").value = e.kvType ?? "";
    $<HTMLSelectElement>("#sdLoadMode").value = e.loadMode ?? "";
    $<HTMLInputElement>("#sdNoOpOffload").checked = e.opOffload === false;
    $<HTMLInputElement>("#sdKvCpu").checked = !!e.kvOnCpu;
    $<HTMLInputElement>("#sdVisionCpu").checked = !!e.visionOnCpu;
    $<HTMLInputElement>("#sdExtra").value = e.extra ?? "";
    $<HTMLInputElement>(
      `#sdAddForm input[name="sdPrompt"][value="${c.prompt ? "own" : "settings"}"]`,
    ).checked = true;
  }
  $<HTMLTextAreaElement>("#sdPromptText").value = c?.prompt ?? sd?.instructions ?? "";
  $<HTMLDetailsElement>("#sdEngine").open = !!c?.engine;
  fitShown = "";
  $("#sdFit").textContent = "";
  addForm();
  $<HTMLDialogElement>("#sdAddDialog").showModal();
}

// ---------------------------------------------------------------- engine options (src/engine-profile.ts)

/** The engine options in the form (the server keeps only what is set, checked). */
function formProfile(): EngineProfile {
  const v = (id: string) => $<HTMLInputElement | HTMLSelectElement>(id).value.trim();
  return {
    ctx: Number(v("#sdCtx")) || undefined,
    ubatch: Number(v("#sdUbatch")) || undefined,
    flashAttn: (v("#sdFlash") || undefined) as EngineProfile["flashAttn"],
    kvType: (v("#sdKvType") || undefined) as EngineProfile["kvType"],
    loadMode: (v("#sdLoadMode") || undefined) as EngineProfile["loadMode"],
    opOffload: $<HTMLInputElement>("#sdNoOpOffload").checked ? false : undefined,
    kvOnCpu: $<HTMLInputElement>("#sdKvCpu").checked || undefined,
    visionOnCpu: $<HTMLInputElement>("#sdVisionCpu").checked || undefined,
    extra: v("#sdExtra") || undefined,
  };
}

/** A column's engine options, short, as llama.cpp's options (not translated: they are its words). */
function engineSummary(e: EngineProfile): string[] {
  return [
    e.ctx && `-c ${e.ctx}`,
    e.ubatch && `-ub ${e.ubatch}`,
    e.flashAttn && `-fa ${e.flashAttn}`,
    e.kvType && `KV ${e.kvType}`,
    e.kvOnCpu && "-nkvo",
    e.opOffload === false && "--no-op-offload",
    e.visionOnCpu && "--no-mmproj-offload",
    e.loadMode && `--load-mode ${e.loadMode}`,
    e.extra,
  ].filter((x): x is string => !!x);
}

/** The column as the form describes it, for the server (add, edit, where its model would go). */
function formColumn() {
  const f = $<HTMLFormElement>("#sdAddForm");
  const kind = ($<HTMLInputElement>('input[name="kind"]:checked', f)?.value ??
    "builtin") as Contender["kind"];
  const val = (id: string) => $<HTMLInputElement>(id).value.trim();
  const own = $<HTMLInputElement>('input[name="sdPrompt"]:checked', f)?.value === "own";
  return {
    id: editing,
    prompt: own ? $<HTMLTextAreaElement>("#sdPromptText").value : undefined,
    kind,
    modelFile: files.model,
    mmprojFile: files.mmproj,
    url: val("#sdUrl"),
    name: val("#sdName"),
    apiKey: val("#sdKey"),
    think: $<HTMLInputElement>("#sdThink").checked,
    examples: Number($<HTMLInputElement>("#sdExamples").value),
    engine: kind === "server" ? undefined : formProfile(),
  };
}

type Fit = FitPreview & { ctx: number; skipped: string[]; busy: boolean };
let fitTimer: ReturnType<typeof setTimeout> | null = null;
/** The column last asked about (its JSON): asked again only when it changes. */
let fitShown = "";
let fitSeq = 0;

/** Where the model would go, worked out again a moment after the form stops changing (it takes seconds). */
function scheduleFit() {
  if (fitTimer) clearTimeout(fitTimer);
  const col = formColumn();
  const box = $("#sdFit");
  const ready =
    $<HTMLDetailsElement>("#sdEngine").open &&
    col.kind !== "server" &&
    (col.kind !== "files" || (col.modelFile && col.mmprojFile));
  if (!ready) return;
  // what decides where it goes (not the instructions, nor the name)
  const key = JSON.stringify([col.kind, col.modelFile, col.mmprojFile, col.think, col.examples, col.engine]);
  if (key === fitShown) return;
  fitTimer = setTimeout(async () => {
    fitShown = key;
    const seq = ++fitSeq;
    box.classList.add("working");
    if (!box.textContent) box.textContent = t("sdFitWorking");
    try {
      const r = (await deps.api("/api/showdown/fit", col)) as Fit;
      if (seq === fitSeq) drawFit(r);
    } catch (err) {
      if (seq === fitSeq) {
        box.innerHTML = `<p class="bad-text">${deps.esc((err as Error).message)}</p>`;
        fitShown = ""; // asked again on the next change
      }
    } finally {
      if (seq === fitSeq) box.classList.remove("working");
    }
  }, 700);
}

/** Memory in MiB, in binary GB as memory is sold ("16 GB" card: 16384 MiB; bytes() is for downloads, in 1e9). */
const mib = (n: number) =>
  n >= 1024 ? t("gb", { n: num(n / 1024, 1) }) : t("mb", { n: num(Math.round(n)) });

function drawFit(r: Fit) {
  const { esc } = deps;
  let h = `<p class="note">${esc(t("sdFitCtx", { n: r.ctx }))}</p>`;
  if (!r.devices.length) h += `<p>${esc(t("sdFitNoCard"))}</p>`;
  for (const d of r.devices) {
    const parts = [d.model, d.context, d.compute, r.vision];
    const used = parts.reduce((a, b) => a + b, 0);
    const pct = (n: number) => `${Math.max(0, Math.min(100, (n / d.total) * 100)).toFixed(1)}%`;
    h += `<p><b>${esc(t("sdFitCard", { name: d.name, used: mib(used), total: mib(d.total) }))}</b>
      <span class="note">${esc(t("sdFitFree", { free: mib(d.free) }))}</span></p>
      <div class="sd-bar${used > d.total ? " over" : ""}">
        ${["model", "context", "scratch", "vision"].map((k, i) => `<span class="${k}" style="width:${pct(parts[i])}"></span>`).join("")}
      </div>
      <p class="note sd-fit-legend">${(
        [
          ["model", "sdFitModel", d.model],
          ["context", "sdFitContext", d.context],
          ["scratch", "sdFitScratch", d.compute],
          ["vision", "sdFitVision", r.vision],
        ] as const
      )
        .map(([k, key, n]) => `<span><i class="${k}"></i>${esc(t(key, { size: mib(n) }))}</span>`)
        .join("")}</p>`;
  }
  h += `<p>${esc(t("sdFitRam", { model: mib(r.host.model), context: mib(r.host.context) }))}</p>`;
  h += `<p>${esc(
    !r.layers
      ? t("sdFitAll")
      : r.layers.partial
        ? t("sdFitLayers", { n: r.layers.total, k: r.layers.partial })
        : t("sdFitLayersOnly", { n: r.layers.total }),
  )}</p>`;
  if (r.busy) h += `<p class="note">${esc(t("sdFitBusy"))}</p>`;
  if (r.skipped.length)
    h += `<p class="bad-text">${esc(t("sdFitSkipped", { list: r.skipped.join(", ") }))}</p>`;
  if (r.problem) h += `<p class="bad-text" dir="ltr">${esc(r.problem)}</p>`;
  $("#sdFit").innerHTML = h;
}
/** The most examples a column can show here: the session's checked pages (never the page read, but it may not be checked). */
const maxExamples = () => sd?.pages.filter((p) => p.checked).length ?? 0;
/** The examples a column actually shows in this session. */
const usable = (c: Contender) => Math.min(c.examples, maxExamples());

/** The examples box: never more than can be shown, and says how many that is. */
function clampExamples() {
  const box = $<HTMLInputElement>("#sdExamples");
  const max = maxExamples();
  box.max = String(max);
  const n = Math.round(Number(box.value) || 0);
  if (n > max || n < 0 || String(n) !== box.value) box.value = String(Math.max(0, Math.min(max, n)));
  $("#sdExamplesMax").textContent = max ? t("sdExamplesMax", { n: max }) : t("sdExamplesNoChecked");
}

function addForm() {
  clampExamples();
  const kind = ($<HTMLInputElement>('#sdAddForm input[name="kind"]:checked')?.value ??
    "builtin") as Contender["kind"];
  $("#sdAddFiles").hidden = kind !== "files";
  $("#sdAddServer").hidden = kind !== "server";
  $("#sdEngine").hidden = kind === "server"; // its own engine: not ours to start
  scheduleFit();
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
    else if (act === "cellStop" && cur) await api("/api/showdown/stop", cur);
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
      try {
        await api(editing ? "/api/showdown/edit" : "/api/showdown/add", formColumn());
        $<HTMLDialogElement>("#sdAddDialog").close();
      } catch (err) {
        $("#sdAddErr").textContent = (err as Error).message;
      }
    }
  } catch (err) {
    toast((err as Error).message, 5000);
  }
}
