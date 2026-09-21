#!/usr/bin/env bash
# Test, build, and install this fork into an Obsidian vault as a separate
# plugin ("content-publisher-privacat"), so community-store updates of the
# original plugin never overwrite it.
#
# Usage: scripts/deploy-vault.sh [--skip-tests]
#   OBSIDIAN_VAULT  vault directory (default: ~/Obsidian)
set -euo pipefail

cd "$(dirname "$0")/.."

VAULT="${OBSIDIAN_VAULT:-$HOME/Obsidian}"
PLUGIN_ID="content-publisher-privacat"
DEST="$VAULT/.obsidian/plugins/$PLUGIN_ID"

if [ ! -d "$VAULT/.obsidian" ]; then
  echo "No Obsidian vault at $VAULT (set OBSIDIAN_VAULT)" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "==> Installing dependencies"
  npm ci --no-audit --no-fund --ignore-scripts
fi

if [ "${1:-}" != "--skip-tests" ]; then
  echo "==> Running tests"
  npm test --silent
fi

echo "==> Building"
npm run build --silent

UPSTREAM_VERSION="$(node -p 'require("./manifest.json").version')"
COMMIT="$(git rev-parse --short HEAD)"
DIRTY=""
git diff --quiet HEAD -- src main.ts || DIRTY="-dirty"
VERSION="$UPSTREAM_VERSION-privacat.$COMMIT$DIRTY"

echo "==> Installing $VERSION into $DEST"
mkdir -p "$DEST/_backups"
# Keep the previous build so a bad deploy can be rolled back by copying it back
[ -f "$DEST/main.js" ] && cp "$DEST/main.js" "$DEST/_backups/main.js.previous"
cp main.js styles.css "$DEST/"

node -e '
  const fs = require("fs");
  const [src, dest, id, version] = process.argv.slice(1);
  const m = JSON.parse(fs.readFileSync(src, "utf8"));
  Object.assign(m, {
    id,
    name: "Content Publisher (patched)",
    version,
    description: "Local fork of " + m.name + " " + m.version + ". Not updated from the community store."
  });
  fs.writeFileSync(dest, JSON.stringify(m, null, 2) + "\n");
' manifest.json "$DEST/manifest.json" "$PLUGIN_ID" "$VERSION"

echo "==> Done. Restart Obsidian (or disable and re-enable the plugin) to load $VERSION."
