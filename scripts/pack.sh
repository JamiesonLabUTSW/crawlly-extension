#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./manifest.json').version")"
OUT_DIR="dist"
OUT_FILE="$OUT_DIR/ethos-irb-exporter-v${VERSION}.zip"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

zip -r "$OUT_FILE" \
  manifest.json \
  background.js \
  popup.html \
  popup.js \
  popup.css \
  README.md \
  -x "*.DS_Store"

echo "created $OUT_FILE"
