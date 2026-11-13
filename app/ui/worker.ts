// The hidden page that does hand2tex's image and PDF work (called from shell/electron/render.ts): files are
// fetched from the data folder (/files/...), results returned as base64.

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

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

/** Cut off the empty (white) margins of a rendered page, keeping a little padding. */
function trim(src: HTMLCanvasElement, pad = 24): HTMLCanvasElement {
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
  const { c, ctx: out } = canvas(right - left + 1, bottom - top + 1);
  out.drawImage(src, left, top, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

async function renderPdf(
  rel: string,
  scaleFor: (w: number, h: number) => number,
): Promise<HTMLCanvasElement[]> {
  const task = pdfjs.getDocument({ url: `/files/${rel}` });
  const doc = await task.promise;
  const out: HTMLCanvasElement[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: scaleFor(base.width, base.height) });
      const { c, ctx } = canvas(viewport.width, viewport.height);
      await page.render({ canvas: c, canvasContext: ctx, viewport }).promise;
      out.push(c);
    }
  } finally {
    await task.destroy();
  }
  return out;
}

const render = {
  /** A photo or scan → JPEG, upright, long side at most maxSide. */
  async image(rel: string, maxSide: number): Promise<string> {
    const blob = await (await fetch(`/files/${rel}`)).blob();
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

  /** A compiled page → PNG per page at dpi, empty margins cut off. */
  async preview(rel: string, dpi: number): Promise<string[]> {
    const pages = await renderPdf(rel, () => dpi / 72);
    return await Promise.all(pages.map(async (c) => await base64(await blobOf(trim(c), "image/png"))));
  },
};

(window as unknown as { render: typeof render }).render = render;
