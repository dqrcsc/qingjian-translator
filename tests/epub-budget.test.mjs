import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { createDocumentBudget } from '../studio/document-budget.js';
import { readZipArchive } from '../studio/epub-engine.js';

function archive(items) {
  const local = [], central = [];
  let offset = 0;
  for (const { name, text, declaredSize, method = 8 } of items) {
    const file = Buffer.from(name), raw = Buffer.from(text), compressed = method === 8 ? deflateRawSync(raw) : raw;
    let crc = 0xffffffff;
    for (const byte of raw) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(declaredSize ?? raw.length, 22); header.writeUInt16LE(file.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(declaredSize ?? raw.length, 24);
    directory.writeUInt16LE(file.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, file, compressed); central.push(directory, file); offset += header.length + file.length + compressed.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Uint8Array.from(Buffer.concat([...local, cd, end])).buffer;
}
const run = async (options, fn) => {
  const budget = createDocumentBudget(options);
  try { await fn(budget); } finally { budget.dispose(); }
};

test('ZIP validates actual expansion despite understated uncompressed sizes', async () => {
  await run({ maxEntryBytes: 128 }, async budget => {
    const entries = await readZipArchive(archive([{ name: 'chapter', text: 'x'.repeat(4096), declaredSize: 1 }]), { budget });
    await assert.rejects(entries.get('chapter').getBytes(), /单项解压大小/);
    assert.equal(budget.signal.aborted, true);
  });
});

test('ZIP cumulative quota includes multiple members and stored entries', async () => {
  await run({ maxExpandedBytes: 100 }, async budget => {
    const entries = await readZipArchive(archive([{ name: 'one', text: 'x'.repeat(60) }, { name: 'two', text: 'y'.repeat(60), method: 0 }]), { budget });
    assert.equal((await entries.get('one').getBytes()).length, 60);
    await assert.rejects(entries.get('two').getBytes(), /累计解压大小/);
  });
});

test('ZIP ratio checks actual expanded chunks with a small-item grace', async () => {
  await run({ maxCompressionRatio: 2, compressionRatioGraceBytes: 100 }, async budget => {
    const entries = await readZipArchive(archive([{ name: 'chapter', text: 'x'.repeat(500), declaredSize: 1 }]), { budget });
    await assert.rejects(entries.get('chapter').getBytes(), /压缩比/);
  });
});

test('all ZIP reads share the original deadline and cancellation signal', async () => {
  await run({ timeoutMs: 20 }, async budget => {
    const entries = await readZipArchive(archive([{ name: 'one', text: 'hello' }]), { budget });
    await new Promise(resolve => setTimeout(resolve, 25));
    await assert.rejects(entries.get('one').getBytes(), error => error.name === 'TimeoutError');
  });
  const controller = new AbortController();
  await run({ signal: controller.signal }, async budget => {
    const entries = await readZipArchive(archive([{ name: 'one', text: 'hello' }]), { budget });
    controller.abort(new DOMException('replaced', 'AbortError'));
    await assert.rejects(entries.get('one').getBytes(), /replaced/);
  });
});

test('ZIP rejects count overflow, malformed/truncated directories and false output size', async () => {
  await run({ maxEntries: 1 }, async budget => {
    await assert.rejects(readZipArchive(archive([{ name: 'one', text: 'a' }, { name: 'two', text: 'b' }]), { budget }), /条目/);
  });
  const good = archive([{ name: 'one', text: 'hello' }]);
  await assert.rejects(readZipArchive(good.slice(0, -8)), /EPUB|ZIP/);
  const invalid = good.slice(0); new DataView(invalid).setUint32(invalid.byteLength - 6, invalid.byteLength + 100, true);
  await assert.rejects(readZipArchive(invalid), /EPUB|ZIP/);
  const entries = await readZipArchive(archive([{ name: 'one', text: 'hello', declaredSize: 1 }]));
  try { await assert.rejects(entries.get('one').getBytes(), /大小.*不一致/); } finally { entries.dispose?.(); }
});

test('normal compressed/stored ZIP entries preserve content and CRC validation rejects corruption', async () => {
  const entries = await readZipArchive(archive([{ name: 'one', text: 'hello' }, { name: 'two', text: '世界', method: 0 }]));
  try { assert.equal(await entries.get('one').getText(), 'hello'); assert.equal(await entries.get('two').getText(), '世界'); }
  finally { entries.dispose?.(); }
  const corrupt = archive([{ name: 'one', text: 'hello', method: 0 }]); new Uint8Array(corrupt)[33] ^= 1;
  const broken = await readZipArchive(corrupt);
  try { await assert.rejects(broken.get('one').getBytes(), /校验/); } finally { broken.dispose?.(); }
});

test('cancellation during a pending decompression read cannot yield partial bytes', async () => {
  const controller = new AbortController();
  await run({ signal: controller.signal }, async budget => {
    const entries = await readZipArchive(archive([{ name: 'chapter', text: 'x'.repeat(65536) }]), { budget });
    const reading = entries.get('chapter').getBytes();
    controller.abort(new DOMException('chapter replaced while decompressing', 'AbortError'));
    await assert.rejects(reading, /chapter replaced while decompressing/);
    assert.equal(budget.signal.aborted, true);
  });
});

test('ZIP accepts data-descriptor members but rejects duplicate names and overlaps', async () => {
  const descriptor = archive([{ name: 'one', text: 'hello' }]);
  const view = new DataView(descriptor), cd = view.getUint32(descriptor.byteLength - 6, true);
  view.setUint16(6, 8, true); view.setUint16(cd + 8, 8, true);
  view.setUint32(14, 0, true); view.setUint32(18, 0, true); view.setUint32(22, 0, true);
  const entries = await readZipArchive(descriptor);
  try { assert.equal(await entries.get('one').getText(), 'hello'); } finally { entries.dispose(); }
  await assert.rejects(readZipArchive(archive([{ name: 'same', text: 'first' }, { name: 'same', text: 'second' }])), /重复/);
  const overlapping = archive([{ name: 'one', text: 'hello' }, { name: 'two', text: 'world' }]);
  const corrupt = new DataView(overlapping), start = corrupt.getUint32(overlapping.byteLength - 6, true);
  // Point the second member at the first header; metadata validation must fail instead of aliasing it.
  corrupt.setUint32(start + 46 + 3 + 42, 0, true);
  await assert.rejects(readZipArchive(overlapping), /不一致|重叠/);
});
