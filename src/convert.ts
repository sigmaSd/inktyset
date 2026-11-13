// LaTeX → Typst, for Typst output. The model reads pages in LaTeX (it knows LaTeX far better than Typst: asked
// for Typst it mixed in \frac and \left), and this turns that LaTeX into Typst, deterministically: nothing is
// re-read or guessed. The math goes through tex2typst; the structure the model uses (headings, theorem-like
// environments, lists, tables, bold and italic) is converted here, and the rest of the text is escaped for Typst.

import { tex2typst } from "tex2typst";

/** Our LaTeX preamble's shortcuts (pipeline.ts): tex2typst doesn't know them. */
const SHORTCUTS: [RegExp, string][] = ["R", "N", "Z", "Q", "C"].map((l) => [
  new RegExp(`\\\\${l}(?![a-zA-Z])`, "g"),
  `\\mathbb{${l}}`,
]);

/** [??] (what the model couldn't read) stays [??] in Typst math, as a quoted string. */
function math(tex: string): string {
  let s = tex.replace(/\\textbf\{\[\?\?\]\}/g, "[??]").replace(/\[\?\?\]/g, "\\text{[??]}");
  for (const [re, to] of SHORTCUTS) s = s.replace(re, to);
  try {
    return tex2typst(s.trim());
  } catch {
    return `"${tex.trim().replace(/["\\]/g, "\\$&")}"`; // not convertible: shown as written, to fix by hand
  }
}

const THEOREMS = ["theorem", "lemma", "proposition", "corollary", "definition", "remark", "example", "proof"];
const DISPLAY = ["align*", "align", "equation*", "equation", "gather*", "gather", "multline*", "displaymath"];

/** Characters with a meaning in Typst markup, escaped in ordinary text. */
function escapeText(s: string): string {
  return s.replace(/[#*_@<`]/g, "\\$&");
}

/** The content of a {…} group starting at `i` (at the "{"), and where it ends. */
function group(s: string, i: number): [string, number] | null {
  if (s[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "\\") {
      j++;
      continue;
    }
    if (s[j] === "{") depth++;
    else if (s[j] === "}" && --depth === 0) return [s.slice(i + 1, j), j + 1];
  }
  return null;
}

/** Text with inline LaTeX markup (no math in it) → Typst markup. */
function text(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "%" && s[i - 1] !== "\\") {
      const end = s.indexOf("\n", i);
      out += "//" + s.slice(i + 1, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end;
      continue;
    }
    if (c === "~") {
      out += " ";
      i++;
      continue;
    }
    if (c !== "\\") {
      out += escapeText(c);
      i++;
      continue;
    }
    // a command
    const m = /^\\([a-zA-Z]+\*?|.)/.exec(s.slice(i));
    if (!m) {
      i++;
      continue;
    }
    const name = m[1];
    i += m[0].length;
    if (name === "\\") {
      out += " \\\n"; // line break
      if (s[i] === "\n") i++;
      continue;
    }
    if ("%&$#_{}".includes(name)) {
      out += name === "%" || name === "&" || name === "{" || name === "}" ? name : "\\" + name;
      continue;
    }
    if (name === "," || name === ";" || name === " " || name === "quad" || name === "qquad") {
      out += " ";
      continue;
    }
    const arg = group(s, i);
    const wrap: Record<string, (x: string) => string> = {
      textbf: (x) => (/^\[(\?\?|FIGURE:.*)\]$/s.test(x) ? x : `*${text(x)}*`),
      textit: (x) => `_${text(x)}_`,
      emph: (x) => `_${text(x)}_`,
      underline: (x) => `#underline[${text(x)}]`,
      texttt: (x) => "`" + x + "`",
      textrm: (x) => text(x),
      text: (x) => text(x),
      mbox: (x) => text(x),
    };
    if (wrap[name] && arg) {
      out += wrap[name](arg[0]);
      i = arg[1];
    } else if (["label", "index", "vspace", "hspace"].includes(name) && arg) {
      i = arg[1]; // names and spacing, not text: dropped (a Typst label couldn't go on plain text anyway)
    } else if (["noindent", "medskip", "bigskip", "smallskip", "par", "newline", "indent"].includes(name)) {
      out += name === "newline" ? " \\\n" : name.endsWith("skip") ? "\n" : "";
    } else if (arg) {
      out += text(arg[0]); // a command we don't know: its text, without the command
      i = arg[1];
    }
  }
  return out;
}

/** A tabular's rows → #table(…). */
function table(spec: string, body: string): string {
  const columns = (spec.match(/[lcrpXmb]/g) ?? ["l"]).length;
  const cells: string[] = [];
  for (const row of body.split(/\\\\/)) {
    const clean = row.replace(/\\(hline|toprule|midrule|bottomrule)/g, "").trim();
    if (!clean) continue;
    for (const cell of clean.split(/(?<!\\)&/)) cells.push(`[${convertInline(cell.trim())}]`);
  }
  return `#table(columns: ${columns}, ${cells.join(", ")})`;
}

/** Text that may hold inline math ($…$, \(…\)). */
function convertInline(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    let m: RegExpExecArray | null;
    if ((m = /^\$((?:\\.|[^$])+)\$/.exec(s.slice(i))) || (m = /^\\\(([\s\S]+?)\\\)/.exec(s.slice(i)))) {
      out += `$${math(m[1])}$`;
      i += m[0].length;
      continue;
    }
    const next = s.slice(i).search(/\$|\\\(/);
    const end = next <= 0 ? (next === 0 ? i + 1 : s.length) : i + next;
    out += text(s.slice(i, end));
    i = end;
  }
  return out;
}

export function latexToTypst(body: string): string {
  const lists: ("itemize" | "enumerate")[] = [];
  let out = "";
  let i = 0;
  const rest = () => body.slice(i);
  while (i < body.length) {
    let m: RegExpExecArray | null;
    // display math: $$…$$, \[…\], and the display environments
    if ((m = /^\$\$([\s\S]+?)\$\$/.exec(rest())) || (m = /^\\\[([\s\S]+?)\\\]/.exec(rest()))) {
      out += `$ ${math(m[1])} $`;
      i += m[0].length;
      continue;
    }
    if ((m = /^\\begin\{([a-z]+\*?)\}/.exec(rest()))) {
      const env = m[1];
      if (DISPLAY.includes(env)) {
        const close = `\\end{${env}}`;
        const end = body.indexOf(close, i);
        const inner = body.slice(i + m[0].length, end < 0 ? body.length : end);
        const aligned = env.startsWith("align") ? `\\begin{aligned}${inner}\\end{aligned}` : inner;
        out += `$ ${math(aligned)} $`;
        i = end < 0 ? body.length : end + close.length;
        continue;
      }
      if (env === "tabular") {
        const spec = group(body, i + m[0].length);
        const from = spec ? spec[1] : i + m[0].length;
        const end = body.indexOf("\\end{tabular}", from);
        out += table(spec?.[0] ?? "l", body.slice(from, end < 0 ? body.length : end));
        i = end < 0 ? body.length : end + "\\end{tabular}".length;
        continue;
      }
      i += m[0].length;
      if (THEOREMS.includes(env)) {
        const title = /^\[([^\]]*)\]/.exec(rest());
        out += `#${env}[`;
        if (title) {
          out += `*(${text(title[1])})* `;
          i += title[0].length;
        }
      } else if (env === "itemize" || env === "enumerate") lists.push(env);
      // other environments (center, …): their content only
      continue;
    }
    if ((m = /^\\end\{([a-z]+\*?)\}/.exec(rest()))) {
      if (THEOREMS.includes(m[1])) out += "]";
      else if (m[1] === "itemize" || m[1] === "enumerate") lists.pop();
      i += m[0].length;
      continue;
    }
    if ((m = /^\\item\s*/.exec(rest())) && lists.length) {
      if (out && !out.endsWith("\n")) out += "\n";
      out += "  ".repeat(lists.length - 1) + (lists.at(-1) === "enumerate" ? "+ " : "- ");
      i += m[0].length;
      continue;
    }
    if ((m = /^\\(sub)*section\*?/.exec(rest()))) {
      const level = 1 + (m[0].match(/sub/g)?.length ?? 0);
      const title = group(body, i + m[0].length);
      if (title) {
        out += `${"=".repeat(level)} ${convertInline(title[0])}`;
        i = title[1];
        continue;
      }
    }
    // up to the next structure: ordinary text with inline math
    const next = rest()
      .slice(1)
      .search(/\$\$|\\\[|\\begin\{|\\end\{|\\item\b|\\(?:sub)*section\b/);
    const end = next < 0 ? body.length : i + 1 + next;
    out += convertInline(body.slice(i, end));
    i = end;
  }
  return out.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
