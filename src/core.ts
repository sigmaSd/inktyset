// Inktyset itself, without its window: the pages, the queue that reads them one at a time, previews, the
// downloads a first start needs, the settings, the phone and the scanner. The Electron shell gives it a
// Renderer (Chromium's image and PDF decoding, in a hidden window) and its dialogs; the window talks to it
// through server.ts.

import { existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { type ComponentId, install, type Progress, sizeOf, supported, verifyModelDir } from "./components.ts";
import { checkHardware, type Hardware } from "./hardware.ts";
import { Library } from "./library.ts";
import { Model, type ModelKind } from "./model.ts";
import { Phone } from "./phone.ts";
import { pagesFolderIn } from "./folders.ts";
import {
  applyEdits,
  type Chat,
  chatInstructions,
  editsIn,
  fitHistory,
  isWholePage,
  imageTokens,
  proposalIn,
  textTokens,
} from "./chat.ts";
import { isNoEdit, type PictureEdit, sanitizeEdit } from "./picture.ts";
import { cleanLatex, type Format, langInfo, langPrompt, PROMPT } from "./pipeline.ts";
import { Scanner } from "./scanner.ts";
import { Showdown } from "./showdown.ts";
import { isArabicLang } from "./scripts.ts";
import {
  type Anchor,
  bodyStart,
  Flow,
  fromSheet,
  type Sheet,
  type Spot,
  synctexAnchors,
  toSpots,
} from "./sync.ts";
import { Tex, type TexMode } from "./tex.ts";
import { latexToTypst } from "./convert.ts";
import { Typst } from "./typst.ts";
import { msg, resolveLang, setCoreLanguage } from "./i18n.ts";
import { loadLocales } from "./locales.ts";
import type { Translations } from "./po.ts";

const MAX_SIDE = 1600; // the long side of what the model sees
const BASE_SIDE = 3200; // the picture edits start from: sharper than what the model sees, for crops
const CHAT_SIDE = 1024; // the scan and the preview in the page chat: enough to see, cheaper than reading size
const CHAT_CONTEXT = 12288; // the engine's context (src/model.ts -c)
const CHAT_ANSWER = 4096; // room for the answer (a whole page rewritten, and a few sentences)

/** Image and PDF work, done by Chromium (shell/electron/render.ts). Paths are relative to the data folder. */
export interface Renderer {
  /** A photo or scan → JPEG, upright (EXIF), long side at most `maxSide`. */
  image(rel: string, maxSide: number): Promise<Buffer>;
  /** Each page of a PDF → JPEG, long side `maxSide`. */
  pdfPages(rel: string, maxSide: number): Promise<Buffer[]>;
  /** One sheet of a PDF (from 0) → JPEG, long side `maxSide`. */
  pdfPage(rel: string, index: number, maxSide: number): Promise<Buffer>;
  /** A picture as the user edited it (src/picture.ts) → JPEG, long side at most `maxSide`. */
  edited(rel: string, edit: PictureEdit, maxSide: number): Promise<Buffer>;
  /** A compiled page → PNG per page at `dpi`, empty margins cut off, and where each sits on its page. */
  preview(rel: string, dpi: number): Promise<{ png: Buffer; sheet: Sheet }[]>;
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
  /** Move a folder to the system's trash. */
  trash(path: string): Promise<void>;
}

/** Settings of this computer (userData/settings.json); the language belongs to the pages (state.json). */
export interface Settings {
  phone: boolean;
  tex: TexMode;
  /** Ctrl+click between the preview and the text (src/sync.ts); off until turned on in Settings. */
  goToSource?: boolean;
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
  /** The session open when Inktyset last closed ("" or none: the first one). */
  session?: string;
}

/** Where the sessions other than the first are, in the pages folder: one folder each. */
const SESSIONS = "sessions";

/** A session's name: one line, not too long. */
export function sessionName(raw: string): string {
  return String(raw).replace(/\s+/g, " ").trim().slice(0, 80);
}

/** A folder name made from a session's name, safe on every system. */
export function sessionFolder(name: string): string {
  const f = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 60);
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(f) || !f ? "session" : f;
}

/** A session in the sidebar. */
export interface SessionInfo {
  id: string;
  name: string;
  created: number;
  pages: number;
  checked: number;
  waiting: number;
  reading: boolean;
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
  /** The session open: its pages are the ones shown, read and changed. */
  lib: Library;
  /** Its id: "" for the first session (the pages folder's own pages), else its folder in sessions/. */
  session = "";
  /** The pages folder. */
  readonly folder: string;
  /** Every session opened or listed, kept: work started in one (a page being read, a preview, an answer) ends
   * in it, whichever is open by then. */
  readonly #libs = new Map<string, Library>();
  /** Counts every change of any session, and every switch: the windows ask again when it moves. */
  version = 0;
  readonly #listeners = new Set<() => void>();
  readonly model: Model;
  readonly tex: Tex;
  readonly typst: Typst;
  readonly phone: Phone;
  readonly scanner: Scanner;
  /** Compare models on the session's pages (src/showdown.ts). */
  readonly showdown: Showdown;
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
  /** A .deb or .rpm copy: a newer version released, and its package of the same kind to download; or null. */
  release: { version: string; url: string } | null = null;
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
    this.folder = dataDir;
    this.lib = this.#library("");
    const first = this.lib;
    const changed = () => this.changed();
    this.model = new Model(userData, changed);
    this.tex = new Tex(userData, (p) => this.#track("tectonic", p));
    this.typst = new Typst(userData, (p) => this.#track("typst", p));
    this.scanner = new Scanner(changed);
    this.showdown = new Showdown(this, userData);
    this.phone = new Phone({
      stateDir: join(userData, "phone"),
      photos: join(dataDir, "phone"),
      changed,
      // the phone's photos arrive in the first session's phone/ folder, and go to the session open
      seen: (rel) => first.seenPhone.has(rel),
      arrived: (path, rel) => {
        first.seenPhone.add(rel);
        void first.save();
        void this.#fromPhone(path, msg("phoneLabel", { name: rel.split(/[\\/]/).at(-1) }));
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
    await this.showdown.load();
    // the session open last time, if it's still there
    const last = this.settings.session;
    if (last && this.#isSession(last)) {
      this.lib = this.#library(last);
      this.session = last;
      await this.lib.init();
    }
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
    return langPrompt(this.lib.settings.language) + this.#notes();
  }

  #notes() {
    const notes = this.settings.instructions?.trim();
    return notes ? `\n\nNotes from the person who wrote these pages (follow them):\n${notes}` : "";
  }

  /**
   * The instructions as the user sets them, all in one text: Inktyset's (or their own), then their notes; not the
   * writing language's rule, which every reading adds. What a showdown column with its own instructions starts from.
   */
  instructionsText(): string {
    return (this.settings.prompt?.trim() || PROMPT) + this.#notes();
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
    const lib = this.lib;
    lib.settings.format = format;
    for (const p of lib.pages) {
      if (p.status !== "done" || (p.format ?? "latex") === format) continue;
      if (format === "typst") await this.#ensureTypst(p.id, lib);
      p.format = format;
      p.ok = null;
    }
    lib.changed();
    void this.recompileAll();
  }

  /** pages/<id>.typ from pages/<id>.tex, unless it's already newer. */
  async #ensureTypst(id: string, lib = this.lib) {
    const tex = await stat(lib.texPath(id)).catch(() => null);
    const typ = await stat(lib.typPath(id)).catch(() => null);
    if (typ && tex && typ.mtimeMs >= tex.mtimeMs) return;
    const latex = await readFile(lib.texPath(id), "utf8").catch(() => "");
    await writeFile(lib.typPath(id), latexToTypst(latex));
  }

  async setLanguage(language: string) {
    const lib = this.lib;
    const changed = language.toLowerCase() !== lib.settings.language.toLowerCase();
    lib.settings.language = language;
    lib.changed();
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

  /** Tell the windows: something changed in a session, or another one is open. */
  onChange(f: () => void) {
    this.#listeners.add(f);
    return () => this.#listeners.delete(f);
  }

  #emit() {
    this.version++;
    for (const f of this.#listeners) f();
  }

  /** Pages waiting or being read: in the session open, or the one a page is still being read in. */
  busy() {
    return this.lib.busy() || !!this.#readingLib?.busy();
  }

  // ------------------------------------------------------------------ sessions

  #library(id: string) {
    let lib = this.#libs.get(id);
    if (!lib) {
      lib = new Library(id ? join(this.folder, SESSIONS, id) : this.folder);
      lib.onChange(() => this.#emit());
      this.#libs.set(id, lib);
    }
    return lib;
  }

  #isSession(id: string) {
    return (
      id === "" || (sessionFolder(id) === id && existsSync(join(this.folder, SESSIONS, id, "state.json")))
    );
  }

  /** The sessions, newest first (the first session, made before any other, is last). */
  async sessions(): Promise<SessionInfo[]> {
    const dir = join(this.folder, SESSIONS);
    const ids = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory() && this.#isSession(d.name))
      .map((d) => d.name);
    return ["", ...ids]
      .map((id) => {
        const l = this.#library(id);
        return {
          id,
          name: l.name,
          created: l.created,
          pages: l.pages.length,
          checked: l.pages.filter((p) => p.checked).length,
          waiting: l.pages.filter((p) => p.status === "queued" || p.status === "working").length,
          reading: l.pages.some((p) => p.status === "working" || p.trial === "working"),
        };
      })
      .sort((a, b) => b.created - a.created);
  }

  /** A new session, opened. Its folder is named after it (another one by that name: a number is added). */
  async newSession(raw: string) {
    const name = sessionName(raw);
    const base = sessionFolder(name);
    let id = base;
    for (let n = 2; existsSync(join(this.folder, SESSIONS, id)); n++) id = `${base} ${n}`;
    await mkdir(join(this.folder, SESSIONS, id), { recursive: true });
    const lib = this.#library(id);
    lib.name = name;
    lib.created = Date.now() / 1000;
    await lib.init();
    await this.openSession(id);
    return id;
  }

  /** Show another session. Its waiting pages are read now; a page still being read in the one left finishes. */
  async openSession(id: string) {
    if (!this.#isSession(id)) throw Object.assign(new Error("no such session"), { code: 404 });
    if (id === this.session) return;
    const lib = this.#library(id);
    await lib.init();
    this.lib = lib;
    this.session = id;
    this.settings.session = id || undefined;
    await writeFile(this.#settingsFile(), JSON.stringify(this.settings, null, 2));
    this.#emit();
    this.wake();
  }

  /**
   * A session's name. Its folder is renamed too while the session has no pages (named just after it was made);
   * after that it keeps its name: work on its pages may be going on in it. Returns the session's id.
   */
  async renameSession(id: string, raw: string) {
    if (!this.#isSession(id)) throw Object.assign(new Error("no such session"), { code: 404 });
    let lib = this.#library(id);
    lib.name = sessionName(raw);
    const folder = sessionFolder(lib.name);
    if (id && folder !== id && !lib.pages.length && !lib.intake) {
      let to = folder;
      for (let n = 2; existsSync(join(this.folder, SESSIONS, to)); n++) to = `${folder} ${n}`;
      await lib.save();
      await rename(lib.dir, join(this.folder, SESSIONS, to));
      lib.closed = true;
      this.#libs.delete(id);
      const moved = this.#library(to);
      if (this.lib === lib) {
        this.lib = moved;
        this.session = to;
        this.settings.session = to;
        await writeFile(this.#settingsFile(), JSON.stringify(this.settings, null, 2));
      }
      lib = moved;
      id = to;
    }
    lib.changed();
    return id;
  }

  /**
   * A session goes to the system's trash, with its folder. The first one can't (it is the pages folder itself).
   * Open, the first one is shown instead; anything being done in it is stopped first.
   */
  async deleteSession(id: string) {
    if (!id || !this.#isSession(id)) throw Object.assign(new Error("no such session"), { code: 404 });
    if (id === this.session) await this.openSession("");
    const lib = this.#library(id);
    this.#asked = this.#asked.filter((a) => a.lib !== lib);
    if (this.#chatLib === lib) this.#chatAbort?.abort();
    if (this.#readingLib === lib) this.#reading?.abort();
    await this.#job;
    await this.#compiling;
    await lib.save();
    lib.closed = true;
    this.#libs.delete(id);
    await this.shell.trash(lib.dir);
    this.#emit();
  }

  /** A photo from the phone: into the session open (copied there, when it isn't the first one). */
  async #fromPhone(path: string, label: string) {
    const lib = this.lib;
    if (lib.dir === this.folder) return await this.addFile(path, label, "phone");
    const dest = join(lib.dir, "originals", `phone-${Date.now().toString(36)}-${basename(path)}`);
    await copyFile(path, dest);
    await this.addFile(dest, label, "phone");
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

  /** A file of a session as the renderer asks for it: from the pages folder (server.ts /data/). */
  #at(path: string) {
    return relative(this.folder, path).split("\\").join("/");
  }

  /** A file (under the data folder) becomes pages: an image one, a PDF one per sheet. */
  async addFile(path: string, label: string, origin: "file" | "scan" | "phone", lib = this.lib) {
    lib.intake++;
    this.changed();
    try {
      if (/\.pdf$/i.test(path)) {
        const sheets = await this.renderer.pdfPages(this.#at(path), MAX_SIDE);
        for (const [i, jpeg] of sheets.entries()) {
          const id = lib.nextId();
          await writeFile(lib.scanPath(id), jpeg);
          const p = lib.add(
            id,
            sheets.length > 1 ? `${label} · sheet ${i + 1}/${sheets.length}` : label,
            origin,
          );
          Object.assign(p, { source: lib.rel(path), sheet: i }); // for Edit picture: the sheet, sharper
        }
      } else {
        const jpeg = await this.renderer.image(this.#at(path), MAX_SIDE);
        const id = lib.nextId();
        await writeFile(lib.scanPath(id), jpeg);
        lib.add(id, label, origin).source = lib.rel(path);
      }
    } catch (e) {
      lib.addFailed(label, origin, msg("notPicture", { error: (e as Error).message }));
    } finally {
      lib.intake--;
      this.changed();
      this.#wake?.();
    }
  }

  // ------------------------------------------------------------------ the queue

  #stopped = false;
  /** What the queue is doing: a page being read, or a question answered. */
  #job: Promise<void> = Promise.resolve();
  /** The session of the page being read. */
  #readingLib: Library | null = null;

  async #loop() {
    while (!this.#stopped) {
      // a question in the page chat first (someone is waiting for it), then pages, then trial readings, then
      // the showdown's (src/showdown.ts)
      if (this.#asked.length && !this.missing.engine && !this.missing.model) {
        const q = this.#asked.shift()!;
        await (this.#job = this.#answer(q.key, q.lib));
        continue;
      }
      const page = this.lib.pages.find((p) => p.status === "queued");
      const trial = page
        ? undefined
        : this.lib.pages.find((p) => p.trial === "queued" && p.status === "done");
      const compare = page || trial ? null : this.showdown.next(this.lib);
      // nothing to read, or not set up yet (the engine or the model still to download)
      if ((!page && !trial && !compare) || this.missing.engine || this.missing.model) {
        // (the model stays loaded while Inktyset is open, idle or not: the owner's choice, 2026-11-13)
        await new Promise<void>((r) => (this.#wake = r));
        this.#wake = null;
        continue;
      }
      if (compare) await (this.#job = this.showdown.run(compare));
      else await (this.#job = this.#read(page ? page.id : trial!.id, !page));
    }
  }

  /** Read these finished pages again with the current instructions and model, as new versions to compare. */
  tryOn(ids: string[]) {
    const lib = this.lib;
    for (const id of ids) {
      const p = lib.get(id);
      if (p?.status === "done" && p.trial !== "working") Object.assign(p, { trial: "queued", trialErr: "" });
    }
    lib.changed();
    this.wake();
  }

  /** Stop the trial readings not started yet (the one being read finishes). */
  cancelTrials() {
    const lib = this.lib;
    for (const p of lib.pages) if (p.trial === "queued" || p.trial === "failed") p.trial = undefined;
    lib.changed();
  }

  async useVersion(id: string, vid: string) {
    const lib = this.lib;
    const p = lib.get(id);
    if (!p || p.status !== "done") throw new Error("page is not ready");
    await lib.useVersion(p, vid);
    if ((p.format ?? "latex") === "typst") await this.#ensureTypst(id, lib);
    lib.changed();
    await this.compile(id, lib);
  }

  async deleteVersion(id: string, vid: string) {
    const lib = this.lib;
    const p = lib.get(id);
    if (!p) throw new Error("no such page");
    await lib.deleteVersion(p, vid);
    lib.changed();
  }

  /** A version's own preview, to compare it with the one shown (built once; again after an edit). */
  versionPreview(id: string, vid: string): Promise<void> {
    this.#compiling = this.#compiling.then(() => this.#versionPreview(id, vid)).catch(() => {});
    return this.#compiling;
  }

  async #versionPreview(id: string, vid: string) {
    const lib = this.lib;
    const p = lib.get(id);
    const v = p?.versions?.find((x) => x.id === vid);
    if (!p || !v || p.current === vid) return;
    const typst = (p.format ?? "latex") === "typst";
    let body = await lib.versionText(p, vid, typst ? "typ" : "tex");
    if (typst && !body) body = latexToTypst(await lib.versionText(p, vid));
    const { ok, err, pngs } = await this.previewOf(lib, join(lib.buildDir(id), vid), body, typst);
    Object.assign(v, { ok, err, pngs, rev: (v.rev ?? 0) + 1 });
    lib.changed();
  }

  /** A text compiled in `dir` and its preview drawn there: what a version or a showdown reading shows. */
  async previewOf(lib: Library, dir: string, body: string, typst: boolean) {
    const lang = lib.settings.language;
    let pngs: string[] = [],
      ok = false,
      err = "";
    try {
      const r = typst ? await this.typst.compile(dir, body, lang) : await this.tex.compile(dir, body, lang);
      ok = r.ok;
      err = r.err;
      if (r.pdf) {
        const images = await this.renderer.preview(this.#at(r.pdf), 150);
        pngs = await Promise.all(
          images.map(async ({ png }, i) => {
            const f = join(dir, `render-${i + 1}.png`);
            await writeFile(f, png);
            return lib.rel(f);
          }),
        );
      }
    } catch (e) {
      err = (e as Error).message;
    }
    return { ok, err, pngs };
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
    this.showdown.release(); // the graphics chip for the app's model
    const lib = this.lib;
    const page = lib.get(id)!;
    if (trial) Object.assign(page, { trial: "working", trialErr: "", started: Date.now() / 1000 });
    else Object.assign(page, { status: "working", started: Date.now() / 1000, err: "" });
    lib.changed();
    const abort = new AbortController();
    this.#reading = abort;
    this.#readingLib = lib;
    try {
      const jpeg = await readFile(lib.scanPath(id));
      const t0 = Date.now();
      const format = lib.settings.format;
      // always LaTeX: the model reads it far better than Typst, which is converted from it (src/convert.ts)
      const prompt = this.readingPrompt();
      const { text, finish } = await this.model.read(jpeg, prompt, abort.signal);
      const p = lib.get(id);
      if (!p || (!trial && p.status !== "working")) return; // removed or stopped while it was read
      const body = cleanLatex(text);
      // every reading is a version (versions/<id>/vN.tex); the text it replaces stays in its own
      await lib.ensureVersions(p);
      const vid = lib.nextVersion(p);
      const secs = (Date.now() - t0) / 1000;
      const truncated = finish === "length";
      await mkdir(join(lib.dir, "versions", id), { recursive: true });
      await writeFile(lib.versionPath(id, vid), body);
      (p.versions ??= []).push({
        id: vid,
        at: Date.now() / 1000,
        prompt: lib.promptKey(prompt),
        model: this.model.label(),
        secs,
        truncated,
      });
      if (trial) {
        Object.assign(p, { trial: undefined, fresh: vid });
        lib.changed();
        return;
      }
      await lib.saveCurrent(p);
      await writeFile(lib.texPath(id), body);
      await writeFile(join(lib.dir, "raw", `${id}.tex`), body); // untouched, to diff against corrections
      await rm(lib.typPath(id), { force: true });
      if (format === "typst") await writeFile(lib.typPath(id), latexToTypst(body));
      Object.assign(p, { status: "done", format, secs, truncated, current: vid });
      lib.changed();
      await this.compile(id, lib);
    } catch (e) {
      const p = lib.get(id);
      if (p && trial) {
        if (p.trial === "working") Object.assign(p, { trial: "failed", trialErr: (e as Error).message });
      } else if (p && p.status === "working")
        Object.assign(p, { status: "failed", err: (e as Error).message });
      // (otherwise stopped by the user while it was read: it stays as Stop left it)
      if (p) lib.changed();
    } finally {
      this.#reading = null;
      this.#readingLib = null;
    }
  }

  /**
   * Don't read these pages until the user asks: the one being read stops, the waiting ones wait no more. A page
   * read before (being read again) keeps its text and is back as it was; the others show Stopped, with Read.
   */
  async stopPages(ids: string[]) {
    const lib = this.lib;
    for (const id of ids) {
      const p = lib.get(id);
      if (!p || (p.status !== "queued" && p.status !== "working")) continue;
      const had = !!p.current && existsSync(lib.texPath(id));
      const reading = p.status === "working";
      Object.assign(p, { status: had ? "done" : "stopped", err: "" });
      if (reading) this.#reading?.abort();
      if (had) void this.compile(id, lib);
    }
    lib.changed();
  }

  /**
   * The picture Edit picture starts from (scans/<id>.base.jpg): made once, from the file the page came from
   * (sharper than what the model sees), or from the page's picture when that file is gone or unknown.
   */
  async picture(id: string): Promise<{ base: string; edit: PictureEdit }> {
    const lib = this.lib;
    const p = lib.get(id);
    if (!p || !existsSync(lib.scanPath(id))) throw Object.assign(new Error("no picture"), { code: 404 });
    const base = lib.basePath(id);
    if (!existsSync(base)) {
      let jpeg: Buffer | null = null;
      const src = p.source && join(lib.dir, p.source);
      if (src && existsSync(src) && !p.edit) {
        try {
          jpeg =
            p.sheet !== undefined
              ? await this.renderer.pdfPage(this.#at(src), p.sheet, BASE_SIDE)
              : await this.renderer.image(this.#at(src), BASE_SIDE);
        } catch {
          /* not worth failing for: the page's own picture will do */
        }
      }
      await writeFile(base, jpeg ?? (await readFile(lib.scanPath(id))));
    }
    return { base: lib.rel(base), edit: p.edit ?? { rotate: 0, angle: 0, crop: null } };
  }

  /**
   * The page's picture as the user edited it: the model's picture is made again from the base one. A page
   * waiting or being read is read with it; one already read is read again only when asked (a new version).
   */
  async editPicture(id: string, raw: unknown, readAgain: boolean) {
    const lib = this.lib;
    const p = lib.get(id);
    if (!p) throw Object.assign(new Error("no such page"), { code: 404 });
    const edit = sanitizeEdit(raw);
    const { base } = await this.picture(id);
    await writeFile(
      lib.scanPath(id),
      await this.renderer.edited(this.#at(join(lib.dir, base)), edit, MAX_SIDE),
    );
    p.edit = isNoEdit(edit) ? undefined : edit;
    p.pic = (p.pic ?? 0) + 1;
    if (p.status === "working") {
      p.status = "queued"; // read again, from the start, with the new picture
      this.#reading?.abort();
    } else if (p.status === "failed" || (p.status === "done" && readAgain)) {
      Object.assign(p, { status: "queued", err: "", ok: null, pngs: [], rev: p.rev + 1, checked: false });
    }
    lib.changed();
    this.wake();
  }

  // ------------------------------------------------------------------ the page chat (src/chat.ts)
  // A page has any number of chats: chats/<page>/<chat>.json (c1, c2…), their pictures beside them. A question
  // is known by `<page>/<chat>`; the engine answers one at a time, before the next page is read.

  /** Questions waiting for their answer (`<page>/<chat>`), in the order asked. */
  #asked: { key: string; lib: Library }[] = [];
  /** The session of the answer being written. */
  #chatLib: Library | null = null;
  #chatAbort: AbortController | null = null;
  /** The answer being written: its page and chat, and the thinking and text so far (shown as they come). */
  chatLive: { page: string; chat: string; thinking: string; text: string; started: number } | null = null;

  /** A page's chats, newest first: their name (the first question), when they began, how long they are. */
  async chats(page: string) {
    const lib = this.lib;
    // 0.9.0–0.9.5 kept one chat per page, chats/<page>.json: it becomes the page's first
    const old = join(lib.dir, "chats", `${page}.json`);
    if (existsSync(old)) {
      await mkdir(lib.chatDir(page), { recursive: true });
      const c = JSON.parse(await readFile(old, "utf8")) as Chat;
      await writeFile(lib.chatPath(page, "c1"), JSON.stringify({ ...c, id: "c1" }, null, 1));
      await rm(old, { force: true });
    }
    const files = (await readdir(lib.chatDir(page)).catch(() => [] as string[])).filter((f) =>
      /^c\d+\.json$/.test(f),
    );
    const list = await Promise.all(
      files.map(async (f) => {
        const c = await this.chat(page, f.slice(0, -5));
        const first = c.messages.find((m) => m.role === "user");
        return {
          id: c.id,
          title: (first?.text ?? "").split("\n")[0].slice(0, 60),
          pictures: !!first?.attach?.length,
          at: c.messages[0]?.at ?? 0,
          n: c.messages.length,
        };
      }),
    );
    return list.filter((c) => c.n).sort((x, y) => y.at - x.at);
  }

  /** A new chat's name: the next free one (it is saved with its first question). */
  async newChat(page: string) {
    const files = await readdir(this.lib.chatDir(page)).catch(() => [] as string[]);
    const n = Math.max(0, ...files.map((f) => Number(/^c(\d+)\.json$/.exec(f)?.[1] ?? 0)));
    return `c${n + 1}`;
  }

  async chat(page: string, chat: string, lib = this.lib): Promise<Chat> {
    try {
      return { ...(JSON.parse(await readFile(lib.chatPath(page, chat), "utf8")) as Chat), page, id: chat };
    } catch {
      return { page, id: chat, messages: [] };
    }
  }

  async #saveChat(c: Chat, lib: Library) {
    await mkdir(lib.chatDir(c.page), { recursive: true });
    await writeFile(lib.chatPath(c.page, c.id), JSON.stringify(c, null, 1));
  }

  /** Where a chat stands: its question waiting its turn, being answered, or neither. */
  chatState(page: string, chat: string) {
    const lib = this.lib;
    const key = `${page}/${chat}`;
    return {
      waiting: this.#asked.some((a) => a.lib === lib && a.key === key),
      live:
        this.#chatLib === lib && this.chatLive?.page === page && this.chatLive.chat === chat
          ? this.chatLive
          : null,
      reading: lib.pages.find((p) => p.status === "working" || p.trial === "working")?.id ?? null,
    };
  }

  /**
   * A question in one of a page's chats: its text, parts of the scan or preview the user picked (JPEG, base64),
   * and the whole preview if asked. Answered before the next page is read.
   */
  async ask(
    page: string,
    chat: string,
    text: string,
    regions: { data: string; w: number; h: number; from: string }[],
    preview: boolean,
  ) {
    const lib = this.lib;
    const p = lib.get(page);
    if (!p || p.status !== "done") throw Object.assign(new Error("page is not ready"), { code: 409 });
    if (this.missing.engine || this.missing.model) throw new Error(msg("notDownloaded"));
    const key = `${page}/${chat}`;
    if (
      this.#asked.some((a) => a.lib === lib && a.key === key) ||
      (this.#chatLib === lib && this.chatLive?.page === page && this.chatLive.chat === chat)
    )
      throw Object.assign(new Error("already asked"), { code: 409 });
    const c = await this.chat(page, chat, lib);
    const dir = lib.chatDir(page);
    await mkdir(dir, { recursive: true });
    // pictures are numbered across the page's chats (they share the folder)
    let n = Math.max(0, ...(await readdir(dir)).map((f) => Number(/^a(\d+)\.jpg$/.exec(f)?.[1] ?? 0)));
    const attach: Chat["messages"][number]["attach"] = [];
    const keep = async (jpeg: Buffer, from: "scan" | "preview", w: number, h: number) => {
      const file = join(dir, `a${++n}.jpg`);
      await writeFile(file, jpeg);
      attach.push({ file: lib.rel(file), from, w, h });
    };
    for (const r of regions.slice(0, 4))
      await keep(Buffer.from(r.data, "base64"), r.from === "preview" ? "preview" : "scan", r.w, r.h);
    if (preview)
      for (const png of p.pngs.slice(0, 2)) {
        const jpeg = await this.renderer.image(this.#at(join(lib.dir, png)), CHAT_SIDE);
        const { w, h } = jpegSize(jpeg);
        await keep(jpeg, "preview", w, h);
      }
    c.messages.push({
      role: "user",
      text: text.trim(),
      at: Date.now() / 1000,
      ...(attach.length ? { attach } : {}),
    });
    await this.#saveChat(c, lib);
    this.#asked.push({ key, lib });
    lib.changed();
    this.wake();
  }

  /** Don't wait for the page being read: it goes back in the queue (read again after), the question goes now. */
  answerNow(page: string, chat: string) {
    const lib = this.lib;
    const key = `${page}/${chat}`;
    const q = this.#asked.find((a) => a.lib === lib && a.key === key);
    if (!q) return;
    this.#asked = [q, ...this.#asked.filter((x) => x !== q)];
    const p = lib.pages.find((x) => x.status === "working" || x.trial === "working");
    if (!p) return;
    if (p.status === "working") p.status = "queued";
    else p.trial = "queued";
    this.#reading?.abort();
    lib.changed();
  }

  /** Stop a question: not asked any more if it waits, cut short if it's being answered. */
  stopChat(page: string, chat: string) {
    const lib = this.lib;
    this.#asked = this.#asked.filter((x) => x.lib !== lib || x.key !== `${page}/${chat}`);
    if (this.#chatLib === lib && this.chatLive?.page === page && this.chatLive.chat === chat)
      this.#chatAbort?.abort();
    lib.changed();
  }

  /** Forget a chat, and the pictures attached to it. */
  async deleteChat(page: string, chat: string) {
    const lib = this.lib;
    this.stopChat(page, chat);
    const c = await this.chat(page, chat, lib);
    for (const m of c.messages)
      for (const a of m.attach ?? []) await rm(join(lib.dir, a.file), { force: true });
    await rm(lib.chatPath(page, chat), { force: true });
    lib.changed();
  }

  /** An answer's rewrite becomes the page's text: a new version (the text it replaces stays in its own). */
  async applyProposal(page: string, chat: string, n: number) {
    const lib = this.lib;
    const p = lib.get(page);
    const c = await this.chat(page, chat, lib);
    const m = c.messages[n];
    if (!p || p.status !== "done" || !m?.proposal || m.applied) throw new Error("nothing to apply");
    m.applied = await lib.addVersion(p, m.proposal, {
      prompt: lib.promptKey(this.#chatInstructions(p.format ?? "latex", lib)),
      model: this.model.label(),
      secs: m.secs ?? null,
      truncated: false,
      from: "chat",
    });
    await this.#saveChat(c, lib);
    lib.changed();
    await this.compile(page, lib);
  }

  async dismissProposal(page: string, chat: string, n: number) {
    const lib = this.lib;
    const c = await this.chat(page, chat, lib);
    if (c.messages[n]) c.messages[n].dismissed = true;
    await this.#saveChat(c, lib);
    lib.changed();
  }

  /** The chat's instructions, with the pages' writing language and the user's notes on their writing. */
  #chatInstructions(format: "latex" | "typst", lib = this.lib) {
    return chatInstructions(format, langInfo(lib.settings.language).name, this.settings.instructions ?? "");
  }

  async #answer(key: string, lib: Library) {
    this.showdown.release();
    const [id, chat] = key.split("/");
    const p = lib.get(id);
    const c = await this.chat(id, chat, lib);
    if (!p || c.messages.at(-1)?.role !== "user") return;
    const format = p.format ?? "latex";
    const name = format === "typst" ? "Typst" : "LaTeX";
    const abort = new AbortController();
    this.#chatAbort = abort;
    this.chatLive = { page: id, chat, thinking: "", text: "", started: Date.now() / 1000 };
    this.#chatLib = lib;
    lib.changed();
    const t0 = Date.now();
    const answer: Chat["messages"][number] = { role: "assistant", text: "", at: 0 };
    try {
      // what the model always sees: the instructions, the scan, the text as it is now
      const scan = await this.renderer.image(this.#at(lib.scanPath(id)), CHAT_SIDE);
      const size = jpegSize(scan);
      const body = await lib.body(id);
      const intro = `The page's current ${name} text:\n\`\`\`${format === "typst" ? "typst" : "latex"}\n${body}\n\`\`\``;
      const instructions = this.#chatInstructions(format, lib);
      const fixed = textTokens(instructions) + textTokens(intro) + imageTokens(size.w, size.h);
      const history = fitHistory(c.messages, CHAT_CONTEXT - CHAT_ANSWER - fixed - 200);
      const image = (jpeg: Buffer) => ({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` },
      });
      const messages: unknown[] = [
        { role: "system", content: instructions },
        { role: "user", content: [image(scan), { type: "text", text: intro }] },
      ];
      for (const h of history) {
        if (h.message.role === "assistant") {
          messages.push({ role: "assistant", content: h.text });
          continue;
        }
        const pics = h.images
          ? await Promise.all(
              (h.message.attach ?? []).map(async (a) => image(await readFile(join(lib.dir, a.file)))),
            )
          : [];
        const named =
          !h.images && h.message.attach?.length
            ? `[${h.message.attach.length} picture(s) not shown again]\n`
            : "";
        messages.push({
          role: "user",
          content: [...pics, { type: "text", text: named + (h.text || "(see the picture)") }],
        });
      }
      let last = 0;
      const r = await this.model.chat(
        messages,
        {
          // no thinking: on this kind of machine it ran for minutes before answering (the owner's call, 2026-11-13)
          think: false,
          maxTokens: CHAT_ANSWER,
          onDelta: (d) => {
            Object.assign(this.chatLive!, d);
            if (Date.now() - last > 300) {
              last = Date.now();
              lib.changed();
            }
          },
        },
        abort.signal,
      );
      Object.assign(answer, { text: r.text.trim(), thinking: r.thinking.trim(), cut: r.finish === "length" });
      // a fix: its changes made to the page's text here; or the whole new text, for a bigger change
      const edits = editsIn(answer.text);
      let proposal = proposalIn(answer.text);
      if (edits.length) {
        const r = applyEdits(body, edits);
        proposal = r.text;
        if (r.unplaced) answer.unplaced = r.unplaced;
      } else if (proposal !== undefined && !isWholePage(proposal, body)) proposal = undefined; // a piece, not the page
      if (proposal !== undefined && proposal.trim() !== body.trim()) answer.proposal = proposal;
    } catch (e) {
      if (abort.signal.aborted)
        Object.assign(answer, {
          text: this.chatLive?.text ?? "",
          thinking: this.chatLive?.thinking ?? "",
          stopped: true,
        });
      else answer.err = (e as Error).message;
    } finally {
      this.#chatAbort = null;
      this.chatLive = null;
      this.#chatLib = null;
    }
    answer.at = Date.now() / 1000;
    answer.secs = (Date.now() - t0) / 1000;
    const now = await this.chat(id, chat, lib); // (deleted meanwhile: the answer goes nowhere)
    if (now.messages.length) {
      now.messages.push(answer);
      await this.#saveChat(now, lib);
    }
    lib.changed();
  }

  /** Stopped pages go back in the queue. */
  readStopped(ids: string[]) {
    const lib = this.lib;
    for (const id of ids) {
      const p = lib.get(id);
      if (p?.status === "stopped") p.status = "queued";
    }
    lib.changed();
    this.wake();
  }

  /** A page removed while it's being read: stop reading it. */
  cancelReading(id: string) {
    const lib = this.lib;
    const p = lib.get(id);
    if (p?.status === "working" || p?.trial === "working") this.#reading?.abort();
  }

  // ------------------------------------------------------------------ previews

  #compiling: Promise<void> = Promise.resolve();

  /** Build a page's preview (one at a time: TeX and the renderer are shared). */
  compile(id: string, lib = this.lib): Promise<void> {
    this.#compiling = this.#compiling.then(() => this.#compile(id, lib)).catch(() => {});
    return this.#compiling;
  }

  async #compile(id: string, lib: Library) {
    const page = lib.get(id);
    if (!page || page.status !== "done") return;
    const body = await lib.body(id);
    const dir = lib.buildDir(id);
    let ok = false,
      err = "",
      pngs: string[] = [];
    try {
      const lang = lib.settings.language;
      const r =
        (page.format ?? "latex") === "typst"
          ? await this.typst.compile(dir, body, lang)
          : await this.tex.compile(dir, body, lang);
      ok = r.ok;
      err = r.err;
      if (r.pdf) {
        const images = await this.renderer.preview(this.#at(r.pdf), 150);
        pngs = await Promise.all(
          images.map(async ({ png }, i) => {
            const f = join(dir, `render-${i + 1}.png`);
            await writeFile(f, png);
            return lib.rel(f);
          }),
        );
        // where the images sit on the pages, for going to the source and back
        await writeFile(join(dir, "sheets.json"), JSON.stringify(images.map((x) => x.sheet)));
      }
    } catch (e) {
      err = (e as Error).message;
    }
    this.#flows(lib).delete(id);
    const p = lib.get(id);
    if (!p) return;
    Object.assign(p, { ok, err, pngs, unk: body.split("[??]").length - 1, rev: p.rev + 1 });
    lib.changed();
  }

  // ------------------------------------------------------------------ go to the source and back

  /** Per page: what its preview was built from (its rev), and the map between its lines and the preview. */
  readonly #flowMaps = new WeakMap<
    Library,
    Map<string, { rev: number; flow: Flow; sheets: Sheet[] } | null>
  >();
  #flows(lib: Library) {
    let m = this.#flowMaps.get(lib);
    if (!m) this.#flowMaps.set(lib, (m = new Map()));
    return m;
  }

  /** The map between a page's lines and its preview (src/sync.ts), made the first time it's asked for. */
  async #flow(id: string) {
    const lib = this.lib;
    const p = lib.get(id);
    if (!p || p.status !== "done" || !p.pngs.length) return null;
    const known = this.#flows(lib).get(id);
    if (known && known.rev === p.rev) return known;
    // a preview built before Inktyset could go to the source: built again, once
    const dir = lib.buildDir(id);
    const typst = (p.format ?? "latex") === "typst";
    if (!existsSync(join(dir, "sheets.json")) || (!typst && !existsSync(join(dir, "doc.synctex.gz")))) {
      if (known === undefined) {
        this.#flows(lib).set(id, null);
        await this.compile(id, lib);
      }
    }
    // in turn with compiles: one may be about to rebuild the preview, and the Typst copy shares its folder
    let made: { rev: number; flow: Flow; sheets: Sheet[] } | null = null;
    this.#compiling = this.#compiling
      .then(async () => {
        const page = lib.get(id);
        if (!page?.pngs.length) return;
        const rev = page.rev;
        const sheets = JSON.parse(await readFile(join(dir, "sheets.json"), "utf8")) as Sheet[];
        const body = await lib.body(id);
        const lang = lib.settings.language;
        const lines = body.split("\n").length;
        let anchors: Anchor[] | null;
        if (typst) anchors = await this.typst.anchors(join(dir, "sync"), body, lang);
        else {
          const doc = await readFile(join(dir, "doc.tex"), "utf8");
          const sync = gunzipSync(await readFile(join(dir, "doc.synctex.gz"))).toString("utf8");
          anchors = synctexAnchors(sync, bodyStart(doc), lines);
        }
        if (!anchors?.length) return;
        const rows = sheets.map((s) => s.rows);
        const flow = new Flow(anchors, rows, typst ? "start" : "end", isArabicLang(lang));
        made = { rev, flow, sheets };
      })
      .catch(() => {});
    await this.#compiling;
    if (made) this.#flows(lib).set(id, made);
    return made as { rev: number; flow: Flow; sheets: Sheet[] } | null;
  }

  /** The line of a page's text (from 1) at a point of its preview: image `sheet`, `fx` and `fy` fractions of
   * it. Null when it can't be told (no preview; a Typst page whose copy didn't compile). */
  async sourceLine(id: string, sheet: number, fx: number, fy: number): Promise<number | null> {
    const f = await this.#flow(id);
    const s = f?.sheets[sheet];
    if (!f || !s) return null;
    const { x, y } = fromSheet(s, fx, fy);
    return f.flow.line(sheet, x, y);
  }

  /** Where a line of a page's text (from 1) is on its preview. */
  async previewSpots(id: string, line: number): Promise<Spot[]> {
    const f = await this.#flow(id);
    return f ? toSpots(f.flow.where(line), f.sheets) : [];
  }

  async recompileAll() {
    const lib = this.lib;
    for (const p of lib.pages.filter((x) => x.status === "done")) await this.compile(p.id);
  }

  /** Inktyset quits. A page cut off mid-read waits again (not Failed): it's read the next time it opens. */
  stop() {
    this.#stopped = true; // the queue reads nothing more
    const p = (this.#readingLib ?? this.lib).pages.find(
      (x) => x.status === "working" || x.trial === "working",
    );
    if (p?.status === "working") p.status = "queued";
    else if (p) p.trial = "queued";
    this.#reading?.abort();
    this.showdown.quit();
    this.model.stop();
    void this.phone.stop();
  }
}

/** A JPEG's width and height, from its header (the start-of-frame marker). */
export function jpegSize(jpeg: Buffer): { w: number; h: number } {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = jpeg[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { h: jpeg.readUInt16BE(i + 5), w: jpeg.readUInt16BE(i + 7) };
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return { w: CHAT_SIDE, h: CHAT_SIDE };
}
