// Real manifest MAIN-world bridge with local YouTube/player/timedtext fixtures.
import assert from 'node:assert/strict';

const timedtext = text => JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: text }] }] });
const fixture = `<!doctype html><meta charset="utf-8"><title>English fixture title - YouTube</title>
  <div id="movie_player"><video></video></div><script>
  window.fixture = { videoId: 'A', tracks: [], selected: null, selections: [], messages: [], finished: [] };
  const player = document.getElementById('movie_player');
  player.getPlayerResponse = () => ({ videoDetails: { videoId: fixture.videoId },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: fixture.tracks } } });
  player.getOption = (_, key) => key === 'tracklist' ? fixture.tracks : fixture.selected;
  player.setOption = (_, key, track) => { fixture.selections.push(track); fixture.selected = track; };
  player.loadModule = () => {};
  window.addEventListener('message', event => {
    if (event.source === window && event.data?.source === 'IG_YT_MAIN_BRIDGE') fixture.messages.push(event.data);
  });
  </script>`;

export async function verifyYoutubeBridgeBrowser(context, sw) {
  const checks = [], errors = [], pages = [];
  const settingsKey = 'immersive_gemini_settings_v1';
  const saved = await sw.evaluate(key => chrome.storage.local.get(key), settingsKey);
  const check = label => { checks.push(label); console.log(`  ✓ ${label}`); };
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 10000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error(`YouTube bridge timeout: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  async function openFixture() {
    const page = await context.newPage(); pages.push(page);
    page.setDefaultTimeout(10000);
    const held = [], failed = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => failed.push(request.url()));
    await page.route('https://www.youtube.com/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/timedtext') {
        requests.push(url.toString());
        if (url.searchParams.has('held')) { held.push(route); return; }
        const language = url.searchParams.get('lang');
        const text = language === 'ja' ? 'これは日本語の原始字幕です。' : language === 'zh' ? '这是真实的中文原始字幕。' : language === 'ar' ? 'هذه ترجمة عربية أصلية صحيحة' : 'Current English caption.';
        await route.fulfill({ contentType: 'application/json', body: timedtext(text) });
      } else if (route.request().isNavigationRequest()) {
        await route.fulfill({ contentType: 'text/html', body: fixture });
      } else await route.fulfill({ status: 204, body: '' });
    });
    await page.goto('https://www.youtube.com/watch?v=A');
    assert.equal(await page.evaluate(() => window.__IG_YT_BRIDGE_INSTALLED__), true, 'manifest MAIN script must execute');
    return { page, held, failed, requests };
  }
  const navigate = (page, route) => page.evaluate(ids => {
    for (const id of ids) {
      window.dispatchEvent(new Event('yt-navigate-start'));
      history.pushState({}, '', `/watch?v=${id}`);
      fixture.videoId = id; fixture.tracks = []; fixture.selected = null;
      window.dispatchEvent(new Event('yt-navigate-finish'));
    }
  }, route);
  const requestTracks = page => page.evaluate(() => window.postMessage({ source: 'IG_YT_CONTENT_SCRIPT', type: 'REQUEST_YT_TRACKS' }, '*'));
  try {
    await sw.evaluate(({ settingsKey, saved }) => chrome.storage.local.set({ [settingsKey]: {
      ...saved[settingsKey], enableYoutubeDualSub: false, youtubeAutoEnable: false,
      autoTranslateAllPages: false, autoTranslatePageImages: false, enableFloatingBall: false
    } }), { settingsKey, saved });

    for (const transport of ['fetch', 'xhr', 'bridge']) {
      for (const route of [['B'], ['B', 'A']]) {
        const { page, held, failed } = await openFixture();
        await page.evaluate(transport => {
          const url = 'https://www.youtube.com/api/timedtext?v=A&lang=en&held=1';
          if (transport === 'bridge') {
            fixture.tracks = [{ languageCode: 'en', vssId: '.en', baseUrl: url }];
            window.postMessage({ source: 'IG_YT_CONTENT_SCRIPT', type: 'REQUEST_YT_TRACKS' }, '*');
          } else if (transport === 'fetch') {
            window.fetch(url).then(response => response.text()).then(() => fixture.finished.push('fetch'));
          } else {
            const xhr = new XMLHttpRequest(); xhr.open('GET', url);
            xhr.addEventListener('load', () => fixture.finished.push('xhr')); xhr.send();
          }
        }, transport);
        await wait(() => held.length > 0, `${transport} request held`);
        await navigate(page, route);
        for (const response of held) await response.fulfill({ contentType: 'application/json', body: timedtext('STALE_A_CAPTION must never appear.') });
        if (transport === 'bridge') await wait(() => failed.some(url => url.includes('held=1')), 'own request is aborted on navigation');
        else await page.waitForFunction(transport => fixture.finished.includes(transport), transport);
        // postMessage is queued after the body read; a round-trip drains that delivery.
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
        assert.equal(await page.evaluate(() => fixture.messages.some(m => m.type === 'YT_CUES_LOADED' && m.payload.cues.some(c => c.text.includes('STALE_A_CAPTION')))), false);
        check(`MAIN bridge ${transport}: late A response discarded after A → ${route.join(' → ')}`);
        await page.close();
      }
    }

    const { page, requests } = await openFixture();
    await page.evaluate(() => {
      fixture.tracks = [
        { languageCode: 'en', vssId: '.en', baseUrl: 'https://www.youtube.com/api/timedtext?v=A&lang=en' },
        { languageCode: 'ja', kind: 'asr', vssId: 'a.ja', baseUrl: 'https://www.youtube.com/api/timedtext?v=A&lang=ja&kind=asr' }
      ];
    });
    await requestTracks(page);
    await page.waitForFunction(() => fixture.messages.some(m => m.type === 'YT_CUES_LOADED'));
    assert.equal(new URL(requests[0]).searchParams.get('lang'), 'ja');
    assert.equal(await page.evaluate(() => fixture.messages.filter(m => m.type === 'YT_CUES_LOADED').at(-1).payload.languageCode), 'ja');
    check('MAIN bridge selects Japanese ASR before unrelated English manual subtitles and dispatches real timedtext');

    for (const language of ['zh', 'ar']) {
      await page.evaluate(language => {
        const chosen = { languageCode: language, vssId: `.${language}`, baseUrl: `https://www.youtube.com/api/timedtext?v=A&lang=${language}` };
        fixture.tracks.push(chosen);
        fixture.selected = { ...chosen, translationLanguage: { languageCode: 'en' } };
        fixture.messages = []; fixture.selections = [];
      }, language);
      await requestTracks(page);
      await page.waitForFunction(language => fixture.messages.some(m => m.type === 'YT_CUES_LOADED' && m.payload.languageCode === language), language);
      assert.equal(await page.evaluate(() => fixture.selections.length), 0);
      assert.equal(await page.evaluate(() => fixture.selected.translationLanguage.languageCode), 'en');
      assert.equal(await page.evaluate(language => fixture.messages.filter(m => m.type === 'YT_CUES_LOADED').every(m => m.payload.languageCode === language), language), true);
      check(`MAIN bridge honors current ${language} track, preserves player translation choice and accepts its text`);
    }
    assert.deepEqual(errors, []);
    return { checks, errors };
  } finally {
    await Promise.all(pages.filter(page => !page.isClosed()).map(page => page.close()));
    if (Object.hasOwn(saved, settingsKey)) await sw.evaluate(value => chrome.storage.local.set(value), saved);
    else await sw.evaluate(key => chrome.storage.local.remove(key), settingsKey);
  }
}
