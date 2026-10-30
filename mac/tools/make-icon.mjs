#!/usr/bin/env node
// Draws Dec Intern's two icons from one shape, so both stay in step:
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
// Signed distance to a triangle (negative inside).
function triangleSDF(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const e = [[bx - ax, by - ay], [cx - bx, cy - by], [ax - cx, ay - cy]], v = [[px - ax, py - ay], [px - bx, py - by], [px - cx, py - cy]];
  const sgn = Math.sign(e[0][0] * e[2][1] - e[0][1] * e[2][0]);
  let dd = Infinity, side = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = Math.min(1, Math.max(0, (v[i][0] * e[i][0] + v[i][1] * e[i][1]) / (e[i][0] ** 2 + e[i][1] ** 2)));
    const qx = v[i][0] - e[i][0] * t, qy = v[i][1] - e[i][1] * t;
    dd = Math.min(dd, qx * qx + qy * qy);
    side = Math.min(side, sgn * (v[i][0] * e[i][1] - v[i][1] * e[i][0]));
  }
  return -Math.sqrt(dd) * Math.sign(side);
}
// A smooth union, so the tail grows out of the bubble instead of being stuck on.
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k / 4 };
// The bubble and its tail as one shape: distance to its edge on the 18-unit grid.
const bubbleSDF = (px, py) => smin(roundedRectSDF(px, py, 9, 8.1, 6.9, 5.6, 3.1), triangleSDF(px, py, [4.7, 11.9], [8.2, 12.9], [4.3, 15.9]), 1.7);
const cover = d => 1 - Math.min(1, Math.max(0, d / 0.5 + 0.5));
const dots = (px, py, weight = 1) => Math.max(...[6.35, 9, 11.65].map(dx => cover(Math.hypot(px - dx, py - 8.1) - 0.9 * weight)));
// The menu bar glyph: the one outline, tail included, and the three dots.
function bubble(px, py, weight = 1) {
  return Math.max(cover(Math.abs(bubbleSDF(px, py)) - 1.35 * weight / 2), dots(px, py, weight));
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

// app icon: Dec Intern's glossy jade on a rounded square, a solid ivory bubble with jade dots, per Apple's
// 1024 grid with margins. The same colours as the page (ui/index.html): --g1/--g2, --card, --accent.
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const JADE_TOP = [108, 204, 154], JADE_BOTTOM = [36, 122, 84], IVORY = [255, 253, 248], IVORY_LOW = [234, 245, 238], DOT = [43, 138, 95];
// Hard edges here: the 8x supersampling in render() is the antialiasing, so a 1024 icon stays as crisp
// as a 16 one (a soft edge measured on the grid would be 13 pixels wide at 512).
const inside = d => d <= 0 ? 1 : 0;
const appPixel = (px, py) => {
  if (!inside(roundedRectSDF(px, py, 9, 9, 7.7, 7.7, 3.4))) return [0, 0, 0, 0];
  const bg = 1;
  let c = mix(JADE_TOP, JADE_BOTTOM, Math.min(1, Math.max(0, (py - 1.3) / 15.4)));
  // the jelly's shine: a soft light across the top
  const shine = Math.max(0, 1 - Math.hypot((px - 9) / 7.2, (py - 2.6) / 3.2));
  c = mix(c, [255, 255, 255], 0.22 * shine * shine);
  const s = 0.86, ox = 9 - 9 * s, oy = 9 - 8.4 * s;         // glyph, slightly larger inside the tile
  const gx = (px - ox) / s, gy = (py - oy) / s;
  // a soft shadow under the bubble, then the bubble, then its dots
  const shadow = Math.max(0, 1 - Math.max(0, bubbleSDF(gx, gy - 0.45) + 0.2) / 1.1);
  c = mix(c, [14, 60, 38], 0.32 * shadow * shadow);
  const body = inside(bubbleSDF(gx, gy));
  c = mix(c, mix(IVORY, IVORY_LOW, Math.min(1, Math.max(0, (gy - 2.5) / 13))), body);
  c = mix(c, DOT, Math.max(...[6.35, 9, 11.65].map(dx => inside(Math.hypot(gx - dx, gy - 8.1) - 0.95))) * body);
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
