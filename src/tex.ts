// Compiling a page for its preview. "Automatic": the TeX installed on this computer when one is found and passes
// a small test for the language in use (so the preview matches what you compile your thesis with), otherwise
// Tectonic, a self-contained LaTeX that Inktyset downloads once (it fetches the packages a page needs, then works
// offline). "Installed" and "Built-in" force one or the other.

import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirOf, findFile, install, supported } from "./components.ts";
import { type Family, familyFor, pageDocument } from "./pipeline.ts";
import { run, which } from "./run.ts";
import { arabicInLatin } from "./scripts.ts";

export type TexMode = "auto" | "system" | "builtin";

interface SystemTex {
  pdflatex: string | null;
  xelatex: string | null;
}

/** Where TeX distributions put their programs, beyond PATH (a desktop app on macOS doesn't get the shell's PATH). */
function texDirs(): string[] {
  const dirs: string[] = [];
  const glob = (base: string, sub: (y: string) => string[]) => {
    try {
      for (const y of readdirSync(base).sort().reverse()) dirs.push(...sub(y).map((s) => join(base, y, s)));
    } catch {
      /* not there */
    }
  };
  if (process.platform === "darwin") dirs.push("/Library/TeX/texbin");
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    dirs.push(join(local, "Programs", "MiKTeX", "miktex", "bin", "x64"));
    dirs.push(join(process.env.ProgramFiles ?? "C:\\Program Files", "MiKTeX", "miktex", "bin", "x64"));
    glob("C:\\texlive", () => [join("bin", "windows"), join("bin", "win64"), join("bin", "win32")]);
  } else {
    glob("/usr/local/texlive", () => [
      join("bin", "x86_64-linux"),
      join("bin", "aarch64-linux"),
      join("bin", "universal-darwin"),
    ]);
  }
  return dirs;
}

export function findSystemTex(): SystemTex {
  const extra = texDirs();
  return { pdflatex: which("pdflatex", extra), xelatex: which("xelatex", extra) };
}

export interface CompileResult {
  ok: boolean;
  err: string;
  pdf: string | null;
}

/** The first error of a TeX log, with a few lines of context. */
function firstError(log: string, fallback: string): string {
  const m = /^! .*(?:\n.*){0,3}/m.exec(log) ?? /^error: .*/m.exec(log);
  return m ? m[0] : fallback;
}

export class Tex {
  mode: TexMode = "auto";
  /** What the last compile used, for the settings window. */
  using: "system" | "tectonic" | null = null;
  detail = "";
  /** A component download in progress (Tectonic), reported like the others. */
  installing: Promise<void> | null = null;
  readonly #tested = new Map<string, boolean>(); // "<program>|<lang>" → passed the small test
  readonly #system = findSystemTex();
  readonly #base: string;
  readonly #onInstall: (p: Promise<void>) => void;

  constructor(base: string, onInstall: (p: Promise<void>) => void) {
    this.#base = base;
    this.#onInstall = onInstall;
  }

  get system() {
    return this.#system;
  }

  async tectonic(): Promise<string | null> {
    return await findFile(
      dirOf(this.#base, "tectonic"),
      process.platform === "win32" ? "tectonic.exe" : "tectonic",
    );
  }

  /** The installed program to use for this language: pdflatex where it fits, else xelatex. */
  #systemProgram(lang: string, mixed: boolean): { program: string; family: Family } | null {
    const want = familyFor(lang, mixed);
    if (want === "pdftex" && this.#system.pdflatex)
      return { program: this.#system.pdflatex, family: "pdftex" };
    if (this.#system.xelatex) return { program: this.#system.xelatex, family: "xetex" };
    if (this.#system.pdflatex && want === "pdftex")
      return { program: this.#system.pdflatex, family: "pdftex" };
    return null;
  }

  async #runTex(program: string, isTectonic: boolean, dir: string): Promise<CompileResult> {
    const args = isTectonic
      ? ["--keep-logs", "--chatter", "minimal", "doc.tex"]
      : ["-interaction=nonstopmode", "-halt-on-error", "doc.tex"];
    // Tectonic's first compiles download the packages they need: give it longer
    const r = await run(program, args, { cwd: dir, timeoutMs: isTectonic ? 300_000 : 120_000 });
    const pdf = join(dir, "doc.pdf");
    const log = await readFile(join(dir, "doc.log"), "utf8").catch(() => r.stdout + r.stderr);
    const ok = r.code === 0 && existsSync(pdf);
    return {
      ok,
      err: ok ? "" : firstError(log + "\n" + r.stderr, "The preview could not be built."),
      pdf: existsSync(pdf) ? pdf : null,
    };
  }

  /** Does this program work for this language at all? (Checked once, on a tiny page.) */
  async #works(
    program: string,
    isTectonic: boolean,
    family: Family,
    lang: string,
    mixed: boolean,
  ): Promise<boolean> {
    const key = `${program}|${lang}|${mixed}`;
    const known = this.#tested.get(key);
    if (known !== undefined) return known;
    const dir = join(this.#base, "tex-test", String(this.#tested.size));
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "doc.tex"),
      // with an Arabic word when the page has some: the Arabic setup is tested too
      pageDocument(
        `Test $x^2 + \\frac{1}{2}$${mixed ? " تجربة" : ""}.\n\\begin{theorem}x\\end{theorem}`,
        lang,
        family,
      ),
    );
    const r = await this.#runTex(program, isTectonic, dir);
    await rm(dir, { recursive: true, force: true });
    this.#tested.set(key, r.ok);
    return r.ok;
  }

  /** Make sure Tectonic is here, downloading it once (about 22 MB). */
  async #ensureTectonic(): Promise<string> {
    const have = await this.tectonic();
    if (have) return have;
    if (!supported("tectonic"))
      throw new Error("No working LaTeX was found, and Tectonic is not available for this system.");
    if (!this.installing) {
      this.installing = install(this.#base, "tectonic", () => {}, new AbortController().signal).finally(
        () => {
          this.installing = null;
        },
      );
      this.#onInstall(this.installing);
    }
    await this.installing;
    const bin = await this.tectonic();
    if (!bin) throw new Error("Tectonic was downloaded but could not be found.");
    return bin;
  }

  /** Compile `body` as one page in `dir` (wiped first). */
  async compile(dir: string, body: string, lang: string): Promise<CompileResult> {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const mixed = arabicInLatin(body, lang);
    const sys = this.mode !== "builtin" ? this.#systemProgram(lang, mixed) : null;
    if (sys) {
      const usable =
        this.mode === "system" || (await this.#works(sys.program, false, sys.family, lang, mixed));
      if (usable) {
        await writeFile(join(dir, "doc.tex"), pageDocument(body, lang, sys.family));
        this.using = "system";
        this.detail = sys.program;
        return await this.#runTex(sys.program, false, dir);
      }
    }
    if (this.mode === "system") {
      this.using = null;
      this.detail = "No installed LaTeX was found.";
      return {
        ok: false,
        err: "No installed LaTeX was found. Choose Automatic or Built-in in Settings.",
        pdf: null,
      };
    }
    const tectonic = await this.#ensureTectonic();
    await writeFile(join(dir, "doc.tex"), pageDocument(body, lang, "xetex"));
    this.using = "tectonic";
    this.detail = sys ? `Tectonic (the installed LaTeX failed a test for ${lang})` : "Tectonic";
    return await this.#runTex(tectonic, true, dir);
  }
}
