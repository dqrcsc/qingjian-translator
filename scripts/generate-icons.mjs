#!/usr/bin/env node
/**
 * Pure Node.js PNG icon generator (16x16, 48x48, 128x128) using built-in node:zlib.
 * Zero external dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'icons');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(typeStr, dataBuf) {
  const typeBuf = Buffer.from(typeStr, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuf.length, 0);
  const crcInput = Buffer.concat([typeBuf, dataBuf]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, dataBuf, crcBuf]);
}

function writePng(filePath, width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // Filter 0
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw, { level: 9 });
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = Buffer.concat([
    pngSig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(filePath, png);
}

function sdRoundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const denom = bax * bax + bay * bay;
  const h = denom === 0 ? 0 : Math.max(0, Math.min(1, (pax * bax + pay * bay) / denom));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function sdBox(px, py, bx, by) {
  const dx = Math.abs(px) - bx;
  const dy = Math.abs(py) - by;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function mix(a, b, t) {
  return a * (1 - t) + b * t;
}

function mixColor(c1, c2, t) {
  const k = clamp01(t);
  return [
    mix(c1[0], c2[0], k),
    mix(c1[1], c2[1], k),
    mix(c1[2], c2[2], k)
  ];
}

/**
 * Evaluates the "青简 · 译读" (QingJian) Celadon Bamboo Slips icon at normalized coordinates (nx, ny) in [-1, 1].
 */
function sampleQingJianIcon(nx, ny) {
  // 1. Outer Squircle Badge
  const dBadge = sdRoundedBox(nx, ny, 0.90, 0.90, 0.36);
  if (dBadge > 0.02) {
    return [0, 0, 0, 0];
  }

  // Deep bamboo-forest jade background gradient
  const diag = clamp01((nx + ny + 1.8) / 3.6);
  let bg = mixColor([19, 94, 82], [7, 36, 33], diag);

  // Subtle top-left celadon radial glow
  const glow = clamp01(1 - Math.hypot(nx + 0.45, ny + 0.48) * 0.85);
  bg = mixColor(bg, [45, 180, 152], glow * 0.32);

  // Inner jade rim highlight near squircle border
  const rimDist = Math.abs(dBadge + 0.035);
  const rim = clamp01(1 - rimDist / 0.035) * 0.35;
  bg = mixColor(bg, [153, 246, 228], rim);

  let rgb = bg;

  // 2. Soft drop shadow beneath the 3 bamboo slips
  const dShadow1 = sdRoundedBox(nx + 0.38 - 0.02, ny + 0.02 - 0.03, 0.125, 0.50, 0.055);
  const dShadow2 = sdRoundedBox(nx - 0.02, ny - 0.03, 0.135, 0.57, 0.06);
  const dShadow3 = sdRoundedBox(nx - 0.38 - 0.02, ny - 0.02 - 0.03, 0.125, 0.50, 0.055);
  const dShadow = Math.min(dShadow1, dShadow2, dShadow3);
  if (dShadow < 0.08) {
    const sh = clamp01(1 - (dShadow + 0.02) / 0.10) * 0.38;
    rgb = mixColor(rgb, [2, 14, 13], sh);
  }

  // 3. Three Vertical Celadon Bamboo Slips (三联青简)
  const slips = [
    // Left Slip: classical bamboo celadon
    {
      cx: -0.38,
      cy: -0.03,
      hw: 0.122,
      hh: 0.50,
      r: 0.052,
      topCol: [167, 243, 208],
      botCol: [82, 204, 160],
      inkSegs: [
        [-0.38, -0.22, -0.38, -0.04],
        [-0.38, 0.06, -0.38, 0.22]
      ],
      hasSeal: false
    },
    // Center Slip: tallest luminous jade-celadon hero slip
    {
      cx: 0.0,
      cy: 0.0,
      hw: 0.134,
      hh: 0.57,
      r: 0.058,
      topCol: [236, 253, 245],
      botCol: [134, 239, 198],
      inkSegs: [
        [0.0, -0.24, 0.0, 0.02],
        [-0.045, -0.12, 0.045, -0.12],
        [0.0, 0.10, 0.0, 0.23]
      ],
      hasSeal: false
    },
    // Right Slip: rich emerald-celadon with vermilion scholar seal
    {
      cx: 0.38,
      cy: 0.03,
      hw: 0.122,
      hh: 0.50,
      r: 0.052,
      topCol: [142, 238, 192],
      botCol: [52, 185, 140],
      inkSegs: [
        [0.38, -0.20, 0.38, -0.02]
      ],
      hasSeal: true
    }
  ];

  // 4. Horizontal Binding Cords Behind/Between Slips (韦编丝弦连接段)
  const cordYs = [-0.34, 0.34];
  for (const cy of cordYs) {
    const dBackCord = sdRoundedBox(nx, ny - cy, 0.54, 0.026, 0.012);
    if (dBackCord < 0) {
      rgb = [217, 155, 38];
    }
  }

  // Render each bamboo slip
  for (const s of slips) {
    const lx = nx - s.cx;
    const ly = ny - s.cy;
    const dSlip = sdRoundedBox(lx, ly, s.hw, s.hh, s.r);
    if (dSlip <= 0) {
      const vt = clamp01((ly + s.hh) / (2 * s.hh));
      let slipCol = mixColor(s.topCol, s.botCol, vt);

      // Cylindrical bamboo sheen across horizontal width of slip
      const ht = clamp01((lx + s.hw) / (2 * s.hw));
      const bevel = Math.sin(ht * Math.PI);
      slipCol = mixColor(slipCol, [255, 255, 255], bevel * 0.22);

      // Subtle bamboo node groove (竹节横纹) near center
      const dGroove = Math.abs(ly + 0.02);
      if (dGroove < 0.014) {
        slipCol = mixColor(slipCol, [16, 110, 90], (1 - dGroove / 0.014) * 0.25);
      }

      // Slip outer edge border
      if (dSlip > -0.018) {
        slipCol = mixColor(slipCol, [15, 92, 76], 0.45);
      }

      // Classical dark-jade ink calligraphy strokes inside the slip
      for (const [ax, ay, bx, by] of s.inkSegs) {
        const dInk = sdSegment(nx, ny, ax, ay, bx, by) - 0.026;
        if (dInk <= 0) {
          slipCol = [11, 74, 62];
        }
      }

      // Vermilion scholar seal (朱砂雅印) on the lower-right bamboo slip
      if (s.hasSeal) {
        const dSeal = sdRoundedBox(nx - s.cx, ny - (s.cy + 0.14), 0.056, 0.056, 0.018);
        if (dSeal <= 0) {
          slipCol = [225, 45, 57];
        }
      }

      rgb = slipCol;

      // Golden-jade binding cord clasps across the front of each bamboo slip (韦编金扣)
      for (const cy of cordYs) {
        const dFrontCord = sdRoundedBox(nx - s.cx, ny - cy, s.hw + 0.008, 0.028, 0.012);
        if (dFrontCord <= 0) {
          const cordGrad = clamp01((nx - s.cx + s.hw) / (2 * s.hw));
          rgb = mixColor([254, 240, 138], [245, 158, 11], cordGrad);
        }
      }
    }
  }

  return [rgb[0], rgb[1], rgb[2], 255];
}

function renderIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const subSamples = 4; // 4x4 SSAA for crisp rendering at 16x16, 48x48, and 128x128

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;

      for (let sy = 0; sy < subSamples; sy++) {
        const py = ((y + (sy + 0.5) / subSamples) / size) * 2 - 1;
        for (let sx = 0; sx < subSamples; sx++) {
          const px = ((x + (sx + 0.5) / subSamples) / size) * 2 - 1;
          const [r, g, b, a] = sampleQingJianIcon(px, py);
          const alphaNorm = a / 255;
          rSum += r * alphaNorm;
          gSum += g * alphaNorm;
          bSum += b * alphaNorm;
          aSum += a;
        }
      }

      const totalSamples = subSamples * subSamples;
      const finalAlpha = Math.round(aSum / totalSamples);
      const idx = (y * size + x) * 4;
      if (finalAlpha > 0) {
        const weight = aSum / 255;
        buf[idx] = Math.min(255, Math.round(rSum / weight));
        buf[idx + 1] = Math.min(255, Math.round(gSum / weight));
        buf[idx + 2] = Math.min(255, Math.round(bSum / weight));
        buf[idx + 3] = finalAlpha;
      }
    }
  }
  return buf;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const sz of [16, 48, 128]) {
  const outPath = path.join(OUT_DIR, `icon-${sz}.png`);
  writePng(outPath, sz, sz, renderIcon(sz));
  console.log(`Generated ${outPath} (${sz}x${sz}px)`);
}
