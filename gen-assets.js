// 앱 아이콘(icon.ico)과 트레이 아이콘(tray.png)을 순수 Node로 생성
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = Math.round(size * 0.19);
  const bg = [217, 119, 6]; // amber-600 배경 (Claude 톤)

  function inRounded(x, y, x0, y0, x1, y1, rad) {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.max(x0 + rad, Math.min(x, x1 - rad));
    const cy = Math.max(y0 + rad, Math.min(y, y1 - rad));
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= rad * rad;
  }

  function ring(x, y, cx, cy, rOuter, rInner) {
    const dx = x - cx, dy = y - cy;
    const d2 = dx * dx + dy * dy;
    return d2 <= rOuter * rOuter && d2 >= rInner * rInner;
  }

  const s = size / 256;
  const ringsDef = [
    { cx: 90 * s, cy: 128 * s, rOuter: 56 * s, rInner: 40 * s },
    { cx: 166 * s, cy: 128 * s, rOuter: 56 * s, rInner: 40 * s }
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRounded(x, y, 0, 0, size - 1, size - 1, r)) {
        px[i + 3] = 0;
        continue;
      }
      let c = bg, a = 255;
      for (const rg of ringsDef) {
        if (ring(x, y, rg.cx, rg.cy, rg.rOuter, rg.rInner)) { c = [255, 255, 255]; a = 240; break; }
      }
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = a;
    }
  }

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function makeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0;
  entry[1] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}


function pngFromPixels(size, px) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// widget.html 상단의 별(별표) 아이콘 — 크림색 둥근 사각형 배경 + 주황색 8방향 별표를 트레이 크기로 래스터화한다.
const STAR_BG = [238, 236, 225]; // #EEECE1
const STAR_COLOR = [217, 119, 87]; // #D97757
const STAR_LINES = [
  [12, 3, 12, 21],
  [3, 12, 21, 12],
  [5.8, 5.8, 18.2, 18.2],
  [5.8, 18.2, 18.2, 5.8]
];
const STAR_STROKE_W = 2.6;

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx, projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
}

function makeStarTrayPng(size) {
  const px = Buffer.alloc(size * size * 4);
  const margin = size * 0.06;
  const scale = (size - margin * 2) / 24;
  const offset = margin;
  const cornerR = size * 0.16;

  function inRoundedSquare(x, y) {
    const rx = Math.max(cornerR, Math.min(x, size - 1 - cornerR));
    const ry = Math.max(cornerR, Math.min(y, size - 1 - cornerR));
    const dx = x - rx, dy = y - ry;
    return dx * dx + dy * dy <= cornerR * cornerR;
  }

  for (let py = 0; py < size; py++) {
    for (let px_ = 0; px_ < size; px_++) {
      const i = (py * size + px_) * 4;
      if (!inRoundedSquare(px_, py)) { px[i + 3] = 0; continue; }

      const sx = (px_ + 0.5 - offset) / scale;
      const sy = (py + 0.5 - offset) / scale;
      const halfStroke = STAR_STROKE_W / 2;
      let onStar = false;
      for (const [x1, y1, x2, y2] of STAR_LINES) {
        if (distToSegment(sx, sy, x1, y1, x2, y2) <= halfStroke) { onStar = true; break; }
      }

      if (onStar) {
        px[i] = STAR_COLOR[0]; px[i + 1] = STAR_COLOR[1]; px[i + 2] = STAR_COLOR[2]; px[i + 3] = 255;
      } else {
        px[i] = STAR_BG[0]; px[i + 1] = STAR_BG[1]; px[i + 2] = STAR_BG[2]; px[i + 3] = 255;
      }
    }
  }

  return pngFromPixels(size, px);
}

const dir = path.join(__dirname, 'assets');
fs.writeFileSync(path.join(dir, 'icon.ico'), makeIco(makePng(256)));
fs.writeFileSync(path.join(dir, 'icon.png'), makePng(256));
fs.writeFileSync(path.join(dir, 'tray.png'), makeStarTrayPng(32));

console.log('assets generated');
