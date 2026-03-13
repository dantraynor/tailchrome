#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "=== Installing deps ==="
npm ci --silent

echo "=== Type checking ==="
npx tsc --noEmit

echo "=== Running tests ==="
npx vitest run

echo "=== Building extension ==="
npm run build

echo ""
echo "=== All checks passed ==="
echo "Reload unpacked extension from: $(pwd)/dist/"
