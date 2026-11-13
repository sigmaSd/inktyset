import { expect, test } from "vite-plus/test";
import { fullDocument, pageDocument, preamble } from "../src/pipeline.ts";
import { arabicInLatin, markScripts } from "../src/scripts.ts";

test("scripts: Arabic words in a French sentence are marked, as one run with their spaces and digits", () => {
  expect(markScripts("La notion de الدالة المستمرة est centrale.", false)).toBe(
    "La notion de \\textarabic{الدالة المستمرة} est centrale.",
  );
  expect(markScripts("en سنة 2024 مثلا ici", false)).toBe("en \\textarabic{سنة 2024 مثلا} ici");
});

test("scripts: math, commands, names and comments are never marked", () => {
  expect(markScripts("Soit $f(x) = \\text{دالة}$ ici", false)).toBe("Soit $f(x) = \\text{دالة}$ ici");
  expect(markScripts("\\label{eq1} % تعليق\nmot", false)).toBe("\\label{eq1} % تعليق\nmot");
  expect(markScripts("\\begin{align*} x &= y \\end{align*} نص", false)).toBe(
    "\\begin{align*} x &= y \\end{align*} \\textarabic{نص}",
  );
});

test("scripts: Arabic inside a heading or a theorem title is marked inside the braces", () => {
  expect(markScripts("\\section*{Partie تعريف}", false)).toBe("\\section*{Partie \\textarabic{تعريف}}");
});

test("scripts: in an Arabic page, the Latin words are marked instead", () => {
  expect(markScripts("فضاء Banach التام", true)).toBe("فضاء \\textenglish{Banach} التام");
  expect(markScripts("$x \\in \\R$ نص", true)).toBe("$x \\in \\R$ نص"); // math stays as it is
});

test("scripts: brackets stay outside the runs, so a pair is never split between two directions", () => {
  expect(markScripts("فضاء Banach (espace complet) إذا", true)).toBe(
    "فضاء \\textenglish{Banach} (\\textenglish{espace complet}) إذا",
  );
});

test("scripts: a run never crosses a blank line (a paragraph break)", () => {
  expect(markScripts("أ\n\nب", false)).toBe("\\textarabic{أ}\n\n\\textarabic{ب}");
});

test("scripts: a French page with Arabic words compiles with XeTeX and loads Arabic as a second language", () => {
  const body = "Le mot الدالة ici.";
  expect(arabicInLatin(body, "french")).toBe(true);
  expect(arabicInLatin(body, "arabic")).toBe(false);
  const doc = pageDocument(body, "french", "xetex");
  expect(doc).toContain("\\setmainlanguage{french}");
  expect(doc).toContain("\\setotherlanguage{arabic}");
  expect(doc).toContain("\\textarabic{الدالة}");
  expect(fullDocument([body, "x"], "english")).toContain("\\setotherlanguage{arabic}");
  expect(preamble("english", "xetex")).not.toContain("polyglossia"); // nothing mixed: as before
});
