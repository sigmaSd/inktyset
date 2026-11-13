// The Inktyset window. It talks to src/server.ts: /api/state for everything shown, /api/events for change
// notices, POSTs (with the X-Inktyset header) for every action.
import { createLatexEditor } from "./editor.ts";
import { diffWords } from "../../src/diff.ts";
import { MAX_ANGLE, turnCrop } from "../../src/picture.ts";
import { drawFrame } from "./picture.ts";
import { bytes, isRtl, languageName, ltr, num, setUiLang, t, uiLang, websiteUrl } from "./i18n.ts";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
if (navigator.userAgent.includes("Mac")) document.documentElement.classList.add("mac"); // its buttons: left
// As in MedStation's desktop.ts: no browser context menu outside text fields (in a normal browser, while
// testing; the app shows its own menu in text fields), and a file dropped outside the drop handling below
// never replaces the page.
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest?.("input, textarea, [contenteditable]")) e.preventDefault();
});
const FORMAT_NAME = { latex: "LaTeX", typst: "Typst" };
const fmtOf = (p) => p.format ?? "latex";
let S = null; // last state from the server
const texCache = new Map(); // id -> {rev, tex}
const dirty = new Map(); // id -> timer for unsaved edits
const cards = new Map(); // id -> {el, key}

async function api(path, body, raw) {
  const opt = { method: "POST", headers: { "X-Inktyset": "1" } };
  if (raw) {
    opt.body = raw;
    Object.assign(opt.headers, body);
  } else {
    opt.body = JSON.stringify(body || {});
    opt.headers["Content-Type"] = "application/json";
  }
  const r = await fetch(path, opt);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  refresh(); // show the result now, without waiting for the event stream
  return r.json();
}
function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  // an open dialog (Compare, zoom, phone) covers everything else: show the message inside it
  const host = document.querySelector("dialog[open]") || document.body;
  if (t.parentNode !== host) host.append(t);
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), ms);
}
const mmss = (s) => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const about = (s) =>
  s < 60
    ? t("lessMinute")
    : s < 5400
      ? t("aboutMin", { n: num(Math.round(s / 60)) })
      : t("aboutH", { n: num(s / 3600, 1) });

// ---------------------------------------------------------------- live updates
let refreshing = false,
  again = false;
async function refresh() {
  if (refreshing) {
    again = true;
    return;
  }
  refreshing = true;
  try {
    const r = await fetch("/api/state");
    S = await r.json();
    render();
  } catch {
    /* server going away */
  }
  refreshing = false;
  if (again) {
    again = false;
    refresh();
  }
}
function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = refresh;
  es.onerror = () => {
    es.close();
    $("#engine").innerHTML = `<span class="dot bad"></span><span>${esc(t("appClosed"))}</span>`;
    setTimeout(connect, 3000);
  };
}

// ---------------------------------------------------------------- header + tiles
// The window's language (the setting, or the computer's): its catalog comes from the core, once per change.
let loadingLang = null;
async function followLanguage() {
  const want = S.ui?.lang;
  if (!want || want === uiLang() || want === loadingLang) return;
  loadingLang = want;
  try {
    const r = await fetch("/api/i18n").then((r) => r.json());
    setUiLang(r.lang, r.catalog);
    fillHint();
    render();
  } catch {
    /* the app closing: the next state tries again */
  }
  loadingLang = null;
}

/** The keys of the Compare view, under it. */
function fillHint() {
  const k = (s) => `<kbd>${esc(s)}</kbd>`;
  const enter = t("keyEnter");
  $(".cmp-hint").innerHTML = [
    `${k("←")} ${k("→")} ${esc(t("hintPages"))}`,
    `${k(enter)} ${esc(t("hintCheck"))} (${k("Ctrl")}+${k(enter)} ${esc(t("hintWhileTyping"))})`,
    `${k("+")} ${k("−")} ${esc(t("hintOr"))} ${k("Ctrl")}+${esc(t("hintScroll"))} ${esc(t("hintZoom"))}`,
    `${k("L")} ${esc(t("hintLayout"))}`,
    `${k("E")} ${esc(t("hintEditor"))}`,
    `${k(t("keyEsc"))} ${esc(t("hintClose"))}`,
  ].join(" · ");
}
fillHint();

function renderHeader() {
  void followLanguage();
  const m = S.model;
  const setUp = !S.setup.missing.engine && !S.setup.missing.model;
  // the engine starts on demand: "stopped" once set up is as good as ready
  const map = {
    ready: ["ok", t("ready")],
    starting: ["warn", t("loadingModel")],
    stopped: setUp ? ["ok", t("ready")] : ["warn", t("setupNeeded")],
    missing: ["warn", t("setupNeeded")],
    error: ["bad", t("modelStopped")],
  };
  let [cls, text] = map[m.status] || ["", m.status];
  const reading = S.pages.find((p) => p.status === "working" || p.trial === "working"); // a trial too
  if (reading && m.status !== "starting" && m.status !== "error") {
    [cls, text] = ["busy", t("readingPage", { n: pageNumber(reading.id) })];
  }
  $("#engine").innerHTML = `<span class="dot ${cls}"></span><span>${esc(text)}</span>`;
  $("#engine").title = m.detail || "";

  const sel = $("#lang");
  if (sel.dataset.lang !== uiLang()) {
    // the writing languages, named in the window's language
    sel.length = 0;
    for (const l of S.languages) sel.add(new Option(languageName(l.id, l.name), l.id));
    sel.add(new Option(t("otherLanguage"), "__other"));
    sel.dataset.lang = uiLang();
  }
  const cur = S.settings.language;
  if (document.activeElement !== sel && document.activeElement !== $("#langOther")) {
    const known = S.languages.some((l) => l.id === cur);
    sel.value = known ? cur : "__other";
    $("#langOther").hidden = known;
    if (!known) $("#langOther").value = cur;
  }
  $("#version").textContent = S.appVersion ? S.appVersion : "";
  $("#version").title = S.appVersion ? `Inktyset ${S.appVersion}` : "";
  $("#updateBtn").hidden = !S.update;
  if (S.update) $("#updateBtn").title = t("updateTitle", { v: S.update });
  const fmt = S.settings.format ?? "latex";
  if (document.activeElement !== $("#format")) $("#format").value = fmt;
  $("#copyAll").textContent = t("copyAll", { f: FORMAT_NAME[fmt] });
  $("#copyAll").title = t("copyAllTitle", { f: FORMAT_NAME[fmt] });
  $("#saveTex").textContent = t("saveFile", { ext: ltr(fmt === "typst" ? ".typ" : ".tex") });
  $("#saveTex").title = t("saveFileTitle");
  const inFormat = S.pages.filter((p) => p.status === "done" && fmtOf(p) === fmt).length;
  $("#copyAll").disabled = $("#saveTex").disabled = !inFormat;
}

function renderScanner() {
  const sc = S.scanner,
    info = $("#scanInfo"),
    row = $("#scanRow");
  $("#scanTile").hidden = !sc.available || (!sc.devices.length && !sc.scanning);
  if ($("#scanTile").hidden) return;
  let html = "";
  if (sc.scanning) {
    info.textContent = t("scanning");
  } else if (sc.looking) {
    info.textContent = t("lookingScanners");
  } else if (!sc.devices.length) {
    info.textContent = t("noScanner");
    html = `<button data-act="find">${t("lookAgain")}</button>`;
  } else {
    info.textContent = sc.error || (sc.devices.length === 1 ? sc.devices[0].name : t("chooseScanner"));
    if (sc.devices.length > 1)
      html += `<select id="scanDev">${sc.devices.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join("")}</select>`;
    html += `<button class="primary" data-act="scan">${t("scanPage")}</button><button class="ghost" data-act="find">${t("refresh")}</button>`;
  }
  const key = html + sc.devices.map((d) => d.id).join();
  if (row.dataset.key !== key) {
    const v = $("#scanDev")?.value;
    row.innerHTML = html;
    row.dataset.key = key;
    if (v && $("#scanDev")) $("#scanDev").value = v;
  }
  row.querySelectorAll("button").forEach((b) => (b.disabled = sc.scanning || sc.looking));
}

function renderPhone() {
  const ph = S.phone || {},
    n = (ph.devices || []).length;
  $("#phoneTile").hidden = !ph.enabled;
  $("#phoneInfo").textContent =
    ph.status === "unavailable" || ph.status === "error"
      ? ph.error || t("phoneUnavailable")
      : ph.status !== "ready"
        ? t("starting")
        : n
          ? t("phonesConnected", { n })
          : t("connectPhone");
  if ($("#phoneDialog").open) renderPhoneDialog();
}

function renderPhoneDialog() {
  const ph = S.phone || {},
    body = $("#phoneBody");
  const devs = ph.devices || [];
  let html = "";
  if (ph.status !== "ready") {
    html = `<p class="err">${esc(ph.error || t("phoneStarting"))}</p>`;
  } else {
    const left = ph.pairingExpiresAt ? (ph.pairingExpiresAt - Date.now()) / 1000 : 0;
    const b = (s) => `<b>${esc(s)}</b>`; // Folder Camera's own (English) names, in bold
    html += `<ol class="steps">
      <li>${esc(t("phoneStep1")).replace("{app}", b("Folder Camera"))}</li>
      <li>${esc(t("phoneStep2"))
        .replace("{app}", "Folder Camera")
        .replace("{settings}", b("Settings"))
        .replace("{button}", b("Scan PC pairing QR"))}</li>
      <li>${esc(t("phoneStep3"))}</li>
      <li>${esc(t("phoneStep4"))}</li></ol>`;
    if (ph.qr && left > 0) {
      html += `<div class="qr">${ph.qr}</div>
        <div class="note" style="text-align:center">${t("codeExpires", { t: mmss(left) })}
        <button class="ghost" data-act="pair">${t("newCode")}</button></div>`;
    } else {
      html += `<div style="text-align:center;margin:16px"><button class="primary" data-act="pair">${t("showCode")}</button></div>`;
    }
    if (devs.length) {
      html +=
        `<h3 style="margin:14px 0 0;font-size:14px">${t("connectedPhones")}</h3><ul class="devices">` +
        devs
          .map(
            (d) =>
              `<li><span>${esc(d.name)}</span><button class="ghost" data-act="revoke" data-id="${esc(d.id)}">${t("remove")}</button></li>`,
          )
          .join("") +
        "</ul>";
    }
  }
  if (body.dataset.html !== html) {
    body.innerHTML = html;
    body.dataset.html = html;
  }
}

// ---------------------------------------------------------------- first start: downloads

function jobHtml(job) {
  if (job.status === "running" && job.progress) {
    const { done, total, phase } = job.progress,
      pct = total ? (100 * done) / total : 0;
    const label =
      phase === "verify"
        ? t("checking")
        : phase === "unpack"
          ? t("unpacking")
          : t("ofTotal", { a: bytes(done), b: bytes(total) });
    return `<span class="bar"><i style="width:${pct.toFixed(1)}%"></i></span><span class="note">${label} · ${num(pct)} %</span>`;
  }
  if (job.status === "error") return `<span class="err-inline">${esc(job.error)}</span>`;
  return "";
}

function renderSetup() {
  const su = S.setup,
    el = $("#setup");
  const need = su.missing.engine || su.missing.model;
  el.hidden = !need;
  if (!need) {
    if (el.dataset.html) {
      el.innerHTML = "";
      el.dataset.html = "";
    }
    return;
  }
  const j = su.jobs,
    running = (k) => j[k].status === "running";
  const row = (k, name, missing) => `<div class="setup-row">
      <span class="setup-name">${missing ? "" : "✓ "}${name}</span>
      ${missing ? jobHtml(running("verify") && k === "model" ? j.verify : j[k]) || `<span class="note">${bytes(su.sizes[k])}</span>` : `<span class="note ok-text">${t("ready")}</span>`}
      ${running(k) ? `<button class="ghost" data-setup="cancel" data-id="${k}">${t("stop")}</button>` : ""}
    </div>`;
  const anyRunning = running("engine") || running("model") || running("verify");
  if (S.model.kind !== "builtin") {
    // the user's own model: what's left is in Settings → Model (and our engine, for model files)
    const engine = S.model.kind === "files" && su.missing.engine;
    const html = `<div class="setup-card">
      <h2>${t("setupTitle")}</h2>
      <p>${t(S.model.kind === "server" ? "setupServer" : "setupFiles")}</p>
      ${engine ? row("engine", t("engineName"), true) : ""}
      ${engine && !su.supported.engine ? `<p class="err">${t("noEngine")}</p>` : ""}
      <div class="setup-actions">
        ${engine && su.supported.engine && !running("engine") ? `<button class="primary" data-setup="engine">${t("download", { size: bytes(su.sizes.engine) })}</button>` : ""}
        <button data-setup="settings">${t("openModelSettings")}</button>
      </div>
      ${S.model.kind === "files" ? hardwareHtml() : ""}
    </div>`;
    if (el.dataset.html !== html) {
      el.innerHTML = html;
      el.dataset.html = html;
    }
    return;
  }
  const total = (su.missing.engine ? su.sizes.engine : 0) + (su.missing.model ? su.sizes.model : 0);
  let html = `<div class="setup-card">
    <h2>${t("setupTitle")}</h2>
    <p>${t("setupText")}</p>
    ${row("engine", t("engineName"), su.missing.engine)}
    ${row("model", t("modelName"), su.missing.model)}`;
  if (!su.supported.engine && su.missing.engine) {
    html += `<p class="err">${t("noEngine")}</p>`;
  }
  if (!anyRunning) {
    html += `<div class="setup-actions">
      ${su.supported.engine || !su.missing.engine ? `<button class="primary" data-setup="download">${t("download", { size: bytes(total) })}</button>` : ""}
      ${su.missing.model ? `<button data-setup="folder" title="${t("haveModelTitle")}">${t("haveModel")}</button>` : ""}
    </div>`;
  }
  html += `${hardwareHtml()}</div>`;
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-setup]");
  if (!b) return;
  const su = S.setup;
  try {
    if (b.dataset.setup === "download") {
      if (su.missing.engine) await api("/api/setup/download", { id: "engine" });
      if (su.missing.model) await api("/api/setup/download", { id: "model" });
    } else if (b.dataset.setup === "engine") await api("/api/setup/download", { id: "engine" });
    else if (b.dataset.setup === "settings") {
      $("#settingsDialog").showModal();
      renderSettings();
      $("#modelSection")?.scrollIntoView({ block: "start" });
    } else if (b.dataset.setup === "cancel") await api("/api/setup/cancel", { id: b.dataset.id });
    else if (b.dataset.setup === "folder") await api("/api/setup/model-folder");
    else if (b.dataset.setup === "tectonic") await api("/api/setup/download", { id: "tectonic" });
    else if (b.dataset.setup === "default-model") await api("/api/setup/default-model");
  } catch (err) {
    toast(err.message);
  }
});

/** This computer, as the engine sees it, and what that means for reading pages. */
function hardwareHtml() {
  const hw = S.hardware;
  if (!hw) return "";
  const gpu =
    hw.devices === null
      ? t("gpuLater")
      : hw.devices.length
        ? hw.devices.map((d) => esc(d.name.replace(/^\S+: /, ""))).join(", ")
        : t("gpuNone");
  const gb = (n) => t("gb", { n: num(n) });
  let html = `<p class="note">${t("thisComputer", { mem: gb(hw.memoryGB), gpu })}</p>`;
  for (const a of hw.advice)
    html += `<p class="${a.level === "bad" ? "err" : "warn-note"}">${esc(t(a.id, { need: gb(a.need), have: gb(a.have) }))}</p>`;
  return html;
}

// ---------------------------------------------------------------- settings
function renderSettings() {
  const d = $("#settingsDialog");
  if (!d.open) return;
  const body = $("#settingsBody");
  const a = document.activeElement;
  if (
    body.contains(a) &&
    (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && /^(text|password|url)$/.test(a.type)))
  )
    return; // being typed in: it's saved when left, then the dialog is drawn again
  const m = S.machine,
    ph = S.phone,
    sc = S.scanner,
    su = S.setup;
  const tx = S.tex;
  const usingText =
    tx.using === "system"
      ? t("usingInstalledLatex", { d: esc(tx.detail) })
      : tx.using === "tectonic"
        ? t("using", { d: esc(tx.detail) })
        : t("notUsedYet");
  const found = [tx.system.pdflatex, tx.system.xelatex].filter(Boolean);
  const radio = (
    v,
    label,
    help,
  ) => `<label class="choice"><input type="radio" name="tex" value="${v}" ${m.tex === v ? "checked" : ""}>
    <span><b>${label}</b><small>${help}</small></span></label>`;
  const tecJob = su.jobs.tectonic;
  const uiOptions = [["auto", t("appLanguageAuto")], ...(S.ui?.available ?? []).map((l) => [l.code, l.name])]
    .map(([v, n]) => `<option value="${esc(v)}" ${S.ui?.setting === v ? "selected" : ""}>${esc(n)}</option>`)
    .join("");
  let html = `
  <section class="set">
    <h3>${t("appLanguage")}</h3>
    <select id="setUi">${uiOptions}</select>
    <p class="note">${t("appLanguageNote")}
      <a href="https://github.com/sigmaSd/inktyset/blob/main/docs/translating.md" target="_blank">${t("helpTranslate")}</a></p>
  </section>
  <section class="set">
    <h3>${t("latexForPreviews")}</h3>
    ${radio("auto", t("auto"), t("autoHelp"))}
    ${radio("system", t("installedLatex"), found.length ? t("found", { list: found.map(esc).join(", ") }) : t("noneFound"))}
    ${radio("builtin", t("builtin"), tx.tectonic ? t("downloaded") : t("tectonicHelp", { size: bytes(su.sizes.tectonic) }))}
    <p class="note">${usingText}</p>
    ${tecJob.status === "running" || tecJob.status === "error" ? `<div class="setup-row"><span class="setup-name">Tectonic</span>${jobHtml(tecJob)}</div>` : ""}
  </section>
  <section class="set">
    <h3>Typst</h3>
    <p class="note">${S.typst.system ? t("usingInstalledTypst", { d: esc(S.typst.system) }) : S.typst.downloaded ? t("downloaded") : t("typstHelp", { size: bytes(su.sizes.typst) })}</p>
    ${su.jobs.typst.status === "running" || su.jobs.typst.status === "error" ? `<div class="setup-row"><span class="setup-name">Typst</span>${jobHtml(su.jobs.typst)}</div>` : ""}
  </section>
  <section class="set">
    <h3>${t("phone")}</h3>
    <label class="choice"><input type="checkbox" id="setPhone" ${m.phone ? "checked" : ""}>
      <span><b>${t("phoneSetting")}</b>
      <small>${t("phoneSettingHelp")}
      ${navigator.userAgent.includes("Windows") ? t("firewall") : ""}</small></span></label>
    ${m.phone && ph.status === "error" ? `<p class="err">${esc(ph.error)}</p>` : ""}
  </section>
  <section class="set">
    <h3>${t("scanner")}</h3>
    ${
      sc.available
        ? `<p class="note">${sc.looking ? t("lookingScanners") : sc.devices.length ? t("found", { list: sc.devices.map((x) => esc(x.name)).join(", ") }) : t("noScannerShort")}</p>
      <button data-act="find" ${sc.looking ? "disabled" : ""}>${t("lookForScanners")}</button>`
        : `<p class="note">${t("saneNote")}</p>`
    }
  </section>
  ${readingHtml()}
  ${modelHtml()}
  ${foldersHtml()}
  <section class="set">
    <h3>${t("about")}</h3>
    <p class="note">Inktyset <bdi>${esc(S.appVersion)}</bdi>. ${S.update ? t("aboutUpdate", { v: esc(S.update) }) : ""}
      ${t("freeSoftware")}</p>
    <p class="note"><a href="${websiteUrl()}" target="_blank">${t("website")}</a> ·
      <a href="https://github.com/sigmaSd/inktyset" target="_blank">${t("source")}</a> ·
      <a href="https://github.com/sigmaSd/inktyset/releases" target="_blank">${t("whatsNew")}</a> ·
      <a href="https://github.com/sigmaSd/inktyset/blob/main/THIRD_PARTY_NOTICES.md" target="_blank">${t("licenses")}</a> ·
      <a href="https://github.com/sigmaSd/inktyset/issues" target="_blank">${t("report")}</a></p>
  </section>`;
  if (body.dataset.html !== html) {
    body.innerHTML = html;
    body.dataset.html = html;
  }
}

$("#updateBtn").onclick = async () => {
  if (S.pages.some((p) => p.status === "working" || p.status === "queued") && !confirm(t("restartConfirm")))
    return;
  try {
    await api("/api/install-update");
  } catch (err) {
    toast(err.message);
  }
};
$("#settingsBtn").onclick = () => {
  $("#settingsDialog").showModal();
  renderSettings();
};
$("#settingsClose").onclick = () => $("#settingsDialog").close();
// Settings → Your pages: the folder they're in, and another one (Inktyset restarts there). No list of the
// folders used before: where private pages are kept stays the user's to remember.
function foldersHtml() {
  const f = S.folders;
  return `<section class="set">
    <h3>${t("yourPages")}</h3>
    <p class="note">${t("savedIn", { p: `<bdi>${esc(S.folder)}</bdi>` })}</p>
    ${f.given ? `<p class="note">${t("folderGiven")}</p>` : ""}
    <div class="setup-actions">
      <button data-act="pickFolder">${t("useOtherFolder")}</button>
      ${S.folder !== f.default ? `<button data-act="usualFolder">${t("useUsualFolder")}</button>` : ""}
    </div>
    <p class="note">${t("otherFolderHelp")}</p>
  </section>`;
}

// The notes and the instructions, in a big editor over Settings: Done puts the text back in the box, which
// saves it as typing there does; Cancel (or Esc) leaves it, after asking when something was changed.
const expandBtn = (id) =>
  `<button class="ghost small" data-act="expand" data-for="${id}" title="${t("expandTitle")}">⤢ ${t("expand")}</button>`;
let expanding = null; // the box being edited in the big editor, and its text when opened
function openExpand(id) {
  const box = $(`#${id}`);
  if (!box) return;
  expanding = { id, start: box.value };
  $("#expandTitle").textContent = t(id === "setNotes" ? "yourNotes" : "allInstructions");
  const ta = $("#expandText");
  Object.assign(ta, { value: box.value, placeholder: box.placeholder, spellcheck: id === "setNotes" });
  ta.dir = id === "setPrompt" ? "ltr" : "auto"; // Inktyset's instructions are English
  $("#expandDialog").showModal();
  ta.focus();
}
const expandChanged = () => expanding && $("#expandText").value !== expanding.start;
$("#expandDone").onclick = () => {
  const box = expanding && $(`#${expanding.id}`); // (Settings may have been redrawn meanwhile)
  if (box && expandChanged()) {
    box.value = $("#expandText").value;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
  }
  expanding = null;
  $("#expandDialog").close();
};
$("#expandCancel").onclick = () => {
  if (expandChanged() && !confirm(t("discardEdits"))) return;
  expanding = null;
  $("#expandDialog").close();
};
$("#expandDialog").addEventListener("cancel", (e) => {
  if (expandChanged() && !confirm(t("discardEdits"))) e.preventDefault();
  else expanding = null;
});

// Settings → Reading instructions: the user's notes, and (advanced) all of Inktyset's instructions.
let promptOpen = false;
function readingHtml() {
  const rd = S.reading,
    custom = !!rd.prompt;
  const anyDone = S.pages.some((p) => p.status === "done");
  return `<section class="set">
    <h3>${t("readingInstructions")}</h3>
    <div class="field">
      <div class="field-row"><label for="setNotes">${t("yourNotes")}</label>${expandBtn("setNotes")}</div>
      <small>${esc(t("yourNotesHelp"))}</small>
      <textarea id="setNotes" rows="3" placeholder="${esc(t("yourNotesPh"))}">${esc(rd.instructions)}</textarea>
    </div>
    <details id="promptBox" ${promptOpen ? "open" : ""}><summary>${t("allInstructions")}${custom ? ` <span class="changed">${t("promptChanged")}</span>` : ""}</summary>
      <p class="note">${esc(t("allInstructionsHelp"))}</p>
      <textarea id="setPrompt" class="prompt" rows="14" dir="ltr" spellcheck="false">${esc(rd.prompt || rd.defaultPrompt)}</textarea>
      <div class="prompt-reset">
        ${expandBtn("setPrompt")}
        ${custom ? `<span class="warn-note">${t("promptCustom")}</span>` : ""}
        <button id="resetPrompt" data-act="resetPrompt" ${custom ? "" : "disabled"}>${t("resetPrompt")}</button>
      </div>
      ${rd.added ? `<p class="note">${t("thenAdded")}</p><pre class="prompt-added" dir="ltr">${esc(rd.added)}</pre>` : ""}
    </details>
    <p class="note">${t("tryOnPagesHelp")}</p>
    <button data-act="tryOn" ${anyDone ? "" : "disabled"}>${t("tryOnPages")}</button>
  </section>`;
}

// Settings → Model: the built-in one, other model files, or a model server on the user's own network.
let serverModels = [];
function modelHtml() {
  const m = S.machine,
    su = S.setup,
    kind = S.model.kind;
  const radio = (v, label, help) =>
    `<label class="choice"><input type="radio" name="modelKind" value="${v}" ${kind === v ? "checked" : ""}>
    <span><b>${label}</b><small>${help}</small></span></label>`;
  const path = (p) => (p ? `<bdi>${esc(p)}</bdi>` : t("notChosen"));
  let detail = "";
  if (kind === "builtin")
    detail = `<p class="note">${t("modelFiles", { p: `<bdi>${esc(su.modelDir)}</bdi>` })}</p>
    <div class="setup-actions">
      <button data-setup="folder">${t("otherFolder")}</button>
      ${su.custom.modelDir ? `<button class="ghost" data-setup="default-model">${t("ownCopy")}</button>` : ""}
    </div>
    ${su.jobs.verify.status === "running" || su.jobs.verify.status === "error" ? `<div class="setup-row"><span class="setup-name">${t("checkingFiles")}</span>${jobHtml(su.jobs.verify)}</div>` : ""}`;
  else if (kind === "files")
    detail = `<div class="file-row"><span class="note">${t("modelFileLabel", { p: path(m.modelFile) })}</span>
      <button data-act="chooseFile" data-which="model">${t("choose")}</button></div>
    <div class="file-row"><span class="note">${t("mmprojLabel", { p: path(m.mmprojFile) })}</span>
      <button data-act="chooseFile" data-which="mmproj">${t("choose")}</button></div>`;
  else
    detail = `<label class="field">${t("serverUrl")}
      <input type="url" id="setUrl" dir="ltr" placeholder="http://127.0.0.1:11434" value="${esc(m.serverUrl ?? "")}"></label>
    <label class="field">${t("serverModelName")}
      <input type="text" id="setSrvModel" dir="ltr" list="srvModels" placeholder="${esc(t("serverModelPh"))}" value="${esc(m.serverModel ?? "")}">
      <datalist id="srvModels">${serverModels.map((n) => `<option value="${esc(n)}">`).join("")}</datalist></label>
    <div class="setup-actions"><button data-act="findModels">${t("findModels")}</button></div>
    <label class="field">${t("serverKey")}
      <input type="password" id="setSrvKey" dir="ltr" autocomplete="off" value="${esc(m.serverKey ?? "")}"></label>`;
  const engine =
    kind === "server"
      ? ""
      : `<label class="field">${t("ownServer")}
      <input type="text" id="setServer" dir="ltr" placeholder="${t("ownServerPh")}" value="${esc(su.custom.serverPath)}"></label>
    <p class="note">${su.serverPath ? t("using", { d: `<bdi>${esc(su.serverPath)}</bdi>` }) : t("noEngineYet")}</p>
    ${hardwareHtml()}`;
  return `<section class="set" id="modelSection">
    <h3>${t("modelEngine")}</h3>
    ${radio("builtin", t("modelBuiltin"), t("modelBuiltinHelp"))}
    ${radio("files", t("modelFilesKind"), t("modelFilesHelp"))}
    ${radio("server", t("modelServerKind"), t("modelServerHelp"))}
    ${detail}
    <p class="note">${t("readingWith", { m: `<bdi>${esc(S.model.label)}</bdi>` })}</p>
    ${S.model.status === "error" && S.model.detail ? `<p class="err">${esc(S.model.detail)}</p>` : ""}
    ${engine}
  </section>`;
}

$("#settingsDialog").addEventListener(
  "toggle",
  (e) => {
    if (e.target.id === "promptBox") promptOpen = e.target.open;
  },
  true,
);

// the reset button wakes up as soon as the instructions are typed into, before they're saved
$("#settingsDialog").addEventListener("input", (e) => {
  if (e.target.id !== "setPrompt") return;
  const b = $("#resetPrompt");
  if (b) b.disabled = !S.reading.prompt && e.target.value.trim() === S.reading.defaultPrompt.trim();
});
$("#settingsDialog").addEventListener("change", async (e) => {
  const v = e.target.value;
  try {
    if (e.target.name === "tex") await api("/api/settings", { tex: v });
    else if (e.target.name === "modelKind") await api("/api/settings", { modelKind: v });
    else if (e.target.id === "setNotes") await api("/api/settings", { instructions: v });
    else if (e.target.id === "setPrompt")
      // the same as Inktyset's own: keep following Inktyset's (it may improve in an update)
      await api("/api/settings", { prompt: v.trim() === S.reading.defaultPrompt.trim() ? "" : v });
    else if (e.target.id === "setUrl") await api("/api/settings", { serverUrl: v });
    else if (e.target.id === "setSrvModel") await api("/api/settings", { serverModel: v });
    else if (e.target.id === "setSrvKey") await api("/api/settings", { serverKey: v });
    else if (e.target.id === "setPhone") await api("/api/settings", { phone: e.target.checked });
    else if (e.target.id === "setUi") await api("/api/settings", { ui: e.target.value });
    else if (e.target.id === "setServer") {
      await api("/api/settings", { serverPath: e.target.value });
      toast(t("saved"));
    }
    if (/^set(Notes|Prompt|Url|SrvModel|SrvKey)$/.test(e.target.id)) toast(t("saved"));
  } catch (err) {
    toast(err.message, 6000);
  }
  $("#settingsBody").dataset.html = ""; // drawn again with what was saved
  renderSettings();
});

// ---------------------------------------------------------------- trying other instructions on some pages
function openTrial() {
  const list = $("#trialList");
  list.innerHTML = S.pages
    .filter((p) => p.status === "done")
    .map(
      (p) =>
        `<label><input type="checkbox" value="${esc(p.id)}"> ${esc(t("pageN", { n: pageNumber(p.id) }))}
        <small><bdi>${esc(p.label)}</bdi></small></label>`,
    )
    .join("");
  $("#trialInfo").textContent = t("usuallyTakes", { t: about(S.avgSecs) });
  updateTrialGo();
  $("#trialDialog").showModal();
}
function updateTrialGo() {
  const n = $("#trialList").querySelectorAll("input:checked").length;
  $("#trialGo").textContent = n ? t("trialGo", { n }) : t("trialNone");
  $("#trialGo").disabled = !n;
}
$("#trialList").addEventListener("change", updateTrialGo);
$("#trialCancel").onclick = () => $("#trialDialog").close();
$("#trialGo").onclick = async () => {
  const ids = [...$("#trialList").querySelectorAll("input:checked")].map((i) => i.value);
  try {
    await api("/api/trial", { ids });
    $("#trialDialog").close();
    $("#settingsDialog").close();
  } catch (err) {
    toast(err.message);
  }
};

// ---------------------------------------------------------------- Edit picture
// Turn, straighten and crop a page's picture (src/picture.ts). The preview is drawn here from the page's base
// picture by the same code the image worker uses (picture.ts); saving sends only the numbers.
const pic = { id: null, src: null, edit: null, drag: null };
const WHOLE = { x: 0, y: 0, w: 1, h: 1 };

async function openPicture(id) {
  const r = await api(`/api/page/${id}/picture`);
  const blob = await (await fetch(`/files/${r.base}`)).blob();
  const bmp = await createImageBitmap(blob);
  // the preview works on a smaller copy: straightening is redrawn as the slider moves
  const s = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  const small = document.createElement("canvas");
  small.width = Math.round(bmp.width * s);
  small.height = Math.round(bmp.height * s);
  small.getContext("2d").drawImage(bmp, 0, 0, small.width, small.height);
  bmp.close();
  Object.assign(pic, { id, src: small, edit: structuredClone(r.edit) });
  const p = S.pages.find((x) => x.id === id);
  // a page read already: read it again only if asked (a new version, the text stays in the old one)
  $("#picSaveRead").hidden = p?.status !== "done";
  $("#picSave").classList.toggle("primary", p?.status !== "done");
  $("#picInfo").textContent =
    p?.status === "working"
      ? t("pictureWhileReading")
      : p?.status === "done"
        ? t("pictureReadAgainInfo")
        : "";
  $("#pictureDialog").showModal();
  drawPicture();
}

function drawPicture() {
  const e = pic.edit;
  const stage = $("#picStage");
  // as big as the dialog allows
  const maxW = stage.clientWidth || 640,
    maxH = Math.max(240, innerHeight * 0.6);
  const full = drawFrame(pic.src, { ...e, crop: null });
  const s = Math.min(maxW / full.width, maxH / full.height);
  const c = $("#picCanvas");
  c.width = Math.round(full.width * s);
  c.height = Math.round(full.height * s);
  c.getContext("2d").drawImage(full, 0, 0, c.width, c.height);
  stage.style.height = `${c.height}px`;
  $("#picAngle").value = e.angle;
  $("#picAngleOut").textContent = `${e.angle > 0 ? "+" : ""}${num(e.angle, 1)}°`;
  placeCrop();
}

function placeCrop() {
  const c = $("#picCanvas"),
    cr = pic.edit.crop ?? WHOLE,
    box = $("#picCrop");
  Object.assign(box.style, {
    left: `${c.offsetLeft + cr.x * c.width}px`,
    top: `${c.offsetTop + cr.y * c.height}px`,
    width: `${cr.w * c.width}px`,
    height: `${cr.h * c.height}px`,
  });
  box.classList.toggle("whole", !pic.edit.crop);
}

/** Where the pointer is on the picture, as fractions of it (kept inside). */
function picPoint(ev) {
  const r = $("#picCanvas").getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)),
  };
}

const MIN = 0.05;
$("#picStage").addEventListener("pointerdown", (ev) => {
  if (!pic.src) return;
  ev.preventDefault();
  const at = picPoint(ev),
    cr = { ...(pic.edit.crop ?? WHOLE) };
  const handle = ev.target.dataset?.h;
  const inside = at.x > cr.x && at.x < cr.x + cr.w && at.y > cr.y && at.y < cr.y + cr.h;
  // a corner: resize; inside a crop: move it; anywhere else: draw a new one from here
  pic.drag = handle
    ? { kind: "corner", h: handle, cr }
    : inside && pic.edit.crop
      ? { kind: "move", at, cr }
      : { kind: "new", at };
  $("#picStage").setPointerCapture(ev.pointerId);
});
$("#picStage").addEventListener("pointermove", (ev) => {
  const d = pic.drag;
  if (!d) return;
  const p = picPoint(ev);
  let cr;
  if (d.kind === "new") {
    cr = {
      x: Math.min(d.at.x, p.x),
      y: Math.min(d.at.y, p.y),
      w: Math.abs(p.x - d.at.x),
      h: Math.abs(p.y - d.at.y),
    };
    if (cr.w < 0.01 && cr.h < 0.01) return; // a click, not a drag yet
  } else if (d.kind === "move") {
    cr = {
      ...d.cr,
      x: Math.min(1 - d.cr.w, Math.max(0, d.cr.x + p.x - d.at.x)),
      y: Math.min(1 - d.cr.h, Math.max(0, d.cr.y + p.y - d.at.y)),
    };
  } else {
    // the corner follows the pointer, the opposite one stays
    let [x1, y1, x2, y2] = [d.cr.x, d.cr.y, d.cr.x + d.cr.w, d.cr.y + d.cr.h];
    if (d.h.includes("w")) x1 = Math.min(p.x, x2 - MIN);
    else x2 = Math.max(p.x, x1 + MIN);
    if (d.h.includes("n")) y1 = Math.min(p.y, y2 - MIN);
    else y2 = Math.max(p.y, y1 + MIN);
    cr = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  pic.edit.crop = cr;
  placeCrop();
});
const endDrag = () => {
  const cr = pic.edit?.crop;
  if (pic.drag && cr && (cr.w < MIN || cr.h < MIN)) pic.edit.crop = null; // too small to be meant
  pic.drag = null;
  if (pic.edit) placeCrop();
};
$("#picStage").addEventListener("pointerup", endDrag);
$("#picStage").addEventListener("pointercancel", endDrag);

const turn = (dir) => {
  pic.edit.rotate = (pic.edit.rotate + dir * 90 + 360) % 360;
  pic.edit.crop = turnCrop(pic.edit.crop, dir); // the same part of the page stays kept
  drawPicture();
};
$("#picLeft").onclick = () => turn(-1);
$("#picRight").onclick = () => turn(1);
$("#picAngle").min = -MAX_ANGLE;
$("#picAngle").max = MAX_ANGLE;
$("#picAngle").addEventListener("input", (ev) => {
  pic.edit.angle = Number(ev.target.value);
  $("#picStage").classList.add("grid"); // lines to straighten against, while the slider moves
  drawPicture();
});
$("#picAngle").addEventListener("change", () => $("#picStage").classList.remove("grid"));
$("#picWhole").onclick = () => {
  pic.edit.crop = null;
  placeCrop();
};
$("#picReset").onclick = () => {
  pic.edit = { rotate: 0, angle: 0, crop: null };
  drawPicture();
};
$("#picCancel").onclick = () => $("#pictureDialog").close();
$("#pictureDialog").addEventListener("close", () => Object.assign(pic, { id: null, src: null, edit: null }));
async function savePicture(readAgain) {
  try {
    await api(`/api/page/${pic.id}/picture`, { edit: pic.edit, readAgain });
    $("#pictureDialog").close();
  } catch (err) {
    toast(err.message);
  }
}
$("#picSave").onclick = () => savePicture(false);
$("#picSaveRead").onclick = () => savePicture(true);
addEventListener("resize", () => pic.src && drawPicture());

// ---------------------------------------------------------------- pages
function statusOf(p) {
  if (p.status === "queued") return ["", t("waiting")];
  if (p.status === "working") return ["busy", t("reading")];
  if (p.status === "failed") return ["bad", t("failed")];
  if (p.status === "stopped") return ["", t("stoppedChip")];
  if (p.ok === false) return ["bad", t("formatError", { f: FORMAT_NAME[fmtOf(p)] })];
  if (p.ok === null) return ["busy", t("buildingPreview")];
  if (p.checked) return ["ok", t("checked")];
  if (p.truncated) return ["warn", t("mayBeCut")];
  if (p.unk) return ["warn", t("unclear", { n: p.unk })];
  return ["ok", t("statusDone")];
}

function renderStatusLine() {
  const pages = S.pages,
    queued = pages.filter((p) => p.status === "queued").length;
  const working = pages.find((p) => p.status === "working");
  const done = pages.filter((p) => p.status === "done").length;
  const el = $("#statusLine");
  if (!pages.length && !S.intake) {
    el.innerHTML = "";
    return;
  }
  let html = `<span>${t("pagesDone", { done: `<strong>${done}</strong>`, n: pages.length })}</span>`;
  const checked = pages.filter((p) => p.status === "done" && p.checked).length;
  if (done)
    html +=
      `<span>· ${t("checkedOf", { c: `<strong>${checked}</strong>`, d: done })}</span>` +
      (checked < done
        ? ` <button class="ghost compare" data-act="compareNext">${t("proofreadNext")}</button>`
        : "");
  if (working || queued || S.intake) {
    const elapsed = working ? Date.now() / 1000 - working.started : 0;
    const left = Math.max(0, S.avgSecs - elapsed) + queued * S.avgSecs;
    html += `<span class="bar"><i style="width:${((100 * done) / Math.max(1, pages.length)).toFixed(1)}%"></i></span>`;
    html += `<span>${S.intake ? t("addingFiles") + " · " : ""}${working || queued ? t("timeLeft", { t: about(left) }) : ""}</span>`;
    if (queued + (working ? 1 : 0) > 1)
      html += ` <button class="ghost" data-act="stopAll" title="${t("stopAllTitle")}">${t("stopAll")}</button>`;
    html += `<span class="note">${t("canClose")}</span>`;
  }
  const stopped = pages.filter((p) => p.status === "stopped").length;
  if (stopped)
    html += `<span>· ${t("stoppedN", { n: stopped })} <button class="ghost" data-act="readStopped">${t("readThem", { n: stopped })}</button></span>`;
  const trials = pages.filter((p) => p.trial === "queued" || p.trial === "working").length;
  if (trials)
    html += `<span>· ${t("trialsLeft", { n: trials })} <button class="ghost" data-act="stopTrials">${t("stopTrials")}</button></span>`;
  el.innerHTML = html;
}

function pageNumber(id) {
  return S.pages.findIndex((p) => p.id === id) + 1;
}

function cardKey(p) {
  return [
    p.status,
    p.rev,
    p.ok,
    p.unk,
    p.err,
    p.truncated,
    p.checked,
    p.pngs.join(),
    p.trial,
    p.fresh,
    p.current,
    p.versions?.length,
    p.pic,
  ].join("|");
}

/** A trial reading of the page, waiting, running or failed. */
const trialChip = (p) =>
  p.trial === "queued"
    ? `<span class="chip">${t("trialWaiting")}</span>`
    : p.trial === "working"
      ? `<span class="chip busy">${t("trying")}</span>`
      : p.trial === "failed"
        ? `<span class="chip bad" title="${esc(p.trialErr)}">${t("trialFailedShort")}</span>`
        : "";

function buildCard(p) {
  const [cls, label] = statusOf(p);
  const el = document.createElement("article");
  el.className =
    "card " +
    ({ queued: "queued", working: "working", failed: "failed", stopped: "queued" }[p.status] ||
      (p.ok === false ? "broken" : !p.checked && (p.unk || p.truncated) ? "unclear" : "done"));
  el.dataset.id = p.id;
  const scan = p.noScan
    ? `<div class="col scan"><h3>${t("scan")}</h3></div>`
    : `<div class="col scan"><div class="col-head"><h3>${t("scan")}</h3>
      <button class="ghost small" data-act="editPicture" title="${t("editPictureTitle")}">${t("editPicture")}</button></div>
      <img loading="lazy" src="/files/scans/${p.id}.jpg?r=${p.pic ?? 0}" alt="${t("scanAlt")}"></div>`;
  let mid = "",
    right = "";
  const stop = `<button data-act="stopPage" title="${t("stopPageTitle")}">${t("stopPage")}</button>`;
  if (p.status === "queued") {
    mid = `<div class="col" style="grid-column: span 2"><div class="waiting">${t("waitingTurn")}${stop}</div></div>`;
  } else if (p.status === "working") {
    mid = `<div class="col" style="grid-column: span 2"><div class="waiting"><div class="spinner"></div>
      <div>${t("readingHandwriting")} <b class="elapsed"></b></div><div class="note">${t("usuallyTakes", { t: about(S.avgSecs) })}</div>${stop}</div></div>`;
  } else if (p.status === "stopped") {
    mid = `<div class="col" style="grid-column: span 2"><div class="waiting">${t("stoppedText")}
      <button class="primary" data-act="readPage">${t("readPage")}</button></div></div>`;
  } else if (p.status === "failed") {
    mid = `<div class="col" style="grid-column: span 2"><div class="err">${esc(p.err || t("wentWrong"))}</div>
      <p><button class="primary" data-act="redo">${t("tryAgain")}</button></p></div>`;
  } else {
    mid = `<div class="col"><h3>${FORMAT_NAME[fmtOf(p)]}</h3><div class="code card-code"></div>
      <div class="editor-foot">
        <span class="saved"></span><span class="grow"></span>
        ${p.unk ? `<button data-act="nextUnk" title="${t("nextUnclearTitle")}">${t("nextUnclear")}</button>` : ""}
        <button class="primary" data-act="copy">${t("copyFmt", { f: FORMAT_NAME[fmtOf(p)] })}</button>
      </div></div>`;
    let prev = "";
    if (p.truncated) prev += `<div class="err" style="margin-bottom:8px">${t("cutOff")}</div>`;
    if (p.ok === false)
      prev += `<div class="err">${t("noCompile", { f: FORMAT_NAME[fmtOf(p)] })}<pre>${esc(p.err)}</pre></div>`;
    if (p.ok === null)
      prev += `<div class="waiting"><div class="spinner"></div>${t("buildingPreview")}</div>`;
    prev += p.pngs
      .map((src) => `<img src="/files/${esc(src)}?r=${p.rev}" alt="${t("renderedAlt")}">`)
      .join("");
    right = `<div class="col preview"><h3>${t("preview")}</h3>${prev}</div>`;
  }
  el.innerHTML = `<div class="card-head" draggable="true" title="${t("dragToMove")}">
      <h2>${t("pageN", { n: pageNumber(p.id) })}</h2><span class="chip ${cls}">${esc(label)}</span>
      ${trialChip(p)}
      <span class="src" title="${esc(p.label)}"><bdi>${esc(p.label)}</bdi></span><span class="spacer"></span>
      ${p.fresh ? `<button class="compare fresh" data-act="fresh" title="${t("newVersionTitle")}">${t("newVersion")}</button>` : ""}
      ${!p.fresh && (p.versions?.length ?? 0) > 1 ? `<button class="ghost" data-act="versions" title="${t("versionsTitle")}">${t("versionsN", { n: p.versions.length })}</button>` : ""}
      ${p.status === "done" ? `<button class="ghost compare" data-act="compare" title="${t("compareTitle")}">${t("compare")}</button>` : ""}
      <button class="ghost" data-act="up" title="${t("moveUp")}">↑</button>
      <button class="ghost" data-act="down" title="${t("moveDown")}">↓</button>
      ${p.status === "done" ? `<button class="ghost" data-act="redo" title="${t("readAgainTitle")}">${t("readAgain")}</button>` : ""}
      <button class="ghost" data-act="delete" title="${t("removeTitle")}">${t("remove")}</button>
    </div><div class="card-body">${scan}${mid}${right}</div>`;
  return el;
}

// The list's editors: one per card, made when the card comes near the visible area (main scrolls) and
// released when it goes far away again (unless it's being typed in or has unsaved text), so a list of
// hundreds of pages stays light. Removed with their card.
const cardEds = new Map(); // page id -> { ed, div }
const nearView = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) mountEditor(e.target);
      else releaseEditor(e.target);
    }
  },
  { root: $("main"), rootMargin: "800px 0px" },
);

function releaseEditor(div) {
  const id = div.closest(".card")?.dataset.id;
  const entry = id && cardEds.get(id);
  if (!entry || entry.div !== div || entry.ed.hasFocus() || dirty.has(id)) return;
  entry.ed.destroy();
  cardEds.delete(id); // the box stays observed: back near the view, it gets a new editor
}

function mountEditor(div) {
  const card = div.closest(".card"),
    id = card?.dataset.id;
  if (!id || cardEds.get(id)?.div === div) return;
  dropEditor(id); // an editor left on an older box of this card
  const ed = createLatexEditor(div, { onChange: (pid, text) => save(pid, text, $(".saved", card)) });
  cardEds.set(id, { ed, div });
  const p = S.pages.find((x) => x.id === id);
  if (pendingTex.has(id)) ed.load(id, pendingTex.get(id), p && fmtOf(p)); // an edit not saved yet: it wins
  if (p) loadTex(p, card);
}

/** A card leaves (removed or rebuilt): its editor goes, and its box is no longer watched. */
function dropEditor(id, cardEl) {
  const code = cardEl && $(".card-code", cardEl);
  if (code) nearView.unobserve(code);
  const entry = cardEds.get(id);
  if (!entry) return;
  nearView.unobserve(entry.div);
  entry.ed.destroy();
  cardEds.delete(id);
}

/** Fill a card's editor with the page's text, unless it's being typed in or has unsaved edits. */
async function loadTex(p, el) {
  const entry = cardEds.get(p.id);
  if (!entry || entry.div !== $(".card-code", el)) return; // not near the visible area yet
  const fill = (tex) => {
    if (!dirty.has(p.id) && (!entry.ed.hasFocus() || entry.ed.text === ""))
      entry.ed.load(p.id, tex, fmtOf(p));
  };
  const c = texCache.get(p.id);
  if (c && c.rev === p.rev) return fill(c.tex);
  const r = await fetch(`/api/page/${p.id}`).then((r) => r.json());
  texCache.set(p.id, { rev: p.rev, tex: r.tex });
  fill(r.tex);
}

function renderPages() {
  const box = $("#pages");
  $("#empty").hidden = S.pages.length > 0 || S.intake > 0;
  const ids = new Set(S.pages.map((p) => p.id));
  for (const [id, c] of cards)
    if (!ids.has(id)) {
      dropEditor(id, c.el);
      c.el.remove();
      cards.delete(id);
    }
  let prev = null;
  for (const p of S.pages) {
    let c = cards.get(p.id);
    const key = cardKey(p) + "|" + pageNumber(p.id) + "|" + uiLang(); // a new language rebuilds the cards
    const editing = c && !!cardEds.get(p.id)?.ed.hasFocus();
    if (!c || (c.key !== key && !editing)) {
      const el = buildCard(p);
      if (c) {
        dropEditor(p.id, c.el); // the new card gets its own (unsaved text comes back from pendingTex)
        c.el.replaceWith(el);
      } else box.append(el);
      c = { el, key };
      cards.set(p.id, c);
      const code = $(".card-code", el);
      if (code) nearView.observe(code);
    } else if (editing) {
      // keep the editor; refresh only the preview column
      const [cls, label] = statusOf(p);
      const chip = $(".chip", c.el);
      chip.className = "chip " + cls;
      chip.textContent = label;
      const fresh = buildCard(p),
        oldPrev = $(".preview", c.el),
        newPrev = $(".preview", fresh);
      if (oldPrev && newPrev) oldPrev.replaceWith(newPrev);
      c.key = key;
    }
    if ((prev ? prev.nextSibling : box.firstChild) !== c.el) {
      if (prev) prev.after(c.el);
      else box.prepend(c.el);
    }
    prev = c.el;
    if (p.status === "done") loadTex(p, c.el);
  }
}

function tick() {
  if (!S) return;
  for (const p of S.pages)
    if (p.status === "working") {
      const el = cards.get(p.id)?.el,
        b = el && $(".elapsed", el);
      if (b) b.textContent = mmss(Date.now() / 1000 - p.started);
    }
  if (S.pages.some((p) => p.status === "working")) renderStatusLine();
  if ($("#phoneDialog").open) renderPhoneDialog();
}

function render() {
  renderHeader();
  renderSetup();
  renderSettings();
  renderScanner();
  renderPhone();
  renderStatusLine();
  renderPages();
  renderCompare();
  tick();
}

// ---------------------------------------------------------------- actions
// the button itself says it worked, for a moment
function flash(btn, label) {
  if (!btn) return;
  clearTimeout(btn.flashTimer);
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = label;
  btn.classList.add("copied");
  btn.flashTimer = setTimeout(() => {
    btn.textContent = btn.dataset.label;
    btn.classList.remove("copied");
  }, 1600);
}

function copyOldWay(text) {
  // for browsers that block the clipboard API
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
  (document.querySelector("dialog[open]") || document.body).append(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy refused");
}

async function copyText(text, what, btn) {
  try {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      copyOldWay(text);
    }
    toast(t("copiedWhat", { what }));
    flash(btn, t("copiedBtn"));
  } catch {
    toast(t("copyFailed"));
  }
}

const pendingTex = new Map(); // id -> text waiting to be saved (the editor may show another page by then)
/** Save a page's text a moment after the last keystroke; `el` shows "Saving…/Saved" while `shown()`. */
function save(id, text, el, shown = () => true) {
  clearTimeout(dirty.get(id));
  pendingTex.set(id, text);
  // the compare editor may show another page by the time this save finishes
  const label = (t) => {
    if (el && shown()) el.textContent = t;
  };
  label(t("saving"));
  dirty.set(
    id,
    setTimeout(async () => {
      try {
        const tex = pendingTex.get(id);
        await api(`/api/page/${id}/tex`, { tex });
        texCache.set(id, { rev: -1, tex });
        dirty.delete(id);
        pendingTex.delete(id);
        label(t("saved"));
      } catch (e) {
        label(t("notSaved", { e: e.message }));
      }
    }, 900),
  );
}

// Big images shrink to fit the window; small ones (a single formula) are enlarged up to 2.5x.
function zoom(src) {
  const z = $("#zoom"),
    img = $("img", z);
  img.style.width = "";
  img.onload = () => {
    const s = Math.min((innerWidth * 0.92) / img.naturalWidth, (innerHeight * 0.88) / img.naturalHeight, 2.5);
    img.style.width = Math.round(img.naturalWidth * s) + "px";
  };
  img.src = src;
  if (img.complete && img.naturalWidth) img.onload();
  z.showModal();
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (e.target.matches(".card .scan img, .card .preview img")) {
    const id = e.target.closest(".card").dataset.id;
    if (p_done(id)) openCompare(id);
    else zoom(e.target.src);
    return;
  }
  if (!b) return;
  const act = b.dataset.act,
    card = b.closest(".card"),
    id = card?.dataset.id;
  try {
    if (act === "compare") openCompare(id);
    else if (act === "fresh") {
      const p = S.pages.find((x) => x.id === id);
      openCompare(id, { other: p?.fresh });
    } else if (act === "versions") {
      const p = S.pages.find((x) => x.id === id);
      openCompare(id, { other: p?.versions?.filter((v) => v.id !== p.current).at(-1)?.id });
    } else if (act === "pickFolder" || act === "usualFolder") {
      const busy = S.pages.some((p) => p.status === "working" || p.trial === "working");
      if (busy && !confirm(t("folderWhileReading"))) return;
      await api("/api/folder", { usual: act === "usualFolder" });
    } else if (act === "stopPage") await api(`/api/page/${id}/stop`);
    else if (act === "readPage") await api(`/api/page/${id}/read`);
    else if (act === "stopAll") await api("/api/stop-all");
    else if (act === "readStopped") await api("/api/read-stopped");
    else if (act === "editPicture") await openPicture(id);
    else if (act === "expand") openExpand(b.dataset.for);
    else if (act === "tryOn") openTrial();
    else if (act === "stopTrials") await api("/api/trial/cancel");
    else if (act === "resetPrompt") {
      await api("/api/settings", { prompt: "" });
      $("#settingsBody").dataset.html = "";
    } else if (act === "chooseFile") await api("/api/model/file", { which: b.dataset.which });
    else if (act === "findModels") {
      const r = await api("/api/model/list", { url: $("#setUrl")?.value, key: $("#setSrvKey")?.value });
      serverModels = r.models;
      toast(t("modelsFound", { n: serverModels.length }));
      $("#settingsBody").dataset.html = "";
      renderSettings();
    } else if (act === "compareNext") {
      const n = nextUnchecked(null);
      if (n) openCompare(n);
    } else if (act === "copy") {
      const text = cardEds.get(id)?.ed.text ?? (await fetch(`/api/page/${id}`).then((r) => r.json())).tex;
      copyText(text, t("pageN", { n: pageNumber(id) }), b);
    } else if (act === "nextUnk") cardEds.get(id)?.ed.nextUnclear();
    else if (act === "redo") {
      if (p_done(id) && !confirm(t("confirmRedo"))) return;
      await api(`/api/page/${id}/redo`);
    } else if (act === "delete") {
      if (confirm(t("confirmRemove", { n: pageNumber(id) }))) await api(`/api/page/${id}/delete`);
    } else if (act === "up" || act === "down")
      await api(`/api/page/${id}/move`, { by: act === "up" ? -1 : 1 });
    else if (act === "find") await api("/api/scanner/find");
    else if (act === "scan")
      await api("/api/scanner/scan", { device: $("#scanDev")?.value || S.scanner.devices[0].id });
    else if (act === "pair") await api("/api/phone/pair");
    else if (act === "revoke") {
      if (confirm(t("confirmRevoke"))) await api("/api/phone/revoke", { id: b.dataset.id });
    }
  } catch (err) {
    toast(err.message);
  }
});
const p_done = (id) => S.pages.find((p) => p.id === id)?.status === "done";

// ---------------------------------------------------------------- compare view
// One page at a time, full window: scan and preview (one above the other for wide strips,
// side by side for full pages), linked zoom and scroll, the LaTeX editor beside them.
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem("h2t." + k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("h2t." + k, JSON.stringify(v));
    } catch {}
  },
};
const cmp = { id: null, rev: null, z: 1, layout: null, editor: store.get("cmpEditor", true), syncing: false };
const donePages = () => S.pages.filter((p) => p.status === "done");

function nextUnchecked(fromId) {
  const done = donePages(),
    i = done.findIndex((p) => p.id === fromId);
  for (let k = 1; k <= done.length; k++) {
    const p = done[(i + k + done.length) % done.length];
    if (!p.checked && p.id !== fromId) return p.id;
  }
  return null;
}

function openCompare(id, opts = {}) {
  const d = $("#compare");
  cmp.other = opts.other ?? null; // another version beside the one shown
  if (opts.other && S.pages.find((p) => p.id === id)?.fresh === opts.other) void api(`/api/page/${id}/seen`);
  cmp.id = id;
  cmp.rev = null;
  cmp.z = 1;
  if (!d.open) {
    cmp.layout = null;
    d.showModal();
  } // a layout picked by hand stays while paging
  renderCompare();
  for (const pane of panes()) pane.scrollTo(0, 0);
  if (!cmpEd.hasFocus()) d.focus(); // keys to the view (Enter = checked), unless typing in the editor
}

function applyLayout() {
  const img = $("#paneScan img"),
    box = $("#cmpImages");
  let layout = cmp.layout;
  if (!layout) layout = img.naturalWidth && img.naturalWidth / img.naturalHeight > 1.4 ? "stack" : "side";
  box.classList.toggle("stack", layout === "stack");
  $("#cmpLayout").textContent = layout === "stack" ? t("sideBySide") : t("stacked");
}

/** The image panes shown: scan, preview, and another version's preview while two are compared. */
const panes = () => ["#paneScan", "#panePrev", "#paneOther"].map((s) => $(s)).filter((el) => !el.hidden);

function setZoom(z) {
  const old = cmp.z;
  cmp.z = Math.max(0.5, Math.min(5, z));
  $("#cmpImages").style.setProperty("--z", cmp.z);
  $("#cmpZoom").textContent = Math.round(cmp.z * 100) + "%";
  // keep the middle of the view in place
  for (const pane of panes()) {
    const k = cmp.z / old;
    pane.scrollLeft = (pane.scrollLeft + pane.clientWidth / 2) * k - pane.clientWidth / 2;
    pane.scrollTop = (pane.scrollTop + pane.clientHeight / 2) * k - pane.clientHeight / 2;
  }
}

function renderCompare() {
  const d = $("#compare");
  if (!d.open || !S) return;
  const p = S.pages.find((x) => x.id === cmp.id);
  if (!p || p.status !== "done") {
    // removed or sent back to be read again
    const n = nextUnchecked(cmp.id) || donePages()[0]?.id;
    if (n && n !== cmp.id) openCompare(n);
    else d.close();
    return;
  }
  const done = donePages(),
    i = done.findIndex((x) => x.id === p.id);
  const checked = done.filter((x) => x.checked).length;
  $("#cmpTitle").textContent = t("pageN", { n: pageNumber(p.id) });
  const fname = FORMAT_NAME[fmtOf(p)];
  $("#panePrev .pane-label").textContent = t("previewOf", { f: fname });
  // previous/next: in Arabic the previous page is to the right
  $("[data-cmp=prev]", d).textContent = isRtl() ? "›" : "‹";
  $("[data-cmp=next]", d).textContent = isRtl() ? "‹" : "›";
  if (cmp.layoutLang !== uiLang()) {
    cmp.layoutLang = uiLang();
    applyLayout(); // its button's words
  }
  $("#cmpEditorBtn").textContent = fname;
  const copyBtn = $("[data-cmp=copy]");
  if (!copyBtn.classList.contains("copied"))
    copyBtn.textContent = copyBtn.dataset.label = t("copyFmt", { f: fname });
  $("#cmpTitle").title = p.label;
  const [cls, label] = statusOf(p);
  $("#cmpChip").className = "chip " + cls;
  $("#cmpChip").textContent = label;
  $("#cmpProgress").textContent = t("checkedOf", { c: checked, d: done.length });
  $("[data-cmp=prev]", d).disabled = i <= 0;
  $("[data-cmp=next]", d).disabled = i >= done.length - 1;
  const cb = $("#cmpCheck");
  cb.textContent = p.checked ? t("checked") : t("markChecked");
  cb.className = p.checked ? "checked" : "primary";
  cb.title = p.checked ? t("unmarkTitle") : t("markTitle");
  $("#cmpUnk").hidden = !p.unk;
  // versions: the one shown, and another one beside it (its preview, and what differs)
  const others = (p.versions ?? []).filter((v) => v.id !== p.current);
  if (cmp.other && !others.some((v) => v.id === cmp.other)) cmp.other = null;
  const ov = others.find((v) => v.id === cmp.other);
  $("#cmpVersions").hidden = !others.length;
  const sel = $("#cmpOther"),
    key = others.map((v) => v.id).join() + "|" + uiLang() + "|" + p.id;
  if (sel.dataset.key !== key) {
    sel.innerHTML =
      `<option value="">${esc(t("nothing"))}</option>` +
      [...others]
        .reverse()
        .map((v) => `<option value="${v.id}">${esc(versionName(v))}</option>`)
        .join("");
    sel.dataset.key = key;
  }
  sel.value = cmp.other ?? "";
  $("#cmpEditor").hidden = !cmp.editor || !!ov;
  $("#cmpEditorBtn").classList.toggle("on", cmp.editor);
  $("#cmpEditorBtn").disabled = !!ov;
  $("#paneOther").hidden = !ov;
  $("#cmpDiff").hidden = !ov;
  if (ov) {
    $("#panePrev .pane-label").textContent = t("shownVersion", { v: p.current ?? "" });
    $("#paneOther .pane-label").textContent = versionName(ov);
    renderOther(p, ov);
    void renderDiff(p, ov);
  } else cmp.otherKey = cmp.diffKey = null;

  if (cmp.rev !== p.rev || cmp.revLang !== uiLang()) {
    // new page, or its preview was rebuilt (or the language changed): keep zoom and scroll
    cmp.revLang = uiLang();
    const first = cmp.rev === null;
    cmp.rev = p.rev;
    const img = $("#paneScan img"),
      src = `/files/scans/${p.id}.jpg`;
    if (first) {
      img.onload = applyLayout;
      if (!img.src.endsWith(src)) img.src = src;
      else applyLayout();
    }
    let prev = "";
    if (p.truncated) prev += `<div class="err">${t("cutOff")}</div>`;
    if (p.ok === false)
      prev += `<div class="err">${t("noCompile", { f: FORMAT_NAME[fmtOf(p)] })}<pre>${esc(p.err)}</pre></div>`;
    if (p.ok === null)
      prev += `<div class="waiting"><div class="spinner"></div>${t("buildingPreview")}</div>`;
    prev += p.pngs.map((s) => `<img src="/files/${esc(s)}?r=${p.rev}" alt="${t("renderedAlt")}">`).join("");
    $("#prevInner").innerHTML = prev;
    if (first) setZoom(1);
  }
  if (cmpEd.pageId !== p.id) {
    cmpEd.load(p.id, "", fmtOf(p)); // another page: empty until its text arrives (fresh undo history)
    $(".saved", d).textContent = "";
  }
  // fill the editor unless you are typing in it (an empty editor, right after a page switch, is always filled)
  const mayFill = () => cmpEd.pageId === p.id && !dirty.has(p.id) && (!cmpEd.hasFocus() || cmpEd.text === "");
  if (mayFill()) {
    const c = texCache.get(p.id);
    if (c && c.rev === p.rev) cmpEd.load(p.id, c.tex, fmtOf(p));
    else
      fetch(`/api/page/${p.id}`)
        .then((r) => r.json())
        .then((r) => {
          texCache.set(p.id, { rev: p.rev, tex: r.tex });
          if (mayFill()) cmpEd.load(p.id, r.tex, fmtOf(p));
        });
  }
}

/** "v2 · 13/11/2026 10:02 · Qwen3.5 9B" */
function versionName(v) {
  const date = new Date(v.at * 1000).toLocaleString(`${uiLang()}-u-nu-latn`, {
    dateStyle: "short",
    timeStyle: "short",
  });
  return `${v.id} · ${date} · ${v.model || t("earlierReading")}`;
}

/** The other version's preview: built when first compared. */
function renderOther(p, ov) {
  const key = `${p.id}|${ov.id}|${ov.rev ?? 0}|${uiLang()}`;
  if (cmp.otherKey === key) return;
  cmp.otherKey = key;
  let html = "";
  if (ov.truncated) html += `<div class="err">${t("cutOff")}</div>`;
  if (ov.ok === false)
    html += `<div class="err">${t("noCompile", { f: FORMAT_NAME[fmtOf(p)] })}<pre>${esc(ov.err)}</pre></div>`;
  if (!ov.pngs) {
    html += `<div class="waiting"><div class="spinner"></div>${t("buildingPreview")}</div>`;
    void api(`/api/page/${p.id}/version/${ov.id}/preview`).catch((e) => toast(e.message));
  } else
    html += ov.pngs.map((s) => `<img src="/files/${esc(s)}?r=${ov.rev}" alt="${t("renderedAlt")}">`).join("");
  $("#otherInner").innerHTML = html;
}

/** What differs between the text shown and the other version, word by word, and what to do with it. */
async function renderDiff(p, ov) {
  const key = `${p.id}|${ov.id}|${p.rev}|${uiLang()}`;
  if (cmp.diffKey === key) return;
  cmp.diffKey = key;
  const get = (vid) => fetch(`/api/page/${p.id}/version/${vid}`).then((r) => r.json());
  const [other, shown] = await Promise.all([
    get(ov.id),
    p.current ? get(p.current) : { tex: "", prompt: "" },
  ]);
  if (cmp.diffKey !== key) return; // moved on meanwhile
  const shownText = cmpEd.pageId === p.id && cmpEd.text ? cmpEd.text : shown.tex;
  const parts = diffWords(shownText, other.tex);
  const text = parts
    .map((x) =>
      x.op === "same"
        ? esc(x.text)
        : x.op === "del"
          ? `<del>${esc(x.text)}</del>`
          : `<ins>${esc(x.text)}</ins>`,
    )
    .join("");
  const samePrompt = other.prompt === shown.prompt;
  $("#cmpDiff").innerHTML = `<div class="diff-head">
      <button class="primary" data-cmp="useOther" title="${esc(t("useVersionTitle", { v: ov.id }))}">${esc(t("useVersion", { v: ov.id }))}</button>
      <button class="ghost" data-cmp="deleteOther">${esc(t("deleteVersion", { v: ov.id }))}</button>
    </div>
    <p class="note">${esc(t("diffLegend", { a: p.current ?? "", b: ov.id }))}</p>
    ${
      !other.prompt || !shown.prompt
        ? ""
        : samePrompt
          ? `<p class="note">${esc(t("sameInstructions"))}</p>`
          : `<details class="note"><summary>${esc(t("otherInstructions"))}</summary><pre dir="ltr">${esc(other.prompt)}</pre></details>`
    }
    ${parts.every((x) => x.op === "same") ? `<p class="note">${esc(t("sameText"))}</p>` : ""}
    <pre class="diff" dir="auto">${text}</pre>`;
}

const cmpEd = createLatexEditor($("#cmpCode"), {
  onChange: (id, text) => save(id, text, $("#compare .saved"), () => cmpEd.pageId === id),
  onCheck: () => cmpCheckAndNext().catch((err) => toast(err.message)),
});

async function cmpCheckAndNext() {
  const p = S.pages.find((x) => x.id === cmp.id);
  if (!p) return;
  if (dirty.has(p.id)) await new Promise((r) => setTimeout(r, 950)); // let the last edit save first
  if (!p.checked) await api(`/api/page/${p.id}/check`, { checked: true });
  const n = nextUnchecked(p.id);
  if (n) openCompare(n);
  else toast(t("allChecked"));
}

async function cmpAction(act) {
  const p = S.pages.find((x) => x.id === cmp.id),
    done = donePages();
  const i = done.findIndex((x) => x.id === cmp.id);
  if (act === "prev" && i > 0) openCompare(done[i - 1].id);
  else if (act === "next" && i < done.length - 1) openCompare(done[i + 1].id);
  else if (act === "close") $("#compare").close();
  else if (act === "in") setZoom(cmp.z * 1.25);
  else if (act === "out") setZoom(cmp.z / 1.25);
  else if (act === "fit") setZoom(1);
  else if (act === "layout") {
    cmp.layout = $("#cmpImages").classList.contains("stack") ? "side" : "stack";
    applyLayout();
  } else if (act === "editor") {
    cmp.editor = !cmp.editor;
    store.set("cmpEditor", cmp.editor);
    renderCompare();
  } else if (act === "check") {
    if (p.checked) await api(`/api/page/${p.id}/check`, { checked: false });
    else await cmpCheckAndNext();
  } else if (act === "copy")
    copyText(cmpEd.text, t("pageN", { n: pageNumber(cmp.id) }), $("[data-cmp=copy]"));
  else if (act === "nextUnk") cmpEd.nextUnclear();
  else if (act === "useOther" && cmp.other) {
    const was = p.current,
      next = cmp.other;
    if (dirty.has(p.id)) await new Promise((r) => setTimeout(r, 950)); // the last edit is saved first
    await api(`/api/page/${p.id}/version/${next}/use`);
    texCache.delete(p.id);
    cmpEd.load(p.id, "", fmtOf(p)); // filled again with the version now shown
    cmp.other = was; // still side by side, the other way round
    cmp.diffKey = cmp.otherKey = null;
    toast(t("nowShowing", { v: next }));
  } else if (act === "deleteOther" && cmp.other) {
    if (!confirm(t("confirmDeleteVersion", { v: cmp.other }))) return;
    await api(`/api/page/${p.id}/version/${cmp.other}/delete`);
    cmp.other = null;
  }
}
$("#cmpOther").addEventListener("change", (e) => {
  cmp.other = e.target.value || null;
  cmp.diffKey = cmp.otherKey = null;
  renderCompare();
});

$("#compare").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cmp]");
  if (b && !b.disabled) cmpAction(b.dataset.cmp).catch((err) => toast(err.message));
  // after a mouse click, give the keys back to the view (a keyboard press keeps focus on the button)
  if (b && e.detail > 0 && b.dataset.cmp !== "nextUnk") $("#compare").focus();
});
$("#compare").addEventListener("keydown", (e) => {
  if (e.defaultPrevented) return; // the editor handled it (Ctrl+Enter, completion, search…)
  const typing =
    e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT" || !!e.target.closest?.(".cm-editor");
  if (e.key === "Enter" && (e.ctrlKey || !typing) && !e.target.closest("button")) {
    e.preventDefault();
    cmpCheckAndNext().catch((err) => toast(err.message));
    return;
  }
  if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
  const map = {
    // in Arabic the pages run right to left: → goes back
    ArrowLeft: isRtl() ? "next" : "prev",
    ArrowRight: isRtl() ? "prev" : "next",
    "+": "in",
    "=": "in",
    "-": "out",
    0: "fit",
    l: "layout",
    L: "layout",
    e: "editor",
    E: "editor",
  };
  if (map[e.key]) {
    e.preventDefault();
    cmpAction(map[e.key]);
  }
});
// Ctrl + mouse wheel zooms both images
$("#cmpImages").addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(cmp.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  },
  { passive: false },
);
// scrolling one image scrolls the other to the same relative place
for (const a of ["#paneScan", "#panePrev", "#paneOther"]) {
  $(a).addEventListener("scroll", () => {
    if (cmp.syncing) return;
    cmp.syncing = true;
    const A = $(a);
    const fy = A.scrollTop / Math.max(1, A.scrollHeight - A.clientHeight);
    const fx = A.scrollLeft / Math.max(1, A.scrollWidth - A.clientWidth);
    for (const B of panes())
      if (B !== A) {
        B.scrollTop = fy * (B.scrollHeight - B.clientHeight);
        B.scrollLeft = fx * (B.scrollWidth - B.clientWidth);
      }
    requestAnimationFrame(() => {
      cmp.syncing = false;
    });
  });
}
$("#compare").addEventListener("close", () => {
  cmp.id = null;
});

$("#pick").onclick = () => $("#files").click();
$("#files").onchange = (e) => {
  upload([...e.target.files]);
  e.target.value = "";
};
async function upload(files) {
  files = files.filter(
    (f) => f.type.startsWith("image/") || /\.pdf$/i.test(f.name) || f.type === "application/pdf",
  );
  if (!files.length) {
    toast(t("onlyPhotos"));
    return;
  }
  toast(t("addingN", { n: files.length }));
  for (const f of files) {
    try {
      await api("/api/upload", { "X-Filename": encodeURIComponent(f.name) }, f);
    } catch (e) {
      toast(`${f.name}: ${e.message}`);
    }
  }
}
// Dragging a page (its header, scan or preview) moves it in the list. Only files from outside the window add
// pages: a picture dragged from a page carries itself as a file, and used to come back as another page.
let pageDrag = null; // the page being dragged, "inside" for any other drag that started in the window, or null
const element = (n) => (n?.nodeType === 1 ? n : n?.parentElement);
const editable = (n) => !!element(n)?.closest?.("textarea, input, [contenteditable=true], .cm-editor");
function clearDropMark() {
  for (const c of document.querySelectorAll(".card.drop-before, .card.drop-after"))
    c.classList.remove("drop-before", "drop-after");
}
/** The card under the pointer, and whether the dragged page goes after it. */
function dropMark(e) {
  const card = element(e.target)?.closest?.(".card");
  if (!card || card.dataset.id === pageDrag) return null;
  const r = card.getBoundingClientRect();
  return { card, after: e.clientY > r.top + r.height / 2 };
}
addEventListener("dragstart", (e) => {
  const card = editable(e.target) ? null : element(e.target)?.closest?.(".card");
  pageDrag = card?.dataset.id ?? "inside";
  if (!card) return;
  e.dataTransfer.effectAllowed = "move";
  card.classList.add("lifted");
});
addEventListener("dragend", () => {
  clearDropMark();
  document.querySelector(".card.lifted")?.classList.remove("lifted");
  pageDrag = null;
});
let dragDepth = 0;
addEventListener("dragenter", (e) => {
  if (!pageDrag && e.dataTransfer?.types.includes("Files")) {
    dragDepth++;
    document.body.classList.add("dragging");
  }
});
addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove("dragging");
  }
});
addEventListener("dragover", (e) => {
  if (pageDrag === "inside" && editable(e.target)) return; // text moved within the editors: as usual
  e.preventDefault();
  if (!pageDrag || pageDrag === "inside") return;
  e.dataTransfer.dropEffect = "move";
  const m = dropMark(e);
  const same = m && m.card.classList.contains(m.after ? "drop-after" : "drop-before");
  if (!same) {
    clearDropMark();
    if (m) m.card.classList.add(m.after ? "drop-after" : "drop-before");
  }
});
addEventListener("drop", (e) => {
  if (pageDrag === "inside" && editable(e.target)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  if (pageDrag) {
    // from inside the window: a page put elsewhere, or nothing
    const m = pageDrag !== "inside" && dropMark(e);
    clearDropMark();
    if (!m) return;
    const ids = S.pages.map((p) => p.id);
    const from = ids.indexOf(pageDrag);
    let to = ids.indexOf(m.card.dataset.id) + (m.after ? 1 : 0);
    if (from < to) to--;
    if (from >= 0 && to !== from)
      api(`/api/page/${pageDrag}/move`, { by: to - from }).catch((err) => toast(err.message));
    return;
  }
  upload([...e.dataTransfer.files]);
});
addEventListener("paste", (e) => {
  if (e.target.tagName === "TEXTAREA") return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) upload(files);
});

$("#phoneTile").onclick = async () => {
  const ph = S?.phone || {};
  renderPhoneDialog();
  $("#phoneDialog").showModal();
  if (ph.status === "ready" && !(ph.qr && ph.pairingExpiresAt > Date.now()) && !(ph.devices || []).length) {
    try {
      await api("/api/phone/pair");
    } catch (e) {
      toast(e.message);
    }
  }
};
$("#phoneClose").onclick = () => $("#phoneDialog").close();
$("#zoom").onclick = () => $("#zoom").close();

$("#format").onchange = async (e) => {
  try {
    await api("/api/settings", { format: e.target.value });
    toast(e.target.value === "typst" ? t("nowTypst") : t("backLatex"), 5000);
  } catch (err) {
    toast(err.message);
  }
};
$("#lang").onchange = async (e) => {
  const v = e.target.value;
  if (v === "__other") {
    $("#langOther").hidden = false;
    $("#langOther").focus();
    return;
  }
  $("#langOther").hidden = true;
  try {
    await api("/api/settings", { language: v });
    toast(t("langChanged", { l: e.target.selectedOptions[0].text }));
  } catch (err) {
    toast(err.message);
  }
};
$("#langOther").onchange = async (e) => {
  const v = e.target.value.trim();
  if (!v) return;
  try {
    await api("/api/settings", { language: v });
    toast(t("langChanged", { l: v }));
  } catch (err) {
    toast(err.message);
  }
};
$("#copyAll").onclick = async (e) =>
  copyText(await fetch("/api/all.tex").then((r) => r.text()), t("allPages"), e.currentTarget);
// Save .tex: the system's Save dialog (opened by the app), then where it went.
$("#saveTex").onclick = async (e) => {
  const btn = e.currentTarget;
  try {
    const r = await api("/api/save-document");
    if (!r.path) return; // cancelled
    flash(btn, t("savedBtn"));
    toast(t("savedTo", { p: r.path }), 6000);
  } catch (err) {
    toast(t("saveFailed", { e: err.message }), 5000);
  }
};

setInterval(tick, 1000);
// safety net in case an event is ever missed: the state is small and local
setInterval(async () => {
  try {
    const v = (await (await fetch("/api/version")).json()).version;
    if (!S || v !== S.version) refresh();
  } catch {}
}, 5000);
refresh();
connect();
