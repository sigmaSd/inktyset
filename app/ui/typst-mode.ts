// Typst in the editor (app/ui/editor.ts): a small highlighter (CodeMirror has no Typst mode) and completion of
// what handwritten math needs: math functions and symbols inside $…$, Inktyset's #theorem[…] blocks outside.

import { type Completion, type CompletionContext, snippetCompletion } from "@codemirror/autocomplete";
import type { StreamParser } from "@codemirror/language";

interface State {
  math: boolean;
  comment: boolean;
}

/** Token names map to highlight tags: keyword ($), tagName (#calls, math names), heading, string, comment… */
export const typstMode: StreamParser<State> = {
  name: "typst",
  startState: () => ({ math: false, comment: false }),
  copyState: (s) => ({ ...s }),
  token(stream, state) {
    if (state.comment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.comment = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.comment = true;
      return "comment";
    }
    if (stream.peek() === "\\" && !state.math) {
      stream.next(); // an escaped character
      stream.next();
      return null;
    }
    if (stream.match("$")) {
      state.math = !state.math;
      return "keyword";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
    if (state.math) {
      if (stream.match(/^[a-zA-Z][a-zA-Z.]*/)) return "tagName";
      if (stream.match(/^\d+(?:\.\d+)?/)) return "number";
      if (stream.match(/^[()[\]{}]/)) return "bracket";
      if (stream.match(/^(?:&|\\|_|\^|->|<=|>=|!=|=>|<-)/)) return "operator";
      stream.next();
      return null;
    }
    if (stream.sol() && stream.match(/^\s*=+\s/)) {
      stream.skipToEnd();
      return "heading";
    }
    if (stream.match(/^#[a-zA-Z_][\w-]*/)) return "tagName";
    if (stream.match(/^[[\]()]/)) return "bracket";
    if (stream.sol() && stream.match(/^\s*[-+]\s/)) return "operator"; // list items
    stream.next();
    return null;
  },
};

const fn = (name: string, detail: string, template: string): Completion =>
  snippetCompletion(template, { label: name, detail, type: "function" });
const sym = (name: string, detail: string): Completion => ({ label: name, detail, type: "keyword" });

const GREEK = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
  "eta",
  "theta",
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
  "epsilon.alt",
  "phi.alt",
  "theta.alt",
];

const MATH: Completion[] = [
  fn("frac", "fraction", "frac(${a}, ${b})"),
  fn("sqrt", "root", "sqrt(${x})"),
  fn("root", "n-th root", "root(${n}, ${x})"),
  fn("sum", "sum", "sum_(${i=1})^${n}"),
  fn("product", "product", "product_(${i=1})^${n}"),
  fn("integral", "integral", "integral_${a}^${b}"),
  fn("lim", "limit", "lim_(${x -> oo})"),
  fn("abs", "|x|", "abs(${x})"),
  fn("norm", "‖x‖", "norm(${x})"),
  fn("vec", "vector", "vec(${x})"),
  fn("hat", "hat", "hat(${x})"),
  fn("tilde", "tilde", "tilde(${x})"),
  fn("overline", "overline", "overline(${x})"),
  fn("underline", "underline", "underline(${x})"),
  fn("bb", "blackboard", "bb(${R})"),
  fn("cal", "calligraphic", "cal(${A})"),
  fn("upright", "upright", "upright(${x})"),
  fn("binom", "binomial", "binom(${n}, ${k})"),
  fn("mat", "matrix", "mat(${a}, ${b}; ${c}, ${d})"),
  fn("cases", "cases", 'cases(${a} &"if" ${x}, ${b} &"otherwise")'),
  ...[
    ["oo", "∞"],
    ["partial", "∂"],
    ["nabla", "∇"],
    ["dot", "⋅"],
    ["times", "×"],
    ["plus.minus", "±"],
    ["arrow.r", "→"],
    ["arrow.l.r", "↔"],
    ["arrow.r.double", "⇒"],
    ["arrow.l.r.double", "⇔"],
    ["mapsto", "↦"],
    ["in", "∈"],
    ["in.not", "∉"],
    ["subset", "⊂"],
    ["subset.eq", "⊆"],
    ["union", "∪"],
    ["sect", "∩"],
    ["without", "∖"],
    ["emptyset", "∅"],
    ["forall", "∀"],
    ["exists", "∃"],
    ["approx", "≈"],
    ["equiv", "≡"],
    ["eq.not", "≠"],
    ["lt.eq", "≤"],
    ["gt.eq", "≥"],
    ["tilde.op", "∼"],
    ["dots.h", "…"],
    ["dots.c", "⋯"],
    ["compose", "∘"],
    ["quad", "space"],
    ["RR", "ℝ"],
    ["NN", "ℕ"],
    ["ZZ", "ℤ"],
    ["QQ", "ℚ"],
    ["CC", "ℂ"],
    ["sin", ""],
    ["cos", ""],
    ["tan", ""],
    ["log", ""],
    ["ln", ""],
    ["exp", ""],
    ["det", ""],
    ["max", ""],
    ["min", ""],
    ["sup", ""],
    ["inf", ""],
    ["ker", ""],
    ["dim", ""],
    ["gcd", ""],
  ].map(([n, d]) => sym(n, d || "operator")),
  ...GREEK.map((n) => sym(n, "Greek")),
];

const BLOCKS: Completion[] = [
  ...["theorem", "lemma", "proposition", "corollary", "definition", "remark", "example", "proof"].map((n) =>
    snippetCompletion(`#${n}[\n\t\${}\n]`, { label: `#${n}`, detail: "block", type: "class" }),
  ),
  snippetCompletion("#table(columns: ${2}, [${}], [])", { label: "#table", detail: "table", type: "class" }),
  { label: "#pagebreak()", detail: "new page", type: "keyword" },
];

/** Inside $…$ when an odd number of unescaped $ comes before. */
function inMath(text: string): boolean {
  return ((text.replace(/\\\$/g, "").match(/\$/g) ?? []).length & 1) === 1;
}

export function typstCompletions(ctx: CompletionContext) {
  const before = ctx.state.doc.sliceString(0, ctx.pos);
  if (inMath(before)) {
    const word = ctx.matchBefore(/[a-zA-Z][a-zA-Z.]*/);
    if (!word || (word.to - word.from < 2 && !ctx.explicit)) return null;
    return { from: word.from, options: MATH, validFor: /^[a-zA-Z.]*$/ };
  }
  const word = ctx.matchBefore(/#[a-zA-Z]*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  return { from: word.from, options: BLOCKS, validFor: /^#[a-zA-Z]*$/ };
}
