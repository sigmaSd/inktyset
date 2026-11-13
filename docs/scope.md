# What hand2tex is for (decided 2026-11-13)

**Handwritten pages in, a typeset document you can trust out. Math first; other handwriting welcome.**

## Why not "photo in, text out"

Any chat model or OCR tool turns one photo into text. On that alone hand2tex would lose: bigger models in the
cloud read better. What they don't give, and what hand2tex is built around, is the path from a *stack* of
handwritten pages to a document you can rely on:

- **Batch, private:** hundreds of pages read in order, overnight if needed, on your own computer.
- **Proven to compile:** every page is compiled and shown rendered, not just as text that looks right.
- **Proofreading as a workflow:** the scan next to the rendered page (Compare view, linked zoom), the model's
  `[??]` where it couldn't read, a "checked" mark per page and progress over the whole document.
- **Faithful:** the model is told never to "fix" the math or complete steps; chat models do.
- **Learns from corrections:** the model's untouched answer is kept next to the corrected page, to improve the
  instructions from real mistakes.

## Inputs

Mathematics is the hardest case and the reason to choose hand2tex, so it leads: the instructions, the
completion, the preamble are math-first. Other handwriting (prose, lecture notes, lists, tables) is read too,
and should come out as clean LaTeX without math markup where there is no math.

## Outputs

Formats that compile, because the compile-and-compare check is the point:

- **LaTeX:** now.
- **Typst:** next. A single small compiler that compiles in milliseconds (the preview could follow typing),
  growing among students; also spares Typst users any TeX installation.
- Perhaps Markdown with math, for light notes.

Not plain text or HTML: nothing to check them against, and that is generic OCR.

## Name

"hand2tex" no longer fits once Typst arrives. The name should say the outcome (a clean, typeset copy of your
notes), not the input or one format. To pick before the first public release, when renaming is still cheap
(package and product name, app ID, data folders with migration, menu entry, README, repository).
