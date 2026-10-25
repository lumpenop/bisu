#!/bin/sh
# Builds ~/Applications/bisu.app from mac/native/bisu.swift — the same bundle name and identifier the
# Electron build used, so the Accessibility grant, the login item and everything else macOS knows
# about "bisu" keep pointing at it.
#
# The engine and the page are copied in unchanged: this replaces the shell, not the assistant.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
mac=$(dirname "$here")
repo=$(dirname "$mac")
dest="${BISU_APP_DIR:-$HOME/Applications}/bisu.app"
build="$here/.build"

mkdir -p "$build"
echo "bisu: compiling the shell"
xcrun swiftc -O -o "$build/bisu" "$here/bisu.swift" \
  -framework Cocoa -framework WebKit -framework Carbon

app="$build/bisu.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

cp "$build/bisu" "$app/Contents/MacOS/bisu"

# ---- the app itself: the engine, the page, and the computer-use server ----
res="$app/Contents/Resources/app"
mkdir -p "$res/mac/assets" "$res/mac/cu"
cp -R "$repo/ui" "$res/ui"
cp "$repo/launch.zsh" "$repo/agents.json" "$repo/prompt.md" "$repo/prompt-suggest.md" "$res/"
cp "$mac/assets/trayTemplate.png" "$mac/assets/trayTemplate@2x.png" "$res/mac/assets/"
cp "$mac/cu/bisu-cu.swift" "$res/mac/cu/" 2>/dev/null || true

if [ -f "$mac/assets/AppIcon.icns" ]; then
  cp "$mac/assets/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
else
  node "$mac/tools/make-icon.mjs" >/dev/null 2>&1 || true
  [ -f "$mac/assets/AppIcon.icns" ] && cp "$mac/assets/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
fi

plist="$app/Contents/Info.plist"
cat > "$plist" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>bisu</string>
  <key>CFBundleIdentifier</key><string>com.bisu.desktop</string>
  <key>CFBundleName</key><string>bisu</string>
  <key>CFBundleDisplayName</key><string>bisu</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>bisu reads the app you were in and the text you selected, so you do not have to explain it.</string>
  <key>NSDesktopFolderUsageDescription</key>
  <string>bisu runs Claude Code in the folder you pick, which is often on your Desktop.</string>
  <key>NSDocumentsFolderUsageDescription</key>
  <string>bisu runs Claude Code in the folder you pick, which is often in your Documents.</string>
  <key>NSDownloadsFolderUsageDescription</key>
  <string>bisu runs Claude Code in the folder you pick, which is often in your Downloads.</string>
  <key>NSRemovableVolumesUsageDescription</key>
  <string>bisu runs Claude Code in the folder you pick, which can be on an external drive.</string>
</dict>
</plist>
XML

# ---- dec-secret bridge ----
# dec-secret lives under the person's Desktop, which macOS will not let a Finder-launched app read.
# The three files are self-contained, so a copy in bisu's own support folder is readable anywhere and
# is what both shells launch.
dec_root=""
if [ -f "$HOME/.local/bin/dec-secret" ]; then
  dec_mjs=$(sed -n 's/.*"\(\/[^"]*dec-secret\.mjs\)".*/\1/p' "$HOME/.local/bin/dec-secret" | head -1 || true)
  if [ -n "${dec_mjs:-}" ]; then dec_root=$(dirname "$(dirname "$dec_mjs")"); fi
fi
bridge="$HOME/Library/Application Support/bisu/dec"
if [ -n "$dec_root" ] && [ -f "$dec_root/sdk/dec-secret.mjs" ]; then
  rm -rf "$bridge"
  mkdir -p "$bridge/sdk" "$bridge/app/chromium"
  cp "$dec_root/sdk/dec-secret.mjs" "$bridge/sdk/"
  cp "$dec_root/app/chromium/secret-env-run.cjs" "$dec_root/app/chromium/key-proxy.cjs" "$bridge/app/chromium/"
  echo "bisu: dec-secret bridged from $dec_root"
fi

# ---- computer-use helper ----
# The MCP server spawns this; keeping it in the support folder means it survives reinstalls and can be
# rebuilt without touching the signed bundle.
cu_bin="$HOME/Library/Application Support/bisu/bin"
mkdir -p "$cu_bin"
if [ -f "$mac/cu/bisu-cu.swift" ]; then
  if [ ! -x "$cu_bin/bisu-cu" ] || [ "$mac/cu/bisu-cu.swift" -nt "$cu_bin/bisu-cu" ]; then
    xcrun swiftc -O -o "$cu_bin/bisu-cu" "$mac/cu/bisu-cu.swift" && echo "bisu: computer-use helper built"
  fi
fi

# Modifying a bundle invalidates its signature and Apple Silicon refuses to run an unsigned one.
# A stable identity matters beyond that: macOS ties the Accessibility and Desktop-folder grants to
# the signature, so signing with the same local certificate every build keeps those grants instead of
# asking again after each rebuild. Ad-hoc is the fallback when there is no such certificate.
sign_id="${BISU_SIGN_ID:-}"
if [ -z "$sign_id" ]; then
  # The hash, not the name: a name can exist in more than one keychain, and codesign refuses an
  # ambiguous match.
  sign_id=$(security find-identity -v -p codesigning 2>/dev/null |
    grep -m1 -i "local code signing" | awk '{print $2}' || true)
fi
if [ -n "$sign_id" ]; then
  if codesign --force --deep --sign "$sign_id" "$app" >/dev/null 2>&1; then
    echo "bisu: signed as \"$sign_id\""
  else
    codesign --force --deep --sign - "$app" >/dev/null 2>&1 || echo "bisu: signing failed" >&2
  fi
else
  codesign --force --deep --sign - "$app" >/dev/null 2>&1 || echo "bisu: ad-hoc signing failed" >&2
fi

rm -rf "$dest"
mv "$app" "$dest"
/usr/bin/touch "$dest"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$dest" >/dev/null 2>&1 || true

echo "bisu: $dest"
du -sh "$dest" 2>/dev/null | sed 's/^/  size: /'
