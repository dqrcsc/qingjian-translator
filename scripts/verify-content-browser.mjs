// Actual manifest-injected content scripts, storage, DOM and background requests.
// CDP controls only scheduling/decoding boundaries in the extension's isolated world.
import assert from 'node:assert/strict';
import http from 'node:http';

export async function verifyContentBrowser(context, sw) {
  const checks = [], errors = [], pages = [];
  const html = `<!doctype html><title>Content regression fixture</title>
    <style>p{margin:2px;font:14px/18px sans-serif}img{width:240px;height:160px}</style>
    ${Array.from({ length: 40 }, (_, i) => `<p class="fixture">This is an English test paragraph number ${i}.</p>`).join('')}
    <img id="fixture-image" src="/image.svg" alt="English diagram">`;
  let imageCalls = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(); return;
    }
    if (req.method === 'GET') {
      if (req.url === '/image.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="white"/><text x="20" y="60">Hello diagram</text></svg>');
      } else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); }
      return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const parts = body.messages.at(-1).content;
    let answer;
    if (Array.isArray(parts)) {
      imageCalls++;
      answer = { hasText: true, regions: [{ original: 'Hello', translation: `图译 ${imageCalls}`, box_2d: [100, 100, 300, 800] }] };
    } else {
      answer = [...parts.matchAll(/"id"\s*:\s*(\d+)/g)].map(m => ({ id: Number(m[1]), translation: `段落译文 ${m[1]}` }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const settings = { providerId: 'custom', apiProtocol: 'openai', apiBaseUrl: `${base}/v1`,
    apiKey: 'local-test-only', modelId: 'fixture-vision', enableCache: false,
    autoTranslateAllPages: false, autoTranslatePageImages: false, enableFloatingBall: false,
    enableYoutubeDualSub: true, youtubeAutoEnable: false, neverTranslateDomains: '' };
  const store = raw => sw.evaluate(value => chrome.storage.local.set({ immersive_gemini_settings_v1: value }), raw);
  const send = (tabId, message) => sw.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), { tabId, message });
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 12000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error(`Content regression timeout: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  async function open(url, route) {
    const page = await context.newPage(); pages.push(page);
    await page.setViewportSize({ width: 1200, height: 1200 });
    page.on('pageerror', error => errors.push(error.message));
    if (route) await page.route('https://www.youtube.com/**', route);
    const cdp = await context.newCDPSession(page);
    const contexts = [];
    cdp.on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description || exceptionDetails.text));
    await cdp.send('Runtime.enable');
    await page.goto(url);
    let world;
    await wait(async () => {
      for (const candidate of contexts.filter(item => !item.auxData?.isDefault)) {
        try {
          const probe = await cdp.send('Runtime.evaluate', { contextId: candidate.id,
            expression: 'Boolean(globalThis.__IMMERSIVE_GEMINI_CONTENT_LOADED__ && globalThis.QingJianSettings)', returnByValue: true });
          if (probe.result.value) { world = candidate.id; return true; }
        } catch { /* navigation can retire contexts */ }
      }
      return false;
    }, 'manifest content-script injection');
    const evaluate = async expression => {
      const value = await cdp.send('Runtime.evaluate', { contextId: world, expression, awaitPromise: true, returnByValue: true });
      if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
      return value.result.value;
    };
    const tabId = await sw.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
    assert.ok(tabId);
    return { page, evaluate, tabId };
  }
  try {
    await store(settings);
    const { page, evaluate, tabId } = await open(`${base}/fixture`);
    // Hold only extension callbacks, leaving page rendering and the native observer running.
    await evaluate(`(() => {
      const nativeRAF = requestAnimationFrame, NativeIO = IntersectionObserver;
      globalThis.__frames = []; globalThis.__observations = [];
      globalThis.__holdFrames = false; globalThis.__holdObservations = false;
      globalThis.requestAnimationFrame = fn => __holdFrames ? __frames.push(fn) : nativeRAF(fn);
      globalThis.IntersectionObserver = class extends NativeIO {
        constructor(fn, options) { super((entries, observer) => {
          if (__holdObservations) __observations.push(() => fn(entries, observer));
          else fn(entries, observer);
        }, options); }
      };
      globalThis.__flushFrames = async () => {
        while (__frames.length) { __frames.shift()(performance.now()); await Promise.resolve(); }
      };
      globalThis.__flushObservations = () => { while (__observations.length) __observations.shift()(); };
    })()`);
    const toggle = () => send(tabId, { type: 'TOGGLE_PAGE_TRANSLATION' });
    assert.equal((await toggle()).isPageTranslated, true);
    await page.waitForFunction(() => document.querySelectorAll('p.fixture[data-ig-status="done"]').length === 40);
    for (const cleanupFirst of [true, false]) {
      await evaluate('__holdFrames = true; __holdObservations = true');
      assert.equal((await toggle()).isPageTranslated, false);
      assert.equal((await toggle()).isPageTranslated, true);
      await wait(() => evaluate('__observations.length > 0'), 'new observer delivery');
      if (cleanupFirst) await evaluate('__flushFrames()');
      assert.equal(await page.locator('p.fixture[data-ig-status="observed"]').count(), 40);
      await evaluate('__flushObservations()');
      if (!cleanupFirst) await evaluate('__flushFrames()');
      await evaluate('__holdFrames = false; __holdObservations = false; __flushFrames()');
      await page.waitForFunction(() => document.querySelectorAll('p.fixture[data-ig-status="done"]').length === 40);
      assert.equal(await page.locator('p.fixture .ig-trans-node').count(), 40);
    }
    await toggle();
    await page.waitForFunction(() => !document.querySelector('p.fixture .ig-trans-node'));
    checks.push('Actual content injection: 40 paragraphs survive both RAF/observer orderings and final disable removes translations');

    // Defer Image.onload in the content world while the real image still decodes.
    await evaluate(`(() => {
      const NativeImage = Image;
      globalThis.__decoded = [];
      globalThis.Image = function(...args) {
        const image = new NativeImage(...args);
        Object.defineProperty(image, 'onload', { set(fn) {
          image.addEventListener('load', event => __decoded.push(() => fn.call(image, event)), { once: true });
        } });
        return image;
      };
    })()`);
    const imageUrl = `${base}/image.svg`;
    const translateImage = () => send(tabId, { type: 'SHOW_PAGE_TOAST', payload: { mode: 'image-translate', srcUrl: imageUrl } });
    await translateImage();
    await wait(() => evaluate('__decoded.length === 1'), 'first image decode');
    await toggle(); await toggle(); // actual disable cancels the pending decode's scope
    await translateImage();
    await wait(() => evaluate('__decoded.length === 2'), 'replacement image decode');
    await evaluate('__decoded.shift()()');
    await evaluate('Promise.resolve().then(() => Promise.resolve())');
    assert.equal(await page.locator('.ig-img-overlay-layer').count(), 0);
    assert.equal(await page.locator('#fixture-image').getAttribute('data-ig-img-status'), 'loading');
    await evaluate('__decoded.shift()()');
    await page.waitForFunction(() => document.querySelector('#fixture-image').dataset.igImgStatus === 'done');
    assert.equal(await page.locator('.ig-img-overlay-layer').count(), 1);
    assert.match(await page.locator('.ig-img-bilingual-drawer').textContent(), /图译 2/);
    await toggle(); await toggle();
    await page.waitForFunction(() => !document.querySelector('.ig-img-overlay-layer'));
    checks.push('Actual image entry: cancellation during decode cannot restore an old layer or clear replacement loading; latest image renders once');
    await page.close();

    // The URL selects the real YouTube integration; all YouTube traffic is fulfilled locally.
    const videoHtml = '<!doctype html><title>Audio gate fixture</title><div id="movie_player" class="html5-video-player"><video></video><div class="ytp-right-controls"></div></div>';
    const initialAudioSettings = { ...settings, providerId: 'deepseek' };
    delete initialAudioSettings.apiProtocol;
    await store(initialAudioSettings);
    const audio = await open('https://www.youtube.com/watch?v=local-fixture', route => route.fulfill({
      status: 200, contentType: route.request().resourceType() === 'document' ? 'text/html' : 'application/json',
      body: route.request().resourceType() === 'document' ? videoHtml : '{}'
    }));
    await audio.page.locator('[data-open-list]').click();
    await audio.evaluate(`globalThis.__captures = 0;
      HTMLMediaElement.prototype.captureStream = function() { __captures++; return new MediaStream(); };`);
    await audio.page.locator('[data-act="audio-listen"]').click();
    assert.equal(await audio.evaluate('__captures'), 0, 'initial storage load must reject missing DeepSeek protocol before capture');
    const cases = [
      { providerId: 'google', allowed: true }, { providerId: 'deepseek', allowed: false },
      { providerId: 'custom', allowed: false }, { providerId: 'custom', apiProtocol: 'gemini', allowed: true },
      { providerId: 'google', apiProtocol: 'openai', allowed: false }
    ];
    for (let i = 0; i < cases.length; i++) {
      const { allowed, ...raw } = cases[i];
      const style = i % 2 ? 'mask' : 'marker';
      const value = { ...settings, ...raw, translationStyle: style };
      if (!Object.hasOwn(raw, 'apiProtocol')) delete value.apiProtocol;
      await store(value);
      await wait(async () => (await send(audio.tabId, { type: 'GET_PAGE_STATUS' })).translationStyle === style, 'storage change applied');
      const before = await audio.evaluate('__captures');
      await audio.page.locator('[data-act="audio-listen"]').click();
      assert.equal(await audio.evaluate('__captures'), before + Number(allowed), JSON.stringify(raw));
    }
    checks.push('Actual initial storage load, storage changes and YouTube audio button: missing Google/DeepSeek/custom and explicit protocols gated before capture');
    assert.deepEqual(errors, [], 'content-script contexts must have no uncaught exceptions');
    return checks;
  } finally {
    for (const page of pages) if (!page.isClosed()) await page.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
