import { expect, test } from "vite-plus/test";
import { allBodies, cleanLatex, familyFor, fullDocument, langPrompt, preamble } from "../src/pipeline.ts";
import { typstBodies, typstDocument, typstPreamble } from "../src/typst.ts";

test("cleanup: keeps only the body when the model wraps it in fences or a whole document", () => {
  expect(cleanLatex("```latex\n$x^2$\n```")).toBe("$x^2$\n");
  expect(
    cleanLatex("<think>hmm</think>\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}"),
  ).toBe("Hello\n");
  expect(cleanLatex("\\usepackage{amsmath}\n$a$")).toBe("$a$\n");
});

test("prompt: English adds nothing; other languages say not to translate", () => {
  expect(langPrompt("english")).toBe("");
  expect(langPrompt("french")).toContain("keep it in French");
  expect(langPrompt("Dutch")).toContain("Do not translate");
});

test("preview: pdflatex for English, French and unlisted languages; XeTeX for the rest", () => {
  expect(familyFor("english")).toBe("pdftex");
  expect(familyFor("french")).toBe("pdftex");
  expect(familyFor("Dutch")).toBe("pdftex");
  expect(familyFor("arabic")).toBe("xetex");
  expect(familyFor("german")).toBe("xetex");
});

test("preamble: every package before the language setup (Arabic's bidi must come last)", () => {
  const p = preamble("arabic", "xetex");
  const lang = p.indexOf("\\usepackage{polyglossia}");
  expect(lang).toBeGreaterThan(0);
  for (const pkg of ["amsmath", "xcolor", "geometry"]) expect(p.indexOf(pkg)).toBeLessThan(lang);
  expect(p.indexOf("\\newtheorem")).toBeGreaterThan(lang);
  expect(p).toContain("\\arabicfont");
});

test("preamble: French with pdflatex uses babel", () => {
  const p = preamble("french", "pdftex");
  expect(p).toContain("\\usepackage[french]{babel}");
  expect(p).not.toContain("polyglossia");
});

test("export: pages are numbered, and each starts a new page in the full document", () => {
  expect(allBodies(["a", "b"])).toBe("% ---- page 1\na\n\n% ---- page 2\nb\n");
  const doc = fullDocument(["a", "b"], "english");
  expect(doc).toContain("\\begin{document}");
  expect(doc).toContain("\\clearpage\n% ---- page 2");
});

test("typst: language, theorem blocks, and pages separated by page breaks", () => {
  expect(typstPreamble("arabic")).toContain('lang: "ar"');
  expect(typstPreamble("arabic")).toContain("Amiri");
  expect(typstPreamble("Dutch")).not.toContain("lang:");
  expect(typstPreamble("english")).toContain("#let theorem(body)");
  expect(typstDocument(["a", "b"], "english")).toContain("#pagebreak()\n// ---- page 2");
  expect(typstBodies(["a"])).toBe("// ---- page 1\na\n");
});
