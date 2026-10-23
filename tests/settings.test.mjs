import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { LLM_PROVIDERS } from '../shared/constants.js';
import { getSettings, getActiveProtocol, saveSettings, onSettingsChanged } from '../shared/storage.js';

const key = 'immersive_gemini_settings_v1';
let stored, listener;
globalThis.chrome = { storage: {
  local: { async get() { return { [key]: stored }; }, async set(value) { stored = value[key]; } },
  onChanged: { addListener(fn) { listener = fn; }, removeListener() {} }
} };
const source = fs.readFileSync(new URL('../content/content-main.js', import.meta.url), 'utf8');
const context = vm.createContext({ QingJianSettings: globalThis.QingJianSettings });
vm.runInContext(source.slice(source.indexOf('  const DEFAULT_SETTINGS ='), source.indexOf('  const STYLE_LIST =')), context);

test('raw stored provider settings resolve consistently in storage and content entry points', async () => {
  for (const provider of LLM_PROVIDERS) {
    for (const protocol of [undefined, '', null, 'invalid', 'gemini', 'openai']) {
      stored = { providerId: provider.id, apiKey: 'private-key', providerConfigs: { private: {} } };
      if (protocol !== undefined) stored.apiProtocol = protocol;
      const expected = ['gemini', 'openai'].includes(protocol) ? protocol : provider.protocol;
      const actual = await getSettings();
      assert.equal(getActiveProtocol(actual), expected, `${provider.id}/${protocol}`);
      const content = context.sanitizeContentSettings(stored);
      assert.equal(content.apiProtocol, expected, `content ${provider.id}/${protocol}`);
      assert.equal(content.apiKey, undefined);
      assert.equal(content.providerConfigs, undefined);
    }
  }
  stored = {};
  assert.equal((await getSettings()).apiProtocol, 'gemini');
  assert.equal(context.sanitizeContentSettings().apiProtocol, 'gemini');
});

test('save and storage-change entry points normalize missing/empty protocol', async () => {
  stored = { providerId: 'google' };
  assert.equal((await saveSettings({ providerId: 'deepseek' })).apiProtocol, 'openai');
  assert.equal((await saveSettings({ providerId: 'custom', apiProtocol: 'gemini' })).apiProtocol, 'gemini');
  assert.equal((await saveSettings({ apiProtocol: '' })).apiProtocol, 'openai');
  let changed;
  const unsubscribe = onSettingsChanged(value => { changed = value; });
  listener({ [key]: { newValue: { providerId: 'deepseek' } } }, 'local');
  assert.equal(changed.apiProtocol, 'openai');
  unsubscribe();
});

test('statistics cancellation does not allow a late write to overwrite subsequent counters', async () => {
  const { incrementUsageStats } = await import('../shared/storage.js');
  const nativeGet = chrome.storage.local.get, nativeSet = chrome.storage.local.set;
  const statsKey = 'immersive_gemini_stats_v1';
  let stats = { totalParagraphs: 0 }, release, writes = 0;
  chrome.storage.local.get = async () => ({ [statsKey]: structuredClone(stats) });
  chrome.storage.local.set = async value => {
    writes++;
    if (writes === 1) await new Promise(resolve => { release = resolve; });
    stats = structuredClone(value[statsKey]);
  };
  const controller = new AbortController();
  try {
    const first = incrementUsageStats({ paragraphs: 1 }, controller.signal);
    while (!release) await new Promise(resolve => setTimeout(resolve, 1));
    controller.abort();
    await assert.rejects(first, /abort/i);
    const second = incrementUsageStats({ paragraphs: 2 });
    assert.equal(await second, null, 'bookkeeping must stop delaying the caller after 250ms');
    assert.equal(writes, 1, 'second physical write cannot overtake the first');
    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(writes, 2);
    assert.equal(stats.totalParagraphs, 3, 'no later counter lost to the old write');
  } finally { release?.(); chrome.storage.local.get = nativeGet; chrome.storage.local.set = nativeSet; }
});

test('a stalled physical statistics write bounds the backlog and never delays translations indefinitely', async () => {
  const { incrementUsageStats } = await import('../shared/storage.js');
  const nativeGet=chrome.storage.local.get, nativeSet=chrome.storage.local.set;
  const key='immersive_gemini_stats_v1';
  let stats={totalParagraphs:0},release,writes=0;
  chrome.storage.local.get=async()=>({[key]:structuredClone(stats)});
  chrome.storage.local.set=async value=>{if(++writes===1)await new Promise(r=>{release=r;});stats=structuredClone(value[key]);};
  try {
    const pending=Array.from({length:100},()=>incrementUsageStats({paragraphs:1}));
    await Promise.all(pending);
    assert.equal(writes,1);
    release();
    for(let i=0;i<100&&writes<32;i++)await new Promise(r=>setTimeout(r,1));
    assert.equal(writes,32);
    assert.equal(stats.totalParagraphs,32);
  } finally {release?.();chrome.storage.local.get=nativeGet;chrome.storage.local.set=nativeSet;}
});
