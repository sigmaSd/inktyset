// Mixed scripts in one page (French with Arabic words, Arabic with French terms): XeLaTeX needs each passage in
// the other script marked (\textarabic{…}, \textenglish{…}) or it comes out broken. Detecting it is reliable:
// Arabic letters have their own Unicode blocks, so this is no guess about the language. Only the LaTeX
// preview and the saved .tex document are marked; the page's own text (what you edit and copy) stays as it is.
// Typst needs none of this: it handles right-to-left runs by itself.

/** Arabic script: Arabic, Supplement, Extended-A, Presentation Forms A and B (Persian, Urdu… letters too). */
const ARABIC = "\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF";
/** Latin letters, with accents (French, German, Turkish…). */
const LATIN = "A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F";

const ARABIC_RE = new RegExp(`[${ARABIC}]`, "u");

export const isArabicLang = (lang: string) => (lang || "").trim().toLowerCase() === "arabic";

/** Arabic letters in a page whose main language is written in Latin letters: it needs XeTeX and marking. */
export const arabicInLatin = (body: string, lang: string) => !isArabicLang(lang) && ARABIC_RE.test(body);

/** Command arguments that are names, not text: never marked (\label{eq1} must stay \label{eq1}). */
const NAME_ARGS = new Set([
  "label",
  "ref",
  "eqref",
  "cite",
  "url",
  "href",
  "includegraphics",
  "input",
  "hspace",
  "vspace",
]);
const MATH_ENV = /^(align|equation|gather|multline|displaymath|eqnarray|math)\*?$/;

/**
 * A run of the other script: from its first letter to its last, with the spaces, digits and punctuation in
 * between ("سنة 2024" stays one run), never across a letter of the main script, a blank line or a bracket:
 * "Banach (espace complet)" is two runs with the brackets between them, never one bracket in and one out.
 */
function runPattern(target: string, other: string) {
  return new RegExp(`[${target}](?:(?:[^${other}\\n()\\[\\]]|\\n(?!\\s*\\n))*[${target}])?`, "gu");
}
const ARABIC_RUNS = runPattern(ARABIC, LATIN);
const LATIN_RUNS = runPattern(LATIN, ARABIC);

function wrapRuns(text: string, mainArabic: boolean): string {
  return mainArabic
    ? text.replace(LATIN_RUNS, (run) => `\\textenglish{${run}}`)
    : text.replace(ARABIC_RUNS, (run) => `\\textarabic{${run}}`);
}

/** The end of a {…} or […] group starting at `i`, or -1. */
function groupEnd(s: string, i: number, open: string, close: string): number {
  if (s[i] !== open) return -1;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "\\") {
      j++;
      continue;
    }
    if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return j + 1;
  }
  return -1;
}

/**
 * Mark the passages in the other script: Arabic ones in a Latin-script page, Latin ones in an Arabic page.
 * Math, comments, command names and name-like arguments are copied untouched.
 */
export function markScripts(body: string, mainArabic: boolean): string {
  let out = "",
    buf = "",
    i = 0;
  const flush = () => {
    out += wrapRuns(buf, mainArabic);
    buf = "";
  };
  const copyTo = (end: number) => {
    flush();
    out += body.slice(i, end);
    i = end;
  };
  while (i < body.length) {
    const c = body[i];
    const rest = body.slice(i);
    if (c === "%") {
      const nl = body.indexOf("\n", i);
      copyTo(nl < 0 ? body.length : nl);
    } else if (rest.startsWith("$$")) {
      const end = body.indexOf("$$", i + 2);
      copyTo(end < 0 ? body.length : end + 2);
    } else if (c === "$") {
      let j = i + 1;
      while (j < body.length && body[j] !== "$") j += body[j] === "\\" ? 2 : 1;
      copyTo(Math.min(j + 1, body.length));
    } else if (rest.startsWith("\\[") || rest.startsWith("\\(")) {
      const close = rest[1] === "[" ? "\\]" : "\\)";
      const end = body.indexOf(close, i + 2);
      copyTo(end < 0 ? body.length : end + 2);
    } else if (c === "\\") {
      const m = /^\\([a-zA-Z]+\*?|.)/.exec(rest)!;
      const name = m[1];
      const env = name === "begin" ? /^\\begin\{([^}]+)\}/.exec(rest) : null;
      if (env && MATH_ENV.test(env[1])) {
        const close = `\\end{${env[1]}}`;
        const end = body.indexOf(close, i);
        copyTo(end < 0 ? body.length : end + close.length);
      } else if (env || name === "end") {
        const end = groupEnd(body, i + m[0].length, "{", "}");
        copyTo(end < 0 ? i + m[0].length : end);
      } else if (NAME_ARGS.has(name)) {
        let end = i + m[0].length;
        const opt = groupEnd(body, end, "[", "]");
        if (opt > 0) end = opt;
        const arg = groupEnd(body, end, "{", "}");
        copyTo(arg > 0 ? arg : end);
      } else {
        copyTo(i + m[0].length); // the command name; its arguments are text, marked like the rest
      }
    } else if (c === "{" || c === "}") {
      copyTo(i + 1); // a run never crosses a group's edge
    } else {
      buf += c;
      i++;
    }
  }
  flush();
  return out;
}
