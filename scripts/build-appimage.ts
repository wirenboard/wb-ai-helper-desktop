// Build an AppImage for Linux x64.
// Usage: bun scripts/build-appimage.ts
// Requires: appimagetool in PATH or /tmp/appimagetool

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, chmodSync, copyFileSync, rmSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const BUILD = path.join(ROOT, 'build')
const BIN = path.join(BUILD, 'wb-ai-helper-linux-x64')
const APPDIR = path.join(BUILD, 'WbAiHelper.AppDir')

// Find appimagetool
const APPIMAGETOOL =
  ['/tmp/appimagetool', '/usr/local/bin/appimagetool', 'appimagetool'].find(existsSync) ??
  (() => { throw new Error('appimagetool not found — download from https://github.com/AppImage/AppImageKit/releases') })()

if (!existsSync(BIN)) {
  console.error(`Binary not found: ${BIN}\nRun: bun scripts/build.ts --target=linux-x64`)
  process.exit(1)
}

console.log('▸ Создание AppDir')
if (existsSync(APPDIR)) rmSync(APPDIR, { recursive: true })
mkdirSync(path.join(APPDIR, 'usr', 'bin'), { recursive: true })

// Binary
copyFileSync(BIN, path.join(APPDIR, 'usr', 'bin', 'wb-ai-helper'))
chmodSync(path.join(APPDIR, 'usr', 'bin', 'wb-ai-helper'), 0o755)

// Icon (embedded SVG → PNG via ImageMagick if available, else copy placeholder)
const iconSrc = path.join(ROOT, 'src', 'web', 'public', 'icon.png')
const iconDest = path.join(APPDIR, 'wb-ai-helper.png')
if (existsSync(iconSrc)) {
  copyFileSync(iconSrc, iconDest)
} else {
  // Generate a minimal valid 256×256 PNG icon using ImageMagick
  const im = spawnSync('convert', [
    '-size', '256x256',
    'xc:#1a1a2e',
    '-fill', '#4f9cf9',
    '-font', 'DejaVu-Sans-Bold',
    '-pointsize', '80',
    '-gravity', 'Center',
    '-annotate', '0', 'WB',
    iconDest,
  ], { stdio: 'inherit' })
  if (im.status !== 0) {
    // Fallback: copy from assets if ImageMagick unavailable
    const fallback = path.join(ROOT, 'src', 'web', 'dist', 'favicon.ico')
    if (existsSync(fallback)) {
      copyFileSync(fallback, iconDest)
    } else {
      // Write a minimal 1x1 PNG as placeholder
      const minPng = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
        '2e00000000c4944415478016360f8cfc00000000200013408d240000000049454e44ae426082',
        'hex',
      )
      writeFileSync(iconDest, minPng)
    }
  }
}
// Also symlink as .DirIcon
try { execSync(`ln -sf wb-ai-helper.png ${path.join(APPDIR, '.DirIcon')}`) } catch {}

// Desktop entry
writeFileSync(path.join(APPDIR, 'wb-ai-helper.desktop'), `[Desktop Entry]
Name=WB AI Helper
Comment=AI-помощник для контроллеров Wiren Board
Exec=wb-ai-helper
Icon=wb-ai-helper
Type=Application
Categories=Utility;Development;
Terminal=false
StartupNotify=true
`)

// AppRun launcher — starts the server, opens a Chrome/Chromium app window
writeFileSync(path.join(APPDIR, 'AppRun'), `#!/bin/bash
set -euo pipefail

APPDIR="$(dirname "$(readlink -f "$0")")"
SERVER="$APPDIR/usr/bin/wb-ai-helper"

# Bypass proxy for localhost (curl and fetch)
export NO_PROXY="127.0.0.1,localhost"
export no_proxy="127.0.0.1,localhost"

# Pick a free port starting from 17321
PORT=17321
while ss -tlnp 2>/dev/null | grep -q ":$PORT "; do
  PORT=$((PORT + 1))
done

# Start the server
export WB_HELPER_OPEN_BROWSER=0
"$SERVER" &
SERVER_PID=$!

# Wait up to 8 seconds for the server to be ready
for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

URL="http://127.0.0.1:$PORT/"

# Open in Chrome/Chromium app mode (no browser chrome — looks like a native window)
BROWSER=""
for b in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$b" &>/dev/null; then
    BROWSER="$b"
    break
  fi
done

if [ -n "$BROWSER" ]; then
  "$BROWSER" \\
    --app="$URL" \\
    --window-size=1280,900 \\
    --disable-extensions \\
    --no-first-run \\
    --no-default-browser-check \\
    --disable-background-networking \\
    --user-data-dir="$HOME/.config/wb-ai-helper/chrome-profile" \\
    2>/dev/null
else
  # Fallback: open in default browser
  xdg-open "$URL" 2>/dev/null || open "$URL" 2>/dev/null || echo "Open $URL in your browser"
  # Keep server alive until user presses Ctrl+C
  wait $SERVER_PID
fi

# Kill server when window is closed
kill $SERVER_PID 2>/dev/null || true
`)
chmodSync(path.join(APPDIR, 'AppRun'), 0o755)

// Build AppImage
const out = path.join(BUILD, 'WB-AI-Helper-x86_64.AppImage')
if (existsSync(out)) rmSync(out)

console.log('▸ Упаковка AppImage')
const result = spawnSync(APPIMAGETOOL, [APPDIR, out], {
  stdio: 'inherit',
  env: { ...process.env, ARCH: 'x86_64' },
})
if (result.status !== 0) {
  console.error('appimagetool завершился с ошибкой')
  process.exit(result.status ?? 1)
}

chmodSync(out, 0o755)
rmSync(APPDIR, { recursive: true })

// Write a tiny launcher that auto-detects FUSE availability
const launcher = path.join(BUILD, 'wb-ai-helper.sh')
writeFileSync(launcher, `#!/bin/bash
# Launcher: auto-falls-back to extract-and-run if FUSE unavailable
DIR="$(dirname "$(readlink -f "$0")")"
APPIMAGE="$DIR/WB-AI-Helper-x86_64.AppImage"
if [ ! -f "$APPIMAGE" ]; then
  echo "AppImage not found: $APPIMAGE" >&2; exit 1
fi
# Try FUSE first; if unavailable, extract-and-run
if [ "$(id -u)" != "0" ] && ! grep -q fuse /proc/filesystems 2>/dev/null; then
  exec env APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGE" "$@"
fi
exec "$APPIMAGE" "$@"
`)
chmodSync(launcher, 0o755)

console.log(`\n✔ ${out}`)
console.log(`  launcher: ${launcher}`)
console.log('  Запуск: ./wb-ai-helper.sh  (или ./WB-AI-Helper-x86_64.AppImage напрямую)')
