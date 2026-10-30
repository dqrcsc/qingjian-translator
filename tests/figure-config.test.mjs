import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../studio/studio.js', import.meta.url), 'utf8');
function fixture(overrides = {}) {
  const block = { id: 1, type: 'figure', original: 'caption', translation: 'caption translated', originalImageDataUrl: 'data:image/png;base64,original', imageDataUrl: 'old-image', figureTranslationPending: true, figureLabels: [{ original: 'Hello', translation: '', box_2d: [10,10,80,80] }] };
  const canvas = { width: 200, height: 100 };
  const doc = { blocks: [block], bookTitle: 'fixture' };
  const calls = [];
  const ctx = vm.createContext({ currentDoc: doc, documentSession: 1, DOMException,
    MESSAGE_TYPES: { TRANSLATE_BATCH: 'TRANSLATE_BATCH', TRANSLATE_IMAGE: 'TRANSLATE_IMAGE' },
    createBatches: items => [items], normalizeFigureLabelsToCrop: labels => labels,
    sendModelRequest: async msg => { calls.push(msg); return { ok: true, data: { translations: [{id:0,translation:'New label'}] } }; },
    loadImageToCanvas: async () => canvas,
    renderSeamlessFigureTranslation: (_canvas, labels) => ({ translatedDataUrl: 'new-image', labels }), ...overrides });
  const start = source.indexOf('async function retranslateDocumentFigure(');
  assert.ok(start >= 0, 'figure configuration retranslation must have a real implementation');
  const end = source.indexOf('\nasync function handleFigureImageFile(', start);
  vm.runInContext(source.slice(start, end), ctx);
  return { ctx, block, doc, canvas, calls };
}
test('figure labels are translated with the bound target and redraw atomically from original image', async () => {
  const {ctx,block,canvas,calls}=fixture();
  await ctx.retranslateDocumentFigure(block,{targetLang:'en'},()=>true);
  assert.equal(calls[0].payload.targetLang,'en'); assert.equal(calls[0].payload.bypassCache,true);
  assert.equal(block.figureLabels[0].translation,'New label');assert.equal(block.imageDataUrl,'new-image');
  assert.equal(block.figureTranslationPending,false);assert.equal(canvas.width,0);assert.equal(canvas.height,0);
});
test('missing labels fail without claiming complete or replacing the previous image', async () => {
  const {ctx,block}=fixture({sendModelRequest:async()=>({ok:true,data:{translations:[]}})});
  await assert.rejects(ctx.retranslateDocumentFigure(block,{targetLang:'en'},()=>true),/图中文字/);
  assert.equal(block.figureTranslationPending,true);assert.equal(block.imageDataUrl,'old-image');
});
test('cancelled or replaced figure cannot accept late image decode and frees temporary canvas', async () => {
  let finish;
  const {ctx,block,canvas}=fixture({loadImageToCanvas:()=>new Promise(resolve=>{finish=resolve;})});
  const pending=ctx.retranslateDocumentFigure(block,{targetLang:'en'},()=>true);
  while(!finish) await new Promise(resolve=>setImmediate(resolve));
  block.originalImageDataUrl='replacement';finish(canvas);
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(block.imageDataUrl,'old-image');assert.equal(block.figureTranslationPending,true);assert.equal(canvas.width,0);
});
test('a figure without stored labels uses image recognition and handles a no-text result explicitly', async () => {
  const {ctx,block,calls}=fixture();block.figureLabels=[];
  ctx.sendModelRequest=async msg=>{calls.push(msg);return {ok:true,data:{hasText:false,regions:[]}};};
  await ctx.retranslateDocumentFigure(block,{targetLang:'en'},()=>true);
  assert.equal(calls[0].type,'TRANSLATE_IMAGE');assert.equal(block.figureLabels.length,0);
  assert.equal(block.figureTranslationPending,false);assert.equal(block.isCanvasInpainted,false);
  assert.equal(block.imageDataUrl,block.originalImageDataUrl);
});
test('label-only figures can retranslate overlays without requiring a raster image', async () => {
  const {ctx,block}=fixture();delete block.originalImageDataUrl;delete block.imageDataUrl;
  await ctx.retranslateDocumentFigure(block,{targetLang:'en'},()=>true);
  assert.equal(block.figureLabels[0].translation,'New label');assert.equal(block.figureTranslationPending,false);
  assert.equal(block.isCanvasInpainted,false);
});
