// The hand2tex window. It talks to src/server.ts: /api/state for everything shown, /api/events for change
// notices, POSTs (with the X-Hand2tex header) for every action.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
if (navigator.userAgent.includes("Mac")) document.documentElement.classList.add("mac"); // its buttons: left
let S = null; // last state from the server
const texCache = new Map(); // id -> {rev, tex}
const dirty = new Map(); // id -> timer for unsaved edits
const cards = new Map(); // id -> {el, key}

async function api(path, body, raw) {
  const opt = { method: "POST", headers: { "X-Hand2tex": "1" } };
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
    ? "less than a minute"
    : s < 5400
      ? `about ${Math.round(s / 60)} min`
      : `about ${(s / 3600).toFixed(1)} h`;

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
    $("#engine").innerHTML = '<span class="dot bad"></span><span>App closed — reopen hand2tex</span>';
    setTimeout(connect, 3000);
  };
}

// ---------------------------------------------------------------- header + tiles
function renderHeader() {
  const m = S.model;
  const setUp = !S.setup.missing.engine && !S.setup.missing.model;
  const map = {
    ready: ["ok", "Reading engine ready"],
    starting: ["warn", "Reading engine starting…"],
    stopped: setUp ? ["ok", "Reading engine ready to start"] : ["warn", "Not set up yet"],
    missing: ["warn", "Not set up yet"],
    error: ["bad", "Reading engine stopped"],
  };
  const [cls, text] = map[m.status] || ["", m.status];
  $("#engine").innerHTML = `<span class="dot ${cls}"></span><span>${esc(text)}</span>`;
  $("#engine").title = m.detail || "";

  const sel = $("#lang");
  if (!sel.options.length) {
    for (const l of S.languages) sel.add(new Option(l.name, l.id));
    sel.add(new Option("Other…", "__other"));
  }
  const cur = S.settings.language;
  if (document.activeElement !== sel && document.activeElement !== $("#langOther")) {
    const known = S.languages.some((l) => l.id === cur);
    sel.value = known ? cur : "__other";
    $("#langOther").hidden = known;
    if (!known) $("#langOther").value = cur;
  }
  const done = S.pages.filter((p) => p.status === "done").length;
  $("#copyAll").disabled = $("#saveTex").disabled = !done;
}

function renderScanner() {
  const sc = S.scanner,
    info = $("#scanInfo"),
    row = $("#scanRow");
  $("#scanTile").hidden = !sc.available || (!sc.devices.length && !sc.scanning);
  if ($("#scanTile").hidden) return;
  let html = "";
  if (sc.scanning) {
    info.textContent = "Scanning… keep the lid closed.";
  } else if (sc.looking) {
    info.textContent = "Looking for scanners…";
  } else if (!sc.devices.length) {
    info.textContent = "No scanner found. Plug it in and turn it on.";
    html = `<button data-act="find">Look again</button>`;
  } else {
    info.textContent = sc.error || (sc.devices.length === 1 ? sc.devices[0].name : "Choose a scanner:");
    if (sc.devices.length > 1)
      html += `<select id="scanDev">${sc.devices.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join("")}</select>`;
    html += `<button class="primary" data-act="scan">Scan a page</button><button class="ghost" data-act="find">Refresh</button>`;
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
      ? ph.error || "Phone sending is not available."
      : ph.status !== "ready"
        ? "Starting…"
        : n
          ? `${n} phone${n > 1 ? "s" : ""} connected · photos appear here by themselves`
          : "Connect your phone to send photos";
  if ($("#phoneDialog").open) renderPhoneDialog();
}

function renderPhoneDialog() {
  const ph = S.phone || {},
    body = $("#phoneBody");
  const devs = ph.devices || [];
  let html = "";
  if (ph.status !== "ready") {
    html = `<p class="err">${esc(ph.error || "The phone receiver is still starting. Try again in a moment.")}</p>`;
  } else {
    const left = ph.pairingExpiresAt ? (ph.pairingExpiresAt - Date.now()) / 1000 : 0;
    html += `<ol class="steps">
      <li>Install <b>Folder Camera</b> on the phone (free on F-Droid).</li>
      <li>In Folder Camera, open <b>Settings</b> and tap <b>Scan PC pairing QR</b>.</li>
      <li>Point the phone at this code.</li>
      <li>Take photos of your pages. They appear here by themselves.</li></ol>`;
    if (ph.qr && left > 0) {
      html += `<div class="qr">${ph.qr}</div>
        <div class="note" style="text-align:center">This code works once and expires in ${mmss(left)}.
        <button class="ghost" data-act="pair">New code</button></div>`;
    } else {
      html += `<div style="text-align:center;margin:16px"><button class="primary" data-act="pair">Show a pairing code</button></div>`;
    }
    if (devs.length) {
      html +=
        `<h3 style="margin:14px 0 0;font-size:14px">Connected phones</h3><ul class="devices">` +
        devs
          .map(
            (d) =>
              `<li><span>${esc(d.name)}</span><button class="ghost" data-act="revoke" data-id="${esc(d.id)}">Remove</button></li>`,
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
const bytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

function jobHtml(job) {
  if (job.status === "running" && job.progress) {
    const { done, total, phase } = job.progress,
      pct = total ? (100 * done) / total : 0;
    const label =
      phase === "verify"
        ? "Checking"
        : phase === "unpack"
          ? "Unpacking"
          : `${bytes(done)} of ${bytes(total)}`;
    return `<span class="bar"><i style="width:${pct.toFixed(1)}%"></i></span><span class="note">${label} · ${pct.toFixed(0)}%</span>`;
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
      ${missing ? jobHtml(running("verify") && k === "model" ? j.verify : j[k]) || `<span class="note">${bytes(su.sizes[k])}</span>` : `<span class="note ok-text">Ready</span>`}
      ${running(k) ? `<button class="ghost" data-setup="cancel" data-id="${k}">Stop</button>` : ""}
    </div>`;
  const anyRunning = running("engine") || running("model") || running("verify");
  const total = (su.missing.engine ? su.sizes.engine : 0) + (su.missing.model ? su.sizes.model : 0);
  let html = `<div class="setup-card">
    <h2>Set up hand2tex</h2>
    <p>hand2tex reads your pages on this computer, so it needs two downloads, once. Nothing you add ever leaves this computer.
    Pages you add now wait until it's ready.</p>
    ${row("engine", "Reading engine (llama.cpp)", su.missing.engine)}
    ${row("model", "Model (Qwen3.5 9B vision)", su.missing.model)}`;
  if (!su.supported.engine && su.missing.engine) {
    html += `<p class="err">There is no ready-made reading engine for this system yet. If you have your own llama.cpp build, set its llama-server in Settings.</p>`;
  }
  if (!anyRunning) {
    html += `<div class="setup-actions">
      ${su.supported.engine || !su.missing.engine ? `<button class="primary" data-setup="download">Download (${bytes(total)})</button>` : ""}
      ${su.missing.model ? `<button data-setup="folder" title="Use Qwen3.5-9B-Q4_K_M.gguf and mmproj-F16.gguf you already downloaded">I already have the model files…</button>` : ""}
    </div>`;
  }
  html += `<p class="note">The model needs about 8 GB of free memory. With a graphics chip, a page takes a minute or two; on the processor alone it can take several minutes.</p></div>`;
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
    } else if (b.dataset.setup === "cancel") await api("/api/setup/cancel", { id: b.dataset.id });
    else if (b.dataset.setup === "folder") await api("/api/setup/model-folder");
    else if (b.dataset.setup === "tectonic") await api("/api/setup/download", { id: "tectonic" });
    else if (b.dataset.setup === "default-model") await api("/api/setup/default-model");
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------------- settings
function renderSettings() {
  const d = $("#settingsDialog");
  if (!d.open) return;
  const body = $("#settingsBody");
  if (
    body.contains(document.activeElement) &&
    document.activeElement.tagName === "INPUT" &&
    document.activeElement.type === "text"
  )
    return;
  const t = S.tex,
    m = S.machine,
    ph = S.phone,
    sc = S.scanner,
    su = S.setup;
  const usingText =
    t.using === "system"
      ? `Using the installed LaTeX: ${esc(t.detail)}`
      : t.using === "tectonic"
        ? `Using ${esc(t.detail)}`
        : "Not used yet: the first preview decides.";
  const found = [t.system.pdflatex, t.system.xelatex].filter(Boolean);
  const radio = (
    v,
    label,
    help,
  ) => `<label class="choice"><input type="radio" name="tex" value="${v}" ${m.tex === v ? "checked" : ""}>
    <span><b>${label}</b><small>${help}</small></span></label>`;
  const tecJob = su.jobs.tectonic;
  let html = `
  <section class="set">
    <h3>LaTeX for the previews</h3>
    ${radio("auto", "Automatic", "The LaTeX installed on this computer if it works for your language, otherwise the built-in one.")}
    ${radio("system", "Installed LaTeX", found.length ? `Found: ${found.map(esc).join(", ")}` : "None found on this computer.")}
    ${radio("builtin", "Built-in (Tectonic)", t.tectonic ? "Downloaded." : `Downloaded when first needed (${bytes(su.sizes.tectonic)}); then it fetches the LaTeX packages a page uses, once.`)}
    <p class="note">${usingText}</p>
    ${tecJob.status === "running" || tecJob.status === "error" ? `<div class="setup-row"><span class="setup-name">Tectonic</span>${jobHtml(tecJob)}</div>` : ""}
  </section>
  <section class="set">
    <h3>Phone</h3>
    <label class="choice"><input type="checkbox" id="setPhone" ${m.phone ? "checked" : ""}>
      <span><b>Receive photos from a phone (Folder Camera)</b>
      <small>Off by default. When on, hand2tex listens on your Wi-Fi for photos from phones you pair with a QR code.
      ${navigator.userAgent.includes("Windows") ? "Windows will ask once to allow it through the firewall." : ""}</small></span></label>
    ${m.phone && ph.status === "error" ? `<p class="err">${esc(ph.error)}</p>` : ""}
  </section>
  <section class="set">
    <h3>Scanner</h3>
    ${
      sc.available
        ? `<p class="note">${sc.looking ? "Looking for scanners…" : sc.devices.length ? `Found: ${sc.devices.map((x) => esc(x.name)).join(", ")}` : "No scanner found."}</p>
      <button data-act="find" ${sc.looking ? "disabled" : ""}>Look for scanners</button>`
        : `<p class="note">Scanning needs SANE (scanimage), available on Linux and macOS. You can always add scanned files as photos or PDFs.</p>`
    }
  </section>
  <section class="set">
    <h3>Reading engine</h3>
    <p class="note">Model files: ${esc(su.modelDir)}</p>
    <div class="setup-actions">
      <button data-setup="folder">Use model files from another folder…</button>
      ${su.custom.modelDir ? `<button class="ghost" data-setup="default-model">Use hand2tex's own copy</button>` : ""}
    </div>
    ${su.jobs.verify.status === "running" || su.jobs.verify.status === "error" ? `<div class="setup-row"><span class="setup-name">Checking files</span>${jobHtml(su.jobs.verify)}</div>` : ""}
    <label class="field">Your own llama-server (optional)
      <input type="text" id="setServer" placeholder="Leave empty to use the downloaded one" value="${esc(su.custom.serverPath)}"></label>
    <p class="note">${su.serverPath ? `Using ${esc(su.serverPath)}` : "No reading engine yet."}</p>
  </section>
  <section class="set">
    <h3>Your pages</h3>
    <p class="note">Saved in ${esc(S.folder)}</p>
  </section>`;
  if (body.dataset.html !== html) {
    body.innerHTML = html;
    body.dataset.html = html;
  }
}

$("#settingsBtn").onclick = () => {
  $("#settingsDialog").showModal();
  renderSettings();
};
$("#settingsClose").onclick = () => $("#settingsDialog").close();
$("#settingsDialog").addEventListener("change", async (e) => {
  try {
    if (e.target.name === "tex") await api("/api/settings", { tex: e.target.value });
    else if (e.target.id === "setPhone") await api("/api/settings", { phone: e.target.checked });
    else if (e.target.id === "setServer") {
      await api("/api/settings", { serverPath: e.target.value });
      toast("Saved");
    }
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------------- pages
function statusOf(p) {
  if (p.status === "queued") return ["", "Waiting"];
  if (p.status === "working") return ["busy", "Reading…"];
  if (p.status === "failed") return ["bad", "Failed"];
  if (p.ok === false) return ["bad", "LaTeX error"];
  if (p.ok === null) return ["busy", "Building preview…"];
  if (p.checked) return ["ok", "Checked ✓"];
  if (p.truncated) return ["warn", "May be cut off"];
  if (p.unk) return ["warn", `${p.unk} unclear spot${p.unk > 1 ? "s" : ""}`];
  return ["ok", "Done"];
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
  let html = `<span><strong>${done}</strong> of ${pages.length} page${pages.length === 1 ? "" : "s"} done</span>`;
  const checked = pages.filter((p) => p.status === "done" && p.checked).length;
  if (done)
    html +=
      `<span>· <strong>${checked}</strong> of ${done} checked</span>` +
      (checked < done
        ? ` <button class="ghost compare" data-act="compareNext">Proofread the next one</button>`
        : "");
  if (working || queued || S.intake) {
    const elapsed = working ? Date.now() / 1000 - working.started : 0;
    const left = Math.max(0, S.avgSecs - elapsed) + queued * S.avgSecs;
    html += `<span class="bar"><i style="width:${((100 * done) / Math.max(1, pages.length)).toFixed(1)}%"></i></span>`;
    html += `<span>${S.intake ? "Adding files… · " : ""}${working || queued ? about(left) + " left" : ""}</span>`;
    html += `<span class="note">You can close this window: waiting pages are still finished.</span>`;
  }
  el.innerHTML = html;
}

function pageNumber(id) {
  return S.pages.findIndex((p) => p.id === id) + 1;
}

function cardKey(p) {
  return [p.status, p.rev, p.ok, p.unk, p.err, p.truncated, p.checked, p.pngs.join()].join("|");
}

function buildCard(p) {
  const [cls, label] = statusOf(p);
  const el = document.createElement("article");
  el.className =
    "card " +
    ({ queued: "queued", working: "working", failed: "failed" }[p.status] ||
      (p.ok === false ? "broken" : !p.checked && (p.unk || p.truncated) ? "unclear" : "done"));
  el.dataset.id = p.id;
  const scan = `<div class="col scan"><h3>Scan</h3><img loading="lazy" src="/files/scans/${p.id}.jpg?r=${p.id}" alt="Scan of the page"></div>`;
  let mid = "",
    right = "";
  if (p.status === "queued") {
    mid = `<div class="col" style="grid-column: span 2"><div class="waiting">Waiting its turn…</div></div>`;
  } else if (p.status === "working") {
    mid = `<div class="col" style="grid-column: span 2"><div class="waiting"><div class="spinner"></div>
      <div>Reading the handwriting… <b class="elapsed"></b></div><div class="note">A page usually takes ${about(S.avgSecs)}.</div></div></div>`;
  } else if (p.status === "failed") {
    mid = `<div class="col" style="grid-column: span 2"><div class="err">${esc(p.err || "Something went wrong.")}</div>
      <p><button class="primary" data-act="redo">Try again</button></p></div>`;
  } else {
    mid = `<div class="col"><h3>LaTeX</h3><textarea spellcheck="false" aria-label="LaTeX of this page"></textarea>
      <div class="editor-foot">
        <span class="saved"></span><span class="grow"></span>
        ${p.unk ? `<button data-act="nextUnk" title="Jump to the next [??] the model could not read">Next unclear spot</button>` : ""}
        <button class="primary" data-act="copy">Copy LaTeX</button>
      </div></div>`;
    let prev = "";
    if (p.truncated)
      prev += `<div class="err" style="margin-bottom:8px">The page was very long and may be cut off at the end. Check the last lines.</div>`;
    if (p.ok === false)
      prev += `<div class="err">This LaTeX does not compile yet. Fix the text, and the preview updates by itself.<pre>${esc(p.err)}</pre></div>`;
    if (p.ok === null) prev += `<div class="waiting"><div class="spinner"></div>Building the preview…</div>`;
    prev += p.pngs.map((src) => `<img src="/files/${esc(src)}?r=${p.rev}" alt="Rendered page">`).join("");
    right = `<div class="col preview"><h3>Preview</h3>${prev}</div>`;
  }
  el.innerHTML = `<div class="card-head">
      <h2>Page ${pageNumber(p.id)}</h2><span class="chip ${cls}">${esc(label)}</span>
      <span class="src" title="${esc(p.label)}">${esc(p.label)}</span><span class="spacer"></span>
      ${p.status === "done" ? `<button class="ghost compare" data-act="compare" title="Scan and LaTeX side by side, to proofread">Compare</button>` : ""}
      <button class="ghost" data-act="up" title="Move up">↑</button>
      <button class="ghost" data-act="down" title="Move down">↓</button>
      ${p.status === "done" ? `<button class="ghost" data-act="redo" title="Read this page again">Read again</button>` : ""}
      <button class="ghost" data-act="delete" title="Remove this page">Remove</button>
    </div><div class="card-body">${scan}${mid}${right}</div>`;
  return el;
}

async function loadTex(p, el) {
  const ta = $("textarea", el);
  if (!ta) return;
  const c = texCache.get(p.id);
  if (c && c.rev === p.rev) {
    if (!dirty.has(p.id) && document.activeElement !== ta) ta.value = c.tex;
    return;
  }
  const r = await fetch(`/api/page/${p.id}`).then((r) => r.json());
  texCache.set(p.id, { rev: p.rev, tex: r.tex });
  if (!dirty.has(p.id) && document.activeElement !== ta) ta.value = r.tex;
}

function renderPages() {
  const box = $("#pages");
  $("#empty").hidden = S.pages.length > 0 || S.intake > 0;
  const ids = new Set(S.pages.map((p) => p.id));
  for (const [id, c] of cards)
    if (!ids.has(id)) {
      c.el.remove();
      cards.delete(id);
    }
  let prev = null;
  for (const p of S.pages) {
    let c = cards.get(p.id);
    const key = cardKey(p) + "|" + pageNumber(p.id);
    const editing =
      c &&
      document.activeElement &&
      c.el.contains(document.activeElement) &&
      document.activeElement.tagName === "TEXTAREA";
    if (!c || (c.key !== key && !editing)) {
      const keep = c && $("textarea", c.el);
      const el = buildCard(p);
      if (keep && dirty.has(p.id)) $("textarea", el).value = keep.value;
      if (c) c.el.replaceWith(el);
      else box.append(el);
      c = { el, key };
      cards.set(p.id, c);
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
    toast(`${what} copied`);
    flash(btn, "Copied ✓");
  } catch {
    toast("Could not copy: select the text and press Ctrl+C");
  }
}

const pendingTex = new Map(); // id -> text waiting to be saved (the editor may show another page by then)
function save(id, ta) {
  clearTimeout(dirty.get(id));
  pendingTex.set(id, ta.value);
  const el = $(".saved", ta.closest(".card, #compare"));
  // the compare editor may show another page by the time this save finishes
  const label = (t) => {
    if (el && (!ta.closest("#compare") || ta.dataset.id === id)) el.textContent = t;
  };
  label("Saving…");
  dirty.set(
    id,
    setTimeout(async () => {
      try {
        const tex = pendingTex.get(id);
        await api(`/api/page/${id}/tex`, { tex });
        texCache.set(id, { rev: -1, tex });
        dirty.delete(id);
        pendingTex.delete(id);
        label("Saved");
      } catch (e) {
        label("Not saved: " + e.message);
      }
    }, 900),
  );
}

document.addEventListener("input", (e) => {
  if (e.target.tagName !== "TEXTAREA") return;
  const id = e.target.closest("#compare") ? cmp.id : e.target.closest(".card")?.dataset.id;
  if (id) save(id, e.target);
});

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
    else if (act === "compareNext") {
      const n = nextUnchecked(null);
      if (n) openCompare(n);
    } else if (act === "copy") copyText($("textarea", card).value, `Page ${pageNumber(id)}`, b);
    else if (act === "nextUnk") {
      const ta = $("textarea", card),
        from = ta.selectionEnd || 0;
      let i = ta.value.indexOf("[??]", from);
      if (i < 0) i = ta.value.indexOf("[??]");
      if (i >= 0) {
        ta.focus();
        ta.setSelectionRange(i, i + 4);
        const line = ta.value.slice(0, i).split("\n").length;
        ta.scrollTop = Math.max(0, (line - 4) * 19.5);
      }
    } else if (act === "redo") {
      if (p_done(id) && !confirm("Read this page again? Your corrections on this page will be replaced."))
        return;
      await api(`/api/page/${id}/redo`);
    } else if (act === "delete") {
      if (confirm(`Remove page ${pageNumber(id)} from the list?`)) await api(`/api/page/${id}/delete`);
    } else if (act === "up" || act === "down")
      await api(`/api/page/${id}/move`, { by: act === "up" ? -1 : 1 });
    else if (act === "find") await api("/api/scanner/find");
    else if (act === "scan")
      await api("/api/scanner/scan", { device: $("#scanDev")?.value || S.scanner.devices[0].id });
    else if (act === "pair") await api("/api/phone/pair");
    else if (act === "revoke") {
      if (confirm("Remove this phone? It will need a new code to send photos again."))
        await api("/api/phone/revoke", { id: b.dataset.id });
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

function openCompare(id) {
  const d = $("#compare");
  cmp.id = id;
  cmp.rev = null;
  cmp.z = 1;
  if (!d.open) {
    cmp.layout = null;
    d.showModal();
  } // a layout picked by hand stays while paging
  renderCompare();
  $("#paneScan").scrollTo(0, 0);
  $("#panePrev").scrollTo(0, 0);
  if (document.activeElement?.tagName !== "TEXTAREA") d.focus(); // so Enter means "checked", not a button
}

function applyLayout() {
  const img = $("#paneScan img"),
    box = $("#cmpImages");
  let layout = cmp.layout;
  if (!layout) layout = img.naturalWidth && img.naturalWidth / img.naturalHeight > 1.4 ? "stack" : "side";
  box.classList.toggle("stack", layout === "stack");
  $("#cmpLayout").textContent = layout === "stack" ? "Side by side" : "One above the other";
}

function setZoom(z) {
  const old = cmp.z;
  cmp.z = Math.max(0.5, Math.min(5, z));
  $("#cmpImages").style.setProperty("--z", cmp.z);
  $("#cmpZoom").textContent = Math.round(cmp.z * 100) + "%";
  // keep the middle of the view in place
  for (const pane of [$("#paneScan"), $("#panePrev")]) {
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
  $("#cmpTitle").textContent = `Page ${pageNumber(p.id)}`;
  $("#cmpTitle").title = p.label;
  const [cls, label] = statusOf(p);
  $("#cmpChip").className = "chip " + cls;
  $("#cmpChip").textContent = label;
  $("#cmpProgress").textContent = `${checked} of ${done.length} checked`;
  $("[data-cmp=prev]", d).disabled = i <= 0;
  $("[data-cmp=next]", d).disabled = i >= done.length - 1;
  const cb = $("#cmpCheck");
  cb.textContent = p.checked ? "Checked ✓" : "Mark as checked";
  cb.className = p.checked ? "checked" : "primary";
  cb.title = p.checked
    ? "Click to mark as not checked"
    : "Mark this page as proofread and go to the next one (Enter)";
  $("#cmpEditor").hidden = !cmp.editor;
  $("#cmpEditorBtn").classList.toggle("on", cmp.editor);
  $("#cmpUnk").hidden = !p.unk;

  if (cmp.rev !== p.rev) {
    // new page, or its preview was rebuilt: keep zoom and scroll
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
    if (p.truncated)
      prev += `<div class="err">The page was very long and may be cut off at the end. Check the last lines.</div>`;
    if (p.ok === false)
      prev += `<div class="err">This LaTeX does not compile yet. Fix the text, and the preview updates by itself.<pre>${esc(p.err)}</pre></div>`;
    if (p.ok === null) prev += `<div class="waiting"><div class="spinner"></div>Building the preview…</div>`;
    prev += p.pngs.map((s) => `<img src="/files/${esc(s)}?r=${p.rev}" alt="Rendered page">`).join("");
    $("#prevInner").innerHTML = prev;
    if (first) setZoom(1);
  }
  const ta = $("#cmpEditor textarea");
  if (ta.dataset.id !== p.id) {
    ta.dataset.id = p.id;
    ta.value = "";
    $(".saved", d).textContent = "";
  }
  // fill the editor unless you are typing in it (an empty editor, right after a page switch, is always filled)
  const mayFill = () =>
    ta.dataset.id === p.id && !dirty.has(p.id) && (document.activeElement !== ta || ta.value === "");
  if (mayFill()) {
    const c = texCache.get(p.id);
    if (c && c.rev === p.rev) ta.value = c.tex;
    else
      fetch(`/api/page/${p.id}`)
        .then((r) => r.json())
        .then((r) => {
          texCache.set(p.id, { rev: p.rev, tex: r.tex });
          if (mayFill()) ta.value = r.tex;
        });
  }
}

async function cmpCheckAndNext() {
  const p = S.pages.find((x) => x.id === cmp.id);
  if (!p) return;
  if (dirty.has(p.id)) await new Promise((r) => setTimeout(r, 950)); // let the last edit save first
  if (!p.checked) await api(`/api/page/${p.id}/check`, { checked: true });
  const n = nextUnchecked(p.id);
  if (n) openCompare(n);
  else toast("Every page is checked");
}

async function cmpAction(act) {
  const p = S.pages.find((x) => x.id === cmp.id),
    done = donePages();
  const i = done.findIndex((x) => x.id === cmp.id),
    ta = $("#cmpEditor textarea");
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
  } else if (act === "copy") copyText(ta.value, `Page ${pageNumber(cmp.id)}`, $("[data-cmp=copy]"));
  else if (act === "nextUnk") {
    const from = ta.selectionEnd || 0;
    let k = ta.value.indexOf("[??]", from);
    if (k < 0) k = ta.value.indexOf("[??]");
    if (k >= 0) {
      ta.focus();
      ta.setSelectionRange(k, k + 4);
      const line = ta.value.slice(0, k).split("\n").length;
      ta.scrollTop = Math.max(0, (line - 4) * 19.5);
    }
  }
}

$("#compare").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cmp]");
  if (b && !b.disabled) cmpAction(b.dataset.cmp).catch((err) => toast(err.message));
  // after a mouse click, give the keys back to the view (a keyboard press keeps focus on the button)
  if (b && e.detail > 0 && b.dataset.cmp !== "nextUnk") $("#compare").focus();
});
$("#compare").addEventListener("keydown", (e) => {
  const typing = e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT";
  if (e.key === "Enter" && (e.ctrlKey || !typing) && !e.target.closest("button")) {
    e.preventDefault();
    cmpCheckAndNext().catch((err) => toast(err.message));
    return;
  }
  if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
  const map = {
    ArrowLeft: "prev",
    ArrowRight: "next",
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
for (const [a, b] of [
  ["#paneScan", "#panePrev"],
  ["#panePrev", "#paneScan"],
]) {
  $(a).addEventListener("scroll", () => {
    if (cmp.syncing) return;
    cmp.syncing = true;
    const A = $(a),
      B = $(b);
    const fy = A.scrollTop / Math.max(1, A.scrollHeight - A.clientHeight);
    const fx = A.scrollLeft / Math.max(1, A.scrollWidth - A.clientWidth);
    B.scrollTop = fy * (B.scrollHeight - B.clientHeight);
    B.scrollLeft = fx * (B.scrollWidth - B.clientWidth);
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
    toast("Only photos and PDFs can be added");
    return;
  }
  toast(`Adding ${files.length} file${files.length > 1 ? "s" : ""}…`);
  for (const f of files) {
    try {
      await api("/api/upload", { "X-Filename": encodeURIComponent(f.name) }, f);
    } catch (e) {
      toast(`${f.name}: ${e.message}`);
    }
  }
}
let dragDepth = 0;
addEventListener("dragenter", (e) => {
  if (e.dataTransfer?.types.includes("Files")) {
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
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
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
    toast("Language changed. New pages are read in " + e.target.selectedOptions[0].text + ".");
  } catch (err) {
    toast(err.message);
  }
};
$("#langOther").onchange = async (e) => {
  const v = e.target.value.trim();
  if (!v) return;
  try {
    await api("/api/settings", { language: v });
    toast(`Language changed to ${v}.`);
  } catch (err) {
    toast(err.message);
  }
};
$("#copyAll").onclick = async (e) =>
  copyText(await fetch("/api/all.tex").then((r) => r.text()), "All pages", e.currentTarget);
// Save .tex: the system's Save dialog (opened by the app), then where it went.
$("#saveTex").onclick = async (e) => {
  const btn = e.currentTarget;
  try {
    const r = await api("/api/save-document");
    if (!r.path) return; // cancelled
    flash(btn, "Saved ✓");
    toast(`Saved to ${r.path}`, 6000);
  } catch (err) {
    toast("Could not save: " + err.message, 5000);
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
