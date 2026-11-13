import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFigureLabelsToCrop } from '../studio/pdf-engine.js';
const store = {};
globalThis.chrome = { storage: { local: {
  async get(key) { return { [key]: store[key] }; },
  async set(values) { Object.assign(store, values); }
} } };
const { explainSelectionWithGemini, analyzePdfWithGemini } = await import('../background/gemini-client.js');
const { getUsageStats } = await import('../shared/storage.js');
const base = { providerId: 'custom', apiBaseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', modelId: 'fixture', targetLang: 'es' };
const valid = { translation: 'orilla', contextualMeaning: 'La orilla del río.', breakdown: [{ term: 'bank', meaning: 'orilla' }] };
for (const protocol of ['openai', 'gemini']) {
  test(`${protocol} selection rejects malformed business data before success statistics and accepts valid words/phrases`, async () => {
    let reply, requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return new Response(JSON.stringify(protocol === 'gemini'
        ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: reply }] } }] }
        : { choices: [{ message: { content: reply } }] }));
    };
    const invalid = [{}, null, [], { ...valid, translation: ' ' }, { ...valid, contextualMeaning: 5 },
      { ...valid, breakdown: {} }, { ...valid, breakdown: [null] },
      { ...valid, breakdown: [{ term: 'a', meaning: '' }] }, { ...valid, example: {} }];
    for (const raw of [...invalid.map(v => JSON.stringify(v)), '{bad-json']) {
      reply = raw;
      const before = await getUsageStats(), count = requests;
      await assert.rejects(() => explainSelectionWithGemini({ text: 'bank' }, { ...base, apiProtocol: protocol }));
      const after = await getUsageStats();
      assert.equal(after.totalParagraphs, before.totalParagraphs);
      assert.equal(after.estimatedCharsTranslated, before.estimatedCharsTranslated);
      assert.equal(requests, count + 1, 'bad response must not silently retry');
    }
    for (const text of ['bank', 'river bank']) {
      reply = JSON.stringify(valid);
      const before = await getUsageStats();
      assert.deepEqual(await explainSelectionWithGemini({ text }, { ...base, apiProtocol: protocol }), valid);
      assert.equal((await getUsageStats()).totalParagraphs, before.totalParagraphs + 1);
    }
  });
}
for (const translations of [['Arriba', 'Ir', 'IA'], ['上', '行く', '人工知能'], ['أعلى', 'اذهب', 'ذكاء'], ['A', 'Go', 'AI']]) {
  test(`short labels survive for ${translations.join('/')}, while ticks and duplicates are filtered`, () => {
    const labels = ['Up', 'Go', 'AI'].map((original, i) => ({ original, translation: translations[i], box_2d: [20 + i * 200, 30, 100 + i * 200, 200] }));
    const cleaned = normalizeFigureLabelsToCrop([...labels, labels[0], { original: '85.2%', translation: '85.2%', box_2d: [700, 30, 800, 200] }], [0, 0, 1000, 1000]);
    assert.deepEqual(cleaned.map(l => l.translation), translations);
  });
}
for (const count of [10, 11, 20]) {
  test(`native PDF prompt requests all source languages and preserves ${count} labels`, async () => {
    const labels = Array.from({ length: count }, (_, i) => ({ original: `日本語 ${i}`, translation: `Texto ${i}`, box_2d: [20 + Math.floor(i / 5) * 200, 10 + i % 5 * 180, 100 + Math.floor(i / 5) * 200, 170 + i % 5 * 180] }));
    globalThis.fetch = async (_url, init) => {
      const prompt = JSON.parse(init.body).contents[0].parts.find(p => p.text).text;
      assert.match(prompt, /ALL meaningful/); assert.match(prompt, /ANY source language/);
      assert.doesNotMatch(prompt, /at most 10|ONLY the key English/);
      return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify([
        { page: 1, type: 'figure', original: '図', translation: 'Figura', figureBox2d: [0, 0, 1000, 1000], figureLabels: labels }
      ]) }] } }] }));
    };
    const blocks = await analyzePdfWithGemini({ pageImageBase64: 'AA==', pageNumber: 1 }, { ...base, apiProtocol: 'gemini' });
    assert.equal(normalizeFigureLabelsToCrop(blocks[0].figureLabels, blocks[0].figureBox2d).length, count);
  });
}
