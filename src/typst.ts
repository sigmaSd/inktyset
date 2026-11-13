// Typst output (docs/scope.md): the Typst around a page (pages are converted from the model's LaTeX by
// src/convert.ts), and compiling it for the preview: with a `typst` installed on this computer when it works, otherwise the
// pinned Typst release downloaded once (src/components.ts). The LaTeX side is pipeline.ts and tex.ts.

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirOf, findFile, install, supported } from "./components.ts";
import { run, which } from "./run.ts";

/** Typst's language codes, for hyphenation, quotes and text direction (Arabic is right to left). */
const CODES: Record<string, string> = {
  english: "en",
  french: "fr",
  arabic: "ar",
  german: "de",
  spanish: "es",
  italian: "it",
  portuguese: "pt",
  turkish: "tr",
};

export function typstPreamble(lang: string): string {
  const key = (lang || "english").trim().toLowerCase();
  const code = CODES[key];
  const fonts =
    key === "arabic"
      ? `#set text(font: ("Libertinus Serif", "Amiri", "Noto Naskh Arabic", "PakType Naskh Basic", "Noto Sans Arabic"))\n`
      : "";
  return `#set page(paper: "a4", margin: 2.5cm)
#set text(size: 11pt${code ? `, lang: "${code}"` : ""})
${fonts}#set par(justify: true)
// theorem-like blocks, as the LaTeX preamble's \\newtheorem
#let _thm(name, body, italic: true) = block(width: 100%, above: 1.2em, below: 1.2em)[*#name.* #if italic { emph(body) } else { body }]
#let theorem(body) = _thm("Theorem", body)
#let lemma(body) = _thm("Lemma", body)
#let proposition(body) = _thm("Proposition", body)
#let corollary(body) = _thm("Corollary", body)
#let definition(body) = _thm("Definition", body, italic: false)
#let example(body) = _thm("Example", body, italic: false)
#let remark(body) = _thm("Remark", body, italic: false)
#let proof(body) = block(width: 100%, above: 1.2em, below: 1.2em)[_Proof._ #body #h(1fr) $square$]
`;
}

/** One page alone, for its preview. */
export function typstPage(body: string, lang: string): string {
  return `${typstPreamble(lang)}#set page(numbering: none)\n\n${body}\n`;
}

/** Every finished page in one file, each on its own page. */
export function typstDocument(bodies: string[], lang: string): string {
  const pages = bodies.map((b, i) => `// ---- page ${i + 1}\n${b.trim()}\n`).join("\n#pagebreak()\n");
  return `${typstPreamble(lang)}\n${pages}`;
}

/** What "Copy all Typst" copies: the bodies only. */
export function typstBodies(bodies: string[]): string {
  return bodies.map((b, i) => `// ---- page ${i + 1}\n${b.trim()}\n`).join("\n");
}

// ------------------------------------------------------------------ compiling

/** Typst's first error, with its location lines. */
function firstError(stderr: string): string {
  const lines = stderr.trim().split("\n");
  const i = lines.findIndex((l) => l.startsWith("error"));
  return (i < 0 ? lines.slice(0, 6) : lines.slice(i, i + 8)).join("\n") || "The preview could not be built.";
}

export class Typst {
  /** What the last compile used, for the settings window. */
  using = "";
  installing: Promise<void> | null = null;
  readonly #tested = new Map<string, boolean>();
  readonly #system = which("typst");
  readonly #base: string;
  readonly #onInstall: (p: Promise<void>) => void;

  constructor(base: string, onInstall: (p: Promise<void>) => void) {
    this.#base = base;
    this.#onInstall = onInstall;
  }

  get system() {
    return this.#system;
  }

  async downloaded(): Promise<string | null> {
    return await findFile(dirOf(this.#base, "typst"), process.platform === "win32" ? "typst.exe" : "typst");
  }

  async #run(program: string, dir: string) {
    const r = await run(program, ["compile", "--root", ".", "doc.typ", "doc.pdf"], {
      cwd: dir,
      timeoutMs: 120_000,
    });
    const pdf = join(dir, "doc.pdf");
    const ok = r.code === 0 && existsSync(pdf);
    return { ok, err: ok ? "" : firstError(r.stderr + r.stdout), pdf: existsSync(pdf) ? pdf : null };
  }

  /** An installed typst is used when it compiles a small test page (it may be too old for our preamble). */
  async #works(program: string): Promise<boolean> {
    const known = this.#tested.get(program);
    if (known !== undefined) return known;
    const dir = join(this.#base, "typst-test");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "doc.typ"), typstPage("#theorem[Test $x^2 + frac(1, 2)$.]", "english"));
    const r = await this.#run(program, dir);
    await rm(dir, { recursive: true, force: true });
    this.#tested.set(program, r.ok);
    return r.ok;
  }

  async #ensure(): Promise<string> {
    if (this.#system && (await this.#works(this.#system))) return this.#system;
    const have = await this.downloaded();
    if (have) return have;
    if (!supported("typst"))
      throw new Error("Typst is not installed, and no Typst download exists for this system.");
    if (!this.installing) {
      this.installing = install(this.#base, "typst", () => {}, new AbortController().signal).finally(() => {
        this.installing = null;
      });
      this.#onInstall(this.installing);
    }
    await this.installing;
    const bin = await this.downloaded();
    if (!bin) throw new Error("Typst was downloaded but could not be found.");
    return bin;
  }

  async compile(dir: string, body: string, lang: string) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const program = await this.#ensure();
    this.using = program;
    await writeFile(join(dir, "doc.typ"), typstPage(body, lang));
    return await this.#run(program, dir);
  }
}
