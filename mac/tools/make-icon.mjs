#!/usr/bin/env node
// Draws bisu's two icons from one shape, so both stay in step:
//   assets/trayTemplate.png|@2x   the menu bar glyph (template: black strokes, masked by macOS)
//   assets/AppIcon.iconset/*      the Finder/Dock icon (glyph on a rounded square)
// Run: node tools/make-icon.mjs     then: iconutil -c icns assets/AppIcon.iconset -o assets/AppIcon.icns
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const S = 8; // supersampling per axis

// ---- shape (designed on an 18-unit grid) ----
function roundedRectSDF(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r), qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function inTriangle(px, py, a, b, c) {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  const u = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / d;
  const v = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / d;
  return u >= 0 && v >= 0 && u + v <= 1;
}
// coverage of the speech bubble (stroke + tail + three dots) at a point on the 18-unit grid
function bubble(px, py, weight = 1) {
  const d = roundedRectSDF(px, py, 9, 8.1, 6.9, 5.6, 3.1);
  let a = 1 - Math.min(1, Math.max(0, (Math.abs(d) - 1.35 * weight / 2) / 0.5 + 0.5));
  if (inTriangle(px, py, [5.0, 12.6], [8.6, 12.6], [5.9, 16.2])) a = 1;
  for (const dx of [6.35, 9, 11.65]) {
    const dd = Math.hypot(px - dx, py - 8.1) - 0.9 * weight;
    a = Math.max(a, 1 - Math.min(1, Math.max(0, dd / 0.5 + 0.5)));
  }
  return a;
}

function render(size, pixel) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const px = (x + (sx + 0.5) / S) / size * 18, py = (y + (sy + 0.5) / S) / size * 18;
        const c = pixel(px, py);
        r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
      }
      const n = S * S, i = (y * size + x) * 4;
      buf[i] = a ? Math.round(r / a) : 0;
      buf[i + 1] = a ? Math.round(g / a) : 0;
      buf[i + 2] = a ? Math.round(b / a) : 0;
      buf[i + 3] = Math.round(a / n * 255);
    }
  }
  return buf;
}

// ---- minimal PNG writer ----
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
  return t;
})();
const crc = buf => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0 };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < size; y++) rows.push(Buffer.concat([Buffer.from([0]), rgba.slice(y * size * 4, (y + 1) * size * 4)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), {level: 9})),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- write ----
fs.mkdirSync(ASSETS, {recursive: true});

// menu bar: black ink, alpha carries the shape
for (const [name, size] of [['trayTemplate.png', 18], ['trayTemplate@2x.png', 36]]) {
  const rgba = render(size, (px, py) => [0, 0, 0, bubble(px, py)]);
  fs.writeFileSync(path.join(ASSETS, name), png(size, rgba));
}

// app icon: white glyph on a green rounded square, per Apple's 1024 grid with margins
const GREEN = [47, 111, 79], WHITE = [255, 255, 255];
const appPixel = (px, py) => {
  if (px < 1.2 || px > 16.8 || py < 1.2 || py > 16.8) return [0, 0, 0, 0];
  const bg = 1 - Math.min(1, Math.max(0, (roundedRectSDF(px, py, 9, 9, 7.7, 7.7, 3.4)) / 0.35 + 0.5));
  const s = 0.86, ox = 9 - 9 * s, oy = 9 - 8.4 * s;         // glyph, slightly larger inside the tile
  const ink = bubble((px - ox) / s, (py - oy) / s, 1.15);
  const c = [GREEN[0] + (WHITE[0] - GREEN[0]) * ink, GREEN[1] + (WHITE[1] - GREEN[1]) * ink, GREEN[2] + (WHITE[2] - GREEN[2]) * ink];
  return [c[0], c[1], c[2], bg];
};

const iconset = path.join(ASSETS, 'AppIcon.iconset');
fs.rmSync(iconset, {recursive: true, force: true});
fs.mkdirSync(iconset, {recursive: true});
for (const [name, size] of [['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64],
  ['icon_128x128', 128], ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512],
  ['icon_512x512', 512], ['icon_512x512@2x', 1024]]) {
  fs.writeFileSync(path.join(iconset, name + '.png'), png(size, render(size, appPixel)));
}
const icns = path.join(ASSETS, 'AppIcon.icns');
try {
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icns]);
  fs.rmSync(iconset, {recursive: true, force: true});
  console.log('wrote tray icons and AppIcon.icns');
} catch (e) {
  console.log('wrote tray icons and iconset (iconutil failed: ' + e.message + ')');
}
