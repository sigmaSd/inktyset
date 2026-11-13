// Inktyset itself, without its window: the pages, the queue that reads them one at a time, previews, the
// downloads a first start needs, the settings, the phone and the scanner. The Electron shell gives it a
// Renderer (Chromium's image and PDF decoding, in a hidden window) and its dialogs; the window talks to it
// through server.ts.

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type ComponentId, install, type Progress, sizeOf, supported, verifyModelDir } from "./components.ts";
import { checkHardware, type Hardware } from "./hardware.ts";
import { Library } from "./library.ts";
import { Model, type ModelKind } from "./model.ts";
import { Phone } from "./phone.ts";
import { pagesFolderIn } from "./folders.ts";
import { cleanLatex, type Format, langPrompt, PROMPT } from "./pipeline.ts";
import { Scanner } from "./scanner.ts";
import { Tex, type TexMode } from "./tex.ts";
import { latexToTypst } from "./convert.ts";
import { Typst } from "./typst.ts";
import { msg, resolveLang, setCoreLanguage } from "./i18n.ts";
import { loadLocales } from "./locales.ts";
import type { Translations } from "./po.ts";

const MAX_SIDE = 1600; // the long side of what the model sees

/** Image and PDF work, done by Chromium (shell/electron/render.ts). Paths are relative to the data folder. */
export interface Renderer {
  /** A photo or scan → JPEG, upright (EXIF), long side at most `maxSide`. */
  image(rel: string, maxSide: number): Promise<Buffer>;
  /** Each page of a PDF → JPEG, long side `maxSide`. */
  pdfPages(rel: string, maxSide: number): Promise<Buffer[]>;
  /** A compiled page → PNG per page at `dpi`, empty margins cut off. */
  preview(rel: string, dpi: number): Promise<Buffer[]>;
}

/** What only the shell can do. */
export interface Shell {
  chooseFolder(title: string): Promise<string | null>;
  /** One file, of these extensions (without the dot). */
  chooseFile(title: string, extensions: string[]): Promise<string | null>;
  saveFile(name: string, text: string): Promise<string | null>;
  notify(text: string): void;
  /** Restart into a downloaded update (offered once `Core.update` is set). */
  installUpdate(): void;
  /** Start Inktyset again, in the pages folder of the settings (without a `--folder` it was started with). */
  relaunch(): void;
}

/** Settings of this computer (userData/settings.json); the language belongs to the pages (state.json). */
export interface Settings {
  phone: boolean;
  tex: TexMode;
  serverPath?: string;
  modelDir?: string;
  /** The app's own language: "auto" (the computer's), "en", "fr" or "ar" (src/i18n.ts). */
  ui?: string;
  /** Added to the instructions the model reads with (the user's notes on their handwriting). */
  instructions?: string;
  /** The whole instructions, when the user changed them (empty: Inktyset's own, pipeline.ts PROMPT). */
  prompt?: string;
  /** What reads the pages (src/model.ts): the built-in model, other model files, or a local server. */
  modelKind?: ModelKind;
  modelFile?: string;
  mmprojFile?: string;
  serverUrl?: string;
  serverModel?: string;
  serverKey?: string;
  /** The pages folder, when the user chose one (src/folders.ts); read by the shell before starting. */
  folder?: string;
}

/** Inktyset's own instructions, as shown in the settings. */
export const DEFAULT_PROMPT = PROMPT;

interface Job {
  status: "idle" | "running" | "done" | "error";
  progress: Progress | null;
  error: string;
  abort?: AbortController;
}

export class Core {
  readonly lib: Library;
  readonly model: Model;
  readonly tex: Tex;
  readonly typst: Typst;
  readonly phone: Phone;
  readonly scanner: Scanner;
  settings: Settings = { phone: false, tex: "auto" };
  jobs: Record<ComponentId | "verify", Job> = {
    engine: { status: "idle", progress: null, error: "" },
    model: { status: "idle", progress: null, error: "" },
    tectonic: { status: "idle", progress: null, error: "" },
    typst: { status: "idle", progress: null, error: "" },
    verify: { status: "idle", progress: null, error: "" },
  };
  missing = { engine: true, model: true };
  /** This computer's memory and graphics chips, and what to tell the user about them. */
  hardware: Hardware | null = null;
  /** A downloaded, verified update waiting for a restart (its version), or null. */
  update: string | null = null;
  /** This copy's version (Electron's, from package.json), shown in the window. */
  appVersion = "";
  /** The computer's preferred languages (from the shell), for the app language "auto". */
  systemLocales: readonly string[] = [];
  /** Where the pages go when the user chose no other folder (set by the shell). */
  defaultFolder = "";
  /** The pages folder was given with --folder: for this run only. */
  folderGiven = false;
  /** Where the translations are (locales/app), set by the shell; and what was read there. */
  localesDir = "";
  locales: Record<string, Translations> = {};
  readonly #userData: string;
  renderer!: Renderer;
  shell!: Shell;
  #wake: (() => void) | null = null;
  #reading: AbortController | null = null;
  #changeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string, userData: string) {
    this.#userData = userData;
    this.lib = new Library(dataDir);
    const changed = () => this.changed();
    this.model = new Model(userData, changed);
    this.tex = new Tex(userData, (p) => this.#track("tectonic", p));
    this.typst = new Typst(userData, (p) => this.#track("typst", p));
    this.scanner = new Scanner(changed);
    this.phone = new Phone({
      stateDir: join(userData, "phone"),
      photos: join(dataDir, "phone"),
      changed,
      seen: (rel) => this.lib.seenPhone.has(rel),
      arrived: (path, rel) => {
        this.lib.seenPhone.add(rel);
        void this.addFile(path, msg("phoneLabel", { name: rel.split(/[\\/]/).at(-1) }), "phone");
      },
    });
  }

  async init() {
    await mkdir(this.#userData, { recursive: true });
    await this.lib.init();
    if (this.localesDir) this.locales = await loadLocales(this.localesDir);
    try {
      const saved = JSON.parse(await readFile(this.#settingsFile(), "utf8"));
      if ("recentFolders" in saved) {
        // 0.7.0 listed the folders used before: no longer kept
        delete saved.recentFolders;
        await writeFile(this.#settingsFile(), JSON.stringify(saved, null, 2));
      }
      this.settings = { ...this.settings, ...saved };
    } catch {
      /* first start */
    }
    this.#applySettings();
    await this.refreshMissing();
    if (this.settings.phone) void this.phone.start();
    if (this.scanner.available) void this.scanner.find();
    void this.#loop();
  }

  #settingsFile() {
    return join(this.#userData, "settings.json");
  }

  /** The instructions a page is read with now: Inktyset's (or the user's own), the writing language, the user's notes. */
  readingPrompt(): string {
    return (this.settings.prompt?.trim() || PROMPT) + this.promptAddition();
  }

  /** What follows the instructions, from the user's settings: the writing language's rule, then their notes. */
  promptAddition(): string {
    const notes = this.settings.instructions?.trim();
    return (
      langPrompt(this.lib.settings.language) +
      (notes ? `\n\nNotes from the person who wrote these pages (follow them):\n${notes}` : "")
    );
  }

  #applySettings() {
    const lang = resolveLang(this.settings.ui, this.systemLocales, ["en", ...Object.keys(this.locales)]);
    setCoreLanguage(lang, this.locales[lang] ?? null);
    this.tex.mode = this.settings.tex;
    const s = this.settings;
    const config = {
      kind: s.modelKind ?? "builtin",
      serverPath: s.serverPath,
      modelDir: s.modelDir,
      modelFile: s.modelFile,
      mmprojFile: s.mmprojFile,
      url: s.serverUrl,
      name: s.serverModel,
      apiKey: s.serverKey,
    };
    // another model: the running one stops, the next page starts the new one
    if (JSON.stringify(config) !== JSON.stringify(this.model.config)) this.model.stop();
    this.model.config = config;
  }

  async setSettings(next: Partial<Settings>) {
    const phoneBefore = this.settings.phone;
    const texBefore = this.settings.tex;
    this.settings = { ...this.settings, ...next };
    await writeFile(this.#settingsFile(), JSON.stringify(this.settings, null, 2));
    this.#applySettings();
    if (this.settings.phone !== phoneBefore)
      await (this.settings.phone ? this.phone.start() : this.phone.stop());
    if (this.settings.tex !== texBefore) void this.recompileAll();
    await this.refreshMissing();
    this.changed();
    this.wake();
  }

  /**
   * The document's output format. Every finished page switches at once: to Typst, its LaTeX is converted
   * (src/convert.ts) unless a Typst version newer than the LaTeX exists (Typst corrections are kept); back to
   * LaTeX, it shows its LaTeX (corrections made in Typst don't carry back).
   */
  async setFormat(format: Format) {
    this.lib.settings.format = format;
    for (const p of this.lib.pages) {
      if (p.status !== "done" || (p.format ?? "latex") === format) continue;
      if (format === "typst") await this.#ensureTypst(p.id);
      p.format = format;
      p.ok = null;
    }
    this.lib.changed();
    void this.recompileAll();
  }

  /** pages/<id>.typ from pages/<id>.tex, unless it's already newer. */
  async #ensureTypst(id: string) {
    const tex = await stat(this.lib.texPath(id)).catch(() => null);
    const typ = await stat(this.lib.typPath(id)).catch(() => null);
    if (typ && tex && typ.mtimeMs >= tex.mtimeMs) return;
    const latex = await readFile(this.lib.texPath(id), "utf8").catch(() => "");
    await writeFile(this.lib.typPath(id), latexToTypst(latex));
  }

  async setLanguage(language: string) {
    const changed = language.toLowerCase() !== this.lib.settings.language.toLowerCase();
    this.lib.settings.language = language;
    this.lib.changed();
    if (changed) void this.recompileAll();
  }

  async refreshMissing() {
    this.missing = await this.model.missing();
    void this.refreshHardware();
  }

  async refreshHardware() {
    this.hardware = await checkHardware(await this.model.serverPath());
    this.changed();
  }

  /** Coalesced: many changes in a burst → one update for the windows. */
  changed() {
    if (this.#changeTimer) return;
    this.#changeTimer = setTimeout(() => {
      this.#changeTimer = null;
      this.lib.changed();
    }, 50);
  }

  // ------------------------------------------------------------------ downloads

  #track(id: ComponentId, p: Promise<void>) {
    const job = this.jobs[id];
    job.status = "running";
    job.error = "";
    this.changed();
    p.then(
      () => (job.status = "done"),
      (e: Error) => {
        job.status = "error";
        job.error = e.message;
      },
    ).finally(() => {
      void this.refreshMissing().then(() => {
        this.changed();
        this.wake(); // pages waiting for the setup can be read now
      });
    });
  }

  download(id: ComponentId) {
    const job = this.jobs[id];
    if (job.status === "running" || !supported(id)) return;
    const abort = new AbortController();
    job.abort = abort;
    job.progress = { done: 0, total: sizeOf(id), phase: "download" };
    let last = 0;
    const p = install(
      this.#userData,
      id,
      (pr) => {
        job.progress = pr;
        if (Date.now() - last > 500) {
          last = Date.now();
          this.changed();
        }
      },
      abort.signal,
    );
    this.#track(id, p);
    if (id === "model") {
      // a folder chosen earlier is no longer what we use once our own copy is here
      void p.then(() => this.setSettings({ modelDir: undefined }));
    }
  }

  cancel(id: ComponentId) {
    this.jobs[id].abort?.abort();
  }

  /**
   * Keep the pages in another folder: one the user picks (or the usual one), then restart there. The folder left
   * keeps its pages.
   */
  async useFolder(usual = false) {
    const chosen = usual ? this.defaultFolder : await this.shell.chooseFolder(msg("pagesFolderTitle"));
    if (!chosen) return;
    const dir = usual ? chosen : await pagesFolderIn(chosen);
    const folder = dir === this.defaultFolder ? undefined : dir;
    if (dir === this.lib.dir && !this.folderGiven) {
      // already open (the chosen one could not be, at start): just remember it
      if (this.settings.folder !== folder) await this.setSettings({ folder });
      return;
    }
    await mkdir(dir, { recursive: true });
    await this.setSettings({ folder });
    this.shell.relaunch();
  }

  /** Use model files the user already has: choose their folder, check them, remember it. */
  async useModelFolder() {
    const dir = await this.shell.chooseFolder(msg("modelFolderTitle"));
    if (!dir) return;
    const job = this.jobs.verify;
    job.status = "running";
    job.error = "";
    job.progress = { done: 0, total: 1, phase: "verify" };
    this.changed();
    try {
      let last = 0;
      await verifyModelDir(dir, (done, total) => {
        job.progress = { done, total, phase: "verify" };
        if (Date.now() - last > 500) {
          last = Date.now();
          this.changed();
        }
      });
      job.status = "done";
      await this.setSettings({ modelDir: dir });
    } catch (e) {
      job.status = "error";
      job.error = (e as Error).message;
      this.changed();
    }
  }

  // ------------------------------------------------------------------ pages in

  rel(path: string) {
    return relative(this.lib.dir, path).split("\\").join("/");
  }

  /** A file (under the data folder) becomes pages: an image one, a PDF one per sheet. */
  async addFile(path: string, label: string, origin: "file" | "scan" | "phone") {
    this.lib.intake++;
    this.changed();
    try {
      if (/\.pdf$/i.test(path)) {
        const sheets = await this.renderer.pdfPages(this.rel(path), MAX_SIDE);
        for (const [i, jpeg] of sheets.entries()) {
          const id = this.lib.nextId();
          await writeFile(this.lib.scanPath(id), jpeg);
          this.lib.add(id, sheets.length > 1 ? `${label} · sheet ${i + 1}/${sheets.length}` : label, origin);
        }
      } else {
        const jpeg = await this.renderer.image(this.rel(path), MAX_SIDE);
        const id = this.lib.nextId();
        await writeFile(this.lib.scanPath(id), jpeg);
        this.lib.add(id, label, origin);
      }
    } catch (e) {
      this.lib.addFailed(label, origin, msg("notPicture", { error: (e as Error).message }));
    } finally {
      this.lib.intake--;
      this.changed();
      this.#wake?.();
    }
  }

  // ------------------------------------------------------------------ the queue

  async #loop() {
    for (;;) {
      // pages to read first, then trial readings (other instructions or model, never replacing the text)
      const page = this.lib.pages.find((p) => p.status === "queued");
      const trial = page
        ? undefined
        : this.lib.pages.find((p) => p.trial === "queued" && p.status === "done");
      // nothing to read, or not set up yet (the engine or the model still to download)
      if ((!page && !trial) || this.missing.engine || this.missing.model) {
        await new Promise<void>((r) => (this.#wake = r));
        this.#wake = null;
        continue;
      }
      if (page) await this.#read(page.id);
      else await this.#read(trial!.id, true);
    }
  }

  /** Read these finished pages again with the current instructions and model, as new versions to compare. */
  tryOn(ids: string[]) {
    for (const id of ids) {
      const p = this.lib.get(id);
      if (p?.status === "done" && p.trial !== "working") Object.assign(p, { trial: "queued", trialErr: "" });
    }
    this.lib.changed();
    this.wake();
  }

  /** Stop the trial readings not started yet (the one being read finishes). */
  cancelTrials() {
    for (const p of this.lib.pages) if (p.trial === "queued" || p.trial === "failed") p.trial = undefined;
    this.lib.changed();
  }

  async useVersion(id: string, vid: string) {
    const p = this.lib.get(id);
    if (!p || p.status !== "done") throw new Error("page is not ready");
    await this.lib.useVersion(p, vid);
    if ((p.format ?? "latex") === "typst") await this.#ensureTypst(id);
    this.lib.changed();
    await this.compile(id);
  }

  async deleteVersion(id: string, vid: string) {
    const p = this.lib.get(id);
    if (!p) throw new Error("no such page");
    await this.lib.deleteVersion(p, vid);
    this.lib.changed();
  }

  /** A version's own preview, to compare it with the one shown (built once; again after an edit). */
  versionPreview(id: string, vid: string): Promise<void> {
    this.#compiling = this.#compiling.then(() => this.#versionPreview(id, vid)).catch(() => {});
    return this.#compiling;
  }

  async #versionPreview(id: string, vid: string) {
    const p = this.lib.get(id);
    const v = p?.versions?.find((x) => x.id === vid);
    if (!p || !v || p.current === vid) return;
    const typst = (p.format ?? "latex") === "typst";
    let body = await this.lib.versionText(p, vid, typst ? "typ" : "tex");
    if (typst && !body) body = latexToTypst(await this.lib.versionText(p, vid));
    const dir = join(this.lib.buildDir(id), vid);
    const lang = this.lib.settings.language;
    let pngs: string[] = [],
      ok = false,
      err = "";
    try {
      const r = typst ? await this.typst.compile(dir, body, lang) : await this.tex.compile(dir, body, lang);
      ok = r.ok;
      err = r.err;
      if (r.pdf) {
        const images = await this.renderer.preview(this.rel(r.pdf), 150);
        pngs = await Promise.all(
          images.map(async (png, i) => {
            const f = join(dir, `render-${i + 1}.png`);
            await writeFile(f, png);
            return this.rel(f);
          }),
        );
      }
    } catch (e) {
      err = (e as Error).message;
    }
    Object.assign(v, { ok, err, pngs, rev: (v.rev ?? 0) + 1 });
    this.lib.changed();
  }

  /** Choose the model and vision files of another model (Settings → Model). */
  async chooseModelFile(which: "model" | "mmproj") {
    const file = await this.shell.chooseFile(
      msg(which === "model" ? "chooseModelFile" : "chooseMmprojFile"),
      ["gguf"],
    );
    if (file) await this.setSettings(which === "model" ? { modelFile: file } : { mmprojFile: file });
  }

  wake() {
    this.#wake?.();
  }

  async #read(id: string, trial = false) {
    const page = this.lib.get(id)!;
    if (trial) Object.assign(page, { trial: "working", trialErr: "", started: Date.now() / 1000 });
    else Object.assign(page, { status: "working", started: Date.now() / 1000, err: "" });
    this.lib.changed();
    const abort = new AbortController();
    this.#reading = abort;
    try {
      const jpeg = await readFile(this.lib.scanPath(id));
      const t0 = Date.now();
      const format = this.lib.settings.format;
      // always LaTeX: the model reads it far better than Typst, which is converted from it (src/convert.ts)
      const prompt = this.readingPrompt();
      const { text, finish } = await this.model.read(jpeg, prompt, abort.signal);
      const p = this.lib.get(id);
      if (!p) return; // removed while it was read
      const body = cleanLatex(text);
      // every reading is a version (versions/<id>/vN.tex); the text it replaces stays in its own
      await this.lib.ensureVersions(p);
      const vid = this.lib.nextVersion(p);
      const secs = (Date.now() - t0) / 1000;
      const truncated = finish === "length";
      await mkdir(join(this.lib.dir, "versions", id), { recursive: true });
      await writeFile(this.lib.versionPath(id, vid), body);
      (p.versions ??= []).push({
        id: vid,
        at: Date.now() / 1000,
        prompt: this.lib.promptKey(prompt),
        model: this.model.label(),
        secs,
        truncated,
      });
      if (trial) {
        Object.assign(p, { trial: undefined, fresh: vid });
        this.lib.changed();
        return;
      }
      await this.lib.saveCurrent(p);
      await writeFile(this.lib.texPath(id), body);
      await writeFile(join(this.lib.dir, "raw", `${id}.tex`), body); // untouched, to diff against corrections
      await rm(this.lib.typPath(id), { force: true });
      if (format === "typst") await writeFile(this.lib.typPath(id), latexToTypst(body));
      Object.assign(p, { status: "done", format, secs, truncated, current: vid });
      this.lib.changed();
      await this.compile(id);
    } catch (e) {
      const p = this.lib.get(id);
      if (p && trial) Object.assign(p, { trial: "failed", trialErr: (e as Error).message });
      else if (p) Object.assign(p, { status: "failed", err: (e as Error).message });
      if (p) this.lib.changed();
    } finally {
      this.#reading = null;
    }
  }

  /** A page removed while it's being read: stop reading it. */
  cancelReading(id: string) {
    const p = this.lib.get(id);
    if (p?.status === "working" || p?.trial === "working") this.#reading?.abort();
  }

  // ------------------------------------------------------------------ previews

  #compiling: Promise<void> = Promise.resolve();

  /** Build a page's preview (one at a time: TeX and the renderer are shared). */
  compile(id: string): Promise<void> {
    this.#compiling = this.#compiling.then(() => this.#compile(id)).catch(() => {});
    return this.#compiling;
  }

  async #compile(id: string) {
    const page = this.lib.get(id);
    if (!page || page.status !== "done") return;
    const body = await this.lib.body(id);
    const dir = this.lib.buildDir(id);
    let ok = false,
      err = "",
      pngs: string[] = [];
    try {
      const lang = this.lib.settings.language;
      const r =
        (page.format ?? "latex") === "typst"
          ? await this.typst.compile(dir, body, lang)
          : await this.tex.compile(dir, body, lang);
      ok = r.ok;
      err = r.err;
      if (r.pdf) {
        const images = await this.renderer.preview(this.rel(r.pdf), 150);
        pngs = await Promise.all(
          images.map(async (png, i) => {
            const f = join(dir, `render-${i + 1}.png`);
            await writeFile(f, png);
            return this.rel(f);
          }),
        );
      }
    } catch (e) {
      err = (e as Error).message;
    }
    const p = this.lib.get(id);
    if (!p) return;
    Object.assign(p, { ok, err, pngs, unk: body.split("[??]").length - 1, rev: p.rev + 1 });
    this.lib.changed();
  }

  async recompileAll() {
    for (const p of this.lib.pages.filter((x) => x.status === "done")) await this.compile(p.id);
  }

  stop() {
    this.#reading?.abort();
    this.model.stop();
    void this.phone.stop();
  }
}
