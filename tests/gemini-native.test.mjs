import test from 'node:test';
import assert from 'node:assert/strict';

const stored = {};
let listener;
const event = { addListener() {} };
globalThis.chrome = {
  storage: { local: {
    async get(key) { return { [key]: structuredClone(stored[key]) }; },
    async set(value) { Object.assign(stored, structuredClone(value)); }
  }, onChanged: event },
  runtime: { onInstalled: event, onConnect: event, onMessage: { addListener(fn) { listener = fn; } }, getURL: value => value },
  tabs: { onUpdated: event }, contextMenus: { onClicked: event }, commands: { onCommand: event }
};
const client = await import('../background/gemini-client.js');
const { DEFAULT_SETTINGS } = await import('../shared/constants.js');
const { saveSettings, getUsageStats } = await import('../shared/storage.js');
const settings = { ...DEFAULT_SETTINGS, providerId: 'google', apiProtocol: 'gemini',
  apiBaseUrl: 'https://gemini-fixture.invalid/v1beta', apiKey: 'fixture-native-key',
  modelId: 'gemini-fixture', enableCache: true };
await saveSettings(settings);
await import('../background/service-worker.js');
const message = (type, payload) => new Promise(resolve => listener({ type, payload }, {}, resolve));
const envelope = (parts, finishReason = 'STOP') => ({ candidates: [{ content: { role: 'model', parts }, finishReason }] });
const answer = value => envelope([{ text: typeof value === 'string' ? value : JSON.stringify(value) }]);
let calls = [];
function mockReplies(...replies) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    assert.ok(calls.length <= replies.length, 'unexpected extra Gemini API request');
    const reply = replies[calls.length - 1];
    return new Response(JSON.stringify(reply.body ?? reply), { status: reply.status ?? 200 });
  };
}

test('native Gemini text uses generateContent and joins only non-thought answer parts', async () => {
  mockReplies(envelope([{ text: 'private reasoning', thought: true }, { text: '你好' }, { text: '世界' }]));
  const result = await message('TRANSLATE_INPUT_TEXT', { text: 'Hello world', targetLang: 'zh-CN' });
  assert.equal(result.ok, true);
  assert.equal(result.data.translatedText, '你好世界');
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/v1beta/models/gemini-fixture:generateContent');
  assert.equal(url.searchParams.get('key'), settings.apiKey);
  assert.equal(calls[0].body.contents[0].role, 'user');
  assert.equal(calls[0].body.contents[0].parts[0].text, 'Hello world');
  assert.ok(calls[0].body.systemInstruction.parts[0].text);
  assert.equal(calls[0].body.messages, undefined);
});

test('native Gemini batch retains valid IDs and repairs only the missing subset', async () => {
  mockReplies(answer([{ id: 20, translation: '普通句子' }]), answer([{ id: 10, translation: '保留 {{0}}' }]));
  const before = await getUsageStats();
  const payload = { items: [{ id: 10, text: 'native-batch Keep {{0}}' }, { id: 20, text: 'native-batch Plain sentence' }] };
  const result = await message('TRANSLATE_BATCH', payload);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.translations.map(item => [item.id, item.translation]), [[10, '保留 {{0}}'], [20, '普通句子']]);
  const repairPrompt = calls[1].body.contents[0].parts.map(part => part.text || '').join('');
  assert.match(repairPrompt, /"id":10/);
  assert.doesNotMatch(repairPrompt, /"id":20/);
  assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');
  assert.equal((await getUsageStats()).totalParagraphs - before.totalParagraphs, 2);
  assert.equal((await message('TRANSLATE_BATCH', payload)).ok, true);
  assert.equal(calls.length, 2, 'successful native batch should be cached');
});

test('native Gemini image, audio and PDF requests preserve inlineData MIME and bytes', async () => {
  const image = { hasText: true, regions: [{ original: 'Hello', translation: '你好', box_2d: [0, 0, 100, 100] }] };
  mockReplies(answer(image));
  const translated = await client.translateImageWithGemini({ imageBase64: 'aW1hZ2U=', mimeType: 'image/png' }, settings);
  assert.equal(translated.regions[0].translation, '你好');
  assert.deepEqual(calls[0].body.contents[0].parts[0].inlineData, { mimeType: 'image/png', data: 'aW1hZ2U=' });

  mockReplies(answer({ original: 'Hello', translation: '你好' }));
  const audio = await message('TRANSLATE_YOUTUBE_AUDIO', { audioBase64: 'YXVkaW8=', mimeType: 'audio/webm' });
  assert.equal(audio.ok, true);
  assert.equal(audio.data.translation, '你好');
  assert.deepEqual(calls[0].body.contents[0].parts[0].inlineData, { mimeType: 'audio/webm', data: 'YXVkaW8=' });

  const blocks = [{ page: 1, type: 'paragraph', original: 'Paper', translation: '论文' }];
  mockReplies(answer(blocks));
  assert.deepEqual(await client.analyzePdfWithGemini({ pdfBase64: 'cGRm' }, settings), blocks);
  assert.deepEqual(calls[0].body.contents[0].parts[0].inlineData, { mimeType: 'application/pdf', data: 'cGRm' });
});

test('native Gemini thought-only output fails instead of becoming translated text', async () => {
  mockReplies(envelope([{ text: 'private reasoning must not be shown', thought: true }]));
  const before = await getUsageStats();
  const response = await message('TRANSLATE_INPUT_TEXT', { text: 'native thought-only', targetLang: 'zh-CN' });
  assert.equal(response.ok, false);
  assert.doesNotMatch(JSON.stringify(response), /private reasoning/);
  assert.equal((await getUsageStats()).totalParagraphs, before.totalParagraphs);
});

test('native Gemini blocked and empty output fail visibly without counting completed translations', async () => {
  for (const body of [{ promptFeedback: { blockReason: 'SAFETY' } }, envelope([], 'STOP'),
    envelope([{ text: 'must not accept blocked output' }], 'SAFETY')]) {
    mockReplies(body);
    const before = await getUsageStats();
    const response = await message('TRANSLATE_INPUT_TEXT', { text: 'native blocked input', targetLang: 'zh-CN' });
    assert.equal(response.ok, false);
    assert.ok(response.error.length > 0);
    assert.equal(response.cancelled, false);
    assert.equal((await getUsageStats()).totalParagraphs, before.totalParagraphs);
  }
});

test('native Gemini MAX_TOKENS rejects even parseable partial JSON and cannot poison the cache', async () => {
  const payload = { items: [{ id: 1, text: 'native truncated input' }] };
  mockReplies(envelope([{ text: JSON.stringify([{ id: 1, translation: '截断译文' }]) }], 'MAX_TOKENS'));
  const before = await getUsageStats();
  const failed = await message('TRANSLATE_BATCH', payload);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /MAX_TOKENS|截断|长度/);
  assert.equal((await getUsageStats()).totalParagraphs, before.totalParagraphs);
  mockReplies(answer([{ id: 1, translation: '完整译文' }]));
  const fresh = await message('TRANSLATE_BATCH', payload);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.data.translations[0].cached, false);
  assert.equal(fresh.data.translations[0].translation, '完整译文');
  assert.equal(calls.length, 1);
});

test('native Gemini model discovery paginates, filters non-generation models and strips models prefix', async () => {
  mockReplies({ models: [
    { name: 'models/gemini-fixture-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/embedding-fixture', supportedGenerationMethods: ['embedContent'] }
  ], nextPageToken: 'next page&token' }, {
    models: [{ name: 'models/gemini-fixture-flash', displayName: 'Fixture Flash', supportedGenerationMethods: ['generateContent'] }]
  });
  const models = await client.fetchAvailableModels(settings);
  assert.deepEqual(models.map(model => model.id), ['gemini-fixture-flash', 'gemini-fixture-pro']);
  assert.equal(new URL(calls[0].url).pathname, '/v1beta/models');
  assert.equal(new URL(calls[1].url).searchParams.get('pageToken'), 'next page&token');
  assert.ok(calls.every(call => call.method === 'GET' && new URL(call.url).searchParams.get('key') === settings.apiKey));
});

test('native Gemini 401 is not retried and secrets are redacted from the visible error', async () => {
  mockReplies({ status: 401, body: { error: { message: `Rejected key ${settings.apiKey}` } } });
  const response = await message('TRANSLATE_INPUT_TEXT', { text: 'native unauthorized', targetLang: 'zh-CN' });
  assert.equal(response.ok, false);
  assert.match(response.error, /401/);
  assert.doesNotMatch(response.error, new RegExp(settings.apiKey));
  assert.equal(calls.length, 1);
});
