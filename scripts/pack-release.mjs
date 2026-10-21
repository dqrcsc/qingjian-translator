#!/usr/bin/env node
/**
 * Zero-dependency release ZIP packager for 青简 · 译读 (QingJian) Chrome Extension.
 * Packages only runtime extension files into dist/qingjian-translator-v<version>.zip
 * for GitHub Releases and Chrome Web Store submission.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');

const RUNTIME_ENTRIES = [
  'manifest.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'licenses',
  'background',
  'content',
  'icons',
  'options',
  'popup',
  'shared',
  'studio'
];

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

function collectFiles(relPath, outList = []) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required runtime path: ${relPath}`);
  }
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    const children = fs.readdirSync(fullPath).sort();
    for (const child of children) {
      if (child.startsWith('.')) continue;
      collectFiles(path.posix.join(relPath, child), outList);
    }
  } else if (stat.isFile()) {
    outList.push(relPath);
  }
  return outList;
}

function buildZipBuffer(fileEntries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const relPath of fileEntries) {
    const fullPath = path.join(ROOT, relPath);
    const rawData = fs.readFileSync(fullPath);
    const nameBuf = Buffer.from(relPath.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(rawData);
    const compressed = zlib.deflateRawSync(rawData, { level: 9 });
    const useDeflate = compressed.length < rawData.length;
    const payload = useDeflate ? compressed : rawData;
    const method = useDeflate ? 8 : 0;

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x5548, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localChunks.push(localHeader, nameBuf, payload);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x5548, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralChunks.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDirBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(fileEntries.length, 8);
  eocd.writeUInt16LE(fileEntries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDirBuf, eocd]);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version || '1.0.0';

const allFiles = [];
for (const entry of RUNTIME_ENTRIES) {
  collectFiles(entry, allFiles);
}

fs.mkdirSync(DIST_DIR, { recursive: true });
const outFileName = `qingjian-translator-v${version}.zip`;
const outPath = path.join(DIST_DIR, outFileName);
const zipBuf = buildZipBuffer(allFiles);
fs.writeFileSync(outPath, zipBuf);

console.log(
  `📦 Packaged ${allFiles.length} runtime files into dist/${outFileName} (${(zipBuf.length / 1024).toFixed(1)} KB)`
);
