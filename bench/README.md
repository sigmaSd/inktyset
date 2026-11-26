# Reading benchmark

Handwritten pages with a known right answer, read by several local models (and engine settings) exactly as
Inktyset reads a page, then timed and scored the way Compare models scores a reading against a checked page:
the share of the LaTeX that differs, spaces aside (src/diff.ts `distance`; 0% is the same text).

```sh
cp bench/models.example.json bench/models.json   # then point it at the models on this computer
node tools/bench.ts                              # every page, every model
node tools/bench.ts --pages kalika-60 --models inkling
```

Each run is saved in `bench/runs/<time>/`: `results.json` (timings, memory, scores), each model's text and
thinking, and the engines' logs. A table is printed at the end. It uses the engine Inktyset downloaded
(`--engine` for another `llama-server`), takes the graphics card for itself (don't read pages in Inktyset
meanwhile), and the computer's memory: run it capped, for example
`systemd-run --user --scope -p MemoryMax=24G -p MemorySwapMax=0 node tools/bench.ts`.

## Pages

`pages.json` lists them: where each comes from (a PDF, downloaded once and checked against its checksum), its
license, and what is on it. A page is turned into what Inktyset sends the model: a JPEG, quality 0.92, long side
1600 pixels (`pdftoppm` does it, from poppler-utils), kept in `bench/cache/`.

`answers/<id>.tex` is the page's right answer, written by hand from the page by Inktyset's rules
(src/pipeline.ts `PROMPT`): exactly what is written, printed headers, footers and watermarks left out,
crossed-out writing omitted, `align*` for multi-line computations, `\section*` for headings. A page without one
is timed, not scored.

The pages of the English Handwritten Math Notes Dataset are by HumynLabs and its contributors, under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the answers here are transcriptions of them.

## Models

`models.json` (this computer's, not in git) lists what to run: a name, the model and its vision file (`~` for
the home folder), and optionally `engine`, an engine profile as Compare models' columns have
(src/engine-profile.ts: `ctx`, `ubatch`, `opOffload`, `kvType`…).
