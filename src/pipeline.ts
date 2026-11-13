// What the model is asked, how its answer is cleaned, and the LaTeX around a page for the preview.
// (Ported from the first, Python version: hand2tex.py.)

// Math first (docs/scope.md): the math rules lead; other handwriting (prose, notes, lists, tables) is read too.
export const PROMPT = String.raw`Transcribe this handwritten page into LaTeX body content. It is usually mathematics, but it may also be prose, notes, lists or tables.
Rules:
- Transcribe exactly what is written. Do NOT fix, complete, simplify or add steps, even if the math looks wrong. Do not correct spelling either.
- Ordinary text stays plain text: no $...$ around words. Use $...$ only for mathematics.
- Lists: itemize or enumerate. Tables: tabular.
- Use \begin{theorem}, \begin{lemma}, \begin{proposition}, \begin{corollary}, \begin{definition}, \begin{remark}, \begin{example}, \begin{proof} where the page clearly uses them.
- Use \section*/\subsection* for headings, align* for multi-line computations, $...$ for inline math.
- If a symbol or word is illegible, write \textbf{[??]} in its place. Never guess silently.
- Crossed-out text: omit it.
- Diagrams/figures: write \textbf{[FIGURE: short description]}.
- Output ONLY the LaTeX body. No preamble, no \documentclass, no \begin{document}, no markdown fences, no comments to me.`;

/** The languages offered by name; any other name only changes what the model is told. */
export const LANGS: Record<string, { name: string; polyglossia: string; babel?: string }> = {
  english: { name: "English", polyglossia: "english" },
  french: { name: "French", polyglossia: "french", babel: "french" },
  arabic: { name: "Arabic", polyglossia: "arabic" },
  german: { name: "German", polyglossia: "german" },
  spanish: { name: "Spanish", polyglossia: "spanish" },
  italian: { name: "Italian", polyglossia: "italian" },
  portuguese: { name: "Portuguese", polyglossia: "portuguese" },
  turkish: { name: "Turkish", polyglossia: "turkish" },
};

/** Arabic fonts XeTeX can use, best first (Amiri ships with TeX Live and Tectonic; variable fonts crash it). */
const ARABIC_FONTS = ["Amiri", "Amiri-Regular.ttf", "PakType Naskh Basic", "Droid Arabic Kufi", "Vazirmatn"];

export function langInfo(lang: string) {
  const key = (lang || "english").trim().toLowerCase();
  return LANGS[key] ?? { name: lang.trim(), polyglossia: "" };
}

export function langPrompt(lang: string): string {
  const { name } = langInfo(lang);
  if (name === "English") return "";
  return (
    `\n- The prose is in ${name}: keep it in ${name} exactly as written (same script, accents and spelling). ` +
    "Do not translate it."
  );
}

/** pdfTeX (pdflatex) or XeTeX (xelatex, Tectonic): they need different font and language setups. */
export type Family = "pdftex" | "xetex";

/** pdflatex is kept where it works (English, French: what most theses use); the rest needs XeTeX. */
export function familyFor(lang: string): Family {
  const key = (lang || "english").trim().toLowerCase();
  return key === "english" || key === "french" || !LANGS[key] ? "pdftex" : "xetex";
}

// Every package before the language setup: right-to-left languages load bidi, which must come last
// (it fails after amsmath's "\leqno" and after the color package otherwise).
const PACKAGES = String.raw`\usepackage{amsmath,amssymb,amsthm,mathtools}
\usepackage[margin=2.5cm]{geometry}
\usepackage{xcolor}
\IfFileExists{tikz-cd.sty}{\usepackage{tikz-cd}}{}
\IfFileExists{enumitem.sty}{\usepackage{enumitem}}{}
`;

const DEFINITIONS = String.raw`\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\newtheorem{proposition}[theorem]{Proposition}
\newtheorem{corollary}[theorem]{Corollary}
\theoremstyle{definition}
\newtheorem{definition}[theorem]{Definition}
\newtheorem{example}[theorem]{Example}
\theoremstyle{remark}
\newtheorem{remark}[theorem]{Remark}
% common shortcuts models like to use
\providecommand{\R}{\mathbb{R}}\providecommand{\N}{\mathbb{N}}
\providecommand{\Z}{\mathbb{Z}}\providecommand{\Q}{\mathbb{Q}}
\providecommand{\C}{\mathbb{C}}
`;

export function preamble(lang: string, family: Family): string {
  const info = langInfo(lang);
  let setup: string;
  if (family === "pdftex") {
    setup = "\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\usepackage{lmodern}\n" + PACKAGES;
    if (info.babel) setup += `\\usepackage[${info.babel}]{babel}\n`;
  } else {
    setup = "\\usepackage{fontspec}\n" + PACKAGES;
    if (info.polyglossia && info.polyglossia !== "english") {
      setup += `\\usepackage{polyglossia}\n\\setmainlanguage{${info.polyglossia}}\n\\setotherlanguage{english}\n`;
      if (info.polyglossia === "arabic") {
        setup +=
          ARABIC_FONTS.map(
            (f) => `\\IfFontExistsTF{${f}}{\\newfontfamily\\arabicfont[Script=Arabic]{${f}}}{`,
          ).join("") +
          "}".repeat(ARABIC_FONTS.length) +
          "\n";
      }
    }
  }
  return `\\documentclass[11pt,a4paper]{article}\n${setup}${DEFINITIONS}`;
}

/** The model's answer → the page's LaTeX body. */
export function cleanLatex(t: string): string {
  t = t.replace(/<think>[\s\S]*?<\/think>/g, "");
  t = t.replace(/^\s*```(?:latex|tex)?\s*\n/, "").replace(/\n\s*```\s*$/, "");
  // if the model wrote a whole document anyway, keep only the body
  const m = /\\begin\{document\}([\s\S]*?)(\\end\{document\}|$)/.exec(t);
  if (m) t = m[1];
  t = t.replace(/^\s*\\documentclass.*$|^\s*\\usepackage.*$/gm, "");
  return t.trim() + "\n";
}

/** One page, alone: no page number, since its preview is cropped to the content. */
export function pageDocument(body: string, lang: string, family: Family): string {
  return `${preamble(lang, family)}\\pagestyle{empty}\n\\begin{document}\n${body}\n\\end{document}\n`;
}

/** Every finished page in one file, each on its own page. */
export function fullDocument(bodies: string[], lang: string): string {
  const pages = bodies.map((b, i) => `% ---- page ${i + 1}\n${b.trim()}\n`).join("\\clearpage\n");
  return `${preamble(lang, familyFor(lang))}\\begin{document}\n\n${pages}\n\\end{document}\n`;
}

/** What "Copy all LaTeX" copies: the bodies only, to paste into your own document. */
export function allBodies(bodies: string[]): string {
  return bodies.map((b, i) => `% ---- page ${i + 1}\n${b.trim()}\n`).join("\n");
}
