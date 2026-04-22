#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Memory Guard.app"
APP_BUNDLE_DIR="$ROOT_DIR/src-tauri/target/release/bundle/macos"
APP_PATH="$APP_BUNDLE_DIR/$APP_NAME"
DMG_DIR="$ROOT_DIR/src-tauri/target/release/bundle/dmg"
VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
DMG_NAME="Memory Guard_${VERSION}_aarch64.dmg"
DMG_PATH="$DMG_DIR/$DMG_NAME"

if [[ ! -d "$APP_PATH" ]]; then
  echo "App bundle not found: $APP_PATH" >&2
  exit 1
fi

mkdir -p "$DMG_DIR"
rm -f "$DMG_PATH"

STAGING_DIR="$(mktemp -d /tmp/memory-guard-dmg.XXXXXX)"
cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

cp -R "$APP_PATH" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"

hdiutil create \
  -volname "Memory Guard" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

echo "Created DMG: $DMG_PATH"
