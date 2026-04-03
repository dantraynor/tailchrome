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

FILE="$ROOT/packages/extension/package.json"
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$FILE"
echo "Updated $FILE"

CONSTANTS="$ROOT/packages/shared/src/constants.ts"
sed -i '' "s/EXPECTED_HOST_VERSION = \"[^\"]*\"/EXPECTED_HOST_VERSION = \"$VERSION\"/" "$CONSTANTS"
echo "Updated $CONSTANTS"

echo ""
echo "Version updated to $VERSION in packages/extension/package.json and constants.ts."
echo "Don't forget to commit and tag: git tag v$VERSION"
