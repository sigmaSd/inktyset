// How far a reading is from the text it should have been (the user's checked page, or a benchmark's answer), by
// what it says rather than how it is laid out. Both texts become one sequence, in page order:
//   - the math (between $…$, $$…$$, \(…\), \[…\], and each row of align*, gather… with its & gone) parsed by KaTeX
//     into MathML, then flattened with its structure kept: x^{2} and x^2 are one thing, x^{n+1} and x^n+1 two;
//     \le and \leq both ≤, \left( and ( both (, \mathbb R and \mathbb{R} one double-struck R;
//   - the text around it, as words and punctuation: the commands that frame or place it (\section*, \textbf,
//     \item, environments) left out, so a heading or a bold word counts as its words.
// A formula KaTeX can't parse counts as its raw tokens, so it differs from a right one instead of being dropped.
// What stays a choice of ours (not the parser's): that layout doesn't count (align* rows or $…$ lines, headings,
// spacing), that long and short arrows are one, that a letter is the same in text and in math.

import katex from "katex";
import { myers, type Part as DiffPart, share, tokenize } from "./diff.ts";

/** Environments whose content is math, written as rows (\\) of aligned (&) parts. */
const MATH_ENVS = new Set(
  [
    "align",
    "gather",
    "multline",
    "flalign",
    "alignat",
    "eqnarray",
    "equation",
    "displaymath",
    "math",
    "split",
  ].flatMap((e) => [e, `${e}*`]),
);

/** Labels and numbering: not what the page says. */
const UNSAID = /\\(label|tag)\*?\{[^}]*\}|\\(nonumber|notag)\b/g;

/** A page cut into text and math, in order, with where each part is in it ([start, end) of the LaTeX). */
export type Part = { math: boolean; tex: string; start: number; end: number };

/** What isn't part of what the page says, blanked with spaces (so every place in the LaTeX stays where it is). */
const blank = (latex: string) =>
  latex.replace(/(?<!\\)%.*$/gm, (m) => " ".repeat(m.length)).replace(UNSAID, (m) => " ".repeat(m.length));

/** Where the math is in a page's LaTeX (comments and labels left out). */
export function scan(latex: string): Part[] {
  const s = blank(latex);
  const parts: Part[] = [];
  let text = "",
    from = 0;
  const flush = (to: number) => {
    if (text.trim()) parts.push({ math: false, tex: text, start: from, end: to });
    text = "";
  };
  // (`opens`: where its delimiter is, so the text before it stops there and doesn't hold the $)
  const math = (tex: string, start: number, opens = start) => {
    flush(opens);
    if (tex.trim()) parts.push({ math: true, tex, start, end: start + tex.length });
  };
  const add = (t: string, at: number) => {
    if (!text) from = at;
    text += t;
  };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    if (rest.startsWith("\\\\")) {
      add(" ", i);
      i += 2;
      continue;
    }
    if (s[i] === "\\" && (rest.startsWith("\\$") || rest.startsWith("\\%") || rest.startsWith("\\&"))) {
      add(s[i + 1], i);
      i += 2;
      continue;
    }
    const delimited = (open: string, close: string) => {
      if (!rest.startsWith(open)) return false;
      const end = s.indexOf(close, i + open.length);
      if (end < 0) return false;
      math(s.slice(i + open.length, end), i + open.length, i);
      i = end + close.length;
      from = i;
      return true;
    };
    if (delimited("$$", "$$") || delimited("\\[", "\\]") || delimited("\\(", "\\)")) continue;
    if (s[i] === "$") {
      const end = closingDollar(s, i + 1);
      if (end > 0) {
        math(s.slice(i + 1, end), i + 1, i);
        i = end + 1;
        from = i;
        continue;
      }
    }
    const env = /^\\begin\{([^}]+)\}/.exec(rest);
    if (env && MATH_ENVS.has(env[1])) {
      const close = `\\end{${env[1]}}`;
      const end = s.indexOf(close, i);
      let at = i + env[0].length;
      at += /^\{[^}]*\}/.exec(s.slice(at))?.[0].length ?? 0; // (alignat's {2})
      flush(i);
      for (const row of rows(s.slice(at, end < 0 ? s.length : end))) math(row.tex, at + row.start);
      i = end < 0 ? s.length : end + close.length;
      from = i;
      continue;
    }
    add(s[i], i);
    i++;
  }
  flush(s.length);
  return parts;
}

/** The $ that closes one opened just before `from` (not an escaped \$), or -1. */
function closingDollar(s: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === "$") return j;
  }
  return -1;
}

/**
 * A math environment's rows (split at \\ and & at its own level, not inside a matrix or braces), each where it is
 * in `body` (& made a space, so a row is as long as its place).
 */
function rows(body: string): { tex: string; start: number }[] {
  const out: { tex: string; start: number }[] = [];
  let row = "",
    start = 0,
    depth = 0;
  for (let i = 0; i < body.length; i++) {
    const rest = body.slice(i);
    if (rest.startsWith("\\begin{")) depth++;
    else if (rest.startsWith("\\end{")) depth--;
    if (body[i] === "{") depth++;
    else if (body[i] === "}") depth--;
    if (depth === 0 && rest.startsWith("\\\\")) {
      out.push({ tex: row, start });
      row = "";
      i++;
      start = i + 1;
      continue;
    }
    if (depth === 0 && body[i] === "&") {
      row += " ";
      continue;
    }
    if (body[i] === "\\" && body[i + 1]) {
      row += body[i] + body[i + 1]; // \& \{ \\ inside braces: kept whole
      i++;
      continue;
    }
    row += body[i];
  }
  out.push({ tex: row, start });
  return out;
}

// ------------------------------------------------------------------------------------------------ the tokens

/** One symbol, written one way: long arrows as short ones, the minus sign as a hyphen. */
const SAME: Record<string, string> = { "⟶": "→", "⟵": "←", "⟹": "⇒", "⟸": "⇐", "⟷": "↔", "⟺": "⇔", "−": "-" };
/** MathML elements whose children are arguments (a power's base and exponent…): their grouping is kept. */
const STRUCTURE = new Set([
  "msup",
  "msub",
  "msubsup",
  "mfrac",
  "msqrt",
  "mroot",
  "mover",
  "munder",
  "munderover",
]);
const TABLE = new Set(["mtable", "mtr", "mtd"]);
const LEAF = new Set(["mi", "mn", "mo", "mtext", "ms"]);
/** Elements that only place, space or style what they hold. */
const SKIP = new Set(["mspace", "annotation"]);
const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&#x27;": "'",
};

/** Words and single symbols of some text (as the reading's other score splits it), spaces left out. */
const words = (s: string) => tokenize(s).filter((t) => !/^\s+$/u.test(t));

/** A formula as tokens: KaTeX's MathML flattened, structure kept where it means something. */
export function mathTokens(tex: string): string[] {
  const src = tex.replace(UNSAID, " ").trim();
  if (!src) return [];
  let mathml: string;
  try {
    mathml = katex.renderToString(src, {
      output: "mathml",
      throwOnError: true,
      displayMode: true,
      strict: "ignore",
    });
  } catch {
    // not LaTeX KaTeX reads: its raw tokens, so it differs from a right formula
    return words(src).map((t) => `?${t}`);
  }
  const out: string[] = [];
  const stack: { name: string; open: boolean }[] = [];
  const tag = /<(\/?)([a-z]+)([^>]*?)(\/?)>|([^<]+)/g;
  let variant = "";
  let skipping = 0;
  for (const m of mathml.matchAll(tag)) {
    const [, closing, name, attrs, selfClosing, text] = m;
    if (text !== undefined) {
      if (skipping) continue;
      const leaf = stack.at(-1)?.name;
      if (!leaf || !LEAF.has(leaf)) continue;
      const decoded = text.replace(/&[#\w]+;/g, (e) => ENTITIES[e] ?? e);
      if (leaf === "mtext") out.push(...words(decoded));
      else {
        const sym = SAME[decoded] ?? decoded;
        out.push(variant ? `${variant}:${sym}` : sym);
      }
      continue;
    }
    if (SKIP.has(name)) {
      if (selfClosing) continue;
      skipping += closing ? -1 : 1;
      continue;
    }
    if (closing) {
      const top = stack.pop();
      if (top?.open) out.push(")");
      if (LEAF.has(name)) variant = "";
      continue;
    }
    if (selfClosing) continue;
    // an argument of a power, a fraction…: grouped, so x^{n+1} isn't x^n+1
    const parent = stack.at(-1)?.name ?? "";
    const open = STRUCTURE.has(name) || TABLE.has(name) || (name === "mrow" && STRUCTURE.has(parent));
    if (open) out.push(`${name}(`);
    stack.push({ name, open });
    if (LEAF.has(name)) {
      const v = /mathvariant="([^"]+)"/.exec(attrs)?.[1] ?? "";
      variant = v === "normal" || v === "italic" ? "" : v;
    }
  }
  return out;
}

/** A word or a formula: what it says (`key`), and where it is in the LaTeX. */
interface Unit {
  key: string;
  start: number;
  end: number;
  math: boolean;
}

/**
 * Text as words and punctuation, each where it is (from `base`): the commands around them, braces and
 * environments (their names and their argument) left out; an escaped character is the character.
 */
function textUnits(tex: string, base = 0): Unit[] {
  const out: Unit[] = [];
  const t = tokenize(tex);
  let pos = 0;
  for (let i = 0; i < t.length; i++) {
    const x = t[i];
    const start = pos;
    pos += x.length;
    if (/^\s+$/u.test(x)) continue;
    if (x === "\\begin" || x === "\\end") {
      // its {name} and an optional {argument}
      for (let groups = 0; groups < 2 && t[i + 1] === "{"; groups++)
        while (i + 1 < t.length) {
          pos += t[++i].length;
          if (t[i] === "}") break;
        }
      continue;
    }
    if (
      /^\\[a-zA-Z]+\*?$/.test(x) ||
      x === "\\\\" ||
      x === "{" ||
      x === "}" ||
      x === "~" ||
      /^\\[\s,;:!]$/.test(x)
    )
      continue;
    const key = x.length === 2 && x[0] === "\\" ? x[1] : x;
    out.push({ key: SAME[key] ?? key, start: base + start, end: base + pos, math: false });
  }
  return out;
}

/** Text as words and punctuation: the commands around them, braces and environments left out. */
export function textTokens(tex: string): string[] {
  return textUnits(tex).map((u) => u.key);
}

/** A page's LaTeX as what it says, in order (see the top). */
export function pageTokens(latex: string): string[] {
  return scan(latex).flatMap((p) => (p.math ? mathTokens(p.tex) : textTokens(p.tex)));
}

/** Punctuation and bullets at a formula's edges. */
const EDGE = new Set([",", ".", ";", ":", "*", "∗", "-"]);

/** A reading against the text it should have been. */
export interface PageScore {
  /** The share of what either says that the other doesn't, layout aside: 0 the same, 1 nothing in common. */
  off: number;
  /** The formulas of the right text found, exactly, in the reading (in any order). */
  formulas: { right: number; of: number };
}

/** A formula's key: its tokens, punctuation and a bullet at its edges left out ($x,$ is $x$, and * $x$ is $* x$). */
function formulaKey(tex: string): string {
  const t = mathTokens(tex);
  while (t.length && EDGE.has(t[0])) t.shift();
  while (t.length && EDGE.has(t.at(-1)!)) t.pop();
  return t.join(" ");
}

export function scorePage(reading: string, right: string): PageScore {
  const off = share(pageTokens(reading), pageTokens(right));
  const key = (p: Part) => formulaKey(p.tex);
  const wanted = scan(right)
    .filter((p) => p.math)
    .map(key)
    .filter(Boolean);
  const found = new Map<string, number>();
  for (const k of scan(reading)
    .filter((p) => p.math)
    .map(key))
    found.set(k, (found.get(k) ?? 0) + 1);
  let hits = 0;
  for (const k of wanted) {
    const n = found.get(k) ?? 0;
    if (n > 0) {
      hits++;
      found.set(k, n - 1);
    }
  }
  return { off, formulas: { right: hits, of: wanted.length } };
}

// ------------------------------------------------------------------------------------------------ the diff

/** A page as words and formulas, each where it is. */
function units(latex: string): Unit[] {
  const s = blank(latex);
  return scan(latex).flatMap((p) =>
    p.math
      ? [{ key: `$${formulaKey(p.tex)}`, start: p.start, end: p.end, math: true }]
      : textUnits(s.slice(p.start, p.end), p.start),
  );
}

/**
 * In a stretch of LaTeX, what is only layout: spaces, $ and the other math delimiters, alignment, line breaks,
 * \left and \right, spacing, braces, and the commands that frame or place text (headings, bold, list items).
 */
const NEUTRAL =
  /^(\s+|\$|&|\\\\|\\[[\]()]|\\left|\\right|\\[,;:! ]|\\quad|\\qquad|\\displaystyle|\{|\}|\\(section|subsection|subsubsection|paragraph)\*?|\\(textbf|textit|emph|item|noindent|hline))$/;
/** One symbol, however it is written. */
const SYMBOL: Record<string, string> = {
  "\\to": "→",
  "\\rightarrow": "→",
  "\\longrightarrow": "→",
  "\\Rightarrow": "⇒",
  "\\Longrightarrow": "⇒",
  "\\implies": "⇒",
  "\\le": "≤",
  "\\leq": "≤",
  "\\ge": "≥",
  "\\geq": "≥",
  "\\ne": "≠",
  "\\neq": "≠",
  "\\ldots": "…",
  "\\dots": "…",
  "\\lbrace": "{",
  "\\rbrace": "}",
};

/** Which of a stretch's tokens are layout (NEUTRAL, and \begin{…} and \end{…} with their names). */
function layoutOf(t: string[]): boolean[] {
  const out = t.map((x) => NEUTRAL.test(x));
  for (let i = 0; i < t.length; i++)
    if ((t[i] === "\\begin" || t[i] === "\\end") && t[i + 1] === "{") {
      out[i] = true;
      for (let j = i + 1; j < t.length; j++) {
        out[j] = true;
        if (t[j] === "}") break;
      }
    }
  return out;
}

/**
 * Two ways of writing the same stretch, symbol by symbol, its layout never marked: the reading's shown as it is,
 * the right one's symbols it lacks marked removed, its own that differ marked added.
 */
function symbolDiff(right: string, reading: string): DiffPart[] {
  const ta = tokenize(right);
  const la = layoutOf(ta);
  const a = ta.filter((_, i) => !la[i]);
  // (whether a symbol of the right one had a space before it: removed ones are shown spaced as they were)
  const spaced = ta.flatMap((t, i) => (la[i] ? [] : [i > 0 && /^\s+$/u.test(ta[i - 1])]));
  const b = tokenize(reading);
  const lb = layoutOf(b);
  const kept = b.map((t, i) => [t, i] as const).filter(([, i]) => !lb[i]);
  const key = (t: string) => SYMBOL[t] ?? t;
  const out: DiffPart[] = [];
  const emit = (op: DiffPart["op"], text: string) => {
    const last = out.at(-1);
    if (last?.op === op) last.text += text;
    else out.push({ op, text });
  };
  let next = 0, // the reading's next token to write
    j = 0, // its next symbol (not layout)
    ia = 0; // the right one's next symbol
  const upTo = (i: number) => {
    for (; next < i; next++) emit("same", b[next]);
  };
  for (const [op] of myers(
    a.map(key),
    kept.map(([t]) => key(t)),
  )) {
    if (op === "del") {
      emit("del", (out.at(-1)?.op === "del" && spaced[ia] ? " " : "") + a[ia]);
      ia++;
      continue;
    }
    if (op === "same") ia++;
    const i = kept[j++][1];
    upTo(i);
    emit(op, b[i]);
    next = i + 1;
  }
  upTo(b.length);
  return out;
}

/**
 * What differs between a reading and the text it should have been, as the score counts it (scorePage): the
 * reading in its own layout, with only the words and formulas that say something else marked (removed: the
 * right text's, added: the reading's). Layout alone (\left( or (, $…$ lines or align*, a heading's command)
 * isn't marked; in a formula that differs, its symbols are.
 */
export function meaningDiff(right: string, reading: string): DiffPart[] {
  const a = units(right),
    b = units(reading);
  const out: DiffPart[] = [];
  const emit = (op: DiffPart["op"], text: string) => {
    if (!text) return;
    const last = out.at(-1);
    if (last?.op === op) last.text += text;
    else out.push({ op, text });
  };
  let ia = 0,
    ib = 0,
    cursor = 0; // in the reading: what is written out so far
  const ops = myers(
    a.map((u) => u.key),
    b.map((u) => u.key),
  ).map(([op]) => op);
  for (let k = 0; k < ops.length;) {
    if (ops[k] === "same") {
      const u = b[ib++];
      ia++;
      emit("same", reading.slice(cursor, u.end));
      cursor = u.end;
      k++;
      continue;
    }
    // a run of changes: what the right text has there, what the reading has
    const gone: Unit[] = [],
      came: Unit[] = [];
    for (; k < ops.length && ops[k] !== "same"; k++)
      if (ops[k] === "del") gone.push(a[ia++]);
      else came.push(b[ib++]);
    // written otherwise there (formulas, words): compared symbol by symbol, the layout between them aside
    if (gone.length && came.length) {
      emit("same", reading.slice(cursor, came[0].start));
      const was = right.slice(gone[0].start, gone.at(-1)!.end);
      for (const d of symbolDiff(was, reading.slice(came[0].start, came.at(-1)!.end))) emit(d.op, d.text);
      cursor = came.at(-1)!.end;
      continue;
    }
    // what the right text has there, removed, just before what the reading has next (after the layout between)
    const at = came[0]?.start ?? b[ib]?.start ?? reading.length;
    emit("same", reading.slice(cursor, at));
    cursor = at;
    if (gone.length) emit("del", `${right.slice(gone[0].start, gone.at(-1)!.end)} `);
    for (const u of came) {
      emit("same", reading.slice(cursor, u.start));
      emit("add", reading.slice(u.start, u.end));
      cursor = u.end;
    }
  }
  emit("same", reading.slice(cursor));
  return out;
}
