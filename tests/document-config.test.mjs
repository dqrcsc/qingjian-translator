import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { snapshotDocumentConfig, documentConfigSignature, requestDocumentConfig } from '../shared/document-config.js';

test('document signature tracks translation configuration but excludes scheduling, UI and usage fields', () => {
  const initial = { targetLang: 'zh-CN', apiProtocol: 'openai', apiBaseUrl: 'https://test.invalid/v1', apiKey: 'fixture', modelId: 'model', temperature: 0.2 };
  const signature = documentConfigSignature(initial);
  for (const changes of [{ targetLang: 'en' }, { modelId: 'other' }, { glossaryText: 'word=词' }, { customSystemPrompt: 'literal' }, { apiKey: 'rotated' }, { temperature: 0.4 }]) {
    assert.notEqual(documentConfigSignature({ ...initial, ...changes }), signature);
  }
  assert.equal(documentConfigSignature({ ...initial, maxConcurrency: 8, youtubeShowSidebar: false }), signature);
  assert.equal('requestSignal' in snapshotDocumentConfig({ ...initial, requestSignal: 'unsafe' }), false);
});

test('only the actual extension studio page can supply a whitelisted document snapshot', () => {
  const studio = 'chrome-extension://fixture/studio/studio.html';
  const message = { documentConfig: { apiKey: 'fixture', targetLang: 'en', maxConcurrency: 999, requestBudgetSeconds: 99999 } };
  for (const url of ['https://example.com/', 'https://example.com/studio/studio.html', studio + '/fake']) {
    assert.equal(requestDocumentConfig(message, { url }, studio), undefined);
  }
  const actual = requestDocumentConfig(message, { url: studio + '?url=example' }, studio);
  assert.equal(actual.targetLang, 'en');
  assert.equal('maxConcurrency' in actual, false);
  assert.equal('requestBudgetSeconds' in actual, false);
  assert.throws(() => requestDocumentConfig({ documentConfig: { apiKey: {} } }, { url: studio }, studio), /配置无效/);
});

test('document snapshot freezes the effective fetched model instead of a changing available-model list', () => {
  const settings = { apiProtocol: 'gemini', availableModels: [{ id: 'models/first' }] };
  const snapshot = snapshotDocumentConfig(settings);
  assert.equal(snapshot.modelId, 'first');
  assert.notEqual(documentConfigSignature(settings), documentConfigSignature({ ...settings, availableModels: [{ id: 'models/second' }] }));
  assert.equal(snapshotDocumentConfig({ ...settings, ...snapshot, availableModels: [{ id: 'models/second' }] }).modelId, 'first');
});

test('configuration choices are serialized and an old storage read cannot affect a replacement document', async () => {
  const source = fs.readFileSync(new URL('../studio/studio.js', import.meta.url), 'utf8');
  const start = source.indexOf('let documentConfigChoicePending =');
  const end = source.indexOf("configNotice.querySelector('[data-config-keep]').addEventListener", start);
  let finishRead, applied = 0;
  const buttons = [{ disabled: false }, { disabled: false }];
  const ctx = vm.createContext({ currentDoc: {}, documentSession: 1, docStatusSubtitle: {},
    configNotice: { querySelectorAll: () => buttons }, getSettings: () => new Promise(resolve => { finishRead = resolve; }) });
  vm.runInContext(source.slice(start, end), ctx);
  const first = ctx.withDocumentConfigChoice(() => applied++);
  const second = ctx.withDocumentConfigChoice(() => { applied += 100; });
  assert.ok(buttons.every(button => button.disabled));
  finishRead({ targetLang: 'en' }); await Promise.all([first, second]);
  assert.equal(applied, 1); assert.ok(buttons.every(button => !button.disabled));
  const stale = ctx.withDocumentConfigChoice(() => applied++);
  ctx.currentDoc = {}; ctx.documentSession++;
  finishRead({}); await stale; assert.equal(applied, 1);
});
