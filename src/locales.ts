// The app's translations, read from locales/app/*.po when the app starts (in the package: inside app.asar).
// A new <code>.po file there is a new language in the settings: nothing else to change.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePo, translations, type Translations } from "./po.ts";

export async function loadLocales(dir: string): Promise<Record<string, Translations>> {
  const out: Record<string, Translations> = {};
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    return out; // no catalogs: English only
  }
  for (const f of files) {
    const m = /^([a-z]{2,3}(?:[-_][A-Za-z]+)?)\.po$/.exec(f);
    if (!m) continue;
    try {
      out[m[1].replace("_", "-")] = translations(parsePo(await readFile(join(dir, f), "utf8")));
    } catch (e) {
      console.error(`${f}: ${(e as Error).message}`); // a broken catalog: that language is left out
    }
  }
  return out;
}
