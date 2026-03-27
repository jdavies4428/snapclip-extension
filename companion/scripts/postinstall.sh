#!/bin/zsh
set -euo pipefail

# Resolve the installing user (the person who ran the .pkg — not root)
INSTALL_USER=$(stat -f "%Su" /dev/console 2>/dev/null || echo "$USER")
INSTALL_HOME=$(dscl . -read /Users/"$INSTALL_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')

if [[ -z "$INSTALL_HOME" || ! -d "$INSTALL_HOME" ]]; then
  echo "snapclip-companion: could not resolve home directory for $INSTALL_USER" >&2
  exit 1
fi

COMPANION_LABEL="dev.llmclip.bridge"
SUPPORT_DIR="$INSTALL_HOME/Library/Application Support/LLM Clip Companion"
LOGS_DIR="$SUPPORT_DIR/logs"
BINARY_DEST="$SUPPORT_DIR/SnapClipBridge"
BINARY_SRC="/Library/Application Support/SnapClip/SnapClipBridge"
LAUNCH_AGENTS_DIR="$INSTALL_HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/$COMPANION_LABEL.plist"

# Create directories
mkdir -p "$SUPPORT_DIR" "$LOGS_DIR" "$LAUNCH_AGENTS_DIR"
chown -R "$INSTALL_USER" "$SUPPORT_DIR" "$LAUNCH_AGENTS_DIR"

# Copy and permission the bridge binary
cp "$BINARY_SRC" "$BINARY_DEST"
chmod 755 "$BINARY_DEST"
chown "$INSTALL_USER" "$BINARY_DEST"

# Write the LaunchAgent plist — points directly to the binary, no shell wrapper
cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$COMPANION_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BINARY_DEST</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SNAPCLIP_BRIDGE_HOST</key>
    <string>127.0.0.1</string>
    <key>SNAPCLIP_BRIDGE_PORT</key>
    <string>4311</string>
    <key>SNAPCLIP_BRIDGE_TOKEN</key>
    <string>snapclip-dev</string>
    <key>HOME</key>
    <string>$INSTALL_HOME</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOGS_DIR/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOGS_DIR/stderr.log</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
PLIST

chown "$INSTALL_USER" "$PLIST_PATH"
chmod 644 "$PLIST_PATH"

# Unload any previous version, then load
sudo -u "$INSTALL_USER" launchctl unload -w "$PLIST_PATH" 2>/dev/null || true
sudo -u "$INSTALL_USER" launchctl load -w "$PLIST_PATH"

echo "snapclip-companion: bridge installed and running for $INSTALL_USER"
echo "snapclip-companion: logs at $LOGS_DIR"
