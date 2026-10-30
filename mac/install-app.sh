#!/bin/sh
# Builds ~/Applications/Dec Intern.app — a real bundle, not a shortcut.
#
# Electron is cloned (APFS copy-on-write, so it costs almost no disk) and renamed to Dec Intern, which
# is what makes macOS call the app "덱 인턴" everywhere it matters: Accessibility and Automation
# prompts, System Settings, Activity Monitor, the login items list. A thin launcher that execs
# another bundle's binary would show up as "Electron" in all of those.
#
# The code inside is a copy. Run this again after changing dec-intern, or use `dec-intern app dev` to run the
# working tree directly in Electron while you are editing.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
electron_app="$here/node_modules/electron/dist/Electron.app"
dest="${DEC_INTERN_APP_DIR:-$HOME/Applications}/Dec Intern.app"

[ -d "$electron_app" ] || { echo "dec-intern: Electron is missing. Run 'dec-intern app' once to install it." >&2; exit 1; }
[ -f "$here/assets/AppIcon.icns" ] || node "$here/tools/make-icon.mjs" >/dev/null

tmp="$dest.new"
rm -rf "$tmp"
mkdir -p "$(dirname "$dest")"

# Clone instead of copy where the filesystem supports it; fall back to a plain copy.
cp -cR "$electron_app" "$tmp" 2>/dev/null || cp -R "$electron_app" "$tmp"

# ---- rename the bundle ----
mv "$tmp/Contents/MacOS/Electron" "$tmp/Contents/MacOS/dec-intern"
plist="$tmp/Contents/Info.plist"
pb=/usr/libexec/PlistBuddy
$pb -c "Set :CFBundleExecutable dec-intern" "$plist"
$pb -c "Set :CFBundleName dec-intern" "$plist"
$pb -c "Set :CFBundleDisplayName '덱 인턴'" "$plist"   # the name a person sees; the bundle is Dec Intern.app, the executable dec-intern, the id local.dec.intern
$pb -c "Set :CFBundleIdentifier local.dec.intern" "$plist"
$pb -c "Set :CFBundleIconFile AppIcon" "$plist"
$pb -c "Set :LSUIElement true" "$plist" 2>/dev/null || $pb -c "Add :LSUIElement bool true" "$plist"
$pb -c "Add :NSAppleEventsUsageDescription string 'Dec Intern reads the app you were in and the text you selected, so you do not have to explain it.'" "$plist" 2>/dev/null || true

cp "$here/assets/AppIcon.icns" "$tmp/Contents/Resources/AppIcon.icns"
rm -f "$tmp/Contents/Resources/default_app.asar"

# ---- the app itself: mac/ plus the engine it drives ----
app="$tmp/Contents/Resources/app"
mkdir -p "$app/mac"
cp "$here/main.cjs" "$here/preload.cjs" "$here/context.cjs" "$app/mac/"
cp -R "$here/assets" "$app/mac/assets"
cp -R "$repo/ui" "$app/ui"
cp "$repo/launch.zsh" "$repo/agents.json" "$repo/prompt.md" "$app/"

# ---- computer use: source here, binary in support ----
# The AX/input helper is built once into the support folder rather than inside the signed bundle,
# so it survives reinstalls and can be rebuilt without re-signing the app.
mkdir -p "$app/mac/cu"
cp "$here/cu/dec-intern-cu.swift" "$app/mac/cu/"
cu_bin="$HOME/Library/Application Support/dec-intern/bin"
mkdir -p "$cu_bin"
if [ ! -x "$cu_bin/dec-intern-cu" ] || [ "$here/cu/dec-intern-cu.swift" -nt "$cu_bin/dec-intern-cu" ]; then
  if xcrun -f swiftc >/dev/null 2>&1; then
    xcrun swiftc -O -o "$cu_bin/dec-intern-cu" "$here/cu/dec-intern-cu.swift" && echo "dec-intern: computer-use helper built"
  else
    echo "dec-intern: swiftc not found; the helper will be built on first use" >&2
  fi
fi

# main.cjs resolves the engine as ../ui from mac/, so this is the right entry point.
cat > "$app/package.json" <<JSON
{
  "name": "dec-intern",
  "productName": "dec-intern",
  "version": "0.1.0",
  "private": true,
  "main": "mac/main.cjs"
}
JSON

# ---- dec-secret bridge ----
# dec-secret keeps its files under ~/Desktop, and macOS will not let a Finder-launched app read
# there (Privacy & Security → Files and Folders): the open() blocks instead of prompting. The three
# files are self-contained, so a copy in the app's own support folder is readable from anywhere.
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

# Modifying a signed bundle invalidates the signature; Apple Silicon refuses to run an unsigned
# one, so re-sign ad hoc (this is a local build, not a distributable).
codesign --force --deep --sign - "$tmp" >/dev/null 2>&1 || echo "dec-intern: ad-hoc signing failed (the app may still run)" >&2

rm -rf "$dest"
mv "$tmp" "$dest"
/usr/bin/touch "$dest"

# Make LaunchServices notice the new app rather than a cached older one.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$dest" >/dev/null 2>&1 || true

echo "dec-intern: $dest"
du -sh "$dest" 2>/dev/null | sed 's/^/  size: /'
echo "  open -a '$dest'   (or use Finder/Spotlight)"
