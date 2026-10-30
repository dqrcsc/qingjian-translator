import test from 'node:test';
import assert from 'node:assert/strict';

const key = 'immersive_gemini_settings_v1';
const stored = {};
let listener;
const event = { addListener() {} };
globalThis.chrome = {
  storage: { local: {
    async get(k) { return { [k]: structuredClone(stored[k]) }; },
    async set(value) { Object.assign(stored, structuredClone(value)); }
  }, onChanged: event },
  runtime: { onInstalled: event, onConnect: event, onMessage: { addListener(fn) { listener = fn; } }, getURL: x => x },
  tabs: { onUpdated: event }, contextMenus: { onClicked: event }, commands: { onCommand: event }
};
const { saveSettings } = await import('../shared/storage.js');
await import('../background/service-worker.js');
const message = payload => new Promise(resolve => listener({ type: 'UPDATE_CONTENT_SETTINGS', payload }, { tab: { id: 1 } }, resolve));

test('content settings command merges only its patch and never returns credentials', async () => {
  await saveSettings({ apiKey: 'private-fixture', targetLang: 'ja', modelId: 'private-model' });
  const result = await message({ translationStyle: 'blockquote', floatingBallPositionY: 47.5,
    alwaysTranslateDomains: 'example.org', autoTranslateAllPages: true, autoTranslateOnlinePdf: false });
  assert.deepEqual(result, { ok: true });
  assert.equal(stored[key].targetLang, 'ja');
  assert.equal(stored[key].apiKey, 'private-fixture');
  assert.equal(stored[key].translationStyle, 'blockquote');
  assert.equal(stored[key].floatingBallPositionY, 47.5);
});

test('content settings command rejects unknown/privileged fields and invalid values atomically', async () => {
  for (const patch of [null, [], {}, { apiKey: 'wrong' }, { modelId: 'wrong' },
    { translationStyle: 'bad' }, { floatingBallPositionY: 101 }, { floatingBallPositionY: '50' },
    { autoTranslateAllPages: 'true' }, { alwaysTranslateDomains: [] },
    { translationStyle: 'clean', targetLang: 'fr' }, JSON.parse('{"__proto__":{"polluted":true}}')]) {
    const before = structuredClone(stored[key]);
    const result = await message(patch);
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.deepEqual(stored[key], before);
    assert.equal(result.data, undefined);
  }
});

test('content and settings saves preserve distinct concurrent patches', async () => {
  await saveSettings({ targetLang: 'zh-CN' });
  const replies = await Promise.all([message({ translationStyle: 'marker' }),
    saveSettings({ targetLang: 'fr' }), message({ floatingBallPositionY: 62 })]);
  assert.equal(replies[0].ok, true);
  assert.equal(replies[2].ok, true);
  assert.equal(stored[key].targetLang, 'fr');
  assert.equal(stored[key].translationStyle, 'marker');
  assert.equal(stored[key].floatingBallPositionY, 62);
});

test('storage failure is returned as failure without leaking a settings snapshot', async () => {
  const original = chrome.storage.local.set;
  chrome.storage.local.set = async () => { throw Error('synthetic storage unavailable'); };
  try {
    const result = await message({ translationStyle: 'clean' });
    assert.equal(result.ok, false); assert.match(result.error, /unavailable/);
    assert.equal(result.data, undefined);
  } finally { chrome.storage.local.set = original; }
});
