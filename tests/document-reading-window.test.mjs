import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../studio/studio.js', import.meta.url), 'utf8');
const start = source.indexOf('const DOCUMENT_READING_PAGE_SIZE =');
const end = source.indexOf('function revealDocumentBlock(', start);
function harness() {
  const ctx = vm.createContext({ currentDoc: {}, document: { getElementById: () => null }, bilingualStreamContainer: { scrollTop: 25 }, sourceOutlineViewer: { scrollTop: 50 } });
  vm.runInContext(source.slice(start, end), ctx);
  return ctx;
}

test('document reading ranges remain bounded at 100 blocks across empty, huge and invalid requested pages', () => {
  const ctx = harness();
  for (const total of [0, 1, 100, 101, 10000]) {
    for (const page of [-1, 0, 50, 9999, NaN, Infinity]) {
      const result = ctx.documentReadingRange(total, page);
      assert.ok(result.end - result.start <= 100);
      assert.ok(result.start >= 0 && result.end <= total);
      assert.ok(result.page >= 0 && result.page < result.pages);
    }
  }
  assert.deepEqual({ ...ctx.documentReadingRange(10001, 100) }, { page: 100, pages: 101, start: 10000, end: 10001 });
});

test('search, chapter and document changes reset reading range while rerenders retain the active group', () => {
  const ctx = harness(), blocks = Array.from({ length: 10000 }, (_, id) => ({ id }));
  assert.equal(ctx.selectDocumentReadingWindow(blocks, '', null)[0].id, 0);
  ctx.currentDoc.readingWindowPage = 43;
  assert.equal(ctx.selectDocumentReadingWindow(blocks, '', null)[0].id, 4300);
  assert.equal(ctx.selectDocumentReadingWindow(blocks, 'needle', null)[0].id, 0);
  ctx.currentDoc.readingWindowPage = 40;
  assert.equal(ctx.selectDocumentReadingWindow(blocks, 'NEEDLE', null)[0].id, 4000);
  assert.equal(ctx.selectDocumentReadingWindow(blocks, 'needle', 1)[0].id, 0);
  ctx.currentDoc.readingWindowPage = 99;
  ctx.currentDoc = {};
  assert.equal(ctx.selectDocumentReadingWindow(blocks, 'needle', 1)[0].id, 0);
  assert.equal(ctx.bilingualStreamContainer.scrollTop, 0);
  assert.equal(ctx.sourceOutlineViewer.scrollTop, 0);
  assert.equal(blocks.length, 10000, 'the complete export model remains intact');
});
