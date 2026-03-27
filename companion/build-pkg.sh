#!/bin/zsh
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
COMPANION_DIR="$REPO_ROOT/companion"
DIST_DIR="$COMPANION_DIR/dist"
PKG_STAGE="$COMPANION_DIR/pkg-stage"

VERSION=$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo "0.1.0")
PKG_NAME="SnapClipBridge-$VERSION.pkg"
BINARY_INSTALL_DIR="$PKG_STAGE/Library/Application Support/SnapClip"

echo "==> Building SnapClip companion installer v$VERSION"

# Clean previous build
rm -rf "$DIST_DIR" "$PKG_STAGE"
mkdir -p "$DIST_DIR" "$BINARY_INSTALL_DIR" "$COMPANION_DIR/scripts"

# Step 1: Compile the bridge to a standalone binary
echo "==> Compiling bridge binary (bun --compile)..."
cd "$REPO_ROOT"
bun build --compile bridge/index.js \
  --outfile "$BINARY_INSTALL_DIR/SnapClipBridge" \
  --target bun-darwin-$(uname -m | sed 's/x86_64/x64/;s/arm64/arm64/')

chmod 755 "$BINARY_INSTALL_DIR/SnapClipBridge"
echo "    Binary: $(du -sh "$BINARY_INSTALL_DIR/SnapClipBridge" | cut -f1)"

# Step 2: Build the .pkg using macOS pkgbuild
echo "==> Building .pkg..."
pkgbuild \
  --root "$PKG_STAGE" \
  --scripts "$COMPANION_DIR/scripts" \
  --identifier "dev.llmclip.companion" \
  --version "$VERSION" \
  --install-location "/" \
  "$DIST_DIR/$PKG_NAME"

echo ""
echo "==> Done: $DIST_DIR/$PKG_NAME"
echo "    $(du -sh "$DIST_DIR/$PKG_NAME" | cut -f1)"
echo ""
echo "Install with:"
echo "    open $DIST_DIR/$PKG_NAME"
