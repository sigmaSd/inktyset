// Keeps the translation files in step with the English in the code (docs/translating.md):
//   node tools/i18n.ts            write locales/{app,site}/*.pot from the English, and merge them into each .po
//                                 (new entries empty; changed English marked fuzzy, its old text kept "#|")
//   node tools/i18n.ts --new nl   start a language: locales/app/nl.po and locales/site/nl.po
// Weblate does the merging by itself too; tests/i18n.test.ts fails when a template is out of date.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UI_NOTES, UI_SOURCE } from "../app/ui/i18n.ts";
import { CORE_SOURCE, type Source } from "../src/i18n.ts";
import { type Catalog, type PoEntry, parsePo, pluralRule, writePo } from "../src/po.ts";
import { extract, SITE, SITE_LOCALES } from "./site.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const APP_LOCALES = join(ROOT, "locales", "app");

/** Plural rules of the languages we know; others start with English's (Weblate corrects them). */
export const PLURAL_FORMS: Record<string, string> = {
  en: "nplurals=2; plural=(n != 1);",
  fr: "nplurals=2; plural=(n > 1);",
  ar: "nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);",
  de: "nplurals=2; plural=(n != 1);",
  es: "nplurals=2; plural=(n != 1);",
  it: "nplurals=2; plural=(n != 1);",
  pt: "nplurals=2; plural=(n > 1);",
  tr: "nplurals=2; plural=(n != 1);",
};

const HEADERS = (project: string, lang = "") => ({
  "Project-Id-Version": project,
  "Report-Msgid-Bugs-To": "https://github.com/sigmaSd/inktyset/issues",
  Language: lang,
  "MIME-Version": "1.0",
  "Content-Type": "text/plain; charset=UTF-8",
  "Content-Transfer-Encoding": "8bit",
  "Plural-Forms": PLURAL_FORMS[lang] ?? PLURAL_FORMS.en,
});

function entry(ctx: string, src: Source, note?: string): PoEntry {
  const comments = note ? [note] : [];
  return typeof src === "string"
    ? { ctx, id: src, str: [""], fuzzy: false, comments }
    : { ctx, id: src.one, plural: src.other, str: ["", ""], fuzzy: false, comments };
}

/** locales/app/inktyset.pot: the core's messages, then the window's. */
export function appTemplate(): Catalog {
  const notes = UI_NOTES as Record<string, string>;
  const keys = new Set<string>();
  const entries: PoEntry[] = [];
  for (const [k, v] of [...Object.entries(CORE_SOURCE), ...Object.entries(UI_SOURCE)] as [string, Source][]) {
    if (keys.has(k)) throw new Error(`i18n: key "${k}" is both in src/i18n.ts and app/ui/i18n.ts`);
    keys.add(k);
    entries.push(entry(k, v, notes[k]));
  }
  return { headers: HEADERS("Inktyset"), entries };
}

/** locales/site/website.pot: the website's English (site/index.html). */
export async function siteTemplate(): Promise<Catalog> {
  const english = extract(await readFile(join(SITE, "index.html"), "utf8"));
  const entries = [...english].map(([k, v]) =>
    entry(
      k,
      v,
      /<[a-z]/.test(v) ? "Keep the HTML tags (links, <b>, <code>) around the same words" : undefined,
    ),
  );
  return { headers: HEADERS("Inktyset website"), entries };
}

/** A language's catalog brought up to date with the template. */
export function merge(po: Catalog, pot: Catalog, lang: string): Catalog {
  const forms = pluralRule(po.headers["Plural-Forms"] ?? PLURAL_FORMS[lang]).count;
  const old = new Map(po.entries.map((e) => [e.ctx, e]));
  const entries = pot.entries.map((t): PoEntry => {
    const e = old.get(t.ctx);
    const size = t.plural !== undefined ? forms : 1;
    const str = Array.from({ length: size }, (_, i) => e?.str[i] ?? "");
    if (!e || str.every((s) => !s)) return { ...t, str, fuzzy: false, previous: undefined };
    const changed = e.id !== t.id || e.plural !== t.plural;
    return {
      ...t,
      str,
      fuzzy: e.fuzzy || changed,
      previous: changed ? e.id : e.fuzzy ? e.previous : undefined,
    };
  });
  return { headers: { ...HEADERS(pot.headers["Project-Id-Version"], lang), ...po.headers }, entries };
}

async function update(dir: string, potName: string, pot: Catalog, newLang?: string) {
  await writeIfChanged(join(dir, potName), writePo(pot));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".po"));
  if (newLang && !files.includes(`${newLang}.po`)) files.push(`${newLang}.po`);
  for (const f of files) {
    const lang = f.slice(0, -3);
    const text = await readFile(join(dir, f), "utf8").catch(() => "");
    const po = text ? parsePo(text) : { headers: {}, entries: [] };
    await writeIfChanged(join(dir, f), writePo(merge(po, pot, lang)));
  }
}

async function writeIfChanged(path: string, text: string) {
  if ((await readFile(path, "utf8").catch(() => "")) === text) return;
  await writeFile(path, text);
  console.log(`wrote ${path}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf("--new");
  const newLang = i > 0 ? process.argv[i + 1] : undefined;
  if (i > 0 && !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(newLang ?? ""))
    throw new Error("--new needs a code like nl or pt_BR");
  await update(APP_LOCALES, "inktyset.pot", appTemplate(), newLang);
  await update(SITE_LOCALES, "website.pot", await siteTemplate(), newLang);
}
