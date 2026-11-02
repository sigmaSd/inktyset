#!/usr/bin/env bash
# Start the local vision model for hand2tex on the Radeon 760M (Vulkan).
# Listens on 127.0.0.1:8080 only. Stop with Ctrl+C.
#
#   ./start-server.sh            -> Qwen3.5-9B  (default, ~7 GB RAM)
#   QUANT=Q8_0 ./start-server.sh -> 9B at Q8_0 instead of Q4_K_M (download it first)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER="$HOME/dev/lab/llama.cpp/build-vulkan/bin/llama-server"
export TMPDIR="$HOME/dev/tmp"

case "${1:-9b}" in
  9b)
    MODEL="$HERE/models/Qwen3.5-9B-${QUANT:-Q4_K_M}.gguf"
    MMPROJ="$HERE/models/mmproj-F16.gguf"
    EXTRA=(-ngl 99)
    ;;
  *) echo "usage: $0 [9b]" >&2; exit 1 ;;
esac

for f in "$MODEL" "$MMPROJ" "$SERVER"; do
  [[ -e "$f" ]] || { echo "missing: $f" >&2; exit 1; }
done

exec "$SERVER" \
  -m "$MODEL" --mmproj "$MMPROJ" \
  "${EXTRA[@]}" -c 12288 -np 1 \
  --host 127.0.0.1 --port 8080 \
  --jinja --reasoning-budget 0 \
  --no-webui
