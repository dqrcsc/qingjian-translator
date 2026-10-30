import assert from 'node:assert/strict';
import http from 'node:http';

export async function verifyContentSettingsBrowser(context, sw) {
  const key = 'immersive_gemini_settings_v1';
  const saved = await sw.evaluate(key => chrome.storage.local.get(key), key);
  const checks = [], errors = [], pages = [];
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Settings concurrency fixture</title><p>Settings controls only.</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const wait = async (predicate, label) => {
    const end = Date.now() + 12000;
    while (!await predicate()) {
      if (Date.now() > end) throw Error(`Settings concurrency timeout: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const current = () => sw.evaluate(async key => (await chrome.storage.local.get(key))[key], key);
  const check = text => { checks.push(text); console.log(`  ✓ ${text}`); };
  let popup;
  try {
    await sw.evaluate(key => chrome.storage.local.set({ [key]: {
      providerId: 'custom', apiProtocol: 'openai', apiKey: 'local-private-only', modelId: 'fixture',
      apiBaseUrl: 'http://127.0.0.1:1/v1', availableModels: [{ id: 'fixture' }],
      translationStyle: 'clean', targetLang: 'zh-CN', enableFloatingBall: true,
      autoTranslateAllPages: false, autoTranslatePageImages: false,
      floatingBallPositionY: 40, neverTranslateDomains: ''
    } }), key);
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await page.locator('.ig-ball-main').waitFor();
    const cdp = await context.newCDPSession(page), worlds = [];
    cdp.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context));
    await cdp.send('Runtime.enable');
    let world;
    for (const item of worlds.filter(item => !item.auxData?.isDefault)) {
      const result = await cdp.send('Runtime.evaluate', { contextId: item.id, expression: 'Boolean(globalThis.__IMMERSIVE_GEMINI_CONTENT_LOADED__)', returnByValue: true });
      if (result.result.value) world = item;
    }
    assert.ok(world, 'manifest must inject the real content script');
    const evaluate = async expression => (await cdp.send('Runtime.evaluate', {
      contextId: world.id, expression, awaitPromise: true, returnByValue: true
    })).result.value;
    // Observe only platform API calls; product functions and payloads are unchanged.
    await evaluate(`globalThis.auditReads=0;globalThis.auditWrites=0;
      const originalGet=chrome.storage.local.get.bind(chrome.storage.local),originalSet=chrome.storage.local.set.bind(chrome.storage.local);
      chrome.storage.local.get=(...args)=>{auditReads++;return originalGet(...args)};
      chrome.storage.local.set=(...args)=>{auditWrites++;return originalSet(...args)}; true`);
    popup = await context.newPage(); pages.push(popup);
    popup.on('pageerror', error => errors.push(error.message));
    await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup/popup.html`);
    await popup.waitForFunction(() => document.querySelector('#targetLangSelect').value === 'zh-CN');
    await popup.evaluate(() => {
      globalThis.auditLockHeld = false;
      globalThis.auditLockTask = navigator.locks.request('qingjian-settings-write', async () => {
        globalThis.auditLockHeld = true;
        await new Promise(resolve => { globalThis.releaseAuditLock = resolve; });
      });
    });
    await popup.waitForFunction(() => globalThis.auditLockHeld);
    const tabId = await sw.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, page.url());
    await sw.evaluate(id => chrome.tabs.sendMessage(id, { type: 'CYCLE_TRANSLATION_STYLE' }), tabId);
    await popup.locator('#targetLangSelect').selectOption('ja');
    await page.waitForTimeout(100);
    assert.equal((await current()).targetLang, 'zh-CN', 'popup write waits for the same extension lock');
    assert.equal((await current()).translationStyle, 'clean', 'content command waits for the extension lock too');
    await popup.evaluate(() => globalThis.releaseAuditLock());
    await wait(async () => { const s = await current(); return s.targetLang === 'ja' && s.translationStyle === 'blockquote'; }, 'both independent patches persist');
    assert.equal(await evaluate('auditReads + auditWrites'), 0, 'webpage must not read/write entire settings for a partial update');
    assert.equal((await current()).apiKey, 'local-private-only');
    check('Actual content style command and popup language save share the extension lock; both updates survive without webpage snapshot writes');

    await page.bringToFront();
    const ball = await page.locator('.ig-ball-main').boundingBox();
    await page.mouse.move(ball.x + ball.width / 2, ball.y + ball.height / 2);
    await page.mouse.down(); await page.mouse.move(ball.x + ball.width / 2, page.viewportSize().height * 0.7, { steps: 5 }); await page.mouse.up();
    await wait(async () => Math.abs((await current()).floatingBallPositionY - 70) < 1, 'floating ball position persisted');
    assert.equal((await current()).targetLang, 'ja');
    assert.equal(await evaluate('auditReads + auditWrites'), 0);
    check('Real floating-ball drag saves only its position through the background route and preserves unrelated preferences');

    const rejected = await popup.evaluate(async () => {
      const invalid = await chrome.runtime.sendMessage({ type: 'UPDATE_CONTENT_SETTINGS', payload: { translationStyle: 'marker', apiKey: 'cannot-change' } });
      const valid = await chrome.runtime.sendMessage({ type: 'UPDATE_CONTENT_SETTINGS', payload: { autoTranslateOnlinePdf: true } });
      return { invalid, valid };
    });
    assert.equal(rejected.invalid.ok, false); assert.deepEqual(rejected.valid, { ok: true });
    assert.equal((await current()).apiKey, 'local-private-only');
    assert.equal((await current()).translationStyle, 'blockquote');
    check('Actual worker rejects privileged fields atomically and returns no credentials for successful content preference updates');
    assert.deepEqual(errors, []);
    return { checks, errors };
  } finally {
    await popup?.evaluate(() => globalThis.releaseAuditLock?.()).catch(() => {});
    await Promise.all(pages.map(page => page.close()));
    await sw.evaluate(saved => chrome.storage.local.set(saved), saved);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
