#!/usr/bin/env bash
# Install the built desktop app for the current user (no FUSE needed): copies release/linux-unpacked to
# ~/.local/lib/office, the icon to the hicolor theme, and an office.desktop launcher to the applications
# menu and the Desktop folder. Run `pnpm --filter @office/desktop dist` first.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x release/linux-unpacked/office ] || { echo "release/linux-unpacked missing; run: pnpm --filter @office/desktop dist" >&2; exit 1; }
APP="$HOME/.local/lib/office"
mkdir -p "$APP" "$HOME/.local/share/icons/hicolor/512x512/apps" "$HOME/.local/share/applications"
rsync -a --delete release/linux-unpacked/ "$APP/"
cp assets/icon.png "$HOME/.local/share/icons/hicolor/512x512/apps/office.png"
ENTRY="$HOME/.local/share/applications/office.desktop"
cat > "$ENTRY" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Office
Comment=Claude Agent Office
Exec=$APP/office %U
Icon=office
Terminal=false
Categories=Development;
StartupWMClass=office
DESKTOP
chmod +x "$ENTRY"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
if [ -d "$DESKTOP_DIR" ]; then
  cp "$ENTRY" "$DESKTOP_DIR/office.desktop"
  chmod +x "$DESKTOP_DIR/office.desktop"
fi
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
echo "installed: $APP/office, $ENTRY, $DESKTOP_DIR/office.desktop"
