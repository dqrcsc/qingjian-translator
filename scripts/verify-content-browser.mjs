// Actual manifest-injected content scripts, storage, DOM and background requests.
// CDP controls only scheduling/decoding boundaries in the extension's isolated world.
import assert from 'node:assert/strict';
import http from 'node:http';

export async function verifyContentBrowser(context, sw) {
  const checks = [], errors = [], pages = [];
  const recordCheck = label => { checks.push(label); console.log(`  ✓ ${label}`); };
  const html = `<!doctype html><title>Content regression fixture</title>
    <style>p{margin:2px;font:14px/18px sans-serif}img{width:240px;height:160px}</style>
    ${Array.from({ length: 40 }, (_, i) => `<p class="fixture">This is an English test paragraph number ${i}.</p>`).join('')}
    <img id="fixture-image" src="/image.svg" alt="English diagram">`;
  let imageCalls = 0, holdParagraphReplies = false, holdImageReplies = false;
  let subtitleMode = 'ok';
  const subtitleCalls = [], heldSubtitleReplies = [], heldImageReplies = [];
  const heldReplies = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(); return;
    }
    if (req.method === 'GET') {
      if (req.url.startsWith('/image.svg')) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="white"/><text x="20" y="60">Hello diagram</text></svg>');
      } else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); }
      return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const parts = body.messages.at(-1).content;
    if (typeof parts === 'string' && parts.includes('Subtitle Cues to Translate')) {
      subtitleCalls.push({ at: Date.now(), prompt: parts });
      if (subtitleMode !== 'ok') {
        const code = subtitleMode === '503' ? 503 : 401;
        const fail = () => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: { message: `fixture subtitle ${code}` } })); };
        if (subtitleMode === 'hold401') heldSubtitleReplies.push(fail);
        else fail();
        return;
      }
    }
    let answer;
    if (Array.isArray(parts)) {
      imageCalls++;
      answer = { hasText: true, regions: [{ original: 'Hello', translation: `图译 ${imageCalls}`, box_2d: [100, 100, 300, 800] }] };
    } else {
      answer = [...parts.matchAll(/"id"\s*:\s*(\d+)/g)].map(m => ({ id: Number(m[1]), translation: `段落译文 ${m[1]}` }));
    }
    const reply = () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    };
    if (holdImageReplies && Array.isArray(parts)) heldImageReplies.push(reply);
    else if (holdParagraphReplies && !Array.isArray(parts)) heldReplies.push(reply);
    else reply();
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
    page.setDefaultTimeout(12000);
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
    const retainedParagraphs = async () => {
      const prototype = await cdp.send('Runtime.evaluate', { contextId: world, expression: 'Map.prototype' });
      const objects = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId });
      try {
        const result = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId,
          functionDeclaration: 'function() { return this.reduce((n, map) => n + [...map.values()].filter(v => v && v.element && v.element.nodeType === 1).length, 0); }',
          returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
      } finally {
        await cdp.send('Runtime.releaseObject', { objectId: objects.objects.objectId });
        await cdp.send('Runtime.releaseObject', { objectId: prototype.result.objectId });
      }
    };
    return { page, evaluate, tabId, retainedParagraphs };
  }
  try {
    await store(settings);
    const { page, evaluate, tabId, retainedParagraphs } = await open(`${base}/fixture`);
    // Hold only extension callbacks, leaving page rendering and the native observer running.
    await evaluate(`(() => {
      const nativeRAF = requestAnimationFrame, NativeIO = IntersectionObserver;
      globalThis.__frames = []; globalThis.__observations = []; globalThis.__observedTargets = new Set();
      globalThis.__holdFrames = false; globalThis.__holdObservations = false;
      globalThis.requestAnimationFrame = fn => __holdFrames ? __frames.push(fn) : nativeRAF(fn);
      globalThis.IntersectionObserver = class extends NativeIO {
        constructor(fn, options) { super((entries, observer) => {
          if (__holdObservations) __observations.push(() => fn(entries, observer));
          else fn(entries, observer);
        }, options); }
        observe(el) { __observedTargets.add(el); return super.observe(el); }
        unobserve(el) { __observedTargets.delete(el); return super.unobserve(el); }
        disconnect() { __observedTargets.clear(); return super.disconnect(); }
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
    recordCheck('Actual content injection: 40 paragraphs survive both RAF/observer orderings and final disable removes translations');

    // Query actual isolated-world Maps; no production debug hooks or source rewrites.
    await page.locator('p.fixture').evaluateAll(nodes => nodes.forEach(node => node.remove()));
    await toggle();
    const appendParagraphs = (count, extraStyle = '') => page.evaluate(({ count, extraStyle }) => {
      const host = document.createElement('section'); host.id = 'long-page'; host.style.cssText = extraStyle;
      for (let i = 0; i < count; i++) {
        const p = document.createElement('p'); p.className = 'dynamic';
        p.textContent = `Dynamic English paragraph number ${i} for resource reclamation.`; host.appendChild(p);
      }
      document.body.prepend(host);
    }, { count, extraStyle });
    for (let cycle = 0; cycle < 5; cycle++) {
      await appendParagraphs(50);
      await page.waitForFunction(() => document.querySelectorAll('p.dynamic[data-ig-status="done"]').length === 50);
      assert.equal(await retainedParagraphs(), 0, `completed cycle ${cycle} retains no paragraph records`);
      // Moving connected content in a single mutation turn must preserve translations.
      await page.evaluate(() => document.body.appendChild(document.querySelector('#long-page')));
      await page.waitForTimeout(80);
      assert.equal(await page.locator('p.dynamic[data-ig-status="done"]').count(), 50);
      assert.equal(await page.locator('p.dynamic .ig-trans-node').count(), 50);
      await page.locator('#long-page').evaluate(node => node.remove());
      await wait(() => evaluate('__observedTargets.size === 0'), 'completed removal releases observations');
      assert.equal(await retainedParagraphs(), 0);
    }
    await appendParagraphs(200, 'position:absolute;top:10000px');
    await wait(() => evaluate('__observedTargets.size === 200'), 'offscreen paragraphs observed');
    await page.locator('#long-page').evaluate(node => node.remove());
    await wait(() => evaluate('__observedTargets.size === 0'), 'offscreen removal unobserves every target');
    assert.equal(await retainedParagraphs(), 0);

    // Hold intersection delivery so removal happens before the 75ms batch flush.
    await evaluate('__holdObservations = true');
    await appendParagraphs(3);
    await wait(() => evaluate('__observations.length > 0'), 'queued removal observations');
    await evaluate('__flushObservations(); document.querySelector("#long-page").remove(); __holdObservations = false');
    await wait(async () => await retainedParagraphs() === 0, 'queued removal releases map');

    holdParagraphReplies = true;
    await appendParagraphs(3);
    await wait(() => heldReplies.length > 0, 'active paragraph request');
    assert.equal(await retainedParagraphs(), 3, 'measurement must detect active records');
    await page.evaluate(() => { globalThis.removedHost = document.querySelector('#long-page'); removedHost.remove(); });
    await wait(async () => await retainedParagraphs() === 0, 'active removal releases records before response');
    holdParagraphReplies = false;
    heldReplies.splice(0).forEach(reply => reply());
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => removedHost.querySelectorAll('.ig-trans-node, [data-ig-status]').length), 0);
    await page.evaluate(() => { document.body.prepend(removedHost); delete globalThis.removedHost; });
    await page.waitForFunction(() => document.querySelectorAll('p.dynamic[data-ig-status="done"]').length === 3);
    assert.equal(await retainedParagraphs(), 0, 'reinsertion translates and releases new records');
    await page.locator('#long-page').evaluate(node => node.remove());
    await toggle();
    assert.equal(await evaluate('__observedTargets.size'), 0);
    recordCheck('Long page: 5 × 50 completed paragraphs retain 0 records; 200 offscreen targets unobserved after removal; queued/active removal, no late writes, synchronous moves and reinsertion pass');

    // Defer Image.onload in the content world while the real image still decodes.
    await evaluate(`(() => {
      const NativeImage = Image;
      globalThis.__NativeImage = NativeImage;
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
    recordCheck('Actual image entry: cancellation during decode cannot restore an old layer or clear replacement loading; latest image renders once');
    // Keep the image host connected while replacing only its image child.
    await page.evaluate(() => {
      const host = document.createElement('figure'); host.id = 'replacement-image-host';
      const img = document.querySelector('#fixture-image'); img.parentElement.insertBefore(host, img); host.appendChild(img);
    });
    await toggle();
    await page.locator('#replacement-image-host .ig-img-control-bar').waitFor();
    const oldBar = await page.locator('#replacement-image-host .ig-img-control-bar').elementHandle();
    await page.evaluate(() => {
      const old = document.querySelector('#fixture-image'); const fresh = document.createElement('img');
      fresh.id = old.id; fresh.src = old.src; old.replaceWith(fresh);
    });
    await wait(async () => !(await oldBar.evaluate(node => node.isConnected)), 'old image controls released');
    await oldBar.dispose();
    await page.locator('#replacement-image-host .ig-img-control-bar [data-role="trigger"]').click();
    await wait(() => evaluate('__decoded.length === 1'), 'replacement image decode');
    await evaluate('__decoded.shift()()');
    await page.waitForFunction(() => document.querySelector('#fixture-image').dataset.igImgStatus === 'done');
    assert.equal(await page.locator('#replacement-image-host .ig-img-overlay-layer').count(), 1);
    assert.equal(await page.locator('#replacement-image-host .ig-img-control-bar').count(), 1);
    await toggle();
    recordCheck('Image node replacement preserves its host but releases old controls; new button translates the new image and renders one overlay');
    // Source tracking must also work while paragraph translation is disabled.
    await evaluate('globalThis.Image = __NativeImage');
    const imageNode = page.locator('#fixture-image');
    const imageTrigger = page.locator('#replacement-image-host [data-role="trigger"]');
    const hoverImage = () => imageNode.dispatchEvent('mouseover');
    const imageDone = () => page.waitForFunction(() => document.querySelector('#fixture-image').dataset.igImgStatus === 'done');
    await hoverImage();
    assert.equal(await imageNode.getAttribute('data-ig-hover-bound'), '1');
    await imageTrigger.click(); await imageDone();
    const replaceSource = async (attribute, suffix) => {
      await imageNode.evaluate((img, { attribute, url }) => img.setAttribute(attribute, attribute === 'srcset' ? `${url} 1x` : url), { attribute, url: `${base}/image.svg?${suffix}` });
      await page.waitForFunction(suffix => document.querySelector('#fixture-image').currentSrc.includes(suffix), suffix);
      await page.waitForFunction(() => !document.querySelector('.ig-img-overlay-layer'));
      await imageTrigger.waitFor();
    };
    await replaceSource('src', 'new-src');
    await imageTrigger.click(); await imageDone();
    await replaceSource('srcset', 'new-srcset');
    await imageTrigger.click(); await imageDone();
    assert.equal((await send(tabId, { type: 'GET_PAGE_STATUS' })).isPageTranslated, false);
    assert.equal(await page.locator('.ig-img-overlay-layer').count(), 1);
    recordCheck('Manual image session: same IMG src and srcset replacements remove completed stale layers and permit new translation without paragraph activation');

    // Responsive selection can change currentSrc without any src/srcset attribute mutation.
    await page.setViewportSize({ width: 400, height: 1200 });
    await imageNode.evaluate((img, base) => {
      img.sizes = '50vw';
      img.srcset = `${base}/image.svg?responsive-small 240w, ${base}/image.svg?responsive-large 960w`;
    }, base);
    await page.waitForFunction(() => document.querySelector('#fixture-image').currentSrc.includes('responsive-small'));
    await imageTrigger.click(); await imageDone();
    const responsiveAttributes = await imageNode.evaluate(img => [img.src, img.srcset, img.sizes]);
    await page.setViewportSize({ width: 1200, height: 1200 });
    await page.waitForFunction(() => document.querySelector('#fixture-image').currentSrc.includes('responsive-large'));
    await page.waitForFunction(() => !document.querySelector('.ig-img-overlay-layer'));
    assert.deepEqual(await imageNode.evaluate(img => [img.src, img.srcset, img.sizes]), responsiveAttributes);
    await imageTrigger.click(); await imageDone();
    recordCheck('Responsive image load: viewport-only currentSrc change invalidates old translation with unchanged src/srcset/sizes attributes');

    await replaceSource('srcset', 'inflight-old');
    holdImageReplies = true;
    await imageTrigger.click();
    await wait(() => heldImageReplies.length === 1, 'old source image request held');
    await replaceSource('srcset', 'inflight-new');
    await imageTrigger.click();
    await wait(() => heldImageReplies.length === 2, 'new source image request held');
    heldImageReplies.shift()();
    await page.waitForTimeout(180);
    assert.equal(await imageNode.getAttribute('data-ig-img-status'), 'loading');
    assert.equal(await page.locator('.ig-img-overlay-layer').count(), 0);
    heldImageReplies.shift()(); holdImageReplies = false;
    await imageDone();
    assert.equal(await page.locator('.ig-img-overlay-layer').count(), 1);
    recordCheck('Image source replacement in flight: old HTTP reply cannot restore a layer or clear replacement task; latest reply owns the one overlay');

    await hoverImage();
    await toggle(); await toggle();
    assert.equal(await page.locator('.ig-img-control-bar').count(), 0);
    assert.equal(await imageNode.getAttribute('data-ig-hover-bound'), null);
    await hoverImage(); await hoverImage();
    assert.equal(await page.locator('.ig-img-control-bar').count(), 1);
    await imageTrigger.click(); await imageDone();
    recordCheck('Disable/re-hover: release clears hover ownership; repeated hover recreates exactly one working image translation control');
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
    recordCheck('Actual initial storage load, storage changes and YouTube audio button: missing Google/DeepSeek/custom and explicit protocols gated before capture');
    await audio.page.close();
    const subtitleSettings = { ...settings, youtubeAutoEnable: true };
    const captionsHtml = '<!doctype html><title>Subtitle reliability fixture</title><div id="movie_player" class="html5-video-player"><video></video><div class="ytp-right-controls"></div><div class="ytp-caption-window-container"><span class="ytp-caption-segment"></span></div></div>';
    const routeCaptions = route => route.fulfill({ status: 200,
      contentType: route.request().resourceType() === 'document' ? 'text/html' : 'application/json',
      body: route.request().resourceType() === 'document' ? captionsHtml : '{}' });
    const setPlayback = (fixture, paused) => fixture.page.evaluate(paused => {
      const video = document.querySelector('video');
      Object.defineProperty(video, 'paused', { configurable: true, value: paused });
      video.dispatchEvent(new Event(paused ? 'pause' : 'playing'));
    }, paused);
    const seedCaptions = async (fixture, live) => {
      await fixture.page.locator('.ig-yt-ctrl-btn').waitFor();
      await fixture.page.evaluate(live => {
        if (live) document.querySelector('.ytp-caption-segment').textContent = 'Live English subtitle fixture.';
        else window.postMessage({ source: 'IG_YT_MAIN_BRIDGE', type: 'YT_CUES_LOADED', payload: {
          videoTitle: 'Fixture', videoId: new URL(location.href).searchParams.get('v'),
          cues: [{ id: 0, text: 'English subtitle fixture.', start: 0, end: 120 }]
        } }, '*');
      }, live);
    };
    // A tab kept open across an extension reload has a dead runtime connection.
    for (const live of [false, true]) {
      await store(subtitleSettings);
      subtitleMode = 'ok';
      const fixture = await open(`https://www.youtube.com/watch?v=${live ? 'live' : 'cue'}-invalid-context`, routeCaptions);
      await fixture.evaluate(`chrome.runtime.connect = () => { throw new Error('Extension context invalidated.'); };`);
      const before = subtitleCalls.length;
      await seedCaptions(fixture, live);
      await fixture.page.locator('.ig-yt-line-trans').filter({ hasText: '刷新页面' }).waitFor();
      assert.equal(subtitleCalls.length, before, 'dead connection never reaches the model');
      assert.doesNotMatch(await fixture.page.locator('.ig-yt-translation-error').textContent(), /字幕返回为空|检查模型/);
      const refresh = fixture.page.locator('.ig-yt-translation-error button');
      assert.equal(await refresh.textContent(), '刷新页面');
      await Promise.all([fixture.page.waitForEvent('load'), refresh.click()]);
      await seedCaptions(fixture, live);
      await fixture.page.locator('.ig-yt-line-trans').filter({ hasText: '段落译文' }).waitFor();
      assert.equal(await fixture.page.locator('.ig-yt-translation-error').count(), 0);
      recordCheck(`${live ? 'Live' : 'Track'} invalidated runtime shows refresh, never false model-empty/loading; actual refresh restores translation`);
      await fixture.page.close();
    }

    for (const live of [false, true]) {
      await store(subtitleSettings);
      subtitleMode = '401';
      const fixture = await open(`https://www.youtube.com/watch?v=${live ? 'live' : 'cue'}-failure`, routeCaptions);
      const start = subtitleCalls.length;
      await seedCaptions(fixture, live);
      await fixture.page.locator('.ig-yt-translation-error').filter({ hasText: '已暂停' }).waitFor();
      await fixture.page.locator('.ig-yt-line-trans').filter({ hasText: '已暂停' }).waitFor();
      assert.doesNotMatch(await fixture.page.locator('.ig-yt-line-trans').textContent(), /正在.*翻译/);
      for (const paused of [false, true]) {
        await setPlayback(fixture, paused);
        await fixture.page.waitForTimeout(700);
        assert.equal(subtitleCalls.length - start, 1, `${live ? 'live' : 'cue'} 401 stays at one request during ${paused ? 'pause' : 'play'}`);
      }
      // Live text changes must not bypass a permanent session failure.
      if (live) await fixture.page.locator('.ytp-caption-segment').evaluate(el => { el.textContent = 'A different live caption.'; });
      await fixture.page.waitForTimeout(300);
      assert.equal(subtitleCalls.length - start, 1);
      subtitleMode = '503';
      const transientStart = subtitleCalls.length;
      await fixture.page.locator('.ig-yt-translation-error button').click();
      await fixture.page.locator('.ig-yt-translation-error').filter({ hasText: '已暂停' }).waitFor({ timeout: 16000 });
      assert.equal(subtitleCalls.length - transientStart, 9, '3 session attempts × 3 bounded HTTP attempts');
      const attempts = subtitleCalls.slice(transientStart);
      assert.ok(attempts[3].at - attempts[2].at >= 900, 'first session retry waits at least ~1s');
      assert.ok(attempts[6].at - attempts[5].at >= 1900, 'second session retry waits at least ~2s');
      await fixture.page.waitForTimeout(500);
      assert.equal(subtitleCalls.length - transientStart, 9, 'no further automatic requests after retry exhaustion');
      subtitleMode = 'ok';
      await store({ ...subtitleSettings, modelId: 'fixture-vision-recovered' });
      await fixture.page.locator('.ig-yt-line-trans').filter({ hasText: '段落译文' }).waitFor();
      assert.equal(await fixture.page.locator('.ig-yt-translation-error').count(), 0);
      recordCheck(`${live ? 'Live native captions' : 'Loaded cue track'} real entry: 401 makes one request across play/pause; 503 stops at 9 HTTP calls with 1s/2s session backoff; visible restart and settings-change recovery pass`);
      await fixture.page.close();
    }

    // A held old-video 401 must not stop the new video's successful subtitle session.
    await store(subtitleSettings); subtitleMode = 'hold401';
    const stale = await open('https://www.youtube.com/watch?v=stale-video', routeCaptions);
    await seedCaptions(stale, false);
    await wait(() => heldSubtitleReplies.length === 1, 'held old video request');
    await stale.page.evaluate(() => history.pushState({}, '', '/watch?v=fresh-video'));
    // Wait for the production SPA poll to establish the new session, then use the real bridge event.
    await stale.page.waitForTimeout(1400);
    subtitleMode = 'ok';
    await seedCaptions(stale, false);
    await stale.page.locator('.ig-yt-line-trans').filter({ hasText: '段落译文' }).waitFor();
    heldSubtitleReplies.shift()();
    await stale.page.waitForTimeout(300);
    assert.equal(await stale.page.locator('.ig-yt-translation-error').count(), 0);
    assert.match(await stale.page.locator('.ig-yt-line-trans').textContent(), /段落译文/);
    recordCheck('YouTube SPA navigation: delayed old-video 401 cannot poison the new video translation session');

    // Returning to the SAME video must also recover, without a cue-track event.
    await store(subtitleSettings); subtitleMode = 'hold401';
    const returning = await open('https://www.youtube.com/watch?v=returning-live', routeCaptions);
    await seedCaptions(returning, true);
    await wait(() => heldSubtitleReplies.length === 1, 'held live-caption request before leaving video');
    await returning.page.evaluate(() => history.pushState({}, '', '/'));
    await returning.page.waitForTimeout(1400);
    subtitleMode = 'ok';
    const returnStart = subtitleCalls.length;
    await returning.page.evaluate(() => {
      history.pushState({}, '', '/watch?v=returning-live');
      document.querySelector('.ytp-caption-segment').textContent = 'Resumed same-video live caption.';
    });
    await returning.page.locator('.ig-yt-line-trans').filter({ hasText: '段落译文' }).waitFor();
    assert.ok(subtitleCalls.length > returnStart, 'same-video live captions resume after route cancellation');
    heldSubtitleReplies.shift()();
    await returning.page.waitForTimeout(300);
    assert.equal(await returning.page.locator('.ig-yt-translation-error').count(), 0);
    assert.match(await returning.page.locator('.ig-yt-line-trans').textContent(), /段落译文/);
    recordCheck('YouTube home → same live video: cancelled busy ownership resets, native captions resume without a cue-track event, and old 401 stays ignored');
    assert.deepEqual(errors, [], 'content-script contexts must have no uncaught exceptions');
    return checks;
  } finally {
    for (const page of pages) if (!page.isClosed()) await page.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
