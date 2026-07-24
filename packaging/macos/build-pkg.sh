#!/usr/bin/env bash
# Build tailscale-browser-ext as a universal macOS binary, then a flat .pkg that installs:
#   - /Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext
#   - /Applications/Tailchrome Helper.app  (repair/re-run fallback)
# and runs a postinstall script that registers native messaging for the logged-in user.
#
# Usage: from repo root, ./packaging/macos/build-pkg.sh
# Optional: VERSION=1.2.3 ./packaging/macos/build-pkg.sh
#
# Signing (optional): set MACOS_SIGN_APPLICATION_IDENTITY and
# MACOS_SIGN_INSTALLER_IDENTITY (see packaging/macos/README.md).

set -euo pipefail
export COPYFILE_DISABLE=1

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

VERSION="${VERSION:-$(git describe --tags --always 2>/dev/null || echo dev)}"
TS_VERSION="${TS_VERSION:-$(cd host && go list -m -f '{{.Version}}' tailscale.com | sed 's/^v//')}"
HOST_LDFLAGS="-X main.version=${VERSION} -X tailscale.com/version.shortStamp=${TS_VERSION} -X tailscale.com/version.longStamp=${TS_VERSION}"
# pkgbuild --version expects a simple dotted string (no git metadata)
VERSION_PKG="${VERSION#v}"
VERSION_PKG="${VERSION_PKG%%-*}"
if [[ -z "$VERSION_PKG" || "$VERSION_PKG" == "dev" ]]; then
  VERSION_PKG="0.0.0"
fi
PKG_ID="org.tesseras.tailchrome.helper"
OUT_NAME="tailchrome-helper-macos.pkg"
DIST_DIR="$ROOT/dist"
HOST_DIR="$ROOT/host"
STAGE="$ROOT/packaging/macos/.pkg-stage-$$"

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

mkdir -p "$DIST_DIR" "$STAGE/pkgroot/Library/Application Support/Tailscale/BrowserExt" "$STAGE/pkgroot/Applications" "$STAGE/scripts"

echo "Building universal binary (version $VERSION)..."
(
  cd "$HOST_DIR"
  GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -ldflags "$HOST_LDFLAGS" -o "$STAGE/tailscale-browser-ext-arm64" .
  GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "$HOST_LDFLAGS" -o "$STAGE/tailscale-browser-ext-amd64" .
)
lipo -create -output "$STAGE/pkgroot/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext" \
  "$STAGE/tailscale-browser-ext-arm64" \
  "$STAGE/tailscale-browser-ext-amd64"
chmod 755 "$STAGE/pkgroot/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext"

echo "Staging Tailchrome Helper.app..."
cp -R "$ROOT/packaging/macos/TailchromeHelper.app" "$STAGE/pkgroot/Applications/Tailchrome Helper.app"
chmod 755 "$STAGE/pkgroot/Applications/Tailchrome Helper.app/Contents/MacOS/tailchrome-helper"
APP_PLIST="$STAGE/pkgroot/Applications/Tailchrome Helper.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION_PKG" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION_PKG" "$APP_PLIST"

echo "Staging postinstall script..."
cp "$ROOT/packaging/macos/scripts/postinstall" "$STAGE/scripts/postinstall"
chmod 755 "$STAGE/scripts/postinstall"

# Optional: Developer ID signing (requires Apple Developer Program)
if [[ -n "${MACOS_SIGN_APPLICATION_IDENTITY:-}" ]]; then
  echo "Signing binaries with: $MACOS_SIGN_APPLICATION_IDENTITY"
  codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_APPLICATION_IDENTITY" \
    "$STAGE/pkgroot/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext"
  codesign --force --options runtime --timestamp --deep --sign "$MACOS_SIGN_APPLICATION_IDENTITY" \
    "$STAGE/pkgroot/Applications/Tailchrome Helper.app"
fi

# Avoid packaging AppleDouble sidecar files when local files have extended
# attributes or resource forks. Run after signing too, because signing tools can
# touch extended attributes.
if command -v xattr >/dev/null 2>&1; then
  xattr -cr "$STAGE/pkgroot" "$STAGE/scripts"
fi
if command -v dot_clean >/dev/null 2>&1; then
  dot_clean -m "$STAGE/pkgroot"
  dot_clean -m "$STAGE/scripts"
fi
find "$STAGE/pkgroot" "$STAGE/scripts" -name '._*' -type f -delete

PKG_PATH="$DIST_DIR/$OUT_NAME"
echo "Writing $PKG_PATH ..."

# Disable bundle relocation so the .app always lands in /Applications,
# even if macOS finds a bundle with the same CFBundleIdentifier elsewhere
# (e.g. a developer's repo checkout).
pkgbuild --analyze --root "$STAGE/pkgroot" "$STAGE/component.plist"
/usr/libexec/PlistBuddy -c "Set :0:BundleIsRelocatable false" "$STAGE/component.plist"

pkgbuild \
  --root "$STAGE/pkgroot" \
  --identifier "$PKG_ID" \
  --version "$VERSION_PKG" \
  --install-location / \
  --ownership recommended \
  --component-plist "$STAGE/component.plist" \
  --scripts "$STAGE/scripts" \
  --filter '\.DS_Store$' \
  --filter '(^|/)\.svn($|/)' \
  --filter '(^|/)CVS($|/)' \
  --filter '(^|/)\._[^/]*$' \
  "$PKG_PATH"

if [[ -n "${MACOS_SIGN_INSTALLER_IDENTITY:-}" ]]; then
  echo "Signing installer package..."
  UNSIGNED="$PKG_PATH.unsigned"
  mv "$PKG_PATH" "$UNSIGNED"
  productsign --sign "$MACOS_SIGN_INSTALLER_IDENTITY" --timestamp "$UNSIGNED" "$PKG_PATH"
  rm -f "$UNSIGNED"
fi

echo "Done: $PKG_PATH"
