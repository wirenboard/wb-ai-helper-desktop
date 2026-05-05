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

// Loading page HTML — polls /api/health then redirects; PORT injected via sed
const LOADING_HTML = String.raw`<!DOCTYPE html><html><head><meta charset="utf-8"><title>WB AI Helper</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0f172a;color:#94a3b8;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:20px}.sp{width:48px;height:48px;border:3px solid #1e293b;border-top:3px solid #3b82f6;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}h1{color:#e2e8f0;font-size:1.5rem;font-weight:600}p{font-size:.85rem}</style></head><body><div class="sp"></div><h1>WB AI Helper</h1><p id="s">Запуск&hellip;</p><script>const u="__APP_URL__";let n=0,dead=false;(function t(){if(dead)return;fetch(u+"api/health",{cache:"no-store",mode:"cors"}).then(r=>{r.ok?location.href=u:retry()}).catch(retry);function retry(){if(++n>90){dead=true;document.getElementById("s").textContent="Не удалось запустить. Откройте: "+u;return;}document.getElementById("s").textContent="Запуск… ("+n+")";setTimeout(t,500);}}())</script></body></html>`

// AppRun launcher — starts the server, opens a Chrome/Chromium app window with loading page
writeFileSync(path.join(APPDIR, 'AppRun'), `#!/bin/bash
set -euo pipefail

APPDIR="$(dirname "$(readlink -f "$0")")"
SERVER="$APPDIR/usr/bin/wb-ai-helper"

# Bypass proxy for localhost
export NO_PROXY="127.0.0.1,localhost"
export no_proxy="127.0.0.1,localhost"

# Pick a free port starting from 17321
PORT=17321
while ss -tlnp 2>/dev/null | grep -q ":$PORT "; do
  PORT=$((PORT + 1))
done

APP_URL="http://127.0.0.1:$PORT/"

# Start the server on the chosen port
export WB_HELPER_OPEN_BROWSER=0
export WB_HELPER_PORT=$PORT
"$SERVER" &
SERVER_PID=$!

# Build loading page data: URI (polls /api/health then redirects to app)
LOADING_HTML=${JSON.stringify(LOADING_HTML).replace(/`/g, '\\`')}
LOADING_HTML="\${LOADING_HTML/__APP_URL__/$APP_URL}"
LOADING_B64=$(printf '%s' "$LOADING_HTML" | base64 -w0 2>/dev/null || printf '%s' "$LOADING_HTML" | base64)
DATA_URI="data:text/html;base64,$LOADING_B64"

# Open in Chrome/Chromium app mode — show loading page immediately while server starts
BROWSER=""
for b in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$b" &>/dev/null; then
    BROWSER="$b"
    break
  fi
done

if [ -n "$BROWSER" ]; then
  "$BROWSER" \\
    --app="$DATA_URI" \\
    --window-size=1280,900 \\
    --disable-extensions \\
    --no-first-run \\
    --no-default-browser-check \\
    --disable-background-networking \\
    --user-data-dir="$HOME/.config/wb-ai-helper/chrome-profile" \\
    2>/dev/null
else
  # Fallback: wait for server then open in default browser
  for i in $(seq 1 60); do
    curl -sf "$APP_URL/api/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
  xdg-open "$APP_URL" 2>/dev/null || open "$APP_URL" 2>/dev/null || echo "Open $APP_URL in your browser"
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
