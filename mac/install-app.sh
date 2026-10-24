#!/bin/sh
# Builds ~/Applications/bisu.app — a real bundle, not a shortcut.
#
# Electron is cloned (APFS copy-on-write, so it costs almost no disk) and renamed to bisu, which
# is what makes macOS call the app "bisu" everywhere it matters: Accessibility and Automation
# prompts, System Settings, Activity Monitor, the login items list. A thin launcher that execs
# another bundle's binary would show up as "Electron" in all of those.
#
# The code inside is a copy. Run this again after changing bisu, or use `bisu app dev` to run the
# working tree directly in Electron while you are editing.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
electron_app="$here/node_modules/electron/dist/Electron.app"
dest="${BISU_APP_DIR:-$HOME/Applications}/bisu.app"

[ -d "$electron_app" ] || { echo "bisu: Electron is missing. Run 'bisu app' once to install it." >&2; exit 1; }
[ -f "$here/assets/AppIcon.icns" ] || node "$here/tools/make-icon.mjs" >/dev/null

tmp="$dest.new"
rm -rf "$tmp"
mkdir -p "$(dirname "$dest")"

# Clone instead of copy where the filesystem supports it; fall back to a plain copy.
cp -cR "$electron_app" "$tmp" 2>/dev/null || cp -R "$electron_app" "$tmp"

# ---- rename the bundle ----
mv "$tmp/Contents/MacOS/Electron" "$tmp/Contents/MacOS/bisu"
plist="$tmp/Contents/Info.plist"
pb=/usr/libexec/PlistBuddy
$pb -c "Set :CFBundleExecutable bisu" "$plist"
$pb -c "Set :CFBundleName bisu" "$plist"
$pb -c "Set :CFBundleDisplayName bisu" "$plist"
$pb -c "Set :CFBundleIdentifier com.bisu.desktop" "$plist"
$pb -c "Set :CFBundleIconFile AppIcon" "$plist"
$pb -c "Set :LSUIElement true" "$plist" 2>/dev/null || $pb -c "Add :LSUIElement bool true" "$plist"
$pb -c "Add :NSAppleEventsUsageDescription string 'bisu reads the app you were in and the text you selected, so you do not have to explain it.'" "$plist" 2>/dev/null || true

cp "$here/assets/AppIcon.icns" "$tmp/Contents/Resources/AppIcon.icns"
rm -f "$tmp/Contents/Resources/default_app.asar"

# ---- the app itself: mac/ plus the engine it drives ----
app="$tmp/Contents/Resources/app"
mkdir -p "$app/mac"
cp "$here/main.cjs" "$here/preload.cjs" "$here/context.cjs" "$app/mac/"
cp -R "$here/assets" "$app/mac/assets"
cp -R "$repo/ui" "$app/ui"
cp "$repo/launch.zsh" "$repo/agents.json" "$repo/prompt.md" "$app/"

# main.cjs resolves the engine as ../ui from mac/, so this is the right entry point.
cat > "$app/package.json" <<JSON
{
  "name": "bisu",
  "productName": "bisu",
  "version": "0.1.0",
  "private": true,
  "main": "mac/main.cjs"
}
JSON

# Modifying a signed bundle invalidates the signature; Apple Silicon refuses to run an unsigned
# one, so re-sign ad hoc (this is a local build, not a distributable).
codesign --force --deep --sign - "$tmp" >/dev/null 2>&1 || echo "bisu: ad-hoc signing failed (the app may still run)" >&2

rm -rf "$dest"
mv "$tmp" "$dest"
/usr/bin/touch "$dest"

# Make LaunchServices notice the new app rather than a cached older one.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$dest" >/dev/null 2>&1 || true

echo "bisu: $dest"
du -sh "$dest" 2>/dev/null | sed 's/^/  size: /'
echo "  open -a '$dest'   (or use Finder/Spotlight)"
