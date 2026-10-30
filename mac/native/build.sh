#!/bin/sh
# Builds ~/Applications/Dec Intern.app from mac/native/dec-intern.swift. The bundle folder and identifier
# (local.dec.intern) are what macOS keys the Accessibility grant, the login item and the folder permissions to:
# keep them, or every grant is asked for again.
#
# The engine and the page are copied in unchanged: this replaces the shell, not the assistant.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
mac=$(dirname "$here")
repo=$(dirname "$mac")
dest="${DEC_INTERN_APP_DIR:-$HOME/Applications}/Dec Intern.app"
build="$here/.build"

mkdir -p "$build"
echo "dec-intern: compiling the shell"
xcrun swiftc -O -o "$build/dec-intern" "$here/dec-intern.swift" \
  -framework Cocoa -framework WebKit -framework Carbon -framework UserNotifications

app="$build/Dec Intern.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

cp "$build/dec-intern" "$app/Contents/MacOS/dec-intern"

# ---- the app itself: the engine, the page, and the computer-use server ----
res="$app/Contents/Resources/app"
mkdir -p "$res/mac/assets" "$res/mac/cu"
cp -R "$repo/ui" "$res/ui"
# Dec Intern's own engine (DEC_INTERN_ENGINE=native), without its benchmarks.
cp -R "$repo/engine" "$res/engine"
rm -rf "$res/engine/eval"
# Except the computer-use benchmark, which Settings runs (and the pretend calendar it does not need).
mkdir -p "$res/engine/eval" && cp "$repo/engine/eval/cu-bench.mjs" "$res/engine/eval/"
cp "$repo/launch.zsh" "$repo/agents.json" "$repo/prompt.md" "$repo/prompt-suggest.md" "$repo/prompt-job.md" "$repo/prompt-goal.md" "$res/"
cp "$mac/assets/trayTemplate.png" "$mac/assets/trayTemplate@2x.png" "$res/mac/assets/"
cp "$mac/cu/dec-intern-cu.swift" "$res/mac/cu/" 2>/dev/null || true

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
  <key>CFBundleExecutable</key><string>dec-intern</string>
  <key>CFBundleIdentifier</key><string>local.dec.intern</string>
  <key>CFBundleName</key><string>덱 인턴</string>
  <key>CFBundleDisplayName</key><string>덱 인턴</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>덱 인턴 reads the app you were in and the text you selected, so you do not have to explain it.</string>
  <key>NSDesktopFolderUsageDescription</key>
  <string>덱 인턴 runs Claude Code in the folder you pick, which is often on your Desktop.</string>
  <key>NSDocumentsFolderUsageDescription</key>
  <string>덱 인턴 runs Claude Code in the folder you pick, which is often in your Documents.</string>
  <key>NSDownloadsFolderUsageDescription</key>
  <string>덱 인턴 runs Claude Code in the folder you pick, which is often in your Downloads.</string>
  <key>NSRemovableVolumesUsageDescription</key>
  <string>덱 인턴 runs Claude Code in the folder you pick, which can be on an external drive.</string>
  <key>NSCalendarsFullAccessUsageDescription</key>
  <string>덱 인턴 reads your calendar and adds or moves events when you ask it to.</string>
  <key>NSCalendarsUsageDescription</key>
  <string>덱 인턴 reads your calendar and adds or moves events when you ask it to.</string>
  <key>NSRemindersFullAccessUsageDescription</key>
  <string>덱 인턴 reads your reminders and adds or checks them off when you ask it to.</string>
  <key>NSRemindersUsageDescription</key>
  <string>덱 인턴 reads your reminders and adds or checks them off when you ask it to.</string>
</dict>
</plist>
XML

# ---- dec-secret bridge ----
# dec-secret lives under the person's Desktop, which macOS will not let a Finder-launched app read.
# The three files are self-contained, so a copy in Dec Intern's own support folder is readable anywhere and
# is what both shells launch.
dec_root=""
if [ -f "$HOME/.local/bin/dec-secret" ]; then
  dec_mjs=$(sed -n 's/.*"\(\/[^"]*dec-secret\.mjs\)".*/\1/p' "$HOME/.local/bin/dec-secret" | head -1 || true)
  if [ -n "${dec_mjs:-}" ]; then dec_root=$(dirname "$(dirname "$dec_mjs")"); fi
fi
bridge="$HOME/Library/Application Support/dec-intern/dec"
if [ -n "$dec_root" ] && [ -f "$dec_root/sdk/dec-secret.mjs" ]; then
  rm -rf "$bridge"
  mkdir -p "$bridge/sdk" "$bridge/app/chromium"
  cp "$dec_root/sdk/dec-secret.mjs" "$bridge/sdk/"
  cp "$dec_root/app/chromium/secret-env-run.cjs" "$dec_root/app/chromium/key-proxy.cjs" "$bridge/app/chromium/"
  echo "dec-intern: dec-secret bridged from $dec_root"
fi

# ---- computer-use helper ----
# The MCP server spawns this; keeping it in the support folder means it survives reinstalls and can be
# rebuilt without touching the signed bundle.
cu_bin="$HOME/Library/Application Support/dec-intern/bin"
mkdir -p "$cu_bin"
if [ -f "$mac/cu/dec-intern-cu.swift" ]; then
  if [ ! -x "$cu_bin/dec-intern-cu" ] || [ "$mac/cu/dec-intern-cu.swift" -nt "$cu_bin/dec-intern-cu" ]; then
    xcrun swiftc -O -o "$cu_bin/dec-intern-cu" "$mac/cu/dec-intern-cu.swift" && echo "dec-intern: computer-use helper built"
  fi
fi
# Calendar and Reminders (engine/calendar.mjs). macOS asks for access on behalf of dec-intern, whose
# Info.plist above carries the reasons; the helper carries the same ones for a run from a terminal.
if [ -f "$mac/cal/dec-intern-cal.swift" ]; then
  if [ ! -x "$cu_bin/dec-intern-cal" ] || [ "$mac/cal/dec-intern-cal.swift" -nt "$cu_bin/dec-intern-cal" ] || [ "$mac/cal/Info.plist" -nt "$cu_bin/dec-intern-cal" ]; then
    xcrun swiftc -O -o "$cu_bin/dec-intern-cal" "$mac/cal/dec-intern-cal.swift" -framework EventKit \
      -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$mac/cal/Info.plist" && echo "dec-intern: calendar helper built"
  fi
fi

# Modifying a bundle invalidates its signature and Apple Silicon refuses to run an unsigned one.
# A stable identity matters beyond that: macOS ties the Accessibility and Desktop-folder grants to
# the signature, so signing with the same local certificate every build keeps those grants instead of
# asking again after each rebuild. Ad-hoc is the fallback when there is no such certificate.
sign_id="${DEC_INTERN_SIGN_ID:-}"
if [ -z "$sign_id" ]; then
  # The hash, not the name: a name can exist in more than one keychain, and codesign refuses an
  # ambiguous match.
  sign_id=$(security find-identity -v -p codesigning 2>/dev/null |
    grep -m1 -i "local code signing" | awk '{print $2}' || true)
fi
if [ -n "$sign_id" ]; then
  if codesign --force --deep --sign "$sign_id" "$app" >/dev/null 2>&1; then
    echo "dec-intern: signed as \"$sign_id\""
  else
    codesign --force --deep --sign - "$app" >/dev/null 2>&1 || echo "dec-intern: signing failed" >&2
  fi
else
  codesign --force --deep --sign - "$app" >/dev/null 2>&1 || echo "dec-intern: ad-hoc signing failed" >&2
fi

rm -rf "$dest"
mv "$app" "$dest"
/usr/bin/touch "$dest"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$dest" >/dev/null 2>&1 || true

echo "dec-intern: $dest"
du -sh "$dest" 2>/dev/null | sed 's/^/  size: /'
