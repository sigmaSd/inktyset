# Inktyset

Turn handwritten pages into a typeset document you can trust, on your own computer. Math first; other
handwriting (prose, lecture notes, lists, tables) works too.

Add photos, scans or PDFs of your notes. Inktyset reads each page with a local vision model and shows the
scan next to the LaTeX and a compiled preview, so you can proofread and fix it page by page, then copy the
LaTeX into your document. Nothing you add leaves your computer. Typst output is planned; see
[docs/scope.md](docs/scope.md) for what Inktyset is (and isn't) for.

- **Pages in:** drag in photos or PDFs, scan with a scanner (Linux, macOS), or send photos from your phone
  with [Folder Camera](https://github.com/sigmaSd/folder-camera) (optional, off by default).
- **Proofreading:** a Compare view shows the scan and the preview together (stacked for single formulas,
  side by side for full pages) with linked zoom and scrolling, the editor beside them, and a "checked" mark
  per page with a counter.
- **Languages:** English by default; French, Arabic, German, Spanish, Italian, Portuguese, Turkish, or any
  other language for the prose. The math is unaffected and nothing is translated.
- **LaTeX:** the preview uses the LaTeX installed on your computer when it works (TeX Live, MiKTeX, MacTeX),
  otherwise a built-in one ([Tectonic](https://tectonic-typesetting.github.io)) downloaded once.

## Requirements

- About 8 GB of free memory for the model.
- A graphics chip with Vulkan (Linux, Windows) or Apple Silicon (Metal) for speed: a page then takes a minute
  or two. Without one, the processor reads it, much more slowly.
- On first start Inktyset downloads the engine
  ([llama.cpp](https://github.com/ggml-org/llama.cpp), about 36 MB) and the model
  ([Qwen3.5 9B](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF), 6.6 GB; Apache-2.0). Downloads resume after
  an interruption and are checked before use. If you already have the model files, point Inktyset to them.

## Development

Electron, TypeScript and [Vite+](https://viteplus.dev) (`vp`), with pnpm.

```sh
vp install          # dependencies
vp run dev          # build and start, printing a link that opens the window in a normal browser
bin/inktyset        # start from this checkout, rebuilding first if the code changed
vp lint             # lint and type-check
vp run dist         # installers for this system, into dist/packages/
```

- `src/`: Inktyset itself (pages, queue, model, LaTeX, downloads, phone, scanner) and the local server the
  window talks to.
- `shell/electron/`: the Electron shell (windows, dialogs, the hidden window that renders images and PDFs).
- `app/ui/`: the window.

`INKTYSET_DATA` and `INKTYSET_USERDATA` move the pages folder and the app's own files, for testing;
`--no-window` starts without opening the window.

## License

GPL-3.0-or-later.
