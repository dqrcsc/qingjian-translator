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
