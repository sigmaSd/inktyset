import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { resolveLang, Translator, typography } from "../src/i18n.ts";
import { parsePo, pluralRule, translations, writePo } from "../src/po.ts";
import { APP_LOCALES, appTemplate, merge, siteTemplate } from "../tools/i18n.ts";
import { render, SITE_LOCALES } from "../tools/site.ts";

const SHIPPED = ["fr", "ar"]; // complete in every release
const names = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

async function catalogs(dir: string) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".po"));
  return Promise.all(
    files.map(async (f) => ({ lang: f.slice(0, -3), cat: parsePo(await readFile(join(dir, f), "utf8")) })),
  );
}

const lf = (s: string) => s.replace(/\r\n/g, "\n"); // a Windows checkout without .gitattributes

test("i18n: the templates match the English in the code (run node tools/i18n.ts)", async () => {
  expect(lf(await readFile(join(APP_LOCALES, "inktyset.pot"), "utf8"))).toBe(writePo(appTemplate()));
  expect(lf(await readFile(join(SITE_LOCALES, "website.pot"), "utf8"))).toBe(writePo(await siteTemplate()));
});

test("i18n: every catalog is merged with its template", async () => {
  for (const [dir, pot] of [
    [APP_LOCALES, appTemplate()],
    [SITE_LOCALES, await siteTemplate()],
  ] as const)
    for (const { lang, cat } of await catalogs(dir)) {
      const keys = cat.entries.map((e) => e.ctx);
      expect(keys, `${dir}/${lang}.po`).toEqual(pot.entries.map((e) => e.ctx));
      expect(writePo(merge(cat, pot, lang))).toBe(writePo(cat));
    }
});

test("i18n: French and Arabic are complete, keep every {name}, and the app's hold no markup", async () => {
  for (const dir of [APP_LOCALES, SITE_LOCALES])
    for (const { lang, cat } of await catalogs(dir)) {
      const forms = pluralRule(cat.headers["Plural-Forms"]).count;
      for (const e of cat.entries) {
        const where = `${lang}.po ${e.ctx}`;
        if (SHIPPED.includes(lang)) {
          expect(e.fuzzy, where).toBe(false);
          expect(e.str.every(Boolean), where).toBe(true);
        }
        if (e.plural !== undefined) expect(e.str.length, where).toBe(forms);
        const english = new Set([...names(e.id), ...names(e.plural ?? "")]);
        for (const s of e.str.filter(Boolean)) {
          // a plural form may leave {n} out ("one page"); every other name must be there
          for (const n of english)
            if (n !== "n" || e.plural === undefined) expect(names(s), where).toContain(n);
          for (const n of names(s)) expect(english, where).toContain(n);
          if (dir === APP_LOCALES) expect(s, where).not.toMatch(/[<>"]/);
          else
            expect([...s.matchAll(/href="[^"]*"/g)].map(String).sort(), where).toEqual(
              [...e.id.matchAll(/href="[^"]*"/g)].map(String).sort(),
            );
        }
      }
    }
});

test("i18n: plural forms are chosen by the catalog's own rule", () => {
  const ar = pluralRule(
    "nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);",
  );
  expect([0, 1, 2, 5, 11, 100, 103].map(ar.pick)).toEqual([0, 1, 2, 3, 4, 5, 3]);
  expect(pluralRule("nplurals=2; plural=(n > 1);").pick(1)).toBe(0);
  expect(pluralRule("nplurals=2; plural=(n > 1);").pick(0)).toBe(0);
});

test("i18n: a translator falls back to English, picks plurals, ignores markup, spaces French", () => {
  const source = { hi: "Hello {name}", pages: { one: "{n} page", other: "{n} pages" }, bad: "Safe" };
  const tr = new Translator("fr", source, {
    plural: "nplurals=2; plural=(n > 1);",
    strings: { hi: "Bonjour {name} !", pages: ["{n} page", "{n} pages"], bad: '<img src="x">' },
  });
  expect(tr.t("hi", { name: "Ada" })).toBe("Bonjour Ada !");
  expect(tr.t("pages", { n: 0 })).toBe("0 page");
  expect(tr.t("pages", { n: 3 })).toBe("3 pages");
  expect(tr.t("bad")).toBe("Safe");
  expect(new Translator("de", source, null).t("pages", { n: 1 })).toBe("1 page");
  expect(typography("fr", "« Oui » : non")).toBe("« Oui » : non");
});

test("i18n: the app's language follows the setting, else the computer's", () => {
  const have = ["en", "fr", "ar"];
  expect(resolveLang("ar", ["fr-FR"], have)).toBe("ar");
  expect(resolveLang("auto", ["fr-FR", "en-US"], have)).toBe("fr");
  expect(resolveLang("auto", ["nl-NL"], have)).toBe("en");
  expect(resolveLang("de", ["ar-TN"], have)).toBe("ar"); // a language no longer there: the computer's
});

test("i18n: catalogs round-trip through the writer, multi-line text included", () => {
  const cat = {
    headers: { Language: "fr", "Plural-Forms": "nplurals=2; plural=(n > 1);" },
    entries: [
      {
        ctx: "a",
        id: 'Say "hi"\nthen go',
        str: ["Dis « salut »\npuis va"],
        fuzzy: false,
        comments: ["note"],
      },
      {
        ctx: "b",
        id: "{n} file",
        plural: "{n} files",
        str: ["{n} fichier", "{n} fichiers"],
        fuzzy: true,
        comments: [],
        previous: "old",
      },
    ],
  };
  const back = parsePo(writePo(cat));
  expect(back.headers).toEqual(cat.headers);
  expect(back.entries).toEqual(cat.entries);
  expect(translations(back).strings).toEqual({ a: "Dis « salut »\npuis va" }); // fuzzy: left out
});

test("i18n: the website's Arabic page is right to left, one folder down, with the language menu", async () => {
  const template = await readFile(join(SITE_LOCALES, "..", "..", "site", "index.html"), "utf8");
  const ar = translations(parsePo(await readFile(join(SITE_LOCALES, "ar.po"), "utf8"))).strings as Record<
    string,
    string
  >;
  const html = render(template, "ar", ar, ["en", "ar", "fr"]);
  expect(html).toContain('<html lang="ar" dir="rtl">');
  expect(html).toContain('href="../style.css"');
  expect(html).toContain('src="../screenshots/list-dark.png"');
  expect(html).toContain('href="#why"');
  expect(html).toContain('<a href="../fr/" hreflang="fr" lang="fr">Français</a>');
  expect(html).toContain(ar.privacyTitle);
  expect(html).not.toContain("Batch and private");
});
