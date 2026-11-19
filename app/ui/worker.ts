// The hidden page that does Inktyset's image and PDF work (called from shell/electron/render.ts): files are
// fetched from the data folder (/data/..., any session's), results returned as base64.

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PictureEdit } from "../../src/picture.ts";
import { drawEdited } from "./picture.ts";
import { type Row, rowsOf, type Sheet } from "../../src/sync.ts";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  return { c, ctx };
}

const blobOf = (c: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((ok, fail) =>
    c.toBlob((b) => (b ? ok(b) : fail(new Error("encode failed"))), type, quality),
  );

/** Cut off the empty (white) margins of a rendered page, keeping a little padding (`at`: where the cut starts). */
function trim(src: HTMLCanvasElement, pad = 24, at = { left: 0, top: 0 }): HTMLCanvasElement {
  const ctx = src.getContext("2d")!;
  const { width: w, height: h } = src;
  const data = ctx.getImageData(0, 0, w, h).data;
  let top = h,
    left = w,
    right = -1,
    bottom = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i] < 231 || data[i + 1] < 231 || data[i + 2] < 231) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return src; // blank page
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(w - 1, right + pad);
  bottom = Math.min(h - 1, bottom + pad);
  Object.assign(at, { left, top });
  const { c, ctx: out } = canvas(right - left + 1, bottom - top + 1);
  out.drawImage(src, left, top, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

async function renderPdf(
  rel: string,
  scaleFor: (w: number, h: number) => number,
  only?: number,
  rows?: Row[][],
): Promise<HTMLCanvasElement[]> {
  const task = pdfjs.getDocument({ url: `/data/${rel}` });
  const doc = await task.promise;
  const out: HTMLCanvasElement[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      if (only !== undefined && n !== only + 1) continue;
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: scaleFor(base.width, base.height) });
      const { c, ctx } = canvas(viewport.width, viewport.height);
      await page.render({ canvas: c, canvasContext: ctx, viewport }).promise;
      out.push(c);
      if (rows) rows.push(await textRows(page, base));
    }
  } finally {
    await task.destroy();
  }
  return out;
}

/** The rows of text on a page, in points from its top left (for going to the source: src/sync.ts). */
async function textRows(page: pdfjs.PDFPageProxy, base: pdfjs.PageViewport): Promise<Row[]> {
  const boxes: Row[] = [];
  for (const item of (await page.getTextContent()).items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const t = pdfjs.Util.transform(base.transform, item.transform) as number[];
    const size = Math.hypot(t[2], t[3]);
    const [x, y] = [t[4], t[5]]; // the start of the baseline
    boxes.push({ left: x, right: x + item.width, top: y - 0.8 * size, bottom: y + 0.25 * size });
  }
  return rowsOf(boxes);
}

const render = {
  /** A photo or scan → JPEG, upright, long side at most maxSide. */
  async image(rel: string, maxSide: number): Promise<string> {
    const blob = await (await fetch(`/data/${rel}`)).blob();
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const { c, ctx } = canvas(bmp.width * s, bmp.height * s);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return await base64(await blobOf(c, "image/jpeg", 0.92));
  },

  /** Each sheet of a PDF → JPEG, long side maxSide. */
  async pdfPages(rel: string, maxSide: number): Promise<string[]> {
    const pages = await renderPdf(rel, (w, h) => maxSide / Math.max(w, h));
    return await Promise.all(pages.map(async (c) => await base64(await blobOf(c, "image/jpeg", 0.92))));
  },

  /** One sheet of a PDF (from 0) → JPEG, long side maxSide. */
  async pdfPage(rel: string, index: number, maxSide: number): Promise<string> {
    const [c] = await renderPdf(rel, (w, h) => maxSide / Math.max(w, h), index);
    if (!c) throw new Error(`no sheet ${index + 1}`);
    return await base64(await blobOf(c, "image/jpeg", 0.92));
  },

  /** A page's base picture as the user edited it (src/picture.ts) → JPEG, long side at most maxSide. */
  async edited(rel: string, edit: PictureEdit, maxSide: number): Promise<string> {
    const blob = await (await fetch(`/data/${rel}`)).blob();
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const c = drawEdited(bmp, edit, maxSide);
    bmp.close();
    return await base64(await blobOf(c, "image/jpeg", 0.92));
  },

  /** A compiled page → PNG per page at dpi, empty margins cut off, and where each sits on its page. */
  async preview(rel: string, dpi: number): Promise<{ png: string; sheet: Sheet }[]> {
    const rows: Row[][] = [];
    const pages = await renderPdf(rel, () => dpi / 72, undefined, rows);
    return await Promise.all(
      pages.map(async (c, i) => {
        const at = { left: 0, top: 0 };
        const cut = trim(c, 24, at);
        const sheet = { scale: dpi / 72, ...at, width: cut.width, height: cut.height, rows: rows[i] };
        return { png: await base64(await blobOf(cut, "image/png")), sheet };
      }),
    );
  },
};

(window as unknown as { render: typeof render }).render = render;
