# Translating Inktyset

Inktyset speaks English, French and Arabic. Adding a language takes no programming: you translate sentences
in a `.po` file, the standard format of translation tools.

There are two files per language:

- `locales/app/<code>.po`: the app (buttons, messages, settings). About 230 short sentences.
- `locales/site/<code>.po`: the website. About 60 paragraphs.

`<code>` is the language's code: `de` German, `es` Spanish, `pt_BR` Brazilian Portuguese, `fa` Persian…

## The easy way: Poedit

1. Install [Poedit](https://poedit.net) (free, Windows, macOS, Linux).
2. Download the template: [`locales/app/inktyset.pot`](../locales/app/inktyset.pot) (and
   [`locales/site/website.pot`](../locales/site/website.pot) for the website).
3. In Poedit: **Create new translation**, open the template, choose your language.
4. Translate. Poedit shows each English sentence and saves the `.po` file.
5. Send the file: [open an issue](https://github.com/sigmaSd/inktyset/issues/new) and attach it, or open a
   pull request that adds it to `locales/app/` (or `locales/site/`).

To improve an existing language, open its `.po` file in Poedit instead of the template.

## What to keep as it is

- **Words in braces**, like `{n}`, `{file}` or `{f}`, are filled in by the app (a number, a file name, the
  word LaTeX or Typst). Keep them, in the place your sentence needs them. The note above an entry says what
  each one is.
- **Plurals**: some entries have a form per count ("1 page", "2 pages"). Poedit shows one box per form your
  language has. A form may leave out `{n}` when the word says the number ("one page").
- **Names** stay as they are: Inktyset, LaTeX, Typst, Tectonic, Folder Camera, llama.cpp, Qwen, Wi-Fi.
- **The website's HTML**: keep the tags (`<a href="…">`, `<b>`, `<code>`) around the same words. Links
  must stay exactly the same.
- No `<`, `>` or `"` in the app's sentences (use your language's quotation marks, like « » or „ “).

## Testing your translation

Put your file in `locales/app/` of a copy of the source, then follow the README's "Build from source". In
Settings → Language of the app, your language appears. Right-to-left languages (Arabic, Persian, Hebrew,
Urdu) turn the window around by themselves.

## For maintainers

The English is in the code: `src/i18n.ts` (the core's messages), `app/ui/i18n.ts` (the window's words, with
notes for translators), `site/index.html` (each translated part has `data-t="key"`). The key is each
entry's `msgctxt`, so changing the English keeps the translation, marked fuzzy (shown in English until a
translator confirms it).

- `node tools/i18n.ts` writes the templates from the English and merges them into every `.po`.
- `node tools/i18n.ts --new nl` starts a language.
- `node tools/site.ts` builds the website in every language into `_site/` (the Pages workflow does this).
- `vp test` fails when a template is out of date, or when French or Arabic misses an entry or a `{name}`.

The project can also be connected to [Weblate](https://hosted.weblate.org) (free for free software), so
translators work in the browser: one component per folder, file format "gettext PO", file mask
`locales/app/*.po` with template `locales/app/inktyset.pot` (and the same for `locales/site/` with
`website.pot`).
