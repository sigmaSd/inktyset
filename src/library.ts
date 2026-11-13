// The pages: their order, status and proofreading marks, kept in <data>/state.json (the same file the first,
// Python version kept, so its pages carry over). Each page's files:
//   scans/<id>.jpg     what the model was shown (resized)
//   pages/<id>.tex     the page's LaTeX, with your corrections (the model always reads in LaTeX)
//   pages/<id>.typ     the same page in Typst, converted from the LaTeX (src/convert.ts), when used
//   raw/<id>.tex       the model's untouched answer (to compare against your corrections later)
//   versions/<id>/     every reading of the page: v1.tex, v2.tex… (and .typ), with your corrections; the
//                      current one is also pages/<id>.tex. A reading with other instructions or another
//                      model is a new version, so nothing is ever lost and two can be compared.
//   build/<id>/        the preview: doc.tex, doc.pdf, render-N.png
//   originals/         files as they were added; phone/ what the phone sent

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PageStatus = "queued" | "working" | "done" | "failed";

/** One reading of a page. */
export interface Version {
  id: string; // "v1", "v2"…
  at: number; // seconds since epoch
  /** The instructions it was read with: a key of Library.prompts ("" for readings older than versions). */
  prompt: string;
  /** What read it ("" when not known). */
  model: string;
  secs: number | null;
  truncated: boolean;
  /** Its own preview, built when it's compared (the current version's is the page's). */
  ok?: boolean | null;
  err?: string;
  pngs?: string[];
  rev?: number;
}

export interface Page {
  id: string;
  label: string;
  origin: "file" | "scan" | "phone";
  status: PageStatus;
  added: number; // seconds since epoch, like the Python version
  started?: number;
  rev: number;
  ok: boolean | null;
  err: string;
  unk: number;
  secs: number | null;
  truncated: boolean;
  pngs: string[];
  checked?: boolean;
  /** What the page was read as; pages from before Typst existed are LaTeX. */
  format?: "latex" | "typst";
  /** Its readings, oldest first, and which one is shown (pages/<id>.tex). */
  versions?: Version[];
  current?: string;
  /** A trial reading (other instructions or model) waiting, running or failed; it never replaces the text. */
  trial?: "queued" | "working" | "failed";
  trialErr?: string;
  /** A version made by a trial, not compared yet. */
  fresh?: string;
}

interface Saved {
  pages: Page[];
  counter: number;
  settings: { language: string; format: "latex" | "typst" };
  seen_phone: string[];
  /** The instructions versions were read with, by key (the same text is kept once). */
  prompts?: Record<string, string>;
}

export class Library {
  pages: Page[] = [];
  counter = 0;
  settings: Saved["settings"] = { language: "english", format: "latex" };
  seenPhone = new Set<string>();
  prompts: Record<string, string> = {};
  /** Files still being prepared (a PDF being split, a photo being resized). */
  intake = 0;
  version = 0;
  readonly dir: string;
  readonly #listeners = new Set<() => void>();
  #saving: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
    const file = join(dir, "state.json");
    if (existsSync(file)) {
      try {
        const d = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved>;
        this.pages = d.pages ?? [];
        this.counter = d.counter ?? 0;
        this.settings = { ...this.settings, ...d.settings };
        this.seenPhone = new Set(d.seen_phone ?? []);
        this.prompts = d.prompts ?? {};
      } catch {
        void copyFile(file, join(dir, "state.broken.json"));
      }
    }
    for (const p of this.pages) {
      if (p.status === "working") p.status = "queued"; // interrupted mid-read
      if (p.trial === "working") p.trial = "queued";
    }
  }

  async init() {
    for (const d of ["scans", "pages", "raw", "build", "originals", "phone", "versions"]) {
      await mkdir(join(this.dir, d), { recursive: true });
    }
    await this.save();
  }

  onChange(f: () => void) {
    this.#listeners.add(f);
    return () => this.#listeners.delete(f);
  }

  /** Something changed: save, and tell the windows. */
  changed() {
    this.version++;
    void this.save();
    for (const f of this.#listeners) f();
  }

  save() {
    // one write at a time, always the latest state
    this.#saving = this.#saving.then(async () => {
      const data: Saved = {
        pages: this.pages,
        counter: this.counter,
        settings: this.settings,
        seen_phone: [...this.seenPhone].sort(),
        prompts: this.prompts,
      };
      const tmp = join(this.dir, "state.tmp");
      await writeFile(tmp, JSON.stringify(data, null, 1));
      await rename(tmp, join(this.dir, "state.json"));
    });
    return this.#saving;
  }

  get(id: string) {
    return this.pages.find((p) => p.id === id);
  }

  busy() {
    return this.intake > 0 || this.pages.some((p) => p.status === "queued" || p.status === "working");
  }

  nextId() {
    this.counter++;
    return `page${String(this.counter).padStart(4, "0")}`;
  }

  /** A new page whose scan is already saved (scans/<id>.jpg). */
  add(id: string, label: string, origin: Page["origin"]) {
    const page: Page = {
      id,
      label,
      origin,
      status: "queued",
      added: Date.now() / 1000,
      rev: 1,
      ok: null,
      err: "",
      unk: 0,
      secs: null,
      truncated: false,
      pngs: [],
      checked: false,
    };
    this.pages.push(page);
    this.changed();
    return page;
  }

  /** A file that could not be turned into a page: listed, with why. */
  addFailed(label: string, origin: Page["origin"], err: string) {
    const page = this.add(this.nextId(), label, origin);
    Object.assign(page, { status: "failed", ok: false, err });
    this.changed();
  }

  texPath = (id: string) => join(this.dir, "pages", `${id}.tex`);
  /** The page in Typst (src/convert.ts makes it from the LaTeX). */
  typPath = (id: string) => join(this.dir, "pages", `${id}.typ`);
  /** The file shown and edited: the page's current format. */
  pathOf = (id: string) =>
    (this.get(id)?.format ?? "latex") === "typst" ? this.typPath(id) : this.texPath(id);
  scanPath = (id: string) => join(this.dir, "scans", `${id}.jpg`);
  buildDir = (id: string) => join(this.dir, "build", id);

  versionPath = (id: string, vid: string, ext: "tex" | "typ" = "tex") =>
    join(this.dir, "versions", id, `${vid}.${ext}`);

  /** Keep instructions once; versions point to them by key. */
  promptKey(text: string) {
    const key = createHash("sha256").update(text).digest("hex").slice(0, 12);
    this.prompts[key] ??= text;
    return key;
  }

  /** A finished page from before versions: its text becomes version 1. */
  async ensureVersions(p: Page) {
    if (p.versions?.length || !existsSync(this.texPath(p.id))) return;
    p.versions = [{ id: "v1", at: p.added, prompt: "", model: "", secs: p.secs, truncated: p.truncated }];
    p.current = "v1";
    await this.saveCurrent(p);
  }

  /** The text shown (with your corrections) back into its version's files. */
  async saveCurrent(p: Page) {
    if (!p.current) return;
    await mkdir(join(this.dir, "versions", p.id), { recursive: true });
    await copyFile(this.texPath(p.id), this.versionPath(p.id, p.current)).catch(() => {});
    if (existsSync(this.typPath(p.id)))
      await copyFile(this.typPath(p.id), this.versionPath(p.id, p.current, "typ"));
  }

  /** The next version's name. */
  nextVersion(p: Page) {
    const n = Math.max(0, ...(p.versions ?? []).map((v) => Number(v.id.slice(1)) || 0));
    return `v${n + 1}`;
  }

  /** Show another version: the current text is kept in its version first. */
  async useVersion(p: Page, vid: string) {
    if (!p.versions?.some((v) => v.id === vid)) throw new Error("no such version");
    if (p.current === vid) return;
    await this.saveCurrent(p);
    await copyFile(this.versionPath(p.id, vid), this.texPath(p.id));
    if (existsSync(this.versionPath(p.id, vid, "typ")))
      await copyFile(this.versionPath(p.id, vid, "typ"), this.typPath(p.id));
    else await rm(this.typPath(p.id), { force: true }); // made again from the LaTeX when needed
    const v = p.versions.find((x) => x.id === vid)!;
    Object.assign(p, { current: vid, secs: v.secs, truncated: v.truncated, ok: null, checked: false });
    if (p.fresh === vid) p.fresh = undefined;
  }

  /** Forget a version that isn't shown. */
  async deleteVersion(p: Page, vid: string) {
    if (p.current === vid) throw new Error("the version shown can't be deleted");
    p.versions = (p.versions ?? []).filter((v) => v.id !== vid);
    if (p.fresh === vid) p.fresh = undefined;
    for (const ext of ["tex", "typ"] as const) await rm(this.versionPath(p.id, vid, ext), { force: true });
    await rm(join(this.buildDir(p.id), vid), { recursive: true, force: true });
  }

  /** A version's LaTeX (the current one: as shown, with the latest corrections). */
  async versionText(p: Page, vid: string, ext: "tex" | "typ" = "tex") {
    const file =
      p.current === vid
        ? ext === "tex"
          ? this.texPath(p.id)
          : this.typPath(p.id)
        : this.versionPath(p.id, vid, ext);
    return await readFile(file, "utf8").catch(() => "");
  }

  async body(id: string) {
    return await readFile(this.pathOf(id), "utf8").catch(() => "");
  }

  /** The finished pages' text, in order: those in `format` (pages read in the other format are left out). */
  async doneBodies(format: "latex" | "typst" = this.settings.format) {
    const done = this.pages.filter((p) => p.status === "done" && (p.format ?? "latex") === format);
    return await Promise.all(done.map((p) => this.body(p.id)));
  }
}
