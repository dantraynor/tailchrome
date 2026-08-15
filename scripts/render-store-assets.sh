#!/usr/bin/env bash
# Renders the store-assets HTML templates to PNG with headless Chrome.
# Requires Google Chrome (macOS). No npm dependencies.
#
# Usage: scripts/render-store-assets.sh [name ...]
#   With no arguments, renders every asset. Pass one or more template
#   basenames (e.g. "screenshot-1-hero") to render only those.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS="$ROOT/store-assets"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [[ ! -x "$CHROME" ]]; then
  echo "error: Google Chrome not found at $CHROME" >&2
  exit 1
fi

render() {
  local name="$1" width="$2" height="$3" scale="$4"
  local html="file://$ASSETS/$name.html"
  local out="$ASSETS/$name.png"
  "$CHROME" \
    --headless=new \
    --disable-gpu \
    --hide-scrollbars \
    --force-device-scale-factor="$scale" \
    --window-size="$width,$height" \
    --virtual-time-budget=10000 \
    --screenshot="$out" \
    "$html" >/dev/null 2>&1
  echo "rendered $name.png (${width}x${height} @${scale}x)"
}

render_all() {
  render screenshot-1-hero       1280 800 1
  render screenshot-2-popup      1280 800 1
  render screenshot-3-features   1280 800 1
  render screenshot-4-exit-nodes 1280 800 1
  render screenshot-5-actions    1280 800 1
  render promo-marquee           1400 560 1
  render promo-small              440 280 1
  render readme-popup             360 540 2
  render readme-popup-exit-nodes  360 540 2
}

if [[ $# -gt 0 ]]; then
  for name in "$@"; do
    case "$name" in
      screenshot-*)    render "$name" 1280 800 1 ;;
      promo-marquee)   render "$name" 1400 560 1 ;;
      promo-small)     render "$name"  440 280 1 ;;
      readme-*)        render "$name"  360 540 2 ;;
      *) echo "error: unknown asset '$name'" >&2; exit 1 ;;
    esac
  done
else
  render_all
fi
