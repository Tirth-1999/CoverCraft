#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$ROOT/build/extension"
ZIP="$ROOT/site/downloads/CoverCraft-extension.zip"

command -v rg >/dev/null 2>&1 || {
  echo "ripgrep (rg) is required for release secret scanning." >&2
  exit 1
}

rm -rf "$STAGE"
mkdir -p "$STAGE/src" "$(dirname "$ZIP")"

cp "$ROOT/manifest.json" "$STAGE/"
cp -R "$ROOT/icons" "$ROOT/vendor" "$STAGE/"
cp -R "$ROOT/src/background" "$ROOT/src/content" "$ROOT/src/dashboard" "$ROOT/src/options" "$ROOT/src/popup" "$ROOT/src/shared" "$ROOT/src/tools" "$STAGE/src/"
cp "$ROOT/src/config.defaults.js" "$ROOT/src/firebase.defaults.js" "$ROOT/src/portfolio.defaults.js" "$STAGE/src/"

if find "$STAGE" -type f \( -name 'config.js' -o -name 'firebase.js' -o -name 'portfolio.js' -o -name '*.env*' \) | grep -q .; then
  echo "Refusing to package local configuration or personal data." >&2
  exit 1
fi

if rg -n --hidden '(sk-or-v1-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9_-]{16,}|tvly-[A-Za-z0-9_-]{16,})' "$STAGE"; then
  echo "Refusing to package a provider API key." >&2
  exit 1
fi

rm -f "$ZIP"
(cd "$STAGE" && zip -qr "$ZIP" .)
unzip -t "$ZIP" >/dev/null

archive_entries="$(unzip -Z1 "$ZIP")"
for required in \
  manifest.json \
  src/background/background.js \
  src/content/content.js \
  src/config.defaults.js \
  src/firebase.defaults.js; do
  grep -Fxq "$required" <<<"$archive_entries" || {
    echo "Release archive is missing $required." >&2
    exit 1
  }
done

echo "Built $ZIP"
