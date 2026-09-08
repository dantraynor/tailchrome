#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

ditto -x -k "${1:-$ROOT/dist/tailchrome-helper-macos-user.zip}" "$TEST_DIR/extracted"
APP="$TEST_DIR/extracted/Tailchrome Helper.app"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")" = \
  org.tesseras.tailchrome.helper.user
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")" = \
  tailchrome-helper
for bin in tailchrome-helper tailscale-browser-ext; do
  test -x "$APP/Contents/MacOS/$bin"
  lipo "$APP/Contents/MacOS/$bin" -verify_arch arm64 x86_64
done
test "$("$APP/Contents/MacOS/tailscale-browser-ext" -version)" = "${2:-0.0.0}"
xcrun clang -fobjc-arc -Wall -Wextra -framework Cocoa \
  "$ROOT/packaging/macos/per-user-launcher.test.m" -o "$TEST_DIR/launcher-test"
"$TEST_DIR/launcher-test"
