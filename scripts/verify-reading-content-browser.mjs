// Reading integrity through actual manifest content scripts and background messages.
import assert from 'node:assert/strict';
import http from 'node:http';

export async function verifyReadingContentBrowser(context, sw) {
  const checks = [], errors = [], pages = [], held = [];
  let failPending = true;
  const calls = [];
  const fixture = `<!doctype html><meta charset="utf-8"><title>Reading integrity fixture</title>
    <style>p{font:18px/28px sans-serif;max-width:800px;margin:24px}textarea{display:block}</style>
    <p id="multi">First English paragraph has useful content.<br>Pending English paragraph remains readable.<br>这段中文必须保持可读。<br>Identical English paragraph remains readable.</p>
    <p id="links">Please read <a id="original-link" href="#destination" title="Documentation" onclick="window.originalClicks=(window.originalClicks||0)+1">the documentation</a> and <a href="https://example.com/guide" target="_blank">the external guide</a> for more details.</p>
    <p id="hover">Hover over this English paragraph to translate it.</p>
    <p id="protected">这是已经中文的内容。<br><code>const answer = 42;</code><br><math><mi>x</mi><mo>+</mo><mi>y</mi></math><br>Another English paragraph can be translated.</p>
    <p id="prewrap" style="white-space:pre-wrap">First wrapped English paragraph.\n这段保留的中文。\nIdentical English wrapped paragraph remains readable.</p>
    <p id="multi-links">Read the <span><a href="#destination">segment guide</a></span><br>这一段中文仍然可读。</p>
    <textarea id="editor"></textarea><div id="destination">Destination</div>`;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(); return; }
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fixture); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const prompt = JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content;
    const items = JSON.parse(prompt.split('Input JSON:\n').at(-1));
    calls.push(...items);
    const reply = () => {
      if (failPending && items.some(item => item.text.includes('Pending English'))) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: { message: 'fixture authorization failure' } })); return;
      }
      const answer = items.map(item => ({ id: item.id, translation: item.text.includes('Identical English') ? item.text :
        `译文 ${item.id} ${(item.text.match(/\{\{\d+\}\}/g) || []).reverse().join(' 与 ')}。` }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    };
    if (items.some(item => item.text.includes('Pending English'))) held.push(reply); else reply();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const settings = { providerId: 'custom', apiProtocol: 'openai', apiBaseUrl: `${base}/v1`, apiKey: 'local-test-only', modelId: 'fixture',
    enableCache: false, batchMaxItems: 1, translationStyle: 'translation-only', enableHoverTranslate: true,
    autoTranslateAllPages: false, autoTranslatePageImages: false, enableFloatingBall: false, enableImageTranslate: false, neverTranslateDomains: '' };
  const send = (tabId, message) => sw.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), { tabId, message });
  const check = label => { checks.push(label); console.log(`  ✓ ${label}`); };
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 15000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error(`Reading content timeout: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  // Range geometry + computed visibility checks raw text even if its ancestor is hidden.
  const visibleText = (page, selector, text) => page.locator(selector).evaluate((el, text) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.nodeValue.includes(text)) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      if ([...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0) && getComputedStyle(node.parentElement).visibility !== 'hidden') return true;
    }
    return false;
  }, text);
  try {
    await sw.evaluate(value => chrome.storage.local.set({ immersive_gemini_settings_v1: value }), settings);
    const page = await context.newPage(); pages.push(page); page.setDefaultTimeout(15000);
    await page.setViewportSize({ width: 1200, height: 1000 });
    page.on('pageerror', e => errors.push(e.message));
    const cdp = await context.newCDPSession(page);
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description || exceptionDetails.text));
    await cdp.send('Runtime.enable');
    await page.goto(`${base}/reading`);
    await page.waitForFunction(() => document.documentElement.dataset.igStyle === 'translation-only');
    const tabId = await sw.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)?.id, `${base}/reading`);
    assert.ok(tabId);
    await page.evaluate(() => { window.originalAnchor = document.querySelector('#original-link'); originalAnchor.addEventListener('click', () => window.listenerClicks = (window.listenerClicks || 0) + 1); });
    const toggle = () => send(tabId, { type: 'TOGGLE_PAGE_TRANSLATION' });
    await toggle();
    await page.locator('#multi .ig-trans-node').first().waitFor();
    await wait(() => held.length > 0, 'pending segment mock request');
    assert.equal(await visibleText(page, '#multi', 'Pending English'), true, 'pending source stays visible after sibling success');
    assert.equal(await visibleText(page, '#multi', '这段中文'), true, 'skipped source stays visible');
    held.shift()();
    await page.locator('#multi .ig-trans-error').waitFor();
    assert.equal(await visibleText(page, '#multi', 'Pending English'), true, 'error source stays visible');
    await wait(() => calls.some(c => c.text.includes('Identical English')), 'identical segment request');
    await page.waitForFunction(() => !document.querySelector('#multi .ig-trans-loading'));
    assert.equal(await visibleText(page, '#multi', 'Identical English'), true, 'identical source stays visible');
    assert.equal(await visibleText(page, '#multi', 'First English'), false, 'success source hidden');
    await page.locator('#protected .ig-trans-node').first().waitFor();
    assert.equal(await visibleText(page, '#protected', '已经中文'), true);
    assert.equal(await visibleText(page, '#protected', 'const answer'), true);
    assert.equal(await visibleText(page, '#protected math', 'x'), true);
    check('Translation-only: pending, failed, skipped, identical, code and math remain readable alongside completed segments');
    failPending = false;
    await page.locator('#multi .ig-trans-error').click();
    await wait(() => held.length > 0, 'retried segment request');
    assert.equal(await visibleText(page, '#multi', 'Pending English'), true);
    held.shift()();
    await page.waitForFunction(() => document.querySelector('#multi').dataset.igStatus === 'done');
    assert.equal(await visibleText(page, '#multi', 'Pending English'), false);
    assert.equal(await visibleText(page, '#multi', '这段中文'), true);
    assert.equal(await visibleText(page, '#multi', 'Identical English'), true);
    assert.equal(await page.locator('#multi .ig-trans-node').count(), 2);
    check('Partial failure retry replaces only translated source, retaining skipped/identical segments and producing no duplicate translations');

    await page.locator('#links .ig-trans-node a').first().waitFor();
    const anchors = page.locator('#links .ig-trans-node a');
    assert.equal(await anchors.count(), 2);
    assert.deepEqual(await anchors.evaluateAll(nodes => nodes.map(n => n.textContent)), ['the external guide', 'the documentation']);
    assert.deepEqual(await anchors.evaluateAll(nodes => nodes.map(n => ({ onclick: n.getAttribute('onclick'), id: n.id }))), [{ onclick: null, id: '' }, { onclick: null, id: '' }]);
    assert.match(await anchors.first().getAttribute('rel'), /noopener/);
    await anchors.filter({ hasText: 'the documentation' }).click();
    assert.equal(new URL(page.url()).hash, '#destination');
    assert.equal(await page.evaluate(() => window.originalClicks || 0), 0, 'translation clone carries no inline event');
    await page.locator('#multi-links .ig-trans-node a').waitFor();
    await page.locator('#multi-links .ig-trans-node a').click();
    assert.equal(new URL(page.url()).hash, '#destination');
    assert.equal(await visibleText(page, '#multi-links', '这一段中文'), true);
    check('Translation-only: reordered safe link placeholders keep clickable native href, text and safe target without copied handlers');
    await page.locator('#prewrap .ig-trans-node').waitFor();
    assert.equal(await visibleText(page, '#prewrap', '这段保留'), true);
    assert.equal(await visibleText(page, '#prewrap', 'Identical English wrapped'), true);
    assert.equal(await page.locator('#prewrap').evaluate(el => {
      const translated = el.querySelector('.ig-trans-node').getBoundingClientRect();
      const node = [...el.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent.includes('这段保留'));
      const range = document.createRange(); range.selectNodeContents(node);
      return range.getBoundingClientRect().top > translated.top;
    }), true, 'pre-wrap paragraph boundaries stay visible');
    check('Pre-wrap text preserves untranslated paragraph breaks and readable skipped/identical source');

    await page.locator('#hover .ig-trans-node').waitFor();
    const count = await page.locator('#hover .ig-trans-node').count();
    assert.equal(count, 1);
    await page.locator('#hover').hover();
    for (const key of ['s', 'a']) {
      await page.keyboard.down('Alt');
      assert.equal(await page.locator('#hover .ig-trans-node').count(), count, 'Alt keydown cannot consume a future chord');
      await page.keyboard.press(key); await page.keyboard.up('Alt');
      assert.equal(await page.locator('#hover .ig-trans-node').count(), count, `Alt+${key} must not toggle paragraph`);
    }
    // Browser-level extension commands may swallow the letter key. Exercise that route too.
    await page.keyboard.down('Alt');
    await send(tabId, { type: 'CYCLE_TRANSLATION_STYLE' });
    await page.keyboard.up('Alt');
    assert.equal(await page.locator('#hover .ig-trans-node').count(), count);
    // A consumed keydown can leave a keyup, followed by a delayed background command.
    await page.keyboard.down('Alt');
    await page.locator('body').dispatchEvent('keyup', { key: 's', altKey: true, bubbles: true });
    await page.keyboard.up('Alt');
    await send(tabId, { type: 'CYCLE_TRANSLATION_STYLE' });
    assert.equal(await page.locator('#hover .ig-trans-node').count(), count, 'letter keyup cancels Alt gesture before late command');
    await page.keyboard.down('Alt');
    await toggle();
    await page.waitForFunction(() => !document.querySelector('#hover .ig-trans-node'));
    const callsAfterDisable = calls.length;
    await page.keyboard.up('Alt');
    await page.waitForTimeout(120);
    assert.equal(calls.length, callsAfterDisable, 'consumed Alt+A cannot retranslate hovered paragraph after page disable');
    await toggle();
    await wait(() => held.length > 0, 'page reenable pending segment'); held.shift()();
    await page.locator('#hover .ig-trans-node').waitFor();
    await page.keyboard.press('Alt');
    assert.equal(await page.locator('#hover .ig-trans-node').count(), 0, 'Alt-only restores on release');
    const before = calls.filter(c => c.text.includes('Hover over')).length;
    await page.mouse.move(0, 0);
    await page.keyboard.down('Alt'); await page.locator('#hover').hover(); await page.keyboard.up('Alt');
    await page.locator('#hover .ig-trans-node').waitFor();
    assert.equal(calls.filter(c => c.text.includes('Hover over')).length, before + 1);
    await page.locator('#editor').focus(); await page.keyboard.press('Alt');
    assert.equal(await page.locator('#hover .ig-trans-node').count(), 1, 'editable focus ignores hover Alt');
    check('Alt-only runs on release; Alt+A/S do not toggle hovered paragraphs; held Alt movement works and editable focus is ignored');

    await send(tabId, { type: 'SET_TRANSLATION_STYLE', payload: { style: 'clean' } });
    await page.waitForFunction(() => document.documentElement.dataset.igStyle === 'clean');
    assert.equal(await visibleText(page, '#multi', 'First English'), true, 'style switch restores source visibility');
    await toggle();
    await page.waitForFunction(() => !document.querySelector('.ig-trans-node,.ig-trans-error,.ig-orig-text'));
    assert.equal(await page.locator('#prewrap').textContent(), 'First wrapped English paragraph.\n这段保留的中文。\nIdentical English wrapped paragraph remains readable.');
    assert.equal(await page.evaluate(() => document.querySelector('#original-link') === window.originalAnchor), true);
    await page.locator('#original-link').click();
    assert.equal(await page.evaluate(() => window.originalClicks), 1);
    assert.equal(await page.evaluate(() => window.listenerClicks), 1);
    check('Style switching and page disable restore original source and the identical link node with both original click handlers');
    assert.deepEqual(errors, []);
    return { checks, errors };
  } finally {
    held.splice(0).forEach(reply => reply());
    for (const page of pages) if (!page.isClosed()) await page.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
