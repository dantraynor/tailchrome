#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

VERSION="${VERSION:-$(git describe --tags --always 2>/dev/null || echo dev)}"
VERSION_PKG="${VERSION#v}"
VERSION_PKG="${VERSION_PKG%%-*}"
if [[ -z "$VERSION_PKG" || "$VERSION_PKG" == "dev" ]]; then
  VERSION_PKG="0.0.0"
fi

NFPM="${NFPM:-}"
if [[ -z "$NFPM" ]] && command -v nfpm >/dev/null 2>&1; then
  NFPM="$(command -v nfpm)"
fi
if [[ -z "$NFPM" ]] && command -v go >/dev/null 2>&1; then
  GOPATH="$(go env GOPATH 2>/dev/null || true)"
  if [[ -n "$GOPATH" && -x "$GOPATH/bin/nfpm" ]]; then
    NFPM="$GOPATH/bin/nfpm"
  fi
fi
if [[ -z "$NFPM" || ! -x "$NFPM" ]]; then
  echo "nFPM is required. Install it with: go install github.com/goreleaser/nfpm/v2/cmd/nfpm@latest" >&2
  exit 1
fi

if [[ ! -f "$ROOT/dist/tailscale-browser-ext-linux-amd64" ]]; then
  echo "Missing dist/tailscale-browser-ext-linux-amd64. Run make host-all first." >&2
  exit 1
fi

mkdir -p "$ROOT/dist"

echo "Building Linux packages (version $VERSION_PKG)..."
VERSION="$VERSION_PKG" "$NFPM" package \
  -f "$ROOT/packaging/linux/nfpm.yaml" \
  -p deb \
  -t "$ROOT/dist/tailchrome-helper-linux-amd64.deb"

VERSION="$VERSION_PKG" "$NFPM" package \
  -f "$ROOT/packaging/linux/nfpm.yaml" \
  -p rpm \
  -t "$ROOT/dist/tailchrome-helper-linux-x86_64.rpm"

echo "Done:"
echo "  $ROOT/dist/tailchrome-helper-linux-amd64.deb"
echo "  $ROOT/dist/tailchrome-helper-linux-x86_64.rpm"
