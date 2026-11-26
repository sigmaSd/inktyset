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
import {
  cleanProfile,
  type EngineProfile,
  fitPreview,
  profileArgs,
  profileKey,
  programFlags,
} from "./engine-profile.ts";
import { msg } from "./i18n.ts";
import { keyOf, type Library } from "./library.ts";
import { type Delta, type Example, Model, type ModelConfig, type ModelKind, pageMessages } from "./model.ts";
import { cleanLatex, langPrompt } from "./pipeline.ts";
import { scorePage } from "./score.ts";

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
  /** How many of the session's checked pages it is shown first, with their text (none: 0). No cap: the engine's
   * memory is the limit, and reading says so when it's reached. */
  examples?: number;
  /** How our engine is started for it (src/engine-profile.ts); none: as for the app. Not for a server's model. */
  engine?: EngineProfile;
}

/** A reading kept (its text is beside it, <page>.tex). */
export interface Reading {
  at: number;
  secs: number;
  /** Tokens written (the thinking too), and how fast it wrote them (tokens a second); null when not known. */
  tokens?: number | null;
  tps?: number | null;
  /** The prompt (instructions, examples, picture): its tokens read and the seconds that took; null when not known. */
  promptTokens?: number | null;
  promptSecs?: number | null;
  /** All the prompt's tokens (the ones the engine had already from the reading before too); null when not known. */
  inTokens?: number | null;
  /** "length": cut at the most it may write. */
  finish: string;
  /** The instructions it was read with (their key, Library keyOf) and the picture's version (Page.pic). */
  prompt: string;
  /** What read it: the model, the thinking, the examples (comboKey). Another since (column edited): outdated. */
  combo?: string;
  /** The pages it was shown first, as examples. */
  examples?: string[];
  /** The column's engine options the engine didn't know: left out of this reading. */
  skipped?: string[];
  pic: number;
  ok: boolean | null;
  err: string;
  pngs: string[];
  rev: number;
  unk: number;
  empty: boolean;
}

/** A reading's distance from the user's text: what it says (src/score.ts), and all of it, the layout too. */
export interface Score {
  content: number;
  all: number;
  /** The text's formulas found exactly in the reading. */
  formulas: { right: number; of: number };
}

export type CellState = "none" | "queued" | "working" | "failed" | "done";

/**
 * The reading being made, as it comes (the open cell shows it): reading the prompt (no word yet), thinking, or
 * writing; the thinking and text so far, their tokens, and when the first came (the prompt read).
 */
export interface Live {
  phase: "prompt" | "thinking" | "writing";
  thinking: string;
  text: string;
  thinkTokens: number;
  textTokens: number;
  /** Seconds since 1970 (as `started`); null while the prompt is read. */
  firstAt: number | null;
}

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
  sameModel(a, b) &&
  a.think === b.think &&
  (a.prompt ?? null) === (b.prompt ?? null) &&
  (a.examples ?? 0) === (b.examples ?? 0) &&
  profileKey(a.engine) === profileKey(b.engine);

/**
 * What a reading was made with, besides the instructions (which have their own key): the model, the thinking, the
 * examples, the engine's options.
 */
export const comboKey = (c: Omit<Contender, "id">) =>
  keyOf(
    JSON.stringify([c.kind, c.modelFile ?? "", c.mmprojFile ?? "", c.url ?? "", c.name ?? "", c.think]) +
      // none: the key from before examples (and engine options) existed, so the readings made then stay current
      (c.examples ? `|${c.examples}` : "") +
      (c.engine ? `|${profileKey(c.engine)}` : ""),
  );

/** Room for thinking: the instructions, the picture, a long thinking and the page. */
const THINK_CTX = 24576;
/** Room for each example page: its picture (up to about 2,500 tokens) and its text. */
const EXAMPLE_CTX = 8192;
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
  /** What the reading being made has said so far (null: none made, or its model still loading). */
  #live: Live | null = null;
  /** The contender the engine holds now ("" none). */
  #inEngine = "";
  /** A reading stopped the app's model while it was loaded: it's loaded again when the readings are done. */
  #reload = false;
  /** Why a reading failed, by cell (until it's asked again). */
  readonly #failed = new Map<string, string>();
  readonly #readings = new Map<string, Reading | null>();
  readonly #texts = new Map<string, string>();
  /** Scores: by cell, the texts they were made from. */
  readonly #scores = new Map<string, { at: number; answer: string; d: Score }>();

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
    const examples = Math.max(0, Math.round(Number(c.examples) || 0));
    const engine = c.kind === "server" ? undefined : cleanProfile(c.engine);
    return {
      kind: c.kind,
      ...(c.kind === "files" ? { modelFile: c.modelFile, mmprojFile: c.mmprojFile } : {}),
      ...(c.kind === "server"
        ? { url: c.url!.trim(), name: c.name?.trim() || undefined, apiKey: c.apiKey || undefined }
        : {}),
      think: !!c.think,
      ...(prompt ? { prompt } : {}),
      ...(examples ? { examples } : {}),
      ...(engine ? { engine } : {}),
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
    // the engine's options, when the window doesn't send them, are the column's own still
    const engine = "engine" in c ? c.engine : before.engine;
    this.contenders[i] = { id, ...this.#shape({ ...c, apiKey, engine }, !sameFiles) };
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

  /**
   * The pages a column shows before reading `page`: the session's first checked pages, never the page itself (its
   * own text would be the answer), as many as the column asks for.
   */
  examplesFor(lib: Library, c: Contender, page: string): string[] {
    if (!c.examples) return [];
    return lib.pages
      .filter((p) => p.id !== page && p.checked && p.status === "done" && !p.noScan)
      .slice(0, c.examples)
      .map((p) => p.id);
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

  /**
   * How far a reading is from the user's text (0 same, 1 nothing in common), or null without one: what it read,
   * its layout aside (src/score.ts), and everything, the layout too (what they'd still change).
   */
  async score(lib: Library, cid: string, page: string, r: Reading, answer: string): Promise<Score | null> {
    if (!answer.trim()) return null;
    const k = this.#key(lib, cid, page);
    const known = this.#scores.get(k);
    if (known && known.at === r.at && known.answer === answer) return known.d;
    const text = await this.text(lib, cid, page);
    const said = scorePage(text, answer);
    const d = { content: said.off, all: distance(text, answer), formulas: said.formulas };
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
            // what it read, and with the layout too (null: the page isn't checked)
            ...(await this.score(lib, c.id, p.id, r, answers.get(p.id) ?? "").then((sc) => ({
              score: sc?.content ?? null,
              scoreAll: sc?.all ?? null,
              formulas: sc?.formulas ?? null,
            }))),
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
        examples: c.examples ?? 0,
        engine: c.engine ?? null,
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
      pages: pages.map((p) => ({
        id: p.id,
        checked: !!p.checked && p.status === "done",
        status: p.status,
        // what its text started as: the model of the version shown (its name as the columns' are)
        from: p.versions?.find((v) => v.id === p.current)?.model ?? "",
      })),
      working: this.#working && {
        contender: this.#working.contender,
        page: this.#working.page,
        started: this.#working.started,
        phase: this.#live?.phase ?? null,
      },
      queued: this.#jobs.filter((j) => j.lib === lib).length,
      /** Nothing is read until the engine and the model are downloaded (core.ts #loop): the window says so. */
      blocked: this.#core.missing.engine || this.#core.missing.model,
      /** Settings' instructions, all in one text: what a column's own instructions start from. */
      instructions: this.#core.instructionsText(),
      // the column whose model is in the engine now ("" none), for the status bar
      engine: {
        status: this.engine.status,
        detail: this.engine.detail,
        holds: this.engine.running && this.engine.status === "ready" ? this.#inEngine : "", // (loaded, not loading)
      },
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
      ...(c.engine?.ctx
        ? { ctx: c.engine.ctx }
        : c.think || c.examples
          ? { ctx: (c.think ? THINK_CTX : 12288) + (c.examples ?? 0) * EXAMPLE_CTX }
          : {}),
    };
  }

  /**
   * Where a column's model would go with its engine options, without loading it (src/engine-profile.ts): on the
   * graphics chip, in the computer's memory. While an engine of ours runs, the chip's free memory is less by its.
   */
  async fit(c: Omit<Contender, "id">) {
    const shaped = this.#shape(c, false);
    if (shaped.kind === "server") throw new Error("a model server starts its own engine");
    const config = this.#config({ id: "", ...shaped });
    const server = await this.engine.serverPath(config);
    if (!server) throw new Error(msg("notDownloaded"));
    const dir = this.#core.model.modelDir();
    const [model, mmproj] =
      shaped.kind === "files"
        ? [shaped.modelFile!, shaped.mmprojFile]
        : MODEL_FILES.slice(0, 2).map((f) => join(dir, f.file));
    const ctx = config.ctx ?? 12288;
    const fit = await fitPreview({ server, model, mmproj, ctx, profile: shaped.engine });
    const { skipped } = profileArgs(shaped.engine, await programFlags(server));
    return { ...fit, ctx, skipped, busy: this.engine.running || this.#core.model.running };
  }

  /** The column's engine options, as the engine in use names them, and those it doesn't know (left out). */
  async #engineArgs(c: Contender, config: ModelConfig) {
    if (!c.engine || c.kind === "server") return { args: [], skipped: [] };
    const bin = await this.engine.serverPath(config);
    if (!bin) return { args: [], skipped: [] }; // no engine: starting it says so
    return profileArgs(c.engine, await programFlags(bin));
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
    let skipped: string[] = [];
    try {
      const config = this.#config(c);
      const engine = await this.#engineArgs(c, config);
      skipped = engine.skipped;
      if (engine.args.length) config.args = engine.args;
      if (JSON.stringify(config) !== JSON.stringify(this.engine.config)) {
        await this.engine.stop();
        this.engine.config = config;
      }
      // one model in the graphics chip's memory: the app's waits (loaded again when the showdown is done, if it was)
      const app = this.#core.model;
      if (c.kind !== "server" && app.kind !== "server") {
        if (app.running) this.#reload = true;
        await app.stop();
      }
      this.#inEngine = c.id;
      const prompt = this.promptFor(c);
      const jpeg = await readFile(lib.scanPath(p.id));
      const exampleIds = this.examplesFor(lib, c, p.id);
      const examples: Example[] = [];
      for (const id of exampleIds)
        examples.push({ jpeg: await readFile(lib.scanPath(id)), text: (await this.answer(lib, id)).trim() });
      await this.engine.ensure(); // loaded first: a reading's time is the reading's alone
      const t0 = Date.now();
      const live: Live = {
        phase: "prompt",
        thinking: "",
        text: "",
        thinkTokens: 0,
        textTokens: 0,
        firstAt: null,
      };
      this.#live = live;
      this.#core.changed();
      const onDelta = (d: Delta) => {
        const phase = d.text.trim() ? "writing" : d.thinking ? "thinking" : live.phase;
        Object.assign(live, d);
        if ((d.thinkTokens || d.textTokens) && live.firstAt === null) live.firstAt = Date.now() / 1000;
        if (phase !== live.phase) {
          live.phase = phase;
          this.#core.changed(); // the window shows what it does now (the words themselves are asked for: live())
        }
      };
      let raw: string,
        thinking = "",
        finish: string,
        tokens: number | null,
        tps: number | null,
        promptTokens: number | null,
        promptSecs: number | null,
        inTokens: number | null;
      if (c.think) {
        // streamed (a long thinking outlasts a plain request's wait), at Qwen's settings for thinking
        const r = await this.engine.chat(
          pageMessages(jpeg, prompt, examples),
          { think: true, maxTokens: THINK_TOKENS, onDelta },
          abort.signal,
        );
        ({ text: raw, thinking, finish, tokens, tps, promptTokens, promptSecs, inTokens } = r);
      } else
        ({
          text: raw,
          thinking,
          finish,
          tokens,
          tps,
          promptTokens,
          promptSecs,
          inTokens,
        } = await this.engine.read(jpeg, prompt, abort.signal, examples, onDelta));
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
        promptTokens,
        promptSecs,
        inTokens,
        finish,
        prompt: keyOf(prompt),
        combo: comboKey(c),
        ...(exampleIds.length ? { examples: exampleIds } : {}),
        ...(skipped.length ? { skipped } : {}),
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
      if (!abort.signal.aborted) {
        let why = (e as Error).message;
        // the engine didn't load, or stopped: with examples, the room they need is the likely cause
        if (c.examples && this.engine.status === "error") why += " " + msg("showdownTooManyExamples");
        this.#failed.set(k, why);
      }
    } finally {
      this.#working = null;
      this.#live = null;
      this.#abort = null;
      if (!this.next(lib)) this.#done();
      this.#core.changed();
    }
  }

  /**
   * Nothing more to read: the engine stops, and the app's model is loaded again if a reading stopped it (one never
   * loaded stays so, until a page is read: it would hold the graphics chip's memory, or the computer's while the
   * chip sleeps).
   */
  #done() {
    this.release();
    const core = this.#core;
    const reload = this.#reload;
    this.#reload = false;
    if (reload && !core.missing.engine && !core.missing.model) void core.model.ensure().catch(() => {});
  }

  /**
   * What Compare is doing, for the pages' status line (it reads on while the pages are shown): the reading being
   * made, in any session (`here`: the one shown), and how many wait.
   */
  activity() {
    const w = this.#working;
    const c = w && this.contenders.find((x) => x.id === w.contender);
    return {
      working:
        w && c
          ? {
              model: contenderName(c),
              page: w.lib.pages.findIndex((p) => p.id === w.page) + 1,
              started: w.started,
              here: w.lib === this.#core.lib,
              loading: this.engine.status === "starting",
              phase: this.#live?.phase ?? null,
            }
          : null,
      queued: this.#jobs.length,
    };
  }

  /**
   * The reading being made in `lib`, as it comes: what it has said so far (`words`), or only how far it is (the
   * status bar); null when none is made there, or its model is still loading.
   */
  live(lib: Library, words: boolean) {
    const w = this.#working,
      l = this.#live;
    if (!w || !l || w.lib !== lib) return null;
    const { thinking, text, ...rest } = l;
    return { contender: w.contender, page: w.page, ...rest, ...(words ? { thinking, text } : {}) };
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
