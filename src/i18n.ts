// The app's own language, apart from the pages' writing language (pipeline.ts). The English text lives in
// the code: here the core's and the shell's messages (errors, page names, notifications, the right-click
// menu), in app/ui/i18n.ts the window's. Other languages are gettext catalogs, locales/app/<code>.po, that
// translators edit with Poedit or on Weblate; tools/i18n.ts keeps locales/app/inktyset.pot and them up to
// date. Each entry's key is its msgctxt. Nothing here touches the disk: src/locales.ts loads the catalogs.

import { pluralRule, type Translations } from "./po.ts";

/** An English entry: a sentence with {names}, or a sentence per count ({n}). */
export type Source = string | { one: string; other: string };
type Vars = Record<string, unknown>;

/** The language to use: the setting, or with "auto" the computer's first preferred one we have. */
export function resolveLang(
  setting: string | undefined,
  systemLocales: readonly string[],
  available: string[],
) {
  if (setting && available.includes(setting)) return setting;
  for (const l of systemLocales) {
    const full = l.replace("_", "-");
    if (available.includes(full)) return full;
    const base = full.toLowerCase().split("-")[0];
    if (available.includes(base)) return base;
  }
  return "en";
}

/** Right-to-left languages among those Inktyset could be translated to. */
export const isRtlLang = (lang: string) =>
  ["ar", "fa", "he", "ur", "ps", "ckb", "yi"].includes(lang.split("-")[0]);

/** A language's name in itself ("Français", "العربية"), for the language menu. */
export function nativeName(code: string): string {
  try {
    const n = new Intl.DisplayNames([code], { type: "language" }).of(code);
    if (n && n !== code) return n[0].toLocaleUpperCase(code) + n.slice(1);
  } catch {
    /* an unknown code: shown as it is */
  }
  return code;
}

/** French typography: a no-break space before : ; ? ! and inside « », so they never start a line. */
export function typography(lang: string, s: string): string {
  if (!lang.startsWith("fr")) return s;
  return s.replace(/ ([:;?!»])/g, " $1").replace(/« /g, "« ");
}

/** Fill {name} placeholders. */
export function fill(s: string, vars: Vars = {}): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/**
 * Looks words up: the language's catalog, else the English source. A translation with < > or " in it is
 * ignored (it would be markup in the window: catalogs come from contributors); tests/i18n.test.ts keeps the
 * shipped ones clean.
 */
export class Translator {
  readonly lang: string;
  readonly #source: Record<string, Source>;
  readonly #strings: Record<string, string | string[]>;
  readonly #pick: (n: number) => number;

  constructor(lang: string, source: Record<string, Source>, tr: Translations | null) {
    this.lang = lang;
    this.#source = source;
    this.#strings = tr?.strings ?? {};
    this.#pick = pluralRule(tr?.plural).pick;
  }

  t(key: string, vars: Vars = {}): string {
    const src = this.#source[key];
    if (src === undefined) return key;
    const tr = this.#strings[key];
    let s: string | undefined;
    if (typeof src === "string") s = typeof tr === "string" ? tr : undefined;
    else if (Array.isArray(tr)) s = tr[this.#pick(Number(vars.n))];
    if (!s || /[<>"]/.test(s)) s = typeof src === "string" ? src : Number(vars.n) === 1 ? src.one : src.other;
    return typography(this.lang, fill(s, vars));
  }
}

/** The core's and the shell's messages, in English. */
export const CORE_SOURCE = {
  scanLabel: "Scan {time}",
  phoneLabel: "Phone photo {name}",
  pagesFolderTitle: "Folder for your pages",
  folderUnavailable: "Your pages folder {p} could not be opened ({e}); Inktyset is using {d} for now.",
  modelFolderTitle: "Folder with Qwen3.5-9B-Q4_K_M.gguf and mmproj-F16.gguf",
  notPicture: "This file could not be opened as a picture or PDF ({error}).",
  previewFailed: "The preview could not be built.",
  noLatexAtAll: "No working LaTeX was found, and Tectonic is not available for this system.",
  tectonicMissing: "Tectonic was downloaded but could not be found.",
  noInstalledLatex: "No installed LaTeX was found.",
  noInstalledLatexHelp: "No installed LaTeX was found. Choose Automatic or Built-in in Settings.",
  tectonicFallback: "Tectonic (the installed LaTeX failed a test for {lang})",
  noTypst: "Typst is not installed, and no Typst download exists for this system.",
  typstMissing: "Typst was downloaded but could not be found.",
  damaged: "The download of {file} was damaged. Try again.",
  unpackFailed: "Could not unpack {file}: {error}",
  downloadStopped: "Download stopped.",
  downloadFailed: "Download of {file} failed: {error}",
  scannerNoAnswer: "The scanner did not respond: {error}",
  scanFailed: "scan failed",
  notDownloaded: "The engine or the model is not downloaded yet.",
  modelStoppedCode: "The model stopped (code {code}). See engine.log.",
  modelTimeout: "The model did not load in time.",
  engineAnswered: "The engine answered {status}: {text}",
  finishing: {
    one: "Finishing {n} page in the background. Open Inktyset to watch.",
    other: "Finishing {n} pages in the background. Open Inktyset to watch.",
  },
  allDone: "All pages are done.",
  couldNotStart: "Inktyset could not start: {error}",
  notAnAddress: "“{url}” is not an address (it starts with http:// or https://).",
  hostNotFound: "{host} could not be found on the network.",
  notLocal:
    "{host} is not on this computer or the local network. Inktyset only uses models on your own machines: your pages never leave them.",
  modelFileMissing: "The model file is not there any more: {file}",
  serverNoAnswer: "The model server at {url} did not answer: {error}",
  noModelOnServer: "The model server at {url} has no model loaded.",
  modelWrongSize: "{file} is missing or has the wrong size in that folder.",
  modelWrongSum: "{file} in that folder is not the expected file (checksum differs).",
  chooseModelFile: "The model (.gguf)",
  chooseMmprojFile: "The model's vision file (mmproj .gguf)",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  selectAll: "Select all",
} satisfies Record<string, Source>;

export type MessageKey = keyof typeof CORE_SOURCE;

let core = new Translator("en", CORE_SOURCE, null);
/** The core's language and catalog (src/locales.ts, Core.#applySettings). */
export function setCoreLanguage(lang: string, tr: Translations | null) {
  core = new Translator(lang, CORE_SOURCE, tr);
}
export const currentLang = () => core.lang;

/** A core or shell message in the app's language. */
export const msg = (key: MessageKey, vars: Vars = {}) => core.t(key, vars);
