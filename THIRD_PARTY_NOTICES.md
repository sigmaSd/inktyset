# Third-party notices

hand2tex is free software under the GNU General Public License, version 3 or later ([LICENSE](LICENSE)). It
is built on the work of others, listed here with their licenses. Each package's full license text is in its
own distribution (and in `node_modules/<package>/` in a checkout).

## Included in the app

**Runtime:** [Electron](https://www.electronjs.org) 45 (MIT), with Chromium and Node.js; their own license
files ship inside every installer (`LICENSE`, `LICENSES.chromium.html`).

**The window** (bundled into `app/ui/dist/`):

| Package | License |
|---|---|
| [CodeMirror](https://codemirror.net) 6: `@codemirror/autocomplete`, `commands`, `language`, `legacy-modes`, `search`, `state`, `streamparser`, `view` | MIT, © Marijn Haverbeke and others |
| [Lezer](https://lezer.codemirror.net): `@lezer/common`, `highlight`, `lr`; `style-mod`, `w3c-keyname`, `crelt`, `@marijn/find-cluster-break` | MIT, © Marijn Haverbeke |
| [PDF.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist`) | Apache-2.0, © Mozilla Foundation |

**The main process** (bundled into `dist/app/electron.mjs`):

| Package | License |
|---|---|
| [folder-camera-receiver](https://github.com/sigmaSd/folder-camera) | GPL-3.0-or-later |
| `@peculiar/x509`, `@peculiar/asn1-*`, `@peculiar/utils`, `pvtsutils`, `pvutils` | MIT, © PeculiarVentures |
| `asn1js` | BSD-3-Clause, © PeculiarVentures |
| `reflect-metadata` | Apache-2.0, © Microsoft |
| `tsyringe` | MIT, © Microsoft |
| `tslib` | 0BSD, © Microsoft |
| `qrcode`, `dijkstrajs`, `pngjs`, `yargs` and its helpers (`cliui`, `yargs-parser`, `y18n`, `camelcase`, `decamelize`, `find-up`, `locate-path`, `p-limit`, `p-locate`, `p-try`, `path-exists`, `require-directory`, `require-main-filename`, `get-caller-file`, `set-blocking`, `which-module`, `string-width`, `strip-ansi`, `ansi-regex`, `ansi-styles`, `color-convert`, `color-name`, `emoji-regex`, `is-fullwidth-code-point`, `wrap-ansi`) | MIT or ISC |
| `electron-updater`, `builder-util-runtime`, `fs-extra`, `graceful-fs`, `jsonfile`, `universalify`, `js-yaml`, `lazy-val`, `lodash.escaperegexp`, `lodash.isequal`, `semver`, `debug`, `ms`, `sax`, `tiny-typed-emitter` | MIT, ISC or BlueOak-1.0.0 |
| `argparse` (via `js-yaml`) | Python-2.0 |

## Downloaded on first use

hand2tex downloads these from their publishers when it needs them (checked against pinned SHA-256 sums); they
are not part of the installers.

| Component | License | Source |
|---|---|---|
| [llama.cpp](https://github.com/ggml-org/llama.cpp) server, release b12061 | MIT, © The ggml authors | GitHub releases of ggml-org/llama.cpp |
| [Qwen3.5-9B](https://huggingface.co/Qwen) vision model, Q4_K_M quantization and its image encoder | Apache-2.0, © Alibaba Cloud (Qwen team); GGUF files by [Unsloth](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF) | Hugging Face, unsloth/Qwen3.5-9B-GGUF |
| [Tectonic](https://tectonic-typesetting.github.io) 0.17.0 (only when no working LaTeX is installed) | MIT, © the Tectonic Project | GitHub releases of tectonic-typesetting/tectonic |

Tectonic in turn fetches the TeX packages and fonts a page uses from its TeX Live-based bundle, under their
own licenses (mostly the LaTeX Project Public License; fonts such as Amiri under the SIL Open Font License).

## Not shipped

Build tools (Vite+, TypeScript, electron-builder and their dependencies) are used to build hand2tex and are
not part of the app.
