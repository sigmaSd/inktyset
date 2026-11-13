// Drawing a page's picture as edited (src/picture.ts): in the Edit picture dialog (main.js) and in the image
// worker that makes the picture the model sees (worker.ts). One function, so what the user sees is what's read.

import { frameSize, type PictureEdit } from "../../src/picture.ts";

type Source = HTMLCanvasElement | HTMLImageElement | ImageBitmap;

/** The picture turned and straightened, on white, at `scale` (before any crop). */
export function drawFrame(src: Source, e: PictureEdit, scale = 1): HTMLCanvasElement {
  const { W, H } = frameSize(src.width, src.height, e);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(W * scale));
  c.height = Math.max(1, Math.round(H * scale));
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff"; // the corners straightening uncovers: white, like paper
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = "high";
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(((e.rotate + e.angle) * Math.PI) / 180);
  ctx.scale(scale, scale);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/** The picture as edited: turned, straightened, cropped, long side at most `maxSide`. */
export function drawEdited(src: Source, e: PictureEdit, maxSide: number): HTMLCanvasElement {
  const frame = drawFrame(src, e);
  const cr = e.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const sx = cr.x * frame.width,
    sy = cr.y * frame.height,
    sw = cr.w * frame.width,
    sh = cr.h * frame.height;
  const s = Math.min(1, maxSide / Math.max(sw, sh));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * s));
  c.height = Math.max(1, Math.round(sh * s));
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}
