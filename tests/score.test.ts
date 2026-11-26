import { expect, test } from "vite-plus/test";
import { meaningDiff, mathTokens, pageTokens, scan, scorePage } from "../src/score.ts";

const off = (reading: string, right: string) => scorePage(reading, right).off;

test("score: the same math written otherwise is the same", () => {
  for (const [a, b] of [
    ["$x^{2}$", "$x^2$"],
    ["$a \\le b$", "$a \\leq b$"],
    ["$\\left( a \\right)$", "$(a)$"],
    ["$\\mathbb R^3$", "$\\mathbb{R}^3$"],
    ["$T : U \\longrightarrow V$", "$T : U \\to V$"],
    ["$x - y$", "$x-y$"],
    ["$$a = b$$", "\\[a = b\\]"],
    ["$a = b$ \\label{eq}", "$a = b$"],
  ])
    expect(off(a, b), `${a} / ${b}`).toBe(0);
});

test("score: the layout doesn't count, what it says does", () => {
  const right = String.raw`\section*{Nilpotent operator:-}
\begin{align*}
T(x,y,z) &= (0,x,y) \\
T^2(x,y,z) &= T(0,x,y) = (0,0,x)
\end{align*}
$\therefore$ nilpotency index of $T = 3$`;
  const laidOut = String.raw`\textbf{Nilpotent operator:-}

$T(x,y,z) = (0,x,y)$ \\
$T^2(x,y,z) = T(0,x,y) = (0,0,x)$

$\therefore$ nilpotency index of $T = 3$`;
  expect(off(laidOut, right)).toBe(0);
  expect(off(laidOut.replace("T = 3", "T = 2"), right)).toBeGreaterThan(0); // a misread digit
  expect(off(laidOut.replace("index", "indexes"), right)).toBeGreaterThan(0); // a misread word
});

test("score: what braces group counts (the old score dropped them)", () => {
  expect(off("$x^{n+1}$", "$x^n+1$")).toBeGreaterThan(0);
  expect(off("$\\frac{a+b}{c}$", "$\\frac{a}{b+c}$")).toBeGreaterThan(0);
  expect(off("$\\sqrt{a+b}$", "$\\sqrt{a}+b$")).toBeGreaterThan(0);
  expect(off("$x_{i+1}$", "$x_i+1$")).toBeGreaterThan(0);
});

test("score: a letter is the same in text and in math; a formula KaTeX can't read differs", () => {
  expect(off("a v-s $V$", "a v-s V")).toBe(0);
  expect(mathTokens("\\frac{1}{2")).toEqual(["?\\frac", "?{", "?1", "?}", "?{", "?2"]);
  expect(off("$\\frac{1}{2$", "$\\frac{1}{2}$")).toBeGreaterThan(0);
});

test("score: where the math is: delimiters, math environments by rows, not escaped dollars, not comments", () => {
  const src = "costs \\$5 and $x$ % $y$ is a comment\nend";
  const parts = scan(src);
  expect(parts.map((p) => [p.math, p.tex.trim()])).toEqual([
    [false, "costs $5 and"],
    [true, "x"],
    [false, "end"],
  ]);
  // each part knows where it is in the LaTeX: math exactly, rows of an environment too (their & made spaces)
  expect(src.slice(parts[1].start, parts[1].end)).toBe("x");
  expect(src.slice(parts[0].start, parts[0].end)).toBe("costs \\$5 and "); // not the $ that opens the math
  const env = "\\begin{align*} a &= b \\\\ c &= d \\end{align*}";
  for (const p of scan(env)) expect(env.slice(p.start, p.end).replace("&", " ")).toBe(p.tex);
  const rows = scan(
    "\\begin{align*} a &= b \\\\ &= \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix} \\end{align*}",
  );
  expect(rows.map((p) => p.math)).toEqual([true, true]); // two rows, the matrix's own \\ kept inside
  expect(pageTokens("\\begin{align*} a &= b \\end{align*}")).toEqual(["a", "=", "b"]);
  // the matrix stays one table, its cells in order
  expect(
    mathTokens("\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}").filter((t) => /^\d$/.test(t)),
  ).toEqual(["1", "2", "3", "4"]);
});

test("score: formulas exactly right, in any order", () => {
  const right = "$a = b$ then $c = d$ and $e = f$";
  expect(scorePage("$c = d$, $a = b$, $e = g$", right).formulas).toEqual({ right: 2, of: 3 });
  expect(scorePage("no math", "words only").formulas).toEqual({ right: 0, of: 0 });
  // punctuation or a bullet at its edges, inside the $ or out: the same formula
  expect(scorePage("* $T : U \\to V$, then $x^2.$", "$* \\quad T : U \\to V$ then $x^2$.").formulas).toEqual({
    right: 2,
    of: 2,
  });
});

/** A diff as text: [-removed-] [+added+], the rest as the reading writes it. */
const marked = (right: string, reading: string) =>
  meaningDiff(right, reading)
    .map((p) => (p.op === "same" ? p.text : p.op === "add" ? `[+${p.text}+]` : `[-${p.text}-]`))
    .join("");

test("meaning diff: the reading as it is written, layout alone never marked", () => {
  for (const [right, reading] of [
    ["$\\left( \\sum_{j=1}^p a_j \\right)$ and more", "$( \\sum_{j=1}^p a_j )$ and more"],
    ["\\section*{Nilpotent operator:-} text", "\\textbf{Nilpotent operator:-} text"],
    ["\\begin{align*} T(x) &= (0,x) \\end{align*}", "$T(x) = (0,x)$"],
    ["$x^{2}$, $a \\le b$", "$x^2$, $a \\leq b$"],
  ])
    expect(marked(right, reading), reading).toBe(reading);
});

test("meaning diff: what the score counts is marked, in a formula symbol by symbol", () => {
  expect(marked("Let $x$ be fixed.", "Let $y$ be fixed now.")).toBe("Let $[-x-][+y+]$ be fixed [+now+].");
  // a row of an align* against a $…$ line: only the digit, not the & or the layout
  expect(
    marked("\\begin{align*} T(x) &= (0,x) \\\\ T^2 &= 3 \\end{align*}", "$T(x) = (0,x)$\n$T^2 = 2$"),
  ).toBe("$T(x) = (0,x)$\n$T^2 =[-3-] [+2+]$");
  // several formulas read otherwise together: still symbol by symbol, not all struck and all added
  expect(marked("$T_1((x,y)) = a$\n\n$T_2((x,y)) = b$", "$T_1(x, y) = a$\n$T_2(x, y) = b$")).toBe(
    "$T_1([-(-]x, y)[-)-] = a$\n$T_2([-(-]x, y)[-)-] = b$",
  );
  // math and words together, removed: spaced as they were
  expect(marked("$\\therefore$ nilpotency index", "Nilpotency index")).toBe(
    "[-\\therefore nilpotency-][+Nilpotency+] index",
  );
  // what the reading lacks, as the right text writes it, just before what comes next (not inside the heading)
  expect(
    marked("\\textbf{Title}\n\nLemma. Let $x$ be.", "\\section*{Title}\n\n\\begin{lemma}\nLet $x$ be."),
  ).toBe("\\section*{Title}\n\n\\begin{lemma}\n[-Lemma. -]Let $x$ be.");
  // the reading's text is all there, in order, once the removed parts are left out
  const reading = "Text $a+b$ and \\textbf{more} words";
  const parts = meaningDiff("Other $a-b$ words", reading);
  expect(
    parts
      .filter((p) => p.op !== "del")
      .map((p) => p.text)
      .join(""),
  ).toBe(reading);
});
