import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../studio/pdf-engine.js', import.meta.url), 'utf8');
const start = source.indexOf('export const PDF_RENDER_LIMITS');
const code = source.slice(start, source.indexOf('\n/**', start)).replaceAll('export ', '');
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function harness({ width = 300, height = 400, phase, neverCancel = false } = {}) {
  const canvases = []; let cleanup = 0, cancellations = 0, resolvePage, textStarted = false;
  const ctx = vm.createContext({ DOMException, document: { createElement() {
    const canvas = { width: 0, height: 0, getContext: () => ({ fillRect() {} }), toDataURL: () => 'data:image/jpeg;base64,eA==' };
    canvases.push(canvas); return canvas;
  } }, loadPdfjs: async () => ({ Util: { transform: (viewport, transform) => transform } }) });
  vm.runInContext(code, ctx);
  const page = { cleanup() { cleanup++; }, getViewport: ({ scale }) => ({ width: width * scale, height: height * scale, scale, transform: [] }),
    render() { let reject; const promise = phase === 'render' ? new Promise((_, r) => reject = r) : Promise.resolve(); return { promise, cancel() { cancellations++; reject?.(new DOMException('cancel', 'AbortError')); } }; },
    streamTextContent() { let done = false; return { getReader: () => ({ read() { textStarted = true; if (phase === 'text') return new Promise(() => {}); if (done) return Promise.resolve({ done: true }); done = true; return Promise.resolve({ done: false, value: { items: [{ str: 'text', transform: [1,0,0,10,20,30], width: 10 }] } }); }, cancel() { cancellations++; return neverCancel ? new Promise(() => {}) : Promise.resolve(); }, releaseLock() {} }) }; }
  };
  const doc = { getPage: () => phase === 'page' ? new Promise(resolve => { resolvePage = resolve; }) : Promise.resolve(page) };
  return { render: ctx.renderPdfPageToCanvas, doc, page, canvases, get cleanup() { return cleanup; }, get textStarted() { return textStarted; }, get cancellations() { return cancellations; }, finishPage() { resolvePage(page); } };
}
test('PDF pixels and edge are bounded before canvas allocation; vector widths use actual scale', async () => {
  for (const size of [[10000,10000], [1000000,100], [300,400]]) {
    const h = harness({ width: size[0], height: size[1] });
    const result = await h.render(h.doc, 1, 2);
    assert.ok(result.width <= 4096 && result.height <= 4096 && result.width * result.height <= 4*1024*1024);
    if (size[0] === 300) assert.equal(result.textItems[0].width, 20);
    else assert.ok(result.textItems[0].width < 20);
    assert.equal(h.cleanup, 1);
  }
});
test('invalid PDF viewport is rejected without creating a canvas', async () => {
  for (const width of [Infinity, NaN, 0, -10]) {
    const h = harness({ width }); await assert.rejects(h.render(h.doc, 1)); assert.equal(h.canvases.length, 0);
  }
});
for (const phase of ['page','render','text']) test(`cancellation during ${phase} settles promptly and releases canvas/late page`, async () => {
  const h = harness({ phase }), controller = new AbortController();
  const task = h.render(h.doc, 1, 2, { signal: controller.signal });
  await tick(); controller.abort();
  await assert.rejects(task, { name: 'AbortError' });
  assert.ok(h.canvases.every(c => c.width === 0 && c.height === 0));
  if (phase === 'page') { h.finishPage(); await tick(); }
  assert.equal(h.cleanup, 1);
  if (phase === 'text') assert.equal(h.cancellations >= 1, true);
});
test('uncancellable late page acquisitions and hung cancellation cannot grow without bound', async () => {
  for (const phase of ['page', 'text']) {
    const h = harness({ phase, neverCancel: true });
    for (let i = 0; i < 2; i++) { const c = new AbortController(); const task = h.render(h.doc, i+1, 2, { signal:c.signal }); await tick(); c.abort(); await assert.rejects(task); }
    await assert.rejects(h.render(h.doc, 3), /取页任务仍在结束/);
    assert.ok(h.canvases.length <= 2);
  }
});
test('completed text cancellation releases the pending-work lease for subsequent pages', async () => {
  const h = harness({ phase: 'text' });
  for (let i = 0; i < 4; i++) {
    const controller = new AbortController();
    const task = h.render(h.doc, i+1, 2, { signal:controller.signal });
    await tick(); controller.abort(); await assert.rejects(task, { name:'AbortError' }); await tick();
  }
  assert.equal(h.canvases.length, 4);
  assert.equal(h.cleanup, 4);
  assert.ok(h.canvases.every(canvas => canvas.width === 0));
});
