// Go to the source and back, like TeXstudio: a point on a page's preview → the line of the page's text that
// made it, and a line → where it is on the preview. Line level, for LaTeX and Typst alike.
//
// Two things are needed: the rows of text on the page (from the PDF, by pdf.js in app/ui/worker.ts), and
// anchors, points on the page that belong to a source line:
//   - LaTeX: SyncTeX, which TeX writes while it typesets (`-synctex=1`). Its points mark where a word ends
//     ("end" anchors: what comes before belongs to their line).
//   - Typst: its compiler has no SyncTeX, so a copy of the page gets an invisible marker at the start of each
//     line of text, and Typst says where each one landed ("start" anchors: what follows belongs to their line).
//     The copy is only measured: the page's text, its file and its preview are never changed (typstMarked).
// All positions are in PDF points from the top left of the page.

/** A row of text on a page. */
export interface Row {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** A point on a page that belongs to a line of the page's text (1-based, in the page's own text). */
export interface Anchor {
  line: number;
  page: number; // 0-based
  x: number;
  y: number;
}

/** A preview image and where it sits on its page: the image is the page drawn at `scale` pixels per point,
 * cropped to its content (`left`, `top`: the crop's corner, in pixels), `width` × `height` pixels. */
export interface Sheet {
  scale: number;
  left: number;
  top: number;
  width: number;
  height: number;
  rows: Row[];
}

/** A highlighted part of a page, on the preview: fractions of the preview image (0 to 1). */
export interface Spot {
  sheet: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

// ------------------------------------------------------------------ rows

/** Rows of text from the boxes of a page's words (any order). Boxes overlapping in height are one row: a
 * superscript joins its line, a fraction its equation. */
export function rowsOf(boxes: Row[]): Row[] {
  const rows: Row[] = [];
  for (const b of [...boxes].filter((b) => b.bottom > b.top).sort((a, b) => a.top - b.top)) {
    const r = rows.at(-1);
    const overlap = r ? Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) : 0;
    if (r && overlap > 0.3 * Math.min(r.bottom - r.top, b.bottom - b.top)) {
      r.top = Math.min(r.top, b.top);
      r.bottom = Math.max(r.bottom, b.bottom);
      r.left = Math.min(r.left, b.left);
      r.right = Math.max(r.right, b.right);
    } else rows.push({ ...b });
  }
  return rows;
}

/** The row at height y: the one it's in, else the nearest (the lower one on a tie). */
function rowAt(rows: Row[], y: number): number {
  let best = 0,
    dist = Infinity;
  rows.forEach((r, i) => {
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d <= dist) {
      if (d < dist || y > r.top) best = i;
      dist = d;
    }
  });
  return best;
}

// ------------------------------------------------------------------ the two directions

export type Kind = "start" | "end";

interface Placed extends Anchor {
  row: number;
  key: number; // x along the reading direction
  seq: number;
}

/** A page's anchors in reading order, each on its row. */
export class Flow {
  readonly #a: Placed[];
  readonly #rows: Row[][];
  readonly #kind: Kind;
  readonly #rtl: boolean;

  constructor(anchors: Anchor[], rows: Row[][], kind: Kind, rtl = false) {
    this.#rows = rows;
    this.#kind = kind;
    this.#rtl = rtl;
    this.#a = anchors
      .filter((a) => rows[a.page]?.length)
      .map((a, seq) => {
        const row = rowAt(rows[a.page], a.y),
          r = rows[a.page][row];
        // right to left, Typst puts a paragraph's or a heading's start at its top left corner (high in the
        // row; a marker inside a paragraph is on its baseline): it's where the row starts, on the right
        const blockStart = rtl && kind === "start" && a.y < r.top + 0.4 * (r.bottom - r.top);
        return { ...a, row, key: blockStart ? -r.right : rtl ? -a.x : a.x, seq };
      })
      .sort((p, q) => p.page - q.page || p.row - q.row || p.key - q.key || p.seq - q.seq);
  }

  #cmp(a: Placed, page: number, row: number, key: number) {
    return a.page - page || a.row - row || a.key - key;
  }

  /** The source line at a point of a page (null: nothing on the page to go by). */
  line(page: number, x: number, y: number): number | null {
    const rows = this.#rows[page];
    if (!rows?.length || !this.#a.length) return null;
    const row = rowAt(rows, y),
      key = this.#rtl ? -x : x;
    if (this.#kind === "start") {
      // the last line that started before the point
      let found: Placed | null = null;
      for (const a of this.#a) if (this.#cmp(a, page, row, key) <= 0) found = a;
      return (found ?? this.#a[0]).line;
    }
    // the first word that ends after the point; after a row's last one, that one
    const after = this.#a.find((a) => this.#cmp(a, page, row, key) >= 0);
    if (!after || after.page !== page || after.row !== row) {
      const last = this.#a.findLast((a) => a.page === page && a.row === row);
      if (last) return last.line;
    }
    return (after ?? this.#a.at(-1)!).line;
  }

  /** Where a source line is: parts of rows. A line with nothing of its own on the page (a blank line, a
   * line inside a block) shows the nearest one: before it for "start" anchors, after it for "end" ones. */
  where(line: number): (Row & { page: number })[] {
    const lines = [...new Set(this.#a.map((a) => a.line))].sort((p, q) => p - q);
    if (!lines.length) return [];
    let target = line;
    if (!lines.includes(line)) {
      const before = lines.filter((l) => l < line).at(-1);
      const after = lines.find((l) => l > line);
      target = (this.#kind === "start" ? (before ?? after) : (after ?? before))!;
    }
    const out: (Row & { page: number })[] = [];
    const a = this.#a;
    const sameRow = (p?: Placed, q?: Placed) => !!p && !!q && p.page === q.page && p.row === q.row;
    for (let i = 0; i < a.length; i++) {
      if (a[i].line !== target || a[i - 1]?.line === target) continue;
      let j = i;
      while (a[j + 1]?.line === target) j++;
      // a run of the line's anchors: "start" anchors begin its text and the next anchor ends it; "end"
      // anchors end its text, the anchor before begins it, and after a row's last one the row is its
      const page = (this.#kind === "start" ? a[i] : a[j]).page;
      let from: Placed | undefined, to: Placed | undefined, toRowEnd: Placed | undefined;
      if (this.#kind === "start") [from, to] = [a[i], a[j + 1]];
      else {
        from = a[i - 1];
        if (sameRow(a[j], a[j + 1])) to = a[j];
        else toRowEnd = a[j];
      }
      const at = (p?: Placed) => (p?.page === page ? p : null);
      out.push(...this.#span(page, at(from), at(to), toRowEnd));
    }
    if (!out.length) {
      // nothing in between (a line that only sets something up): its row
      const first = a.find((x) => x.line === target)!;
      const r = this.#rows[first.page][first.row];
      out.push({ ...r, page: first.page });
    }
    return out;
  }

  /** The text between two anchors of a page (null: from the page's start, to its end; `toRowEnd`: to the end
   * of that anchor's row). */
  #span(page: number, from: Placed | null, to: Placed | null, toRowEnd?: Placed): (Row & { page: number })[] {
    const rows = this.#rows[page];
    const r1 = from?.row ?? 0,
      r2 = to?.row ?? toRowEnd?.row ?? rows.length - 1;
    const out: (Row & { page: number })[] = [];
    for (let r = r1; r <= r2; r++) {
      const row = rows[r];
      // along the reading direction: s (start) and e (end) of what's highlighted in this row
      let s = this.#rtl ? -row.right : row.left,
        e = this.#rtl ? -row.left : row.right;
      if (from && r === r1) s = Math.max(s, from.key);
      if (to && r === r2) e = Math.min(e, to.key);
      if (e - s < 1) continue; // nothing of it on this row (it starts at a row's end, or ends at its start)
      const [left, right] = this.#rtl ? [-e, -s] : [s, e];
      out.push({ top: row.top, bottom: row.bottom, left, right, page });
    }
    return out;
  }
}

/** Highlighted parts of a page in points → spots on the preview images. */
export function toSpots(parts: (Row & { page: number })[], sheets: Sheet[]): Spot[] {
  const spots: Spot[] = [];
  for (const p of parts) {
    const s = sheets[p.page];
    if (!s) continue;
    const pad = 2; // points around the text
    const x0 = Math.max(0, (p.left - pad) * s.scale - s.left),
      x1 = Math.min(s.width, (p.right + pad) * s.scale - s.left);
    const y0 = Math.max(0, (p.top - pad) * s.scale - s.top),
      y1 = Math.min(s.height, (p.bottom + pad) * s.scale - s.top);
    if (x1 > x0 && y1 > y0)
      spots.push({
        sheet: p.page,
        left: x0 / s.width,
        top: y0 / s.height,
        width: (x1 - x0) / s.width,
        height: (y1 - y0) / s.height,
      });
  }
  return spots;
}

/** A point on a preview image (fractions of it) → on its page, in points. */
export function fromSheet(s: Sheet, fx: number, fy: number) {
  return { x: (fx * s.width + s.left) / s.scale, y: (fy * s.height + s.top) / s.scale };
}

// ------------------------------------------------------------------ LaTeX: SyncTeX

/** The first line of the page's text in doc.tex, 1-based (the one after \begin{document}). */
export function bodyStart(doc: string): number {
  const i = doc.split("\n").findIndex((l) => l.trim() === "\\begin{document}");
  return i < 0 ? 1 : i + 2;
}

/** SyncTeX's points for doc.tex, lines counted in the page's text (`first`: where it starts in doc.tex): the
 * ends of words ("end" anchors).
 * Coordinates are in big points (PDF points) from the top left of the page. */
export function synctexAnchors(text: string, first: number, lines: number): Anchor[] {
  let unit = 1,
    xOff = 0,
    yOff = 0;
  const docTags = new Set<string>();
  const out: Anchor[] = [];
  const bp = 65781.76; // scaled points per big point
  let page = -1,
    content = false;
  // the horizontal boxes open (a typeset line is one), and the points directly in them
  const boxes: { line: number; points: Anchor[]; xs: Anchor[] }[] = [];
  const toBody = (line: number) => Math.min(Math.max(line - first + 1, 1), Math.max(lines, 1));
  for (const raw of text.split("\n")) {
    const l = raw.trimEnd();
    if (!content) {
      const input = /^Input:(\d+):(.*)$/.exec(l);
      if (input && /(^|[\\/])doc\.tex$/.test(input[2])) docTags.add(input[1]);
      const n = /^(Unit|X Offset|Y Offset):(-?\d+(?:\.\d+)?)$/.exec(l);
      if (n) {
        if (n[1] === "Unit") unit = Number(n[2]);
        else if (n[1] === "X Offset") xOff = Number(n[2]);
        else yOff = Number(n[2]);
      }
      if (l === "Content:") content = true;
      continue;
    }
    if (l.startsWith("Input:")) {
      const input = /^Input:(\d+):(.*)$/.exec(l);
      if (input && /(^|[\\/])doc\.tex$/.test(input[2])) docTags.add(input[1]);
      continue;
    }
    const pg = /^\{(\d+)$/.exec(l);
    if (pg) {
      page = Number(pg[1]) - 1;
      continue;
    }
    if (l === ")") {
      // kerns and glue (the spaces after words) and math carry the line their word came from; the `x`
      // points lag one word behind, so they count only in a box with nothing else. The fill after a
      // paragraph's last word carries the line the paragraph ends on (a blank line, \end{…}), as does the
      // box: such points go when the box has others.
      const b = boxes.pop();
      if (!b) continue;
      const points = b.points.length ? b.points : b.xs;
      const own = points.filter((p) => p.line !== b.line);
      out.push(...(own.length ? own : points));
      continue;
    }
    // (tag,line[,column]:h,v…  — a box opening; x k g $ h v — points
    const m = /^([(xkg$hv])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+))?/.exec(l);
    if (!m || page < 0) continue;
    const [, type, tag, line] = m;
    if (type === "(") {
      boxes.push({ line: Number(line), points: [], xs: [] });
      continue;
    }
    if (!docTags.has(tag)) continue;
    // a wide kern is the fill at a row's end (after \\, a paragraph's last row), not a space between words:
    // it carries the line TeX had read on to
    if (type === "k" && m[6] && (Number(m[6]) * unit) / bp > 12) continue;
    const a: Anchor = {
      line: Number(line),
      page,
      x: (Number(m[4]) * unit + xOff) / bp,
      y: (Number(m[5]) * unit + yOff) / bp,
    };
    const box = boxes.at(-1);
    if (!box) out.push(a);
    else if (type === "x") box.xs.push(a);
    else box.points.push(a);
  }
  // only the page's own lines (not the preamble's, not \end{document})
  return out
    .filter((a) => a.line >= first && a.line < first + lines)
    .map((a) => ({ ...a, line: toBody(a.line) }));
}

// ------------------------------------------------------------------ Typst: markers

/** The label of the markers in the measured copy, and what makes one. */
export const MARK_LABEL = "inktyset-src";
export const MARK_DEF = `#let _inktyset_src(n) = context [#metadata((line: n, page: here().position().page, x: here().position().x / 1pt, y: here().position().y / 1pt))<${MARK_LABEL}>]\n`;

const KEYWORDS = new Set([
  "let",
  "set",
  "show",
  "import",
  "include",
  "if",
  "for",
  "while",
  "context",
  "return",
  "break",
  "continue",
]);

/**
 * A Typst page's text with a marker at the start of each line of text: `#_inktyset_src(N);` (N: the line).
 * Only where Typst reads text (markup), never inside math, code, strings, raw text or comments; after a
 * heading's `=` or a list's `-` so they stay what they are. `rootOnly`: only at the start of top-level
 * paragraphs (the fallback when the full marking doesn't compile).
 */
export function typstMarked(body: string, rootOnly = false): string {
  type Frame = { mode: "markup" | "code" | "math"; close: string };
  const stack: Frame[] = [{ mode: "markup", close: "" }];
  const marks: { at: number; line: number }[] = [];
  let i = 0,
    line = 1,
    lineStart = true,
    prevBlank = true;
  const n = body.length;
  const top = () => stack.at(-1)!;
  const open = (mode: Frame["mode"], close: string) => {
    stack.push({ mode, close });
    i++;
  };
  const skipString = () => {
    const start = i;
    i++;
    while (i < n && body[i] !== '"') i += body[i] === "\\" ? 2 : 1;
    i++;
    line += (body.slice(start, i).match(/\n/g) ?? []).length;
  };
  const skipTo = (s: string, keep = false) => {
    const j = body.indexOf(s, i);
    i = j < 0 ? n : keep ? j : j + s.length;
  };
  // an embedded expression after `#`, in markup or math: a name (with .fields), then its arguments
  const hash = () => {
    i++;
    const c = body[i];
    if (c === "(") return open("code", ")");
    if (c === "{") return open("code", "}");
    if (c === "[") return open("markup", "]");
    if (c === '"') return skipString();
    const id = /^[\p{L}_][\p{L}\p{N}_-]*(?:\.[\p{L}_][\p{L}\p{N}_-]*)*/u.exec(body.slice(i, i + 200));
    if (!id) return;
    i += id[0].length;
    if (KEYWORDS.has(id[0])) return void stack.push({ mode: "code", close: "\n" }); // to the line's end
    if (body[i] === "(") open("code", ")");
    else if (body[i] === "[") open("markup", "]");
  };
  while (i < n) {
    if (lineStart) {
      lineStart = false;
      const f = top();
      const rest = body.slice(i, body.indexOf("\n", i) < 0 ? n : body.indexOf("\n", i));
      const indent = /^[ \t]*/.exec(rest)![0].length;
      const text = rest.slice(indent);
      const paragraph = prevBlank && stack.length === 1; // a top-level paragraph starts here
      prevBlank = f.mode === "markup" && text === "";
      if (f.mode === "markup" && (!rootOnly || paragraph)) {
        const prefix = /^(=+[ \t]+|[-+][ \t]+|\d+\.[ \t]+|\/[ \t]+)/.exec(text);
        if (text && !/^(\/\/|\/\*|[<\])}])/.test(text)) {
          const at = i + indent + (prefix ? prefix[0].length : 0);
          // a heading or list item with nothing after its sign: nothing to mark
          if (!prefix || text.length > prefix[0].length) marks.push({ at, line });
        }
      }
    }
    const c = body[i],
      f = top();
    if (c === "\n") {
      line++;
      lineStart = true;
      if (f.close === "\n") stack.pop();
      i++;
      continue;
    }
    if (f.mode === "markup") {
      if (c === "\\") i += body[i + 1] === "\n" ? 1 : 2; // an escape; at a line's end, a line break
      else if (body.startsWith("//", i)) skipTo("\n", true);
      else if (body.startsWith("/*", i)) {
        line += (body.slice(i, body.indexOf("*/", i) < 0 ? n : body.indexOf("*/", i)).match(/\n/g) ?? [])
          .length;
        skipTo("*/");
      } else if (c === "`") {
        const ticks = /^`+/.exec(body.slice(i))![0].length;
        const start = i;
        if (ticks >= 3) {
          i += ticks;
          skipTo("`".repeat(ticks));
        } else if (ticks === 1) {
          i++;
          skipTo("`");
        } else i += 2;
        line += (body.slice(start, i).match(/\n/g) ?? []).length;
      } else if (c === "$") open("math", "$");
      else if (c === "[") open("markup", "]");
      else if (c === "]") {
        if (f.close === "]") stack.pop();
        i++;
      } else if (c === "#") hash();
      else i++;
    } else if (f.mode === "code") {
      if (c === '"') skipString();
      else if (body.startsWith("//", i)) skipTo("\n", true);
      else if (body.startsWith("/*", i)) {
        line += (body.slice(i, body.indexOf("*/", i) < 0 ? n : body.indexOf("*/", i)).match(/\n/g) ?? [])
          .length;
        skipTo("*/");
      } else if (c === "(") open("code", ")");
      else if (c === "{") open("code", "}");
      else if (c === "[") open("markup", "]");
      else if (c === "$") open("math", "$");
      else if (c === ")" || c === "}") {
        // closes this group, or the group a statement is in (`#if x { #let y = 1 }`)
        if (f.close === "\n" && stack.length > 1) stack.pop();
        if (top().close === c && stack.length > 1) stack.pop();
        i++;
      } else if (c === ";" && f.close === "\n") {
        stack.pop();
        i++;
      } else i++;
    } else {
      // math
      if (c === "\\") i += body[i + 1] === "\n" ? 1 : 2; // an escape; at a line's end, a line break
      else if (c === '"') skipString();
      else if (body.startsWith("//", i)) skipTo("\n", true);
      else if (c === "$") {
        stack.pop();
        i++;
      } else if (c === "#") hash();
      else i++;
    }
  }
  let out = "",
    at = 0;
  for (const m of marks) {
    out += body.slice(at, m.at) + `#_inktyset_src(${m.line});`;
    at = m.at;
  }
  return out + body.slice(at);
}

/** What Typst says about the markers (`typst eval` on the marked copy) → anchors. */
export function typstAnchors(json: string): Anchor[] {
  const list = JSON.parse(json) as unknown;
  if (!Array.isArray(list)) return [];
  return list
    .map((v: { line?: unknown; page?: unknown; x?: unknown; y?: unknown }) => ({
      line: Number(v?.line),
      page: Number(v?.page) - 1,
      x: Number(v?.x),
      y: Number(v?.y),
    }))
    .filter((a) => [a.line, a.page, a.x, a.y].every(Number.isFinite));
}
