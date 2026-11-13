// hand2tex itself, without its window: the pages, the queue that reads them one at a time, previews, the
// downloads a first start needs, the settings, the phone and the scanner. The Electron shell gives it a
// Renderer (Chromium's image and PDF decoding, in a hidden window) and its dialogs; the window talks to it
// through server.ts.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type ComponentId, install, type Progress, sizeOf, supported, verifyModelDir } from "./components.ts";
import { checkHardware, type Hardware } from "./hardware.ts";
import { Library } from "./library.ts";
import { Model } from "./model.ts";
import { Phone } from "./phone.ts";
import { cleanLatex, langPrompt, PROMPT } from "./pipeline.ts";
import { Scanner } from "./scanner.ts";
import { Tex, type TexMode } from "./tex.ts";

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
  saveFile(name: string, text: string): Promise<string | null>;
  notify(text: string): void;
  /** Restart into a downloaded update (offered once `Core.update` is set). */
  installUpdate(): void;
}

/** Settings of this computer (userData/settings.json); the language belongs to the pages (state.json). */
export interface Settings {
  phone: boolean;
  tex: TexMode;
  serverPath?: string;
  modelDir?: string;
}

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
  readonly phone: Phone;
  readonly scanner: Scanner;
  settings: Settings = { phone: false, tex: "auto" };
  jobs: Record<ComponentId | "verify", Job> = {
    engine: { status: "idle", progress: null, error: "" },
    model: { status: "idle", progress: null, error: "" },
    tectonic: { status: "idle", progress: null, error: "" },
    verify: { status: "idle", progress: null, error: "" },
  };
  missing = { engine: true, model: true };
  /** This computer's memory and graphics chips, and what to tell the user about them. */
  hardware: Hardware | null = null;
  /** A downloaded, verified update waiting for a restart (its version), or null. */
  update: string | null = null;
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
    this.scanner = new Scanner(changed);
    this.phone = new Phone({
      stateDir: join(userData, "phone"),
      photos: join(dataDir, "phone"),
      changed,
      seen: (rel) => this.lib.seenPhone.has(rel),
      arrived: (path, rel) => {
        this.lib.seenPhone.add(rel);
        void this.addFile(path, `Phone photo ${rel.split(/[\\/]/).at(-1)}`, "phone");
      },
    });
  }

  async init() {
    await mkdir(this.#userData, { recursive: true });
    await this.lib.init();
    try {
      this.settings = { ...this.settings, ...JSON.parse(await readFile(this.#settingsFile(), "utf8")) };
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

  #applySettings() {
    this.tex.mode = this.settings.tex;
    this.model.config = { serverPath: this.settings.serverPath, modelDir: this.settings.modelDir };
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

  /** Use model files the user already has: choose their folder, check them, remember it. */
  async useModelFolder() {
    const dir = await this.shell.chooseFolder("Folder with Qwen3.5-9B-Q4_K_M.gguf and mmproj-F16.gguf");
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
      this.lib.addFailed(
        label,
        origin,
        `This file could not be opened as a picture or PDF (${(e as Error).message}).`,
      );
    } finally {
      this.lib.intake--;
      this.changed();
      this.#wake?.();
    }
  }

  // ------------------------------------------------------------------ the queue

  async #loop() {
    for (;;) {
      const page = this.lib.pages.find((p) => p.status === "queued");
      // nothing to read, or not set up yet (the engine or the model still to download)
      if (!page || this.missing.engine || this.missing.model) {
        await new Promise<void>((r) => (this.#wake = r));
        this.#wake = null;
        continue;
      }
      await this.#read(page.id);
    }
  }

  wake() {
    this.#wake?.();
  }

  async #read(id: string) {
    const page = this.lib.get(id)!;
    Object.assign(page, { status: "working", started: Date.now() / 1000, err: "" });
    this.lib.changed();
    const abort = new AbortController();
    this.#reading = abort;
    try {
      const jpeg = await readFile(this.lib.scanPath(id));
      const t0 = Date.now();
      const prompt = PROMPT + langPrompt(this.lib.settings.language);
      const { text, finish } = await this.model.read(jpeg, prompt, abort.signal);
      const p = this.lib.get(id);
      if (!p) return; // removed while it was read
      const body = cleanLatex(text);
      await writeFile(this.lib.texPath(id), body);
      await writeFile(join(this.lib.dir, "raw", `${id}.tex`), body); // untouched, to diff against corrections
      Object.assign(p, { status: "done", secs: (Date.now() - t0) / 1000, truncated: finish === "length" });
      this.lib.changed();
      await this.compile(id);
    } catch (e) {
      const p = this.lib.get(id);
      if (p) {
        Object.assign(p, { status: "failed", err: (e as Error).message });
        this.lib.changed();
      }
    } finally {
      this.#reading = null;
    }
  }

  /** A page removed while it's being read: stop reading it. */
  cancelReading(id: string) {
    if (this.lib.get(id)?.status === "working") this.#reading?.abort();
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
      const r = await this.tex.compile(dir, body, this.lib.settings.language);
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
