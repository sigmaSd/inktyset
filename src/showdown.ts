// Compare models: the session's pages read by several models (or one model with and without thinking first),
// side by side, each reading scored against the pages the user checked (their corrected text is the answer
// key). Opened from the status line, for everyone (app/ui/main.js).
//
// What is compared, the "contenders", belongs to this computer (userData/showdown.json): models are files and
// servers of this machine. Their readings belong to the session: <session>/showdown/<contender>/<page>.json and
// .tex (and .thinking.txt), the preview in build/<page>/sd-<contender>/. A reading is kept until the user asks
// for it again; one made before the instructions or the picture changed shows as outdated.
//
// One model at a time: the showdown has its own engine (src/model.ts, showdown.log), and the app's model is
// stopped while it reads (a graphics chip rarely holds two), then started again. Its readings come last in the
// queue (core.ts #loop): after pages, chat questions and trial readings.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { MODEL_FILES } from "./components.ts";
import { latexToTypst } from "./convert.ts";
import type { Core } from "./core.ts";
import { distance } from "./diff.ts";
import { msg } from "./i18n.ts";
import { keyOf, type Library } from "./library.ts";
import { Model, type ModelConfig, type ModelKind } from "./model.ts";
import { cleanLatex, langPrompt } from "./pipeline.ts";

export interface Contender {
  id: string;
  kind: ModelKind;
  /** files: the model and its vision part. */
  modelFile?: string;
  mmprojFile?: string;
  /** server: its address, the model there, a key. */
  url?: string;
  name?: string;
  apiKey?: string;
  /** Let the model think before it writes: much slower, sometimes better. */
  think: boolean;
  /**
   * Its own instructions, all of them (Core.instructionsText: Inktyset's or the user's, and their notes); the
   * writing language's rule is added as always. None: the ones in Settings, as the app reads.
   */
  prompt?: string;
}

/** A reading kept (its text is beside it, <page>.tex). */
export interface Reading {
  at: number;
  secs: number;
  /** Tokens written (the thinking too), and how fast it wrote them (tokens a second); null when not known. */
  tokens?: number | null;
  tps?: number | null;
  /** "length": cut at the most it may write. */
  finish: string;
  /** The instructions it was read with (their key, Library keyOf) and the picture's version (Page.pic). */
  prompt: string;
  /** What read it: the model and the thinking (comboKey). Another since (the column was edited): outdated. */
  combo?: string;
  pic: number;
  ok: boolean | null;
  err: string;
  pngs: string[];
  rev: number;
  unk: number;
  empty: boolean;
}

export type CellState = "none" | "queued" | "working" | "failed" | "done";

interface Job {
  lib: Library;
  contender: string;
  page: string;
}

/** What a contender is called: the model's name (and the server's address). */
export function contenderName(c: Omit<Contender, "id">): string {
  if (c.kind === "files") return basename(c.modelFile ?? "").replace(/\.gguf$/i, "");
  if (c.kind === "server") {
    let host = c.url ?? "";
    try {
      host = new URL(host).host;
    } catch {
      /* shown as typed */
    }
    return `${c.name || "model"} · ${host}`;
  }
  return "Qwen3.5 9B";
}

/** The same model (the key and the name don't matter). */
const sameModel = (a: Omit<Contender, "id">, b: Omit<Contender, "id">) =>
  a.kind === b.kind &&
  (a.kind !== "files" || (a.modelFile === b.modelFile && a.mmprojFile === b.mmprojFile)) &&
  (a.kind !== "server" || (a.url === b.url && (a.name ?? "") === (b.name ?? "")));

/** The same model, read the same way, with the same instructions: one column is enough. */
const sameCombo = (a: Omit<Contender, "id">, b: Omit<Contender, "id">) =>
  sameModel(a, b) && a.think === b.think && (a.prompt ?? null) === (b.prompt ?? null);

/** What a reading was made with, besides the instructions (which have their own key): the model and the thinking. */
export const comboKey = (c: Omit<Contender, "id">) =>
  keyOf(JSON.stringify([c.kind, c.modelFile ?? "", c.mmprojFile ?? "", c.url ?? "", c.name ?? "", c.think]));

/** Room for thinking: the instructions, the picture, a long thinking and the page. */
const THINK_CTX = 24576;
const THINK_TOKENS = 16384;

export class Showdown {
  contenders: Contender[] = [];
  readonly engine: Model;
  readonly #core: Core;
  readonly #file: string;
  #loaded = false;
  #jobs: Job[] = [];
  #working: (Job & { started: number }) | null = null;
  #abort: AbortController | null = null;
  /** The contender the engine holds now ("" none). */
  #inEngine = "";
  /** Why a reading failed, by cell (until it's asked again). */
  readonly #failed = new Map<string, string>();
  readonly #readings = new Map<string, Reading | null>();
  readonly #texts = new Map<string, string>();
  /** Scores: by cell, the texts they were made from. */
  readonly #scores = new Map<string, { at: number; answer: string; d: number }>();

  constructor(core: Core, userData: string) {
    this.#core = core;
    this.#file = join(userData, "showdown.json");
    this.engine = new Model(userData, () => core.changed(), "showdown");
  }

  async load() {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const saved = JSON.parse(await readFile(this.#file, "utf8")) as { contenders?: Contender[] };
      this.contenders = saved.contenders ?? [];
    } catch {
      /* never opened */
    }
    // to start with: the app's own model
    if (!this.contenders.length) await this.add({ ...this.appModel(), think: false });
  }

  async #save() {
    await writeFile(this.#file, JSON.stringify({ contenders: this.contenders }, null, 2));
  }

  /** The model the app reads with (Settings → Model). */
  appModel(): Omit<Contender, "id" | "think"> {
    const s = this.#core.settings;
    const kind = s.modelKind ?? "builtin";
    if (kind === "files") return { kind, modelFile: s.modelFile, mmprojFile: s.mmprojFile };
    if (kind === "server") return { kind, url: s.serverUrl, name: s.serverModel, apiKey: s.serverKey };
    return { kind };
  }

  /**
   * A column as the window describes it: checked, and only the fields its kind uses. Its files must be there when
   * they are new (`checkFiles`): an edit that keeps files since deleted still saves (the column outlives them).
   */
  #shape(c: Omit<Contender, "id">, checkFiles = true): Omit<Contender, "id"> {
    if (c.kind === "files" && !(c.modelFile && c.mmprojFile)) throw new Error(msg("showdownFilesNeeded"));
    if (c.kind === "files" && checkFiles && !(existsSync(c.modelFile!) && existsSync(c.mmprojFile!)))
      throw new Error(msg("showdownFilesNeeded"));
    if (c.kind === "server" && !c.url?.trim()) throw new Error(msg("showdownUrlNeeded"));
    const prompt = c.prompt?.trim();
    return {
      kind: c.kind,
      ...(c.kind === "files" ? { modelFile: c.modelFile, mmprojFile: c.mmprojFile } : {}),
      ...(c.kind === "server"
        ? { url: c.url!.trim(), name: c.name?.trim() || undefined, apiKey: c.apiKey || undefined }
        : {}),
      think: !!c.think,
      ...(prompt ? { prompt } : {}),
    };
  }

  /** Compare another model (or the same one thinking first, or with other instructions). The same twice: once. */
  async add(c: Omit<Contender, "id">): Promise<string> {
    await this.load();
    const shaped = this.#shape(c);
    const same = this.contenders.find((x) => sameCombo(x, shaped));
    if (same) return same.id;
    const id = randomBytes(4).toString("hex");
    this.contenders.push({ id, ...shaped });
    await this.#save();
    this.#core.changed();
    return id;
  }

  /** Change a column. Its readings stay, outdated (made with something else), until they're read again. */
  async edit(id: string, c: Omit<Contender, "id">) {
    const i = this.contenders.findIndex((x) => x.id === id);
    if (i < 0) throw new Error("no such model");
    const before = this.contenders[i];
    // the key isn't sent to the window: left empty, the column keeps its own
    const apiKey = c.apiKey || (c.kind === "server" && before.kind === "server" ? before.apiKey : undefined);
    const sameFiles = c.modelFile === before.modelFile && c.mmprojFile === before.mmprojFile;
    this.contenders[i] = { id, ...this.#shape({ ...c, apiKey }, !sameFiles) };
    this.#jobs = this.#jobs.filter((j) => j.contender !== id); // waiting with the old settings
    if (this.#working?.contender === id) this.#abort?.abort();
    await this.#save();
    this.#core.changed();
  }

  /** A copy of a column beside it, to change one thing and compare (its readings aren't copied). */
  async duplicate(id: string): Promise<string> {
    const i = this.contenders.findIndex((x) => x.id === id);
    if (i < 0) throw new Error("no such model");
    const copy = { ...this.contenders[i], id: randomBytes(4).toString("hex") };
    this.contenders.splice(i + 1, 0, copy);
    await this.#save();
    this.#core.changed();
    return copy.id;
  }

  /**
   * Why this column can't read now (its model's files were deleted or moved), or "". The column stays, with its
   * readings: reading again just says so, until the files are back or the column points to them (Edit).
   */
  gone(c: Contender): string {
    if (c.kind === "files") {
      const lost = [c.modelFile, c.mmprojFile].find((f) => !f || !existsSync(f));
      return lost === undefined ? "" : msg("showdownFileGone", { file: lost ?? "" });
    }
    if (c.kind === "builtin") {
      const dir = this.#core.model.modelDir();
      return MODEL_FILES.every((f) => existsSync(join(dir, f.file))) ? "" : msg("notDownloaded");
    }
    return ""; // a server: only reading tells
  }

  /** The instructions a column reads with: its own (and the writing language's rule), or the app's. */
  promptFor(c: Contender): string {
    return c.prompt ? c.prompt + langPrompt(this.#core.lib.settings.language) : this.#core.readingPrompt();
  }

  /** Has this reading been made with what the column says now, from the picture the page has now? */
  #outdated(c: Contender, r: Reading, pic: number) {
    return r.prompt !== keyOf(this.promptFor(c)) || r.pic !== pic || (!!r.combo && r.combo !== comboKey(c));
  }

  /** Stop comparing a model: its readings in this session go too. */
  async remove(id: string, lib: Library) {
    this.contenders = this.contenders.filter((c) => c.id !== id);
    this.#jobs = this.#jobs.filter((j) => j.contender !== id);
    if (this.#working?.contender === id) this.#abort?.abort();
    await this.#save();
    await rm(this.#dir(lib, id), { recursive: true, force: true });
    for (const p of lib.pages) await rm(this.#buildDir(lib, id, p.id), { recursive: true, force: true });
    for (const k of [...this.#readings.keys(), ...this.#texts.keys()])
      if (k.startsWith(this.#dir(lib, id))) {
        this.#readings.delete(k);
        this.#texts.delete(k);
      }
    this.#core.changed();
  }

  /**
   * Read with this column from now on: the app's settings take its model, and its instructions when it has its own
   * (they hold the notes too: the notes are emptied). Not the thinking: pages are read without.
   */
  async use(id: string) {
    const c = this.contenders.find((x) => x.id === id);
    if (!c) throw new Error("no such model");
    await this.#core.setSettings({
      modelKind: c.kind,
      ...(c.kind === "files" ? { modelFile: c.modelFile, mmprojFile: c.mmprojFile } : {}),
      ...(c.kind === "server"
        ? { serverUrl: c.url, serverModel: c.name ?? "", serverKey: c.apiKey ?? "" }
        : {}),
      ...(c.prompt ? { prompt: c.prompt, instructions: "" } : {}),
    });
  }

  // ------------------------------------------------------------------ the readings kept

  #dir = (lib: Library, cid: string) => join(lib.dir, "showdown", cid);
  #buildDir = (lib: Library, cid: string, page: string) => join(lib.buildDir(page), `sd-${cid}`);
  #key = (lib: Library, cid: string, page: string) => `${lib.dir}|${cid}|${page}`;

  async reading(lib: Library, cid: string, page: string): Promise<Reading | null> {
    const f = join(this.#dir(lib, cid), `${page}.json`);
    if (!this.#readings.has(f))
      this.#readings.set(f, JSON.parse(await readFile(f, "utf8").catch(() => "null")) as Reading | null);
    return this.#readings.get(f)!;
  }

  async text(lib: Library, cid: string, page: string): Promise<string> {
    const f = join(this.#dir(lib, cid), `${page}.tex`);
    if (!this.#texts.has(f)) this.#texts.set(f, await readFile(f, "utf8").catch(() => ""));
    return this.#texts.get(f)!;
  }

  thinking(lib: Library, cid: string, page: string): Promise<string> {
    return readFile(join(this.#dir(lib, cid), `${page}.thinking.txt`), "utf8").catch(() => "");
  }

  /** The text the user has for a page (with their corrections), in LaTeX: what readings are scored against. */
  async answer(lib: Library, page: string): Promise<string> {
    const p = lib.get(page);
    if (!p || p.status !== "done") return "";
    return await readFile(lib.texPath(page), "utf8").catch(() => "");
  }

  /** How far a reading is from the user's text (0 same, 1 nothing in common), or null without one. */
  async score(lib: Library, cid: string, page: string, r: Reading, answer: string): Promise<number | null> {
    if (!answer.trim()) return null;
    const k = this.#key(lib, cid, page);
    const known = this.#scores.get(k);
    if (known && known.at === r.at && known.answer === answer) return known.d;
    const d = distance(await this.text(lib, cid, page), answer);
    this.#scores.set(k, { at: r.at, answer, d });
    return d;
  }

  /** For the window: every contender's reading of every page of the session, and what's being read. */
  async state(lib: Library) {
    await this.load();
    const pages = lib.pages.filter((p) => !p.noScan);
    const app = this.appModel();
    const answers = new Map<string, string>();
    for (const p of pages) answers.set(p.id, await this.answer(lib, p.id));
    const contenders = [];
    for (const c of this.contenders) {
      const cells: Record<string, unknown> = {};
      for (const p of pages) {
        const k = this.#key(lib, c.id, p.id);
        const r = await this.reading(lib, c.id, p.id);
        const working =
          this.#working && this.#key(this.#working.lib, this.#working.contender, this.#working.page) === k;
        const queued = this.#jobs.some((j) => this.#key(j.lib, j.contender, j.page) === k);
        const failed = this.#failed.get(k) ?? "";
        const state: CellState = working
          ? "working"
          : queued
            ? "queued"
            : failed
              ? "failed"
              : r
                ? "done"
                : "none";
        cells[p.id] = {
          state,
          failed,
          reading: r && {
            ...r,
            outdated: this.#outdated(c, r, p.pic ?? 0),
            score: await this.score(lib, c.id, p.id, r, answers.get(p.id) ?? ""),
          },
        };
      }
      contenders.push({
        id: c.id,
        kind: c.kind,
        name: contenderName(c),
        think: c.think,
        file: c.modelFile ?? c.url ?? "",
        // the app reads without thinking, with Settings' instructions
        app: !c.think && !c.prompt && sameModel(c, { ...app, think: false }),
        prompt: c.prompt ?? null,
        gone: this.gone(c),
        // to edit the column as it is
        modelFile: c.modelFile ?? "",
        mmprojFile: c.mmprojFile ?? "",
        url: c.url ?? "",
        model: c.name ?? "",
        cells,
      });
    }
    return {
      contenders,
      pages: pages.map((p) => ({ id: p.id, checked: !!p.checked && p.status === "done", status: p.status })),
      working: this.#working && {
        contender: this.#working.contender,
        page: this.#working.page,
        started: this.#working.started,
      },
      queued: this.#jobs.filter((j) => j.lib === lib).length,
      /** Nothing is read until the engine and the model are downloaded (core.ts #loop): the window says so. */
      blocked: this.#core.missing.engine || this.#core.missing.model,
      /** Settings' instructions, all in one text: what a column's own instructions start from. */
      instructions: this.#core.instructionsText(),
      engine: { status: this.engine.status, detail: this.engine.detail },
    };
  }

  // ------------------------------------------------------------------ reading

  /** Read these cells (a contender and a page each), or "missing": every one not read yet, or outdated. */
  async queue(lib: Library, cells: { contender: string; page: string }[] | "missing") {
    await this.load();
    let list = cells;
    if (list === "missing") {
      list = [];
      // model by model, so each is loaded once; not the ones whose files are gone
      for (const c of this.contenders.filter((x) => !this.gone(x)))
        for (const p of lib.pages.filter((x) => !x.noScan)) {
          const r = await this.reading(lib, c.id, p.id);
          if (!r || this.#outdated(c, r, p.pic ?? 0)) list.push({ contender: c.id, page: p.id });
        }
    } else
      for (const { contender } of list) {
        const c = this.contenders.find((x) => x.id === contender);
        const why = c && this.gone(c);
        if (why) throw new Error(why);
      }
    for (const { contender, page } of list) {
      if (!this.contenders.some((c) => c.id === contender) || !lib.get(page)) continue;
      const k = this.#key(lib, contender, page);
      this.#failed.delete(k);
      const w = this.#working;
      if (w && this.#key(w.lib, w.contender, w.page) === k) continue;
      if (!this.#jobs.some((j) => this.#key(j.lib, j.contender, j.page) === k))
        this.#jobs.push({ lib, contender, page });
    }
    this.#core.changed();
    this.#core.wake();
  }

  /** Stop reading: one cell (waiting or being read), or all of the session's. The readings kept stay. */
  stop(lib: Library, cell?: { contender: string; page: string }) {
    const hit = (j: Job) =>
      j.lib === lib && (!cell || (j.contender === cell.contender && j.page === cell.page));
    this.#jobs = this.#jobs.filter((j) => !hit(j));
    if (this.#working && hit(this.#working)) this.#abort?.abort();
    this.#core.changed();
  }

  /** The next reading to make, for the session open: one with the model already loaded first. */
  next(lib: Library): Job | null {
    const mine = this.#jobs.filter((j) => j.lib === lib);
    return mine.find((j) => j.contender === this.#inEngine) ?? mine[0] ?? null;
  }

  /** The app's model is about to read: the graphics chip is its own again. */
  release() {
    if (this.engine.running) this.engine.stop();
    this.#inEngine = "";
  }

  #config(c: Contender): ModelConfig {
    const s = this.#core.settings;
    return {
      kind: c.kind,
      serverPath: s.serverPath,
      modelDir: s.modelDir,
      modelFile: c.modelFile,
      mmprojFile: c.mmprojFile,
      url: c.url,
      name: c.name,
      apiKey: c.apiKey,
      ...(c.think ? { ctx: THINK_CTX } : {}),
    };
  }

  /** Make one reading (core.ts #loop calls this when nothing more urgent waits). */
  async run(job: Job) {
    this.#jobs = this.#jobs.filter((j) => j !== job);
    const { lib } = job;
    const c = this.contenders.find((x) => x.id === job.contender);
    const p = lib.get(job.page);
    if (!c || !p) return;
    const k = this.#key(lib, c.id, p.id);
    const why = this.gone(c);
    if (why) {
      this.#failed.set(k, why); // gone while it waited
      if (!this.next(lib)) this.#done();
      this.#core.changed();
      return;
    }
    this.#working = { ...job, started: Date.now() / 1000 };
    const abort = new AbortController();
    this.#abort = abort;
    this.#core.changed();
    try {
      const config = this.#config(c);
      if (JSON.stringify(config) !== JSON.stringify(this.engine.config)) {
        this.engine.stop();
        this.engine.config = config;
      }
      // one model in the graphics chip's memory: the app's waits (started again when the showdown is done)
      if (c.kind !== "server" && this.#core.model.kind !== "server") this.#core.model.stop();
      this.#inEngine = c.id;
      const prompt = this.promptFor(c);
      const jpeg = await readFile(lib.scanPath(p.id));
      await this.engine.ensure(); // loaded first: a reading's time is the reading's alone
      const t0 = Date.now();
      let raw: string,
        thinking = "",
        finish: string,
        tokens: number | null,
        tps: number | null;
      if (c.think) {
        const image = {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` },
        };
        // streamed (a long thinking outlasts a plain request's wait), at Qwen's settings for thinking
        const r = await this.engine.chat(
          [{ role: "user", content: [image, { type: "text", text: prompt }] }],
          { think: true, maxTokens: THINK_TOKENS, onDelta: () => {} },
          abort.signal,
        );
        ({ text: raw, thinking, finish, tokens, tps } = r);
      } else ({ text: raw, finish, tokens, tps } = await this.engine.read(jpeg, prompt, abort.signal));
      const secs = (Date.now() - t0) / 1000;
      const text = cleanLatex(raw);
      const dir = this.#dir(lib, c.id);
      await mkdir(dir, { recursive: true });
      const textFile = join(dir, `${p.id}.tex`);
      await writeFile(textFile, text);
      this.#texts.set(textFile, text);
      const thinkFile = join(dir, `${p.id}.thinking.txt`);
      if (thinking.trim()) await writeFile(thinkFile, thinking);
      else await rm(thinkFile, { force: true });
      const empty = !text.trim();
      const typst = (p.format ?? "latex") === "typst";
      const shown = empty
        ? { ok: null, err: "", pngs: [] }
        : await this.#core.previewOf(
            lib,
            this.#buildDir(lib, c.id, p.id),
            typst ? latexToTypst(text) : text,
            typst,
          );
      const before = await this.reading(lib, c.id, p.id);
      const reading: Reading = {
        at: Date.now() / 1000,
        secs,
        tokens,
        tps,
        finish,
        prompt: keyOf(prompt),
        combo: comboKey(c),
        pic: p.pic ?? 0,
        ok: shown.ok,
        err: shown.err,
        pngs: shown.pngs,
        rev: (before?.rev ?? 0) + 1,
        unk: text.split("[??]").length - 1,
        empty,
      };
      const metaFile = join(dir, `${p.id}.json`);
      await writeFile(metaFile, JSON.stringify(reading, null, 2));
      this.#readings.set(metaFile, reading);
    } catch (e) {
      if (!abort.signal.aborted) this.#failed.set(k, (e as Error).message);
    } finally {
      this.#working = null;
      this.#abort = null;
      if (!this.next(lib)) this.#done();
      this.#core.changed();
    }
  }

  /** Nothing more to read: the engine stops, and the app's model is loaded again (as it is while Inktyset runs). */
  #done() {
    this.release();
    const core = this.#core;
    if (!core.missing.engine && !core.missing.model) void core.model.ensure().catch(() => {});
  }

  /** Inktyset quits. */
  quit() {
    this.#jobs = [];
    this.#abort?.abort();
    this.engine.stop();
  }

  /**
   * Keep a reading as a version of its page: listed with the others and marked new, to compare in the Compare view;
   * the page's text doesn't change.
   */
  async keep(lib: Library, cid: string, page: string) {
    const p = lib.get(page);
    const c = this.contenders.find((x) => x.id === cid);
    const r = await this.reading(lib, cid, page);
    if (!p || !c || !r || p.status !== "done") throw new Error("nothing to keep");
    const text = await this.text(lib, cid, page);
    await lib.ensureVersions(p);
    const vid = lib.nextVersion(p);
    await mkdir(join(lib.dir, "versions", page), { recursive: true });
    await writeFile(lib.versionPath(page, vid), text);
    const prompt = this.promptFor(c);
    (p.versions ??= []).push({
      id: vid,
      at: Date.now() / 1000,
      // the instructions' text is known when they are today's
      prompt: keyOf(prompt) === r.prompt ? lib.promptKey(prompt) : lib.prompts[r.prompt] ? r.prompt : "",
      model: contenderName(c),
      secs: r.secs,
      truncated: r.finish === "length",
    });
    p.fresh = vid;
    lib.changed();
    return vid;
  }
}
