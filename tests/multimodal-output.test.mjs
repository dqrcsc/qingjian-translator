import test from 'node:test';
import assert from 'node:assert/strict';

const stored = {};
globalThis.chrome = { storage: { local: {
  async get(key) { return { [key]: stored[key] }; },
  async set(value) { Object.assign(stored, value); }
} } };
const { analyzePdfWithGemini, translateImageWithGemini } = await import('../background/gemini-client.js');
const { getUsageStats } = await import('../shared/storage.js');
const settings = { providerId: 'google', apiProtocol: 'gemini', apiBaseUrl: 'https://fixture.invalid/v1beta',
  apiKey: 'local-only', modelId: 'gemini-fixture', targetLang: 'zh-CN' };
let calls = [];
const mock = (value, protocol = 'gemini') => {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(protocol === 'gemini'
      ? { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify(value) }] } }] }
      : { choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200 });
  };
};
const paragraph = { page: 1, type: 'paragraph', original: 'Real source', translation: '有效译文' };
const label = { original: 'Hello label', translation: '文字译文', box_2d: [10, 20, 100, 200] };
const pdf = () => analyzePdfWithGemini({ pageImageBase64: 'cGFnZQ==', pageNumber: 1 }, settings);
const image = (overrides = {}) => translateImageWithGemini({ imageBase64: 'aW1hZ2U=', mimeType: 'image/png' }, { ...settings, ...overrides });

test('native Gemini PDF rejects empty, partial, wrong-type and malformed blocks without success accounting', async () => {
  for (const value of [[], {}, [null], [{ ...paragraph, translation: '' }],
    [paragraph, { ...paragraph, translation: '  ' }], [{ ...paragraph, translation: 1 }],
    [{ ...paragraph, original: '' }], [{ ...paragraph, type: 'unknown' }],
    [{ ...paragraph, page: '1' }], [{ ...paragraph, column: 'diagonal' }]]) {
    mock(value); const before = await getUsageStats();
    await assert.rejects(pdf, /PDF.*(无效|缺少|为空)/);
    assert.equal(calls.length, 1, 'invalid business data must not retry automatically');
    assert.equal((await getUsageStats()).totalParagraphs, before.totalParagraphs);
  }
});

test('native Gemini PDF permits source-preserving equation/code blocks and valid translated text', async () => {
  const blocks = [paragraph, { page: 1, type: 'equation', original: '$$x=1$$', translation: '' },
    { page: 1, type: 'code', original: '  return x;\n', translation: '' }];
  mock(blocks); const result = await pdf();
  assert.equal(result[0].translation, paragraph.translation);
  assert.equal(result[1].translation, '$$x=1$$');
  assert.equal(result[2].translation, '  return x;\n');
  assert.deepEqual(calls[0].body.contents[0].parts[0].inlineData, { mimeType: 'image/jpeg', data: 'cGFnZQ==' });
});

test('native Gemini PDF validates figure geometry and every figure label before committing a page', async () => {
  const figure = { ...paragraph, type: 'figure', figureBox2d: [0, 0, 500, 500], figureLabels: [label] };
  for (const invalid of [{ ...figure, figureBox2d: [20, 10, 10, 50] },
    { ...figure, figureBox2d: [0, 0, 1001, 500] }, { ...figure, figureLabels: {} },
    { ...figure, figureLabels: [label, { ...label, translation: '' }] }]) {
    mock([invalid]); await assert.rejects(pdf, /PDF/);
  }
  mock([figure]); assert.deepEqual(await pdf(), [figure]);
  mock([{ ...figure, figureLabels: [] }]); assert.equal((await pdf())[0].figureLabels.length, 0);
});

test('image output rejects missing text, invalid geometry and contradictory no-text responses under both protocols', async () => {
  const valid = { hasText: true, regions: [label] };
  const invalid = [null, [], {}, { hasText: 'false', regions: [] },
    { ...valid, regions: [] }, { ...valid, regions: [label, { ...label, translation: '' }] },
    { ...valid, regions: [{ ...label, original: 42 }] },
    { ...valid, regions: [{ ...label, box_2d: ['0', 0, 100, 100] }] },
    { ...valid, regions: [{ ...label, box_2d: [0, 100, 50, 20] }] },
    { hasText: false, regions: [label] }, { hasText: false, regions: [], summaryTranslation: 'translated text' }];
  for (const protocol of ['gemini', 'openai']) {
    for (const value of invalid) {
      mock(value, protocol); const before = await getUsageStats();
      await assert.rejects(() => image({ apiProtocol: protocol }), /图片/);
      assert.equal(calls.length, 1);
      assert.equal((await getUsageStats()).totalParagraphs, before.totalParagraphs);
    }
  }
});

test('real no-text image and valid regions remain successful; omitted summary is derived from translations', async () => {
  mock({ hasText: false, regions: [], sourceLang: '', summaryTranslation: '' });
  const empty = await image(); assert.equal(empty.hasText, false); assert.deepEqual(empty.regions, []);
  mock({ hasText: true, regions: [label] }); const translated = await image();
  assert.equal(translated.summaryTranslation, label.translation);
  assert.deepEqual(translated.regions, [label]);
  assert.match(translated.imageDataUrl, /^data:image\/png;base64,/);
});
