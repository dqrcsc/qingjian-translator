import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../studio/studio.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('const MAX_CACHED_PAGE_RENDERS ='), source.indexOf('function setLeftPdfPreviewWindow('));
function harness() {
  const pending = [], rendered = [], doc = { pdfDoc: {}, totalPages: 50, pageRenderCache: new Map(), translatingPages: new Set(), leftPreviewWanted: new Set(), pdfArrayBuffer: new ArrayBuffer(12), pdfBlobUrl: 'blob:old-pdf' };
  const controller = new AbortController(), signal = controller.signal;
  const revoked = [];
  const ctx = vm.createContext({ currentDoc: doc, AbortController, URL: { revokeObjectURL: url => revoked.push(url) }, documentRequests: { signal }, leftPdfPageObserver: { disconnect() {} }, pdfNativeEmbed: { removeAttribute() {} }, pdfCanvasScrollViewer: { querySelectorAll: () => [] },
    renderPdfPageToCanvas: (doc, page, scale, { signal }) => new Promise(resolve => pending.push({ page, signal, resolve })) });
  vm.runInContext(code, ctx);
  const finish = async request => {
    const result = { canvas: { width: 600, height: 800 }, width: 600, height: 800, jpegDataUrl: `data:page${request.page}`, jpegBase64: 'bytes', textItems: ['text'] };
    rendered.push(result); request.resolve(result); await tick(); return result;
  };
  return { ctx, doc, pending, rendered, finish, revoked, controller };
}
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
test('PDF renders run at most two concurrently; bounded cache releases canvas, JPEG and text together', async () => {
 const h = harness(); const first = h.ctx.getOrRenderPdfPage(1), second = h.ctx.getOrRenderPdfPage(2), third = h.ctx.getOrRenderPdfPage(3);
 await tick(); assert.equal(h.pending.length, 2); await h.finish(h.pending[0]); await first;
 assert.equal(h.pending.length, 3); await h.finish(h.pending[1]); await h.finish(h.pending[2]); await Promise.all([second, third]);
 for(let page=4;page<=20;page++){const p=h.ctx.getOrRenderPdfPage(page);await tick();await h.finish(h.pending.at(-1));await p;}
 assert.ok(h.doc.pageRenderCache.size<=8); assert.equal(h.rendered[0].canvas,null);assert.equal(h.rendered[0].jpegDataUrl,'');assert.equal(h.rendered[0].jpegBase64,'');assert.equal(h.rendered[0].textItems.length,0);
});
test('PDF translation pins preserve their canvas while offscreen; releasing pin permits complete eviction', async()=>{
 const h=harness();h.doc.translatingPages.add(1);const p=h.ctx.getOrRenderPdfPage(1);await tick();const r=await h.finish(h.pending[0]);await p;
 h.ctx.evictPdfPageRender(h.doc,1);assert.equal(r.canvas.width,600);
 for(let page=2;page<=12;page++){const p=h.ctx.getOrRenderPdfPage(page);await tick();await h.finish(h.pending.at(-1));await p;}
 assert.equal(r.canvas.width,600);h.doc.translatingPages.delete(1);h.ctx.evictPdfPageRender(h.doc,1);assert.equal(r.canvas,null);
});
test('PDF document disposal cancels queued and active work; late completion cannot repopulate old cache',async()=>{
 const h=harness();const promises=[1,2,3,4].map(p=>h.ctx.getOrRenderPdfPage(p));await tick();assert.equal(h.pending.length,2);
 h.ctx.disposePdfPreviewResources(h.doc);assert.ok(h.pending.every(r=>r.signal.aborted));assert.equal(h.doc.pageRenderCache.size,0);assert.equal(h.doc.pdfArrayBuffer,null);assert.deepEqual(h.revoked,['blob:old-pdf']);assert.equal(h.doc.pdfBlobUrl,'');
 const late=await h.finish(h.pending[0]);await h.finish(h.pending[1]);assert.deepEqual(await Promise.all(promises),[null,null,null,null]);assert.equal(late.canvas,null);assert.equal(h.pending.length,2);assert.equal(h.doc.pdfRenderState.records.size,0);
});
test('PDF offscreen eviction ignores even a renderer that returns after abort, and revisiting starts fresh work',async()=>{
 const h=harness();const old=h.ctx.getOrRenderPdfPage(7);await tick();h.ctx.evictPdfPageRender(h.doc,7);const fresh=h.ctx.getOrRenderPdfPage(7);await tick();
 const late=await h.finish(h.pending[0]);assert.equal(await old,null);assert.equal(late.jpegDataUrl,'');const current=await h.finish(h.pending[1]);assert.equal(await fresh,current);assert.equal(h.doc.pageRenderCache.size,1);
});

test('pinned PDF renders cannot exceed eight resident slots and release admits the waiting page', async () => {
  const h = harness();
  for (let page = 1; page <= 8; page++) {
    h.doc.translatingPages.add(page);
    const task = h.ctx.getOrRenderPdfPage(page); await tick(); await h.finish(h.pending.at(-1)); await task;
  }
  h.doc.translatingPages.add(9);
  const ninth = h.ctx.getOrRenderPdfPage(9); await tick();
  assert.equal(h.pending.length, 8, 'pinning is not permission to allocate a ninth canvas');
  h.doc.translatingPages.delete(1); h.ctx.evictPdfPageRender(h.doc, 1); await tick();
  assert.equal(h.pending.length, 9); await h.finish(h.pending.at(-1)); await ninth;
  assert.equal(h.rendered[0].canvas, null);
  assert.ok(h.rendered.filter(result => result.canvas).length <= 8);
});

test('scope cancellation resolves a render waiting behind pinned slots without requiring a scroll', async () => {
  const h = harness();
  for (let page = 1; page <= 8; page++) {
    h.doc.translatingPages.add(page); const task = h.ctx.getOrRenderPdfPage(page);
    await tick(); await h.finish(h.pending.at(-1)); await task;
  }
  h.doc.translatingPages.add(9); const task = h.ctx.getOrRenderPdfPage(9); await tick();
  h.controller.abort();
  assert.equal(await task, null); assert.equal(h.doc.pdfRenderState.queue.length, 0);
  assert.equal(h.pending.length, 8);
});
