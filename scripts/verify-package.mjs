#!/usr/bin/env node
// Inspect the actual ZIP, including decompressed bytes, rather than only its input directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.version, pkg.version, 'manifest/package version mismatch');
const zip = fs.readFileSync(path.join(root, `dist/qingjian-translator-v${manifest.version}.zip`));
const end = zip.length - 22;
assert.equal(zip.readUInt32LE(end), 0x06054b50, 'missing ZIP end record');
const count = zip.readUInt16LE(end + 10);
let cursor = zip.readUInt32LE(end + 16);
const entries = new Map();
for (let i = 0; i < count; i++) {
  assert.equal(zip.readUInt32LE(cursor), 0x02014b50, 'invalid central directory');
  const method = zip.readUInt16LE(cursor + 10);
  const compressedSize = zip.readUInt32LE(cursor + 20);
  const size = zip.readUInt32LE(cursor + 24);
  const nameLength = zip.readUInt16LE(cursor + 28);
  const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
  const offset = zip.readUInt32LE(cursor + 42);
  assert.equal(zip.readUInt32LE(offset), 0x04034b50, `invalid local header: ${name}`);
  assert.ok(!name.startsWith('/') && !name.split('/').includes('..'), `unsafe path: ${name}`);
  assert.ok(!entries.has(name), `duplicate entry: ${name}`);
  assert.match(name, /^(manifest\.json|LICENSE|THIRD_PARTY_NOTICES\.md|licenses\/Apache-2\.0\.txt|(?:background|content|icons|options|popup|shared|studio)\/.+)$/, `unexpected release file: ${name}`);
  assert.ok(!name.split('/').some(part => part.startsWith('.')), `hidden file: ${name}`);
  const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
  const compressed = zip.subarray(start, start + compressedSize);
  assert.ok(method === 0 || method === 8, `unsupported compression: ${name}`);
  const raw = method === 8 ? inflateRawSync(compressed) : compressed;
  assert.equal(raw.length, size, `size mismatch: ${name}`);
  assert.deepEqual(raw, fs.readFileSync(path.join(root, name)), `content mismatch: ${name}`);
  entries.set(name, raw);
  cursor += 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
}
assert.equal(cursor, end, 'central directory size mismatch');
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/Apache-2.0.txt',
  manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page,
  ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap(script => [...(script.js || []), ...(script.css || [])])]) {
  assert.ok(entries.has(name), `missing release file: ${name}`);
}
assert.equal(JSON.parse(entries.get('manifest.json')).version, pkg.version);
// Every runtime file must survive packaging, including indirect imports and vendor workers.
for (const dir of ['background', 'content', 'icons', 'options', 'popup', 'shared', 'studio']) {
  const visit = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(name);
      else assert.ok(entries.has(name), `runtime file omitted: ${name}`);
    }
  };
  visit(dir);
}
console.log(`Verified release ZIP v${pkg.version}: ${count} files, exact contents, runtime references and licenses.`);
