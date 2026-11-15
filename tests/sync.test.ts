// Going to the source and back (src/sync.ts): the marking of Typst pages, and on real compiles (when pdflatex,
// Typst and pdftotext are on this computer) every word of a page found from its line and back.

import { scratch } from "./_env.ts";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { latexToTypst } from "../src/convert.ts";
import { which } from "../src/run.ts";
import {
  type Anchor,
  bodyStart,
  Flow,
  type Kind,
  type Row,
  rowsOf,
  synctexAnchors,
  toSpots,
  typstAnchors,
  typstMarked,
} from "../src/sync.ts";
import { Tex } from "../src/tex.ts";
import { Typst } from "../src/typst.ts";

const unmark = (s: string) => s.replace(/#_inktyset_src\(\d+\);/g, "");
/** The lines that got a marker. */
const marked = (s: string) => [...s.matchAll(/#_inktyset_src\((\d+)\);/g)].map((m) => Number(m[1]));

// ------------------------------------------------------------------ rows and the two directions

test("rows: a line's superscript joins it, the next line is its own", () => {
  const rows = rowsOf([
    { left: 0, right: 10, top: 100, bottom: 112 },
    { left: 10, right: 14, top: 96, bottom: 104 }, // a superscript
    { left: 20, right: 40, top: 100.5, bottom: 112 },
    { left: 0, right: 30, top: 114, bottom: 126 },
  ]);
  expect(rows).toEqual([
    { left: 0, right: 40, top: 96, bottom: 112 },
    { left: 0, right: 30, top: 114, bottom: 126 },
  ]);
});

const ROWS: Row[][] = [
  [
    { left: 70, right: 520, top: 100, bottom: 112 },
    { left: 70, right: 520, top: 114, bottom: 126 },
    { left: 70, right: 300, top: 128, bottom: 140 },
  ],
];

test("start anchors (Typst): a point belongs to the last line that started before it", () => {
  // line 1 starts row 0; line 2 starts mid row 1 and runs to the end
  const anchors: Anchor[] = [
    { line: 1, page: 0, x: 70, y: 103 },
    { line: 2, page: 0, x: 200, y: 123 },
  ];
  const f = new Flow(anchors, ROWS, "start");
  expect(f.line(0, 400, 105)).toBe(1);
  expect(f.line(0, 100, 120)).toBe(1); // row 1, before line 2 starts
  expect(f.line(0, 250, 120)).toBe(2);
  expect(f.line(0, 100, 135)).toBe(2);
  expect(f.line(0, 100, 300)).toBe(2); // below everything: the last row
  expect(f.where(1)).toEqual([
    { ...ROWS[0][0], page: 0 },
    { ...ROWS[0][1], right: 200, page: 0 },
  ]);
  expect(f.where(2)).toEqual([
    { ...ROWS[0][1], left: 200, page: 0 },
    { ...ROWS[0][2], page: 0 },
  ]);
  expect(f.where(5)).toEqual(f.where(2)); // a line without a marker: the one before it
});

test("end anchors (SyncTeX): a point belongs to the first word that ends after it", () => {
  const anchors: Anchor[] = [
    { line: 1, page: 0, x: 150, y: 110 },
    { line: 1, page: 0, x: 520, y: 110 },
    { line: 2, page: 0, x: 300, y: 124 },
    { line: 2, page: 0, x: 520, y: 124 },
  ];
  const f = new Flow(anchors, ROWS, "end");
  expect(f.line(0, 100, 105)).toBe(1);
  expect(f.line(0, 100, 120)).toBe(2);
  expect(f.where(1)).toEqual([{ ...ROWS[0][0], page: 0 }]);
  expect(f.where(2)).toEqual([{ ...ROWS[0][1], page: 0 }]);
});

test("right to left: the line goes on to the left", () => {
  // line 2 starts inside the paragraph: on the baseline
  const f = new Flow(
    [
      { line: 1, page: 0, x: 520, y: 103 },
      { line: 2, page: 0, x: 300, y: 110 },
    ],
    ROWS,
    "start",
    true,
  );
  expect(f.line(0, 400, 105)).toBe(1);
  expect(f.line(0, 200, 105)).toBe(2);
  expect(f.where(2)[0]).toEqual({ ...ROWS[0][0], right: 300, page: 0 });
});

test("right to left in Typst: a paragraph's start, given at its top left corner, is where its row starts", () => {
  // what Typst 0.15 says for an Arabic heading and a paragraph of three lines (2, 3, 4) on one row
  const rows: Row[][] = [
    [
      { left: 490.8, right: 524.4, top: 70.9, bottom: 97.1 },
      { left: 70.9, right: 524.4, top: 95.6, bottom: 114.3 },
    ],
  ];
  const anchors: Anchor[] = [
    { line: 1, page: 0, x: 490.76, y: 70.87 },
    { line: 2, page: 0, x: 70.87, y: 95.58 },
    { line: 3, page: 0, x: 375.58, y: 107.34 },
    { line: 4, page: 0, x: 234.92, y: 107.34 },
  ];
  const f = new Flow(anchors, rows, "start", true);
  expect(f.line(0, 510, 85)).toBe(1);
  expect(f.line(0, 450, 105)).toBe(2);
  expect(f.line(0, 300, 105)).toBe(3);
  expect(f.line(0, 100, 105)).toBe(4);
  expect(f.where(2)).toEqual([{ ...rows[0][1], left: 375.58, page: 0 }]);
});

test("spots: points → fractions of the cropped preview image", () => {
  const sheet = { scale: 2, left: 100, top: 100, width: 1000, height: 500, rows: [] };
  const [s] = toSpots([{ page: 0, left: 100, right: 300, top: 100, bottom: 110 }], [sheet]);
  expect(s.sheet).toBe(0);
  expect(s.left).toBeCloseTo((98 * 2 - 100) / 1000);
  expect(s.width).toBeCloseTo((204 * 2) / 1000);
  expect(s.top).toBeCloseTo((98 * 2 - 100) / 500);
});

// ------------------------------------------------------------------ SyncTeX

test("synctex: points of doc.tex only, in the page's own lines; the lagging x points left out", () => {
  const sync = `SyncTeX Version:1
Input:1:/x/./doc.tex
Input:2:/usr/share/article.cls
Unit:1
X Offset:0
Y Offset:0
Content:
{1
(1,8:4661699,6984526:29834878,498346,139537
x1,8:6555419,6984526
k1,6:6859773,6984526:304354
x2,30:7000000,6984526
k1,7:7258451,6984526:304354
k1,9:34496577,6984526:22658696
)
(1,9:4661699,7875816:29834878,598293,139537
k1,9:6772074,7875816:312338
)
}1
`;
  // doc.tex: the body starts on line 5
  const a = synctexAnchors(sync, 5, 10);
  expect(a.map((x) => x.line)).toEqual([2, 3, 5]);
  expect(a[0].page).toBe(0);
  expect(a[0].x).toBeCloseTo(6859773 / 65781.76);
  expect(a[0].y).toBeCloseTo(6984526 / 65781.76);
  expect(bodyStart("\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n")).toBe(3);
});

// ------------------------------------------------------------------ Typst markers

test("typst markers: at the start of lines of text, after a heading's or a list's sign", () => {
  const body = `= Intro
Some text $x^2$
more text.

- item
+ step
/ Term: meaning
#theorem[
  Inside a block.
]
`;
  const m = typstMarked(body);
  expect(m).toContain("= #_inktyset_src(1);Intro");
  expect(m).toContain("#_inktyset_src(2);Some text");
  expect(m).toContain("#_inktyset_src(3);more text.");
  expect(m).toContain("- #_inktyset_src(5);item");
  expect(m).toContain("+ #_inktyset_src(6);step");
  expect(m).toContain("/ #_inktyset_src(7);Term");
  expect(m).toContain("#_inktyset_src(8);#theorem[");
  expect(m).toContain("  #_inktyset_src(9);Inside");
  expect(marked(m)).toEqual([1, 2, 3, 5, 6, 7, 8, 9]);
});

test("typst markers: never inside math, code, strings, raw text or comments", () => {
  const body = `$ a + b
  = c $
#let f(x) = (
  1, 2
)
#set text(
  size: 11pt,
)
\`\`\`
raw line
\`\`\`
// a comment
/* a
block comment */
#figure(caption: "a
string")[Caption
text]
Text
<label>
`;
  const m = typstMarked(body);
  // 1 math start, 3 #let, 6 #set, 9 raw start, 15 #figure, (16 inside its string), 17 inside its [ ], 18 Text
  expect(marked(m)).toEqual([1, 3, 6, 9, 15, 17, 18]);
  expect(m).toContain("#_inktyset_src(17);text]");
});

test("typst markers: a line break (\\ at a line's end) in text or math doesn't hide the next line", () => {
  const m = typstMarked("One \\\nTwo\n$ a \\\n b $\nThree\n");
  expect(marked(m)).toEqual([1, 2, 3, 5]);
  expect(m).toContain("#_inktyset_src(5);Three");
});

test("typst markers: only paragraph starts, for the fallback", () => {
  const m = typstMarked("One\ntwo\n\nThree\n\n#theorem[\n  four\n]\n", true);
  expect(marked(m)).toEqual([1, 4, 6]);
});

// the page's text is never changed: the marked copy is the text plus markers, and nothing else
const pages = [
  ...["test/out/pages", "test/src"].flatMap((d) =>
    existsSync(d)
      ? readdirSync(d)
          .filter((f) => f.endsWith(".tex"))
          .map((f) => join(d, f))
      : [],
  ),
  "test/page2.baseline.tex",
];

test("typst markers: the copy is the page's text plus markers, nothing else", () => {
  for (const f of pages) {
    const body = latexToTypst(readFileSync(f, "utf8"));
    for (const rootOnly of [false, true]) {
      const m = typstMarked(body, rootOnly);
      expect(unmark(m)).toBe(body);
      // each marker on the line it names
      m.split("\n").forEach((l, i) => {
        for (const n of marked(l)) expect(n, `${f}: line ${i + 1}`).toBe(i + 1);
      });
      const nums = marked(m);
      expect([...nums].sort((p, q) => p - q)).toEqual(nums); // each line once, in order
      expect(nums.every((n) => n >= 1 && n <= body.split("\n").length)).toBe(true);
    }
  }
});

test("typst anchors: what Typst says → anchors (its pages count from 1)", () => {
  expect(typstAnchors('[{"line":3,"page":1,"x":70.8,"y":89.1},{"line":"x"}]')).toEqual([
    { line: 3, page: 0, x: 70.8, y: 89.1 },
  ]);
});

// ------------------------------------------------------------------ on real compiles

/** Lines whose words say where they come from: w<line>x<k>. */
function lineWords(lines: number[], words = 9) {
  return (n: number) =>
    lines.includes(n) ? Array.from({ length: words }, (_, k) => `w${n}x${k + 1}`).join(" ") : "";
}

/** The words of a PDF with their boxes (pdftotext), and their rows. */
function wordsOf(pdf: string) {
  const xml = execFileSync("pdftotext", ["-bbox", pdf, "-"]).toString();
  const pages: { text: string; box: Row }[][] = [];
  for (const pg of xml.split("<page ").slice(1)) {
    pages.push(
      [...pg.matchAll(/xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</g)].map(
        (m) => ({
          text: m[5],
          box: { left: +m[1], top: +m[2], right: +m[3], bottom: +m[4] },
        }),
      ),
    );
  }
  return { pages, rows: pages.map((p) => rowsOf(p.map((w) => w.box))) };
}

/** Every word of the page: clicking it gives its line, and its line's spot covers it. */
function checkWords(pdf: string, anchors: Anchor[], kind: Kind) {
  const { pages, rows } = wordsOf(pdf);
  const flow = new Flow(anchors, rows, kind);
  let words = 0;
  const wrong: string[] = [];
  pages.forEach((ws, page) => {
    for (const w of ws) {
      const m = /^w(\d+)x\d+$/.exec(w.text);
      if (!m) continue;
      words++;
      const want = Number(m[1]);
      const cx = (w.box.left + w.box.right) / 2,
        cy = (w.box.top + w.box.bottom) / 2;
      const got = flow.line(page, cx, cy);
      if (got !== want) wrong.push(`${w.text} → line ${got}`);
      const covered = flow
        .where(want)
        .some((p) => p.page === page && p.left <= cx && cx <= p.right && p.top <= cy && cy <= p.bottom);
      if (!covered) wrong.push(`${w.text} not in its line's spot`);
    }
  });
  expect(words).toBeGreaterThan(30);
  expect(wrong).toEqual([]);
}

// lines of a few words (many start mid-row) and of many (rows full of one line); English and French
const CASES = [
  { words: 3, lang: "english" },
  { words: 9, lang: "english" },
  { words: 5, lang: "french" },
];

/** A page of each kind: paragraphs over several lines, inline math, a theorem, an equation between two
 * paragraphs, a list, a line break, an equation over two lines. The lines with words are the ones the test
 * checks. */
function latexPage(word: (n: number) => string) {
  return [
    `\\section*{${word(1)}}`,
    `${word(2)} ${word(2)}`,
    `${word(3)} $x^2$ ${word(3)}`,
    `${word(4)}`,
    "",
    `\\begin{theorem}${word(6)}`,
    `${word(7)} $\\frac{a}{b}$`,
    "\\end{theorem}",
    `${word(9)}`,
    `${word(10)} ${word(10)} ${word(10)}`,
    "\\[ a^2 + b^2 = c^2 \\]",
    `${word(12)}`,
    "\\begin{itemize}",
    `\\item ${word(14)}`,
    `\\item ${word(15)} ${word(15)}`,
    "\\end{itemize}",
    `${word(17)} \\\\`,
    `${word(18)}`,
    "\\begin{align*} x \\\\",
    "= y \\end{align*}",
    `${word(21)}`,
  ].join("\n");
}

function typstPageBody(word: (n: number) => string) {
  return [
    `= ${word(1)}`,
    `${word(2)} ${word(2)}`,
    `${word(3)} $x^2$ ${word(3)}`,
    `${word(4)}`,
    "",
    `#theorem[${word(6)}`,
    `${word(7)} $a/b$`,
    "]",
    `${word(9)}`,
    `${word(10)} ${word(10)} ${word(10)}`,
    "$ a^2 + b^2 = c^2 $",
    `${word(12)}`,
    "",
    `- ${word(14)}`,
    `- ${word(15)} ${word(15)}`,
    "",
    `${word(17)} \\`,
    `${word(18)}`,
    "$ x \\",
    "  = y $",
    `${word(21)}`,
  ].join("\n");
}

const WORD_LINES = [1, 2, 3, 4, 6, 7, 9, 10, 12, 14, 15, 17, 18, 21];

const pdftotext = which("pdftotext");
const pdflatex = which("pdflatex");

test.skipIf(!pdftotext || !pdflatex)("LaTeX on a real compile: every word to its line and back", async () => {
  for (const c of CASES) {
    const dir = scratch(`sync-latex-${c.words}-${c.lang}`);
    const tex = new Tex(dir, () => {});
    tex.mode = "system";
    const body = latexPage(lineWords(WORD_LINES, c.words));
    const r = await tex.compile(join(dir, "build"), body, c.lang);
    expect(r.ok, r.err).toBe(true);
    const doc = readFileSync(join(dir, "build", "doc.tex"), "utf8");
    const sync = gunzipSync(readFileSync(join(dir, "build", "doc.synctex.gz"))).toString();
    checkWords(r.pdf!, synctexAnchors(sync, bodyStart(doc), body.split("\n").length), "end");
  }
});

/** A Typst to test with: one on PATH, or the one Inktyset downloaded. */
function findTypst(): string | null {
  const found = which("typst");
  if (found) return found;
  const dir = join(homedir(), ".config", "Inktyset", "components", "typst");
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true }))
    if (e.isFile() && e.name === "typst") return join(e.parentPath, e.name);
  return null;
}
const typstBin = findTypst();
const savedBundled = process.env.INKTYSET_BUNDLED;
// the Typst class runs "the package's own" Typst when there is one: this one
beforeAll(() => {
  if (typstBin) process.env.INKTYSET_BUNDLED = dirname(typstBin);
});
afterAll(() => {
  if (savedBundled === undefined) delete process.env.INKTYSET_BUNDLED;
  else process.env.INKTYSET_BUNDLED = savedBundled;
});

test.skipIf(!pdftotext || !typstBin)(
  "Typst on a real compile: every word to its line and back, and the page untouched",
  async () => {
    for (const c of CASES) {
      const dir = scratch(`sync-typst-${c.words}-${c.lang}`);
      const typst = new Typst(dir, () => {});
      const body = typstPageBody(lineWords(WORD_LINES, c.words));
      const preview = await typst.compile(join(dir, "build"), body, c.lang);
      expect(preview.ok, preview.err).toBe(true);
      const before = readFileSync(preview.pdf!);
      const anchors = await typst.anchors(join(dir, "build", "sync"), body, c.lang);
      expect(anchors).not.toBeNull();
      // the preview is the page's own: the marked copy is elsewhere, the preview's files untouched
      expect(readFileSync(preview.pdf!)).toEqual(before);
      expect(readFileSync(join(dir, "build", "doc.typ"), "utf8")).not.toContain("_inktyset_src");
      checkWords(preview.pdf!, anchors!, "start");
    }
  },
);

test.skipIf(!typstBin)("Typst: every converted test page's marked copy compiles", async () => {
  const dir = scratch("sync-typst-pages");
  const typst = new Typst(dir, () => {});
  for (const f of pages) {
    const body = latexToTypst(readFileSync(f, "utf8"));
    const page = await typst.compile(join(dir, "page"), body, "french");
    if (!page.ok) continue; // a page that doesn't compile as it is has no preview to go from
    const anchors = await typst.anchors(join(dir, "sync"), body, "french");
    expect(anchors?.length, f).toBeGreaterThan(0);
  }
});
