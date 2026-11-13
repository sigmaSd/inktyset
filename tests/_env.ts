// Imported first by every test that touches files: a scratch folder per test worker, under node_modules/.cache,
// so tests never read or write the real pages (~/Documents/Inktyset) or the app's own files.

import { mkdirSync, rmSync } from "node:fs";

const base = new URL("../node_modules/.cache/inktyset-tests/", import.meta.url).pathname;
export const TMP = `${base}worker-${process.env.VITEST_POOL_ID ?? 0}`;

/** A fresh, empty folder for one test. */
export function scratch(name: string) {
  const dir = `${TMP}/${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}
