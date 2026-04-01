#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.2.0"
  exit 1
fi

VERSION="$1"

# Validate version format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: version must be in semver format (e.g. 0.2.0)"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Update package.json files
for pkg in shared chrome firefox; do
  FILE="$ROOT/packages/$pkg/package.json"
  sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$FILE"
  echo "Updated $FILE"
done

# Update manifest.json files
for pkg in chrome firefox; do
  FILE="$ROOT/packages/$pkg/manifest.json"
  sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$FILE"
  echo "Updated $FILE"
done

echo ""
echo "Version updated to $VERSION in all 5 files."
echo "Don't forget to commit and tag: git tag v$VERSION"
