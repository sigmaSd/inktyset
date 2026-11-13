import { expect, test } from "vite-plus/test";
import { frameSize, isNoEdit, sanitizeEdit, turnCrop } from "../src/picture.ts";

test("picture: an edit from the window is made safe", () => {
  expect(sanitizeEdit({ rotate: -90, angle: 40, crop: { x: -1, y: 0.5, w: 3, h: 0 } })).toEqual({
    rotate: 270,
    angle: 15,
    crop: { x: 0, y: 0.5, w: 1, h: 0.05 },
  });
  expect(sanitizeEdit({ rotate: "x", angle: Number.NaN, crop: "no" })).toEqual({
    rotate: 0,
    angle: 0,
    crop: null,
  });
  // the whole picture is no crop, and no edit at all
  const whole = sanitizeEdit({ rotate: 360, angle: 0, crop: { x: 0, y: 0, w: 1, h: 1 } });
  expect(isNoEdit(whole)).toBe(true);
});

test("picture: turned a quarter, a picture swaps its sides; straightened, it grows to keep its corners", () => {
  expect(frameSize(400, 300, { rotate: 90, angle: 0, crop: null })).toEqual({ W: 300, H: 400 });
  const { W, H } = frameSize(400, 300, { rotate: 0, angle: 10, crop: null });
  expect(W).toBeGreaterThan(400);
  expect(H).toBeGreaterThan(300);
});

test("picture: a crop stays on the same part of the page as the picture turns", () => {
  const c = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  // the top-left part of a page, turned clockwise, is at its top right
  expect(turnCrop({ x: 0, y: 0, w: 0.5, h: 0.5 }, 1)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
  let d = c;
  for (let i = 0; i < 4; i++) d = turnCrop(d, 1)!;
  for (const k of ["x", "y", "w", "h"] as const) expect(d[k]).toBeCloseTo(c[k]);
  const back = turnCrop(turnCrop(c, 1), -1)!;
  for (const k of ["x", "y", "w", "h"] as const) expect(back[k]).toBeCloseTo(c[k]);
});
