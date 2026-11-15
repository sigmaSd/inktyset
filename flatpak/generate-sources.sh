#!/bin/sh
# Make the Flatpak's offline sources (docs/flathub.md), next to the manifest:
#   node-sources.json            Inktyset's pnpm dependencies (pnpm-lock.yaml)
#   tectonic-cargo-sources.json  Tectonic's crates (its Cargo.lock, at the version src/components.ts pins)
#   typst-cargo-sources.json     Typst's crates (likewise)
# Run it again whenever pnpm-lock.yaml or a pinned version changes. It needs git, curl and a Python with aiohttp,
# tomlkit and PyYAML (Fedora: python3-aiohttp python3-tomlkit python3-pyyaml).
set -eu

TECTONIC=0.17.0 # src/components.ts TECTONIC_URL
TYPST=0.15.1    # src/components.ts TYPST_URL

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
work=${WORK:-$HOME/dev/tmp/inktyset-flatpak-sources}
mkdir -p "$work"

tools=$work/flatpak-builder-tools
[ -d "$tools" ] || git clone --depth 1 https://github.com/flatpak/flatpak-builder-tools.git "$tools"

mkdir -p "$work/tectonic" "$work/typst"
curl -fsSL -o "$work/tectonic/Cargo.lock" \
  "https://raw.githubusercontent.com/tectonic-typesetting/tectonic/tectonic%40$TECTONIC/Cargo.lock"
curl -fsSL -o "$work/typst/Cargo.lock" "https://raw.githubusercontent.com/typst/typst/v$TYPST/Cargo.lock"

cd "$work"
python3 -I "$tools/cargo/flatpak-cargo-generator.py" "$work/tectonic/Cargo.lock" -o "$here/tectonic-cargo-sources.json"
python3 -I "$tools/cargo/flatpak-cargo-generator.py" "$work/typst/Cargo.lock" -o "$here/typst-cargo-sources.json"
# pnpm 12 writes store v11 (the generator's README)
PYTHONPATH="$tools/node" python3 -m flatpak_node_generator pnpm "$repo/pnpm-lock.yaml" \
  --pnpm-store-version v11 -o "$here/node-sources.json"
