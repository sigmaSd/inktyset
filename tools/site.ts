// The website in every language: site/index.html is the English page and the template. Its translatable
// parts carry data-t="key" (the element's content), data-t-content / data-t-alt (an attribute), and the
// <script id="t"> JSON holds downloads.js's words. Translations are locales/site/<code>.po (they may keep the
// English's links and <b>/<code> tags). The GitHub Pages workflow runs this:
//   node tools/site.ts [out]   → out/ (default _site/): the English page, out/<code>/index.html for each
//                                language, and the shared files.
// tools/i18n.ts takes the English from here (extract) for locales/site/website.pot.

import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRtlLang, nativeName, typography } from "../src/i18n.ts";
import { parsePo, translations } from "../src/po.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SITE = join(ROOT, "site");
export const SITE_LOCALES = join(ROOT, "locales", "site");
const URL_BASE = "https://sigmasd.github.io/inktyset/";

// (a closing tag may be split over lines by the formatter: </a\n>)
const ELEMENT = /<(\w+)([^>]*?)\sdata-t="([\w.-]+)"([^>]*)>([\s\S]*?)<\/\1\s*>/g;
const ATTR = /<[^>]*?\sdata-t-(content|alt)="([\w.-]+)"[^>]*>/g;
const JSON_BLOCK = /(<script type="application\/json" id="t">)([\s\S]*?)(<\/script>)/;

// one line, and no space before a tag's ">" (the formatter writes <a href="…"\n>…</a\n>)
const tidy = (html: string) =>
  html
    .replace(/\s+/g, " ")
    .replace(/(<[^<>]*?) >/g, "$1>")
    .trim();

/** The page's English: key → text (HTML for elements). */
export function extract(template: string): Map<string, string> {
  const out = new Map<string, string>();
  const add = (k: string, v: string) => {
    if (out.has(k) && out.get(k) !== v) throw new Error(`site: key "${k}" used twice with different text`);
    out.set(k, v);
  };
  for (const m of template.matchAll(ELEMENT)) {
    if (/data-t[=-]/.test(m[5])) throw new Error(`site: data-t="${m[3]}" holds another translated part`);
    add(m[3], tidy(m[5]));
  }
  for (const m of template.matchAll(ATTR)) {
    const value = new RegExp(`\\s${m[1]}="([^"]*)"`).exec(m[0]);
    if (!value) throw new Error(`site: data-t-${m[1]} without ${m[1]}=""`);
    add(m[2], tidy(value[1]));
  }
  const json = JSON_BLOCK.exec(template);
  if (json)
    for (const [k, v] of Object.entries(JSON.parse(json[2]) as Record<string, string>)) add(`js.${k}`, v);
  return out;
}

/** The page in one language: translated parts (English where a translation is missing), paths one level up. */
export function render(template: string, lang: string, strings: Record<string, string>, langs: string[]) {
  const tr = (k: string, english: string) => {
    const s = strings[k];
    return s ? typography(lang, s) : english;
  };
  let html = template.replace(
    ELEMENT,
    (_, tag: string, a: string, key: string, b: string, inner: string) =>
      `<${tag}${a} data-t="${key}"${b}>${tr(key, inner)}</${tag}>`,
  );
  html = html.replace(ATTR, (tag: string, attr: string, key: string) =>
    tag.replace(new RegExp(`(\\s${attr}=")([^"]*)(")`), (_, p: string, v: string, q: string) => {
      const s = tr(key, v);
      return p + s.replace(/"/g, "&quot;") + q;
    }),
  );
  html = html.replace(JSON_BLOCK, (_, open: string, body: string, close: string) => {
    const words = JSON.parse(body) as Record<string, string>;
    for (const k of Object.keys(words)) words[k] = tr(`js.${k}`, words[k]);
    return open + JSON.stringify(words).replace(/</g, "\\u003c") + close;
  });
  const dir = isRtlLang(lang) ? ' dir="rtl"' : "";
  html = html.replace(/<html lang="en">/, `<html lang="${lang}"${dir}>`);
  const up = lang === "en" ? "" : "../";
  if (up)
    // a page one folder down: its links to the shared files go up a level
    html = html.replace(
      /\s(src|href)="(?!https?:|#|mailto:|\/|\.\.\/)([^"]+)"/g,
      (_, a: string, p: string) => ` ${a}="${up}${p}"`,
    );
  const href = (l: string) => (l === lang ? "./" : up + (l === "en" ? "" : `${l}/`));
  const menu = langs
    .map((l) =>
      l === lang
        ? `<span aria-current="true">${nativeName(l)}</span>`
        : `<a href="${href(l)}" hreflang="${l}" lang="${l}">${nativeName(l)}</a>`,
    )
    .join("");
  html = html.replace(
    /<span class="langs" id="langs"><\/span>/,
    `<span class="langs" id="langs">${menu}</span>`,
  );
  const alternates = langs
    .map((l) => `<link rel="alternate" hreflang="${l}" href="${URL_BASE}${l === "en" ? "" : `${l}/`}" />`)
    .join("\n    ");
  return html.replace("</head>", `  ${alternates}\n  </head>`);
}

/** Every language's strings (locales/site/<code>.po). */
export async function siteCatalogs(): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  for (const f of await readdir(SITE_LOCALES).catch(() => [] as string[])) {
    const m = /^([a-z]{2,3}(?:[-_][A-Za-z]+)?)\.po$/.exec(f);
    if (!m) continue;
    const strings = translations(parsePo(await readFile(join(SITE_LOCALES, f), "utf8"))).strings;
    out[m[1].replace("_", "-")] = Object.fromEntries(
      Object.entries(strings).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  }
  return out;
}

async function build(out: string) {
  const template = await readFile(join(SITE, "index.html"), "utf8");
  const catalogs = await siteCatalogs();
  const langs = ["en", ...Object.keys(catalogs).sort()];
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(SITE, out, { recursive: true });
  await writeFile(join(out, "index.html"), render(template, "en", {}, langs));
  for (const [lang, strings] of Object.entries(catalogs)) {
    await mkdir(join(out, lang), { recursive: true });
    await writeFile(join(out, lang, "index.html"), render(template, lang, strings, langs));
  }
  console.log(`site: ${langs.join(", ")} → ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await build(process.argv[2] ?? join(ROOT, "_site"));
