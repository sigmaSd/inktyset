// The LaTeX editor of the Compare view (CodeMirror 6): highlighting, matching and auto-closed brackets, the
// model's [??] marks in orange, search (Ctrl+F), undo, and completion of LaTeX commands and environments.
// main.js creates one for the Compare view and one per page card in the list (only while the card is near
// the visible area, so hundreds of pages stay light).

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  type Completion,
  type CompletionContext,
  completionKeymap,
  snippetCompletion,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Annotation, EditorSelection, EditorState, Prec } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  MatchDecorator,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/** A change made by hand2tex (a page loaded), not by typing: not saved back. */
const external = Annotation.define<boolean>();

/** Colours from style.css (--hl-*), so they follow light and dark mode. */
const highlight = HighlightStyle.define([
  { tag: t.tagName, color: "var(--hl-command)" },
  { tag: t.keyword, color: "var(--hl-math)", fontWeight: "600" },
  { tag: t.atom, color: "var(--hl-env)" },
  { tag: t.special(t.variableName), color: "var(--hl-env)" },
  { tag: t.bracket, color: "var(--hl-bracket)" },
  { tag: t.number, color: "var(--hl-number)" },
  { tag: t.comment, color: "var(--muted)", fontStyle: "italic" },
  { tag: t.invalid, color: "var(--bad)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", background: "var(--surface-2)", color: "var(--ink)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--ink)", padding: "10px 0" },
  ".cm-line": { padding: "0 12px" },
  ".cm-activeLine": { background: "color-mix(in srgb, var(--accent) 7%, transparent)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--ink)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    background: "color-mix(in srgb, var(--accent) 28%, transparent) !important",
  },
  ".cm-matchingBracket": { background: "color-mix(in srgb, var(--ok) 30%, transparent)", outline: "none" },
  ".cm-nonmatchingBracket": { background: "color-mix(in srgb, var(--bad) 30%, transparent)" },
  ".cm-unclear": {
    background: "var(--warn-soft)",
    color: "var(--warn)",
    fontWeight: "700",
    borderRadius: "3px",
  },
  ".cm-placeholder": { color: "var(--muted)" },
  ".cm-tooltip": { background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "8px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    background: "var(--accent)",
    color: "var(--accent-ink)",
  },
  ".cm-completionDetail": { color: "var(--muted)", fontStyle: "normal", marginLeft: "8px" },
  ".cm-panels": { background: "var(--surface)", color: "var(--ink)", borderColor: "var(--line)" },
  ".cm-panel input, .cm-panel button": { font: "inherit", color: "var(--ink)" },
  ".cm-searchMatch": { background: "var(--warn-soft)" },
});

/** The model's [??]: what it could not read, to fix first. */
const unclear = ViewPlugin.fromClass(
  class {
    decorations;
    readonly #m = new MatchDecorator({
      regexp: /\[\?\?\]/g,
      decoration: Decoration.mark({ class: "cm-unclear" }),
    });
    constructor(view: EditorView) {
      this.decorations = this.#m.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = this.#m.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

// ------------------------------------------------------------------ completion

const cmd = (name: string, detail: string, template?: string): Completion =>
  template
    ? snippetCompletion(template, { label: name, detail, type: "function" })
    : { label: name, detail, type: "keyword" };

const GREEK = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "varepsilon",
  "zeta",
  "eta",
  "theta",
  "vartheta",
  "iota",
  "kappa",
  "lambda",
  "mu",
  "nu",
  "xi",
  "pi",
  "rho",
  "sigma",
  "tau",
  "upsilon",
  "phi",
  "varphi",
  "chi",
  "psi",
  "omega",
  "Gamma",
  "Delta",
  "Theta",
  "Lambda",
  "Xi",
  "Pi",
  "Sigma",
  "Phi",
  "Psi",
  "Omega",
];

const COMMANDS: Completion[] = [
  cmd("\\frac", "fraction", "\\frac{${num}}{${den}}"),
  cmd("\\dfrac", "display fraction", "\\dfrac{${num}}{${den}}"),
  cmd("\\sqrt", "root", "\\sqrt{${}}"),
  cmd("\\sum", "sum", "\\sum_{${i=1}}^{${n}}"),
  cmd("\\prod", "product", "\\prod_{${i=1}}^{${n}}"),
  cmd("\\int", "integral", "\\int_{${a}}^{${b}}"),
  cmd("\\iint", "double integral"),
  cmd("\\oint", "contour integral"),
  cmd("\\lim", "limit", "\\lim_{${x \\to \\infty}}"),
  cmd("\\left(", "sized ( )", "\\left( ${} \\right)"),
  cmd("\\left[", "sized [ ]", "\\left[ ${} \\right]"),
  cmd("\\left\\{", "sized { }", "\\left\\{ ${} \\right\\}"),
  cmd("\\left|", "sized | |", "\\left| ${} \\right|"),
  cmd("\\mathbb", "blackboard", "\\mathbb{${R}}"),
  cmd("\\mathcal", "calligraphic", "\\mathcal{${}}"),
  cmd("\\mathrm", "upright", "\\mathrm{${}}"),
  cmd("\\mathbf", "bold", "\\mathbf{${}}"),
  cmd("\\operatorname", "operator", "\\operatorname{${}}"),
  cmd("\\text", "text in math", "\\text{${}}"),
  cmd("\\textbf", "bold text", "\\textbf{${}}"),
  cmd("\\emph", "emphasis", "\\emph{${}}"),
  cmd("\\section*", "heading", "\\section*{${}}"),
  cmd("\\subsection*", "subheading", "\\subsection*{${}}"),
  cmd("\\binom", "binomial", "\\binom{${n}}{${k}}"),
  cmd("\\hat", "hat", "\\hat{${}}"),
  cmd("\\bar", "bar", "\\bar{${}}"),
  cmd("\\tilde", "tilde", "\\tilde{${}}"),
  cmd("\\vec", "vector", "\\vec{${}}"),
  cmd("\\dot", "dot", "\\dot{${}}"),
  cmd("\\overline", "overline", "\\overline{${}}"),
  cmd("\\underline", "underline", "\\underline{${}}"),
  cmd("\\label", "label", "\\label{${}}"),
  cmd("\\ref", "reference", "\\ref{${}}"),
  ...[
    "partial",
    "nabla",
    "infty",
    "cdot",
    "cdots",
    "ldots",
    "times",
    "div",
    "pm",
    "mp",
    "leq",
    "geq",
    "neq",
    "approx",
    "equiv",
    "sim",
    "simeq",
    "cong",
    "propto",
    "to",
    "mapsto",
    "Rightarrow",
    "Leftarrow",
    "Leftrightarrow",
    "iff",
    "implies",
    "in",
    "notin",
    "subset",
    "subseteq",
    "supset",
    "cup",
    "cap",
    "setminus",
    "emptyset",
    "forall",
    "exists",
    "neg",
    "land",
    "lor",
    "circ",
    "quad",
    "qquad",
    "sin",
    "cos",
    "tan",
    "log",
    "ln",
    "exp",
    "det",
    "max",
    "min",
    "sup",
    "inf",
    "limsup",
    "liminf",
    "ker",
    "dim",
    "deg",
    "gcd",
  ].map((n) => cmd(`\\${n}`, "symbol")),
  ...["R", "N", "Z", "Q", "C"].map((n) => cmd(`\\${n}`, `\\mathbb{${n}}`)),
  ...GREEK.map((n) => cmd(`\\${n}`, "Greek")),
];

const ENVIRONMENTS = [
  "theorem",
  "lemma",
  "proposition",
  "corollary",
  "definition",
  "remark",
  "example",
  "proof",
  "align*",
  "align",
  "equation*",
  "equation",
  "gather*",
  "cases",
  "pmatrix",
  "bmatrix",
  "vmatrix",
  "itemize",
  "enumerate",
];

const envSnippet = (env: string) => {
  const body = env === "itemize" || env === "enumerate" ? "\\item ${}" : "${}";
  return snippetCompletion(`\\begin{${env}}\n\t${body}\n\\end{${env}}`, {
    label: `\\begin{${env}}`,
    detail: "environment",
    type: "class",
  });
};

/** The innermost \begin{…} still open before `pos`, to offer as \end{…}. */
function openEnvironment(doc: string, pos: number): string | null {
  const stack: string[] = [];
  for (const m of doc.slice(0, pos).matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
    if (m[1] === "begin") stack.push(m[2]);
    else if (stack.at(-1) === m[2]) stack.pop();
  }
  return stack.at(-1) ?? null;
}

function latexCompletions(ctx: CompletionContext) {
  const word = ctx.matchBefore(/\\[a-zA-Z*]*\{?[a-zA-Z*]*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const text = ctx.state.doc.toString();
  if (/^\\end\{?/.test(word.text)) {
    const env = openEnvironment(text, word.from);
    return env
      ? { from: word.from, options: [{ label: `\\end{${env}}`, detail: "close", type: "class" }] }
      : null;
  }
  if (/^\\begin\{?/.test(word.text)) return { from: word.from, options: ENVIRONMENTS.map(envSnippet) };
  // and every command already on this page
  const known = new Set(COMMANDS.map((c) => c.label));
  const used = [...new Set(text.match(/\\[a-zA-Z]+\*?/g) ?? [])]
    .filter((c) => !known.has(c) && c !== word.text)
    .map((c): Completion => ({ label: c, detail: "on this page", type: "variable", boost: -1 }));
  return {
    from: word.from,
    options: [...COMMANDS, ...ENVIRONMENTS.map(envSnippet), ...used],
    validFor: /^\\[a-zA-Z*]*$/,
  };
}

// ------------------------------------------------------------------ the editor

export interface LatexEditor {
  /** The page shown, or null. */
  readonly pageId: string | null;
  readonly text: string;
  /** Show a page's text: a fresh undo history when it's another page. */
  load(pageId: string, text: string): void;
  focus(): void;
  hasFocus(): boolean;
  /** Select the next [??] after the cursor (from the top again at the end). */
  nextUnclear(): void;
  /** Remove it (its card left the list or was rebuilt). */
  destroy(): void;
}

export function createLatexEditor(
  parent: HTMLElement,
  opts: { onChange: (pageId: string, text: string) => void; onCheck?: () => void },
): LatexEditor {
  let pageId: string | null = null;
  const extensions = [
    history(),
    drawSelection(),
    highlightActiveLine(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ override: [latexCompletions], icons: false }),
    search({ top: true }),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    StreamLanguage.define(stex),
    syntaxHighlighting(highlight),
    unclear,
    theme,
    placeholder("The LaTeX of this page"),
    // Ctrl+Enter in the Compare view: "checked, next page", as in the rest of it (not a blank line)
    ...(opts.onCheck
      ? [Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => (opts.onCheck!(), true) }]))]
      : []),
    keymap.of([
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
      ...defaultKeymap,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && pageId && !u.transactions.some((tr) => tr.annotation(external))) {
        opts.onChange(pageId, u.state.doc.toString());
      }
    }),
    EditorView.contentAttributes.of({ "aria-label": "LaTeX of this page", spellcheck: "false" }),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ extensions }) });

  return {
    get pageId() {
      return pageId;
    },
    get text() {
      return view.state.doc.toString();
    },
    load(id, text) {
      if (id !== pageId) {
        pageId = id;
        view.setState(EditorState.create({ doc: text, extensions })); // another page: its own undo history
        return;
      }
      if (text === view.state.doc.toString()) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: [external.of(true)],
      });
    },
    focus: () => view.focus(),
    hasFocus: () => view.hasFocus,
    nextUnclear() {
      const doc = view.state.doc.toString();
      const from = view.state.selection.main.to;
      let k = doc.indexOf("[??]", from);
      if (k < 0) k = doc.indexOf("[??]");
      if (k < 0) return;
      view.dispatch({ selection: EditorSelection.single(k, k + 4), scrollIntoView: true });
      view.focus();
    },
    destroy: () => view.destroy(),
  };
}
