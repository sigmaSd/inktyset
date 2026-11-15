# Inktyset on Flathub

The Flatpak is built from `flatpak/io.github.sigmasd.inktyset.yml`. It differs from the other packages in one
way: Flathub doesn't allow an app to download programs when it runs, so llama.cpp's `llama-server` (Vulkan),
Tectonic and Typst are built from source as modules of the manifest and shipped in `/app/bin`. Inktyset finds
them there (`src/components.ts`, `bundledDir`: `/app/bin` when `FLATPAK_ID` is set, or the folder
`INKTYSET_BUNDLED` names), uses them, and never offers to download them. Only the model (6.6 GB, Hugging Face)
is downloaded on first start. The AppImage, .deb, .rpm, Windows and macOS packages download all four as before.

| File in `flatpak/` | What it is |
| --- | --- |
| `io.github.sigmasd.inktyset.yml` | the manifest |
| `io.github.sigmasd.inktyset.metainfo.xml` | the AppStream description: summary, screenshots, releases |
| `io.github.sigmasd.inktyset.desktop` | the launcher |
| `generate-sources.sh` | makes the offline sources below |
| `pnpm-url-keys.py` | run by the build: makes the generator's offline pnpm store findable by pnpm 12 for a package installed by URL (folder-camera-receiver), which the generator keys as `<integrity>\t<name>@<url>` where pnpm 12 looks up `<integrity>\t<url>` |
| `node-sources.json`, `tectonic-cargo-sources.json`, `typst-cargo-sources.json` | generated, not in git here: they go in the Flathub repo next to the manifest |

## Inside the sandbox

- **Permissions:** network (the model's download, Tectonic's LaTeX packages, the phone and network scanners
  on the local Wi-Fi), Wayland with X11 as fallback, `--device=all` (the window and Vulkan for llama-server,
  and USB scanners: Flatpak has no narrower permission for USB devices), Avahi on the system bus (finding
  network scanners), notifications, and `~/Documents/Inktyset` (the default pages folder). Other files and
  folders are opened through the file chooser portal.
- **LaTeX:** a TeX installed on the computer is invisible in the sandbox, so the previews always use the
  bundled Tectonic (Settings → LaTeX shows it as included).
- **Typst:** the bundled one, even if the computer has another.
- **Updates:** Inktyset's own updater is off (`shell/electron/updates.ts` only updates an AppImage, and
  `APPIMAGE` is unset in a Flatpak); Flathub updates it.
- **Scanner:** the manifest builds SANE (`sane-backends`, the drivers for most USB scanners) and
  `sane-airscan` (driverless network scanners: eSCL and WSD, most recent printers that scan), so the Scan
  button works as on the other packages. Scanners that need a vendor's own driver installed on the computer
  (some Epson and Brother models, HP's plugin) aren't seen. To try scanning without a scanner, SANE's virtual
  one: `flatpak run --env=SANE_CONFIG_DIR=<a folder whose dll.conf says test> io.github.sigmasd.inktyset`.

## Build it locally

Needs `flatpak-builder` and the Flathub remote. Once:

```bash
flatpak install --user flathub org.freedesktop.Sdk//26.08 org.electronjs.Electron2.BaseApp//26.08 org.freedesktop.Sdk.Extension.rust-stable//26.08 org.freedesktop.Sdk.Extension.node24//26.08 org.flatpak.Builder
```

Make the offline sources (again whenever `pnpm-lock.yaml` or a pinned version changes):

```bash
PYTHON=/usr/bin/python3 flatpak/generate-sources.sh
```

(`PYTHON` when the `python3` on your PATH lacks aiohttp, tomlkit or PyYAML, as a project's virtualenv may.)

Build and install with Flathub's own builder (`org.flatpak.Builder`; on Fedora the system `flatpak-builder`
1.18.2 fails copying the Electron BaseApp with "lsetxattr(security.selinux): Operation not supported"). With
`--jobs=4` the whole build fits in 3 GB of memory:

```bash
systemd-run --user --scope --quiet -p MemoryMax=3G -p MemorySwapMax=0 flatpak run org.flatpak.Builder --user --install --force-clean --jobs=4 --mirror-screenshots-url=https://dl.flathub.org/media/ --state-dir=$HOME/dev/tmp/flatpak-state --repo=$HOME/dev/tmp/flatpak-repo $HOME/dev/tmp/flatpak-build flatpak/io.github.sigmasd.inktyset.yml
```

The manifest builds the release tag it names. To build the checkout instead, replace the `inktyset` module's
`git` source with `type: dir` and `path: ..` in a copy of the manifest (Flathub doesn't accept `dir` sources).

Try it with its data in scratch folders, never on the real pages:

```bash
flatpak run --env=INKTYSET_DATA=$HOME/dev/tmp/ink-data --env=INKTYSET_USERDATA=$HOME/dev/tmp/ink-user --filesystem=$HOME/dev/tmp io.github.sigmasd.inktyset
```

Check it: the setup screen offers only the model; Settings → LaTeX and Typst say "Included with Inktyset.".
That llama-server sees the graphics card inside the sandbox:

```bash
flatpak run --command=llama-server io.github.sigmasd.inktyset --list-devices
```

Lint, as Flathub's CI does:

```bash
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest flatpak/io.github.sigmasd.inktyset.yml
```

```bash
ostree commit --repo=$HOME/dev/tmp/flatpak-repo --canonical-permissions --branch=screenshots/x86_64 $HOME/dev/tmp/flatpak-build/files/share/app-info/media
```

```bash
flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo $HOME/dev/tmp/flatpak-repo
```

The manifest lints clean. The repo check reports `appstream-external-screenshot-url` and
`appstream-remote-icon-not-mirrored` on a local build: the composer writes the mirrored paths relative to
`media_baseurl="https://dl.flathub.org/media/"`, and the linter compares each path itself with that address.
Flathub's builders mirror the screenshots and icon themselves, so these two don't apply there.

## Submit it

1. Release a version whose tag contains `flatpak/` and the bundled-programs change (0.9.8 or later), and point
   the manifest's `inktyset` source at that tag and its commit.
2. Fork [flathub/flathub](https://github.com/flathub/flathub) and branch from its `new-pr` branch.
3. Add, at the top of that branch: the manifest and the three generated `*-sources.json`.
4. Open a pull request against `new-pr`, titled "Add io.github.sigmasd.inktyset". In the description, say why
   the permissions are needed (the list above) and that the programs are built from source while the model
   (data, not a program) is downloaded on first start.
5. Comment `bot, build` on the PR for a test build; answer the reviewers. Once merged, Flathub creates
   `flathub/io.github.sigmasd.inktyset`, where every later update goes.

The app id `io.github.sigmasd.inktyset` is verified by the GitHub account `sigmaSd` owning the repository.

## At each release

In `flathub/io.github.sigmasd.inktyset` (and the copy in `flatpak/` here):

1. The `inktyset` module's source: the new `tag` and `commit`.
2. `flatpak/io.github.sigmasd.inktyset.metainfo.xml`: a `<release version="…" date="…">` at the top, with a
   sentence or two on what changed. It ships in the tag, so add it before tagging.
3. If `pnpm-lock.yaml` changed: `flatpak/generate-sources.sh` and the new `node-sources.json`.
4. If `package.json`'s `packageManager` moved to another pnpm: the two `@pnpm/exe.*` archives (URL and sha512,
   from `https://registry.npmjs.org/@pnpm/exe.linux-x64/<version>`).

The bundled programs move together with `src/components.ts`. When a release changes one there:

- `LLAMA` (llama.cpp): the `llama-server` module's archive URL and sha256, and `-DLLAMA_BUILD_NUMBER`. If the
  Vulkan backend wants newer SPIRV-Headers, the `spirv-headers` module too.
- `TECTONIC_URL`: the `tectonic` archive and sha256, `TECTONIC=` in `generate-sources.sh`, then run it for a new
  `tectonic-cargo-sources.json`.
- `TYPST_URL`: the same for `typst` (`TYPST_VERSION`, `TYPST=` in `generate-sources.sh`).

`sane-backends` and `sane-airscan` (scanning) don't follow Inktyset's versions: move them when they release
(Flathub's bot proposes `sane-airscan` updates through its `x-checker-data`).

`sha256sum` of the downloaded tarball gives the sha256. Each year, when a new freedesktop runtime comes out
(26.08, 27.08…), move `runtime-version`, `base-version` and the SDK extensions to it together.
