// Real popup -> runtime Port -> native Gemini HTTP envelope, entirely on localhost.
import assert from 'node:assert/strict';
import http from 'node:http';

export async function verifyGeminiBrowser(context, sw) {
  const storageKey = 'immersive_gemini_settings_v1';
  const previous = await sw.evaluate(key => chrome.storage.local.get(key), storageKey);
  const checks = [], errors = [], calls = [];
  const apiKey = 'local-gemini-fixture-key';
  let mode = 'success', popup, holdModels = false, modelReplyId = 'gemini-local-fixture';
  const heldModelReplies = [];
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
      res.end(); return;
    }
    try {
      const url = new URL(req.url, 'http://localhost');
      assert.equal(url.searchParams.get('key'), apiKey);
      if (req.method === 'GET' && url.pathname === '/v1beta/models') {
        const modelId = modelReplyId;
        const finish = () => reply(200, { models: [{ name: `models/${modelId}`, supportedGenerationMethods: ['generateContent'] }] });
        if (holdModels) heldModelReplies.push(finish);
        else finish();
        return;
      }
      assert.equal(req.method, 'POST');
      assert.equal(url.pathname, '/v1beta/models/gemini-local-fixture:generateContent');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.contents[0].role, 'user');
      assert.equal(body.messages, undefined);
      const prompt = body.contents[0].parts.map(part => part.text || '').join('');
      const ids = [...prompt.matchAll(/"id"\s*:\s*(\d+)/g)].map(match => Number(match[1]));
      assert.equal(ids.length, 1);
      calls.push({ mode, id: ids[0] });
      if (mode === 'unauthorized') reply(401, { error: { message: `Invalid key ${apiKey}` } });
      else if (mode === 'blocked') reply(200, { promptFeedback: { blockReason: 'SAFETY' } });
      else reply(200, { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [
        { text: 'private reasoning fixture', thought: true },
        { text: JSON.stringify(ids.map(id => ({ id, translation: 'Gemini 原生翻译成功' }))) }
      ] } }] });
    } catch (error) {
      errors.push(error.message);
      reply(400, { error: { message: 'Local Gemini fixture rejected the request shape' } });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1beta`;
    await sw.evaluate(async ({ storageKey, apiKey, base }) => {
      await chrome.storage.local.set({ [storageKey]: {
        providerId: 'google', apiProtocol: 'gemini', apiBaseUrl: base, apiKey,
        modelId: '', availableModels: [],
        providerConfigs: { custom: { apiProtocol: 'gemini', apiBaseUrl: base, apiKey, modelId: '', availableModels: [] } },
        targetLang: 'zh-CN', enableCache: false, autoTranslateAllPages: false, requestBudgetSeconds: 30
      } });
    }, { storageKey, apiKey, base });
    const extensionId = new URL(sw.url()).host;
    popup = await context.newPage();
    popup.on('pageerror', error => errors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.waitForFunction(() => document.querySelector('#targetLangSelect')?.value === 'zh-CN');
    await popup.waitForFunction(() => document.querySelector('#modelSelect').value === 'gemini-local-fixture');
    assert.equal(await sw.evaluate(async key => (await chrome.storage.local.get(key))[key].modelId, storageKey), 'gemini-local-fixture');
    checks.push('Actual popup initial native model discovery commits returned models and updates its dropdown');

    const translate = async (input, expected) => {
      await popup.locator('#quickInput').fill(input);
      await popup.locator('#quickTranslateBtn').click();
      await popup.waitForFunction(fragment => document.querySelector('#quickOutput').textContent.includes(fragment), expected);
      const output = await popup.locator('#quickOutput').textContent();
      assert.doesNotMatch(output, /private reasoning fixture/);
      return output;
    };
    assert.equal(await translate('native browser success', 'Gemini 原生翻译成功'), 'Gemini 原生翻译成功');
    checks.push('Actual Gemini popup success: native generateContent request and candidates/parts response; thought text excluded');

    mode = 'unauthorized';
    const unauthorized = await translate('native browser unauthorized', '401');
    assert.match(unauthorized, /⚠️/);
    assert.ok(!unauthorized.includes(apiKey), 'popup must redact provider key');
    assert.equal(calls.filter(call => call.mode === mode).length, 1, '401 must not retry');
    checks.push('Actual Gemini popup 401: visible failure with redacted key and no retry');

    mode = 'blocked';
    assert.match(await translate('native browser blocked', 'SAFETY'), /⚠️/);
    assert.equal(calls.filter(call => call.mode === mode).length, 1);
    mode = 'success';
    assert.equal(await translate('native browser recovery', 'Gemini 原生翻译成功'), 'Gemini 原生翻译成功');
    checks.push('Actual Gemini popup blocked response fails visibly; next native translation succeeds');

    modelReplyId = 'gemini-custom-fixture';
    await popup.locator('#popupProviderSelect').selectOption('custom');
    await popup.waitForFunction(() => document.querySelector('#modelSelect').value === 'gemini-custom-fixture');
    const custom = await sw.evaluate(async key => (await chrome.storage.local.get(key))[key], storageKey);
    assert.equal(custom.providerId, 'custom');
    assert.equal(custom.availableModels[0].id, modelReplyId);

    // Start a fresh Google discovery, then change provider before its held reply.
    await popup.close(); popup = null;
    await sw.evaluate(async ({ storageKey, custom }) => chrome.storage.local.set({ [storageKey]: {
      ...custom, providerId: 'google', modelId: '', availableModels: [],
      providerConfigs: { ...custom.providerConfigs, google: { ...custom.providerConfigs.google, modelId: '', availableModels: [] } }
    } }), { storageKey, custom });
    modelReplyId = 'gemini-stale-google'; holdModels = true;
    popup = await context.newPage();
    popup.on('pageerror', error => errors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    const heldDeadline = Date.now() + 10000;
    while (!heldModelReplies.length) {
      if (Date.now() > heldDeadline) throw new Error('Native model-list fixture was not requested');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await popup.locator('#popupProviderSelect').selectOption('custom');
    await popup.waitForFunction(() => document.querySelector('#modelSelect').value === 'gemini-custom-fixture');
    heldModelReplies.splice(0).forEach(finish => finish()); holdModels = false;
    // A fresh request is a round trip through the same worker after the stale reply.
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_CACHE_STATS' }));
    const afterStale = await sw.evaluate(async key => (await chrome.storage.local.get(key))[key], storageKey);
    assert.equal(afterStale.providerId, 'custom');
    assert.equal(afterStale.modelId, 'gemini-custom-fixture');
    assert.equal(await popup.locator('#popupProviderSelect').inputValue(), 'custom');
    assert.equal(await popup.locator('#modelSelect').inputValue(), 'gemini-custom-fixture');
    checks.push('Actual popup provider-change discovery updates models; an old provider reply cannot overwrite a newer selection');
    assert.deepEqual(errors, []);
    return checks;
  } finally {
    try {
      await popup?.close();
      await sw.evaluate(async ({ storageKey, previous }) => {
        if (Object.hasOwn(previous, storageKey)) await chrome.storage.local.set(previous);
        else await chrome.storage.local.remove(storageKey);
      }, { storageKey, previous });
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
}
