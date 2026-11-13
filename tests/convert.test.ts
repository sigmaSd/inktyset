import { expect, test } from "vite-plus/test";
import { latexToTypst } from "../src/convert.ts";

test("convert: math through tex2typst, inline and display", () => {
  expect(latexToTypst(String.raw`Let $f:\R\to\R$ and $\frac{a}{b}$.`)).toBe(
    "Let $f : RR -> RR$ and $a/b$.\n",
  );
  expect(latexToTypst(String.raw`\[ \int_0^1 f = 1 \]`)).toBe("$ integral_0^1 f = 1 $\n");
  const align = latexToTypst(String.raw`\begin{align*} a &\leq b, \\ c &= d \end{align*}`);
  expect(align).toContain("& <= b");
  expect(align).toContain("\\");
});

test("convert: headings, theorem blocks with a title, lists, emphasis", () => {
  const out = latexToTypst(String.raw`\section*{Intro}
\begin{theorem}[Rolle] Si $f(a)=f(b)$. \end{theorem}
\begin{proof} Clear. \end{proof}
\begin{enumerate}
\item one
\item \emph{two}
\end{enumerate}`);
  expect(out).toContain("= Intro");
  expect(out).toContain("#theorem[*(Rolle)* ");
  expect(out).toContain("#proof[ Clear. ]");
  expect(out).toContain("+ one");
  expect(out).toContain("+ _two_");
});

test("convert: [??] stays [??], in text and in math", () => {
  expect(latexToTypst(String.raw`a \textbf{[??]} b`)).toBe("a [??] b\n");
  expect(latexToTypst(String.raw`$x + [??]$`)).toContain('"[??]"');
});

test("convert: Typst's special characters in text are escaped; LaTeX escapes undone", () => {
  expect(latexToTypst(String.raw`50\% of #1 & a*b @x \& c`)).toBe("50% of \\#1 & a\\*b \\@x & c\n");
});

test("convert: a table", () => {
  expect(latexToTypst(String.raw`\begin{tabular}{|c|c|}\hline $x$ & 1 \\ \hline\end{tabular}`)).toBe(
    "#table(columns: 2, [$x$], [1])\n",
  );
});

test("convert: \\label is dropped, not shown as text", () => {
  expect(latexToTypst("est continue.\\label{def:cont}").trim()).toBe("est continue.");
});
