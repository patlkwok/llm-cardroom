/**
 * Renders resources/icon.png from the SVG below.
 *
 * electron-builder derives every platform icon from that one 1024px PNG (.ico
 * for Windows, .icns for macOS, a size set for Linux), so this is the only
 * source of truth for the app's artwork. Kept as a script rather than a
 * committed-and-forgotten binary so the design can actually be edited.
 *
 *   npm run icon
 *
 * Rendering goes through a real BrowserWindow because Chromium is the one SVG
 * rasteriser this project already depends on. `nativeImage` cannot read SVG.
 */
const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const SIZE = 1024
const OUT = join(__dirname, '..', 'resources', 'icon.png')

// Suit glyphs drawn as paths in a local 100x100 box: no font dependency, so the
// icon renders identically on whatever machine regenerates it.
const HEART =
  'M50 86 C22 62 8 46 8 30 C8 16 19 6 32 6 C41 6 48 11 50 16 C52 11 59 6 68 6 C81 6 92 16 92 30 C92 46 78 62 50 86 Z'
const SPADE =
  'M50 8 C50 8 90 40 90 60 C90 73 80 82 68 82 C61 82 56 79 53 75 L53 78 C53 84 57 89 63 92 L37 92 C43 89 47 84 47 78 L47 75 C44 79 39 82 32 82 C20 82 10 73 10 60 C10 40 50 8 50 8 Z'

/** One playing card: white rounded rect, rotated about the table centre. */
function card(angle, dx, suitPath, suitColor) {
  const w = 316
  const h = 440
  const x = 512 - w / 2 + dx
  const y = 530 - h / 2
  // Suit is scaled from the 100x100 box to 176px and centred on the card.
  const s = 1.76
  const sx = x + w / 2 - 50 * s
  const sy = y + h / 2 - 50 * s
  return `
    <g transform="rotate(${angle} 512 560)" filter="url(#drop)">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="34" fill="#f6f8fb"/>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="34" fill="none"
            stroke="#c8d2de" stroke-width="3"/>
      <g transform="translate(${sx} ${sy}) scale(${s})">
        <path d="${suitPath}" fill="${suitColor}"/>
      </g>
    </g>`
}

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="felt" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b8055"/>
      <stop offset="1" stop-color="#0a3826"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.42" r="0.62">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="drop" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="10" stdDeviation="18" flood-color="#000000" flood-opacity="0.42"/>
    </filter>
  </defs>

  <rect x="48" y="48" width="928" height="928" rx="208" fill="url(#felt)"/>
  <rect x="48" y="48" width="928" height="928" rx="208" fill="url(#glow)"/>
  <rect x="48" y="48" width="928" height="928" rx="208" fill="none"
        stroke="#ffffff" stroke-opacity="0.12" stroke-width="8"/>

  ${card(-19, -168, SPADE, '#12161c')}
  ${card(13, 112, HEART, '#d62b3e')}
</svg>`

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  // The window is deliberately tiny: capturePage() would be clamped to the
  // display work area (a 1080p screen silently yields a 1024x720 icon), so the
  // SVG is rasterised onto a canvas instead, which has no such limit.
  const win = new BrowserWindow({ width: 200, height: 200, show: false })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8">'))

  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const svg = ${JSON.stringify(svg)}
    const img = new Image()
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = ${SIZE}
    canvas.height = ${SIZE}
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, ${SIZE}, ${SIZE})
    return canvas.toDataURL('image/png')
  })()`)

  const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64')
  if (png.length < 1000) throw new Error(`render looks empty (${png.length} bytes)`)

  mkdirSync(join(__dirname, '..', 'resources'), { recursive: true })
  writeFileSync(OUT, png)
  console.log(`wrote ${OUT} (${SIZE}x${SIZE}, ${png.length} bytes)`)

  win.destroy()
  app.quit()
})
