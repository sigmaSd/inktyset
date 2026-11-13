// The pages: their order, status and proofreading marks, kept in <data>/state.json (the same file the first,
// Python version kept, so its pages carry over). Each page's files:
//   scans/<id>.jpg     what the model was shown (resized)
//   pages/<id>.tex     the LaTeX, with your corrections
//   raw/<id>.tex       the model's untouched answer (to compare against your corrections later)
//   build/<id>/        the preview: doc.tex, doc.pdf, render-N.png
//   originals/         files as they were added; phone/ what the phone sent

import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PageStatus = "queued" | "working" | "done" | "failed";

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
}

interface Saved {
  pages: Page[];
  counter: number;
  settings: { language: string };
  seen_phone: string[];
}

export class Library {
  pages: Page[] = [];
  counter = 0;
  settings = { language: "english" };
  seenPhone = new Set<string>();
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
      } catch {
        void copyFile(file, join(dir, "state.broken.json"));
      }
    }
    for (const p of this.pages) if (p.status === "working") p.status = "queued"; // interrupted mid-read
  }

  async init() {
    for (const d of ["scans", "pages", "raw", "build", "originals", "phone"]) {
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
  scanPath = (id: string) => join(this.dir, "scans", `${id}.jpg`);
  buildDir = (id: string) => join(this.dir, "build", id);

  async body(id: string) {
    return await readFile(this.texPath(id), "utf8").catch(() => "");
  }

  async doneBodies() {
    const done = this.pages.filter((p) => p.status === "done");
    return await Promise.all(done.map((p) => this.body(p.id)));
  }
}
