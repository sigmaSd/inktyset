<p align="center"><img src="app/icon.svg" width="96" alt=""></p>

# Inktyset

**Handwritten pages in, a typeset document you can trust out.** Math first; other handwriting (prose, lecture
notes, lists, tables) works too. Everything runs on your own computer.

Add photos, scans or PDFs of your notes. Inktyset reads each page with a local vision model, compiles it, and
shows the scan next to the LaTeX and the rendered page, so you can proofread page by page, then copy the
LaTeX (or Typst) into your thesis or save one file. Nothing you add leaves your computer.

**[Download](https://sigmasd.github.io/inktyset/)** · Linux, Windows, macOS

![The page list: each page's scan, its LaTeX in a highlighting editor, and the compiled preview](docs/screenshots/list-light.png)

## Why not just paste a photo into a chat?

A chat model reads one photo. Inktyset is built for the whole stack of pages:

- **Batch and private:** hundreds of pages read in order, overnight if needed, on your machine.
- **Proven to compile:** every page is compiled and shown rendered, not just text that looks right.
- **Proofreading as a workflow:** the Compare view puts the scan and the rendered page side by side (one
  above the other for a single formula) with linked zoom and scrolling, the editor beside them; `[??]` marks
  what the model couldn't read; a "checked" mark per page tracks your progress.
- **Faithful:** the model is told never to fix your math or complete steps. Chat models happily "correct" it.

![The Compare view: the handwritten formula above, its compiled LaTeX below, the editor on the right](docs/screenshots/compare-formula-dark.png)

## Features

- **Pages in:** drag in photos or PDFs; scan with a scanner (Linux, macOS); or send photos from your phone
  with [Folder Camera](https://github.com/sigmaSd/folder-camera) (optional, off by default).
- **A real LaTeX editor:** highlighting, matching brackets, search, and completion of commands and
  environments (`\fr` → `\frac{}{}`, `\begin{align*}` … `\end{align*}`).
- **Languages:** English by default; French, Arabic (right to left), German, Spanish, Italian, Portuguese,
  Turkish, or any other language for the prose. The math is unaffected and nothing is translated.
- **LaTeX or Typst:** choose the output in the header. Pages are converted to [Typst](https://typst.app)
  from the model's LaTeX, instantly, and switch back just as fast. The preview uses the LaTeX or Typst
  installed on your computer when it works, otherwise a built-in one
  ([Tectonic](https://tectonic-typesetting.github.io), Typst) downloaded once.
  ([docs/scope.md](docs/scope.md) says what Inktyset is, and isn't, for.)

## Requirements

- About **8 GB of free memory** for the model.
- A **graphics chip** with Vulkan (Linux, Windows) or Apple Silicon (Metal) for speed: a page then takes a
  minute or two. Without one, the processor reads it, much more slowly. Inktyset checks your computer and
  tells you what to expect.
- On first start Inktyset downloads the engine ([llama.cpp](https://github.com/ggml-org/llama.cpp), about
  36 MB) and the model ([Qwen3.5 9B](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF), 6.6 GB). Downloads
  resume after an interruption and are checked before use. Already have the model files? Point Inktyset to
  them.

The installers are not signed: see the [download page](https://sigmasd.github.io/inktyset/) for how to open
an unsigned app on Windows and macOS.

## Development

Electron, TypeScript and [Vite+](https://viteplus.dev) (`vp`), with pnpm.

```sh
vp install          # dependencies
vp hooks enable     # once: format, lint and type-check at each commit
vp run dev          # build and start, printing a link that opens the window in a normal browser
bin/inktyset        # start from this checkout, rebuilding first if the code changed
vp lint             # lint and type-check
vp test             # tests
vp run dist         # installers for this system, into dist/packages/
```

- `src/`: Inktyset itself (pages, queue, model, LaTeX, downloads, phone, scanner, hardware check) and the
  local server the window talks to.
- `shell/electron/`: the Electron shell (window, menus, updates, the hidden window that renders images and
  PDFs).
- `app/ui/`: the window. `tools/`: screenshots. `docs/`: decisions.

`INKTYSET_DATA` and `INKTYSET_USERDATA` move the pages folder and the app's own files, for testing;
`--no-window` starts without opening the window. Releases are built by CI for every `v*` tag.

## License

GPL-3.0-or-later ([LICENSE](LICENSE)). Inktyset builds on llama.cpp, Qwen, Tectonic, PDF.js, CodeMirror,
Electron and more: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
