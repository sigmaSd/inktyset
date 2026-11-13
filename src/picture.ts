// A page's picture as the user fixed it (Edit picture): turned by quarter turns, straightened by a few degrees,
// cropped. Kept as these few numbers on the page, never applied to the original: the picture the model sees
// (scans/<id>.jpg) is made again from the page's base picture (scans/<id>.base.jpg, from the file as it was
// added) each time, so an edit can always be changed or undone. The drawing itself is app/ui/picture.ts, the
// same code in the window's preview and in the image worker.

/** A crop, as fractions of the turned and straightened picture. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PictureEdit {
  /** Quarter turns, clockwise. */
  rotate: 0 | 90 | 180 | 270;
  /** Straightening, in degrees, clockwise. */
  angle: number;
  crop: Crop | null;
}

export const NO_EDIT: PictureEdit = { rotate: 0, angle: 0, crop: null };
/** How far the straightening goes, either way. */
export const MAX_ANGLE = 15;
/** The smallest crop, as a fraction of the picture. */
const MIN_CROP = 0.05;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown, or: number) => (typeof v === "number" && Number.isFinite(v) ? v : or);

/** An edit from the window, made safe: known turns, a bounded angle, a crop inside the picture. */
export function sanitizeEdit(e: unknown): PictureEdit {
  const o = (e ?? {}) as Record<string, unknown>;
  const turns = Math.round(finite(o.rotate, 0) / 90);
  const rotate = ((((turns % 4) + 4) % 4) * 90) as PictureEdit["rotate"];
  const angle = Math.round(clamp(finite(o.angle, 0), -MAX_ANGLE, MAX_ANGLE) * 10) / 10;
  let crop: Crop | null = null;
  if (o.crop && typeof o.crop === "object") {
    const c = o.crop as Record<string, unknown>;
    const x = clamp(finite(c.x, 0), 0, 1 - MIN_CROP);
    const y = clamp(finite(c.y, 0), 0, 1 - MIN_CROP);
    const w = clamp(finite(c.w, 1), MIN_CROP, 1 - x);
    const h = clamp(finite(c.h, 1), MIN_CROP, 1 - y);
    // the whole picture is no crop
    if (x > 0.001 || y > 0.001 || w < 0.999 || h < 0.999) crop = { x, y, w, h };
  }
  return { rotate, angle, crop };
}

export const isNoEdit = (e: PictureEdit) => e.rotate === 0 && e.angle === 0 && !e.crop;

/** The size of a w × h picture once turned and straightened (its bounding box: the corners are filled white). */
export function frameSize(w: number, h: number, e: PictureEdit): { W: number; H: number } {
  const [rw, rh] = e.rotate % 180 ? [h, w] : [w, h];
  const a = (Math.abs(e.angle) * Math.PI) / 180;
  return {
    W: Math.round(rw * Math.cos(a) + rh * Math.sin(a)),
    H: Math.round(rw * Math.sin(a) + rh * Math.cos(a)),
  };
}

/** A crop kept on the same part of the page when the picture turns a quarter (clockwise if `dir` is 1). */
export function turnCrop(c: Crop | null, dir: 1 | -1): Crop | null {
  if (!c) return null;
  return dir === 1
    ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w }
    : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
}
