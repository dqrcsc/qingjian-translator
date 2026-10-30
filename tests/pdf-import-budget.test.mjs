import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { extractPdfBlocksLocally } from '../studio/pdf-engine.js';
import { createDocumentBudget } from '../studio/document-budget.js';
const stream = text => Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Filter /FlateDecode >>\nstream\n'), deflateSync(Buffer.from(text)), Buffer.from('\nendstream\nendobj\n')]);
const arrayBuffer = bytes => Uint8Array.from(bytes).buffer;
test('local PDF Flate extraction respects actual expansion limit and cannot swallow a limit as format fallback', async () => {
  const budget = createDocumentBudget({maxEntryBytes:128});
  try { await assert.rejects(extractPdfBlocksLocally(arrayBuffer(stream(`BT (${ 'long source '.repeat(100) }) Tj ET`)), {budget}), {name:'DocumentLimitError'}); }
  finally {budget.dispose();}
});
test('local PDF multiple Flate streams share expanded bytes and one deadline', async () => {
  const bytes=Buffer.concat([stream(`BT (${'a'.repeat(80)}) Tj ET`),stream(`BT (${'b'.repeat(80)}) Tj ET`)]);
  const budget=createDocumentBudget({maxExpandedBytes:140});
  try {await assert.rejects(extractPdfBlocksLocally(arrayBuffer(bytes),{budget}),{name:'DocumentLimitError'});} finally {budget.dispose();}
  const cancelled=new AbortController();cancelled.abort();
  const stopped=createDocumentBudget({signal:cancelled.signal});
  try {await assert.rejects(extractPdfBlocksLocally(arrayBuffer(bytes),{budget:stopped}),{name:'AbortError'});} finally {stopped.dispose();}
});
test('local PDF normal compressed source survives bounded extraction', async()=>{
  const blocks=await extractPdfBlocksLocally(arrayBuffer(stream('BT (Normal source paragraph.) Tj ET')));
  assert.equal(blocks[0].original,'Normal source paragraph.');
});
