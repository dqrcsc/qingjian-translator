import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { withConcurrencyLimit } from '../background/request-queue.js';

function event() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, emit(...args) { for (const fn of listeners) fn(...args); } };
}
const onConnect = event();
const storage = {};
let lastConnectedPair = null;
globalThis.chrome = {
  storage: { local: { async get(key) { return { [key]: storage[key] }; }, async set(value) { Object.assign(storage, value); } }, onChanged: event() },
  runtime: { onInstalled: event(), onMessage: event(), onConnect, getURL: x => x,
    connect({ name }) {
      let disconnected = false;
      const client = { onMessage: event(), onDisconnect: event() };
      const server = { name, sender: { documentId: 'test-document' }, onMessage: event(), onDisconnect: event() };
      client.postMessage = msg => server.onMessage.emit(msg);
      server.postMessage = msg => client.onMessage.emit(msg);
      client.disconnect = () => {
        if (disconnected) return;
        disconnected = true;
        server.onDisconnect.emit(); client.onDisconnect.emit();
      };
      server.disconnect = () => {
        if (disconnected) return;
        disconnected = true;
        server.onDisconnect.emit(); client.onDisconnect.emit();
      };
      lastConnectedPair = { client, server };
      onConnect.emit(server);
      return client;
    } },
  tabs: { onUpdated: event() }, contextMenus: { onClicked: event() }, commands: { onCommand: event() }
};
const { saveSettings } = await import('../shared/storage.js');
const { DEFAULT_SETTINGS } = await import('../shared/constants.js');
await saveSettings({ ...DEFAULT_SETTINGS, providerId: 'custom', apiProtocol: 'openai',
  apiBaseUrl: 'https://mock.invalid/v1', apiKey: 'dummy-key', modelId: 'test-model', maxConcurrency: 1 });
await import('../shared/request-client.js');
await import('../background/service-worker.js');
const scope = () => globalThis.QingJianRequests.createScope();
const batch = text => ({ type: 'TRANSLATE_BATCH', payload: { items: [{ id: 1, text }] } });
const success = text => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ id: 1, translation: text }]) } }] }));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for test event');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test('disconnect cancels active and queued work without cancelling another scope or caching a failure', async () => {
  const calls = [];
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    calls.push({ url, init, resolve });
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  const a = scope(), b = scope(), c = scope();
  const active = a.request(batch('cancelled-original'));
  await until(() => calls.length === 1);
  const sameScopeQueued = a.request(batch('same-scope-never-send'));
  const queued = b.request(batch('must-never-be-sent'));
  const surviving = c.request(batch('surviving-original'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.length, 1);
  b.cancel(); a.cancel();
  assert.equal((await queued).cancelled, true);
  assert.equal((await sameScopeQueued).cancelled, true);
  assert.equal((await active).cancelled, true);
  assert.equal(calls[0].init.signal.aborted, true);
  await until(() => calls.length === 2);
  assert.match(calls[1].init.body, /surviving-original/);
  calls[1].resolve(success('保留任务'));
  assert.equal((await surviving).data.translations[0].translation, '保留任务');
  const retry = a.request(batch('cancelled-original'));
  await until(() => calls.length === 3);
  calls[2].resolve(success('重新翻译'));
  assert.equal((await retry).data.translations[0].cached, false);
});

test('port cancellation reaches response-body consumption and prevents retries', async () => {
  const { getUsageStats } = await import('../shared/storage.js');
  const before = await getUsageStats();
  let attempts = 0, signal;
  globalThis.fetch = async (_url, init) => {
    attempts++; signal = init.signal;
    return new Response(new ReadableStream({ start(controller) {
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
    } }));
  };
  const a = scope(), pending = a.request(batch('slow-body'));
  await until(() => attempts === 1);
  a.cancel();
  assert.equal((await pending).cancelled, true);
  assert.equal(signal.aborted, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(attempts, 1);
  assert.equal((await getUsageStats()).totalParagraphs, before.totalParagraphs);
});

test('cancelling during retry backoff prevents the next API request', async () => {
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; return new Response('busy', { status: 503 }); };
  const a = scope(), pending = a.request(batch('retry-backoff'));
  await until(() => attempts === 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  a.cancel();
  assert.equal((await pending).cancelled, true);
  // A new task must run promptly; the cancelled backoff cannot hold the semaphore.
  globalThis.fetch = async () => { attempts++; return success('下一任务'); };
  assert.equal((await a.request(batch('after-backoff'))).ok, true);
  assert.equal(attempts, 2);
});

test('cancelling a subset repair counts no completed paragraphs or source characters', async () => {
  const { getUsageStats } = await import('../shared/storage.js');
  const before = await getUsageStats();
  let attempts = 0;
  globalThis.fetch = async (_url, init) => {
    attempts++;
    if (attempts === 1) return success('missing placeholder');
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort',
      () => reject(init.signal.reason), { once: true }));
  };
  const a = scope();
  const pending = a.request({ type: 'TRANSLATE_BATCH', payload: { items: [
    { id: 1, text: 'repair cancellation {{0}}' }, { id: 2, text: 'repair cancellation plain' }
  ] } });
  await until(() => attempts === 2);
  a.cancel();
  assert.equal((await pending).cancelled, true);
  const after = await getUsageStats();
  assert.equal(after.totalParagraphs, before.totalParagraphs);
  assert.equal(after.estimatedCharsTranslated, before.estimatedCharsTranslated);
  assert.equal((after.batchRetries || 0) - (before.batchRetries || 0), 1);
});

test('image downloads share the same cancellation signal as model requests', async () => {
  let signal, requestedUrl;
  globalThis.fetch = (url, init) => new Promise((_resolve, reject) => {
    signal = init.signal; requestedUrl = url;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const a = scope();
  const pending = a.request({ type: 'TRANSLATE_IMAGE', payload: { imageUrl: 'https://mock.invalid/image.png' } });
  await until(() => signal);
  a.cancel();
  assert.equal((await pending).cancelled, true);
  assert.equal(signal.aborted, true);
  assert.equal(requestedUrl, 'https://mock.invalid/image.png');
});

test('aborted waiters never consume a semaphore slot', async () => {
  let release;
  const first = withConcurrencyLimit(1, () => new Promise(resolve => { release = resolve; }));
  await until(() => release);
  const controller = new AbortController();
  const blocked = withConcurrencyLimit(1, () => assert.fail('cancelled waiter ran'), controller.signal);
  controller.abort();
  await assert.rejects(blocked, /abort/i);
  release(); await first;
  assert.equal(await withConcurrencyLimit(1, async () => 'available'), 'available');
});

test('Gemini native requests use the same end-to-end abort signal', async () => {
  await saveSettings({ apiProtocol: 'gemini' });
  try {
    let signal, calls = 0;
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      calls++; signal = init.signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const a = scope(), pending = a.request(batch('gemini-cancel'));
    await until(() => signal);
    a.cancel();
    assert.equal((await pending).cancelled, true);
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
  } finally { await saveSettings({ apiProtocol: 'openai' }); }
});

test('every vendored PDF.js resource matches its recorded upstream bytes', async () => {
  const root = new URL('../studio/vendor/pdfjs/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  assert.equal(manifest.version, '6.4.299');
  assert.ok(Object.keys(manifest.files).length > 190);
  for (const [name, value] of Object.entries(manifest.files)) {
    const bytes = await readFile(new URL(name, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), value.sha256, name);
  }
});

// Accelerate only the configured total deadline; leave 45s attempt limits,
// backoff delays and test polling untouched. Exercise the actual dispatch/port.
async function withShortBudget(fn) {
  const nativeTimeout = globalThis.setTimeout;
  await saveSettings({ requestBudgetSeconds: 30 });
  globalThis.setTimeout = (callback, ms, ...args) => nativeTimeout(callback,
    ms > 29000 && ms <= 30000 ? 80 : ms, ...args);
  try { await fn(); }
  finally { globalThis.setTimeout = nativeTimeout; await saveSettings({ requestBudgetSeconds: 90 }); }
}

test('actual port reports deadline as failure, aborts response body, counts nothing and allows retry', async () => {
  await withShortBudget(async () => {
    const { getUsageStats } = await import('../shared/storage.js');
    const before = await getUsageStats();
    let attempts = 0, signal;
    globalThis.fetch = async (_url, init) => {
      attempts++; signal = init.signal;
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      } }));
    };
    const a = scope();
    const result = await a.request(batch('deadline-body'));
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.cancelled, false);
    assert.match(result.error, /总时间预算/);
    assert.equal(signal.aborted, true);
    assert.equal(attempts, 1);
    assert.equal((await getUsageStats()).totalParagraphs, before.totalParagraphs);
    globalThis.fetch = async () => { attempts++; return success('重试成功'); };
    const fresh = await a.request(batch('deadline-body'));
    assert.equal(fresh.ok, true);
    assert.equal(fresh.data.translations[0].cached, false);
    assert.equal(attempts, 2);
  });
});

test('actual deadline interrupts retry backoff without another API call', async () => {
  await withShortBudget(async () => {
    let attempts = 0;
    globalThis.fetch = async () => { attempts++; return new Response('busy', { status: 503 }); };
    const result = await scope().request(batch('deadline-backoff'));
    assert.equal(result.timedOut, true);
    assert.equal(attempts, 1);
    globalThis.fetch = async () => success('available');
    assert.equal((await scope().request(batch('after-deadline-backoff'))).ok, true);
  });
});

test('subset repair shares the original deadline and counts no completed output', async () => {
  await withShortBudget(async () => {
    const { getUsageStats } = await import('../shared/storage.js');
    const before = await getUsageStats();
    let attempts = 0, repairSignal;
    globalThis.fetch = async (_url, init) => {
      attempts++;
      if (attempts === 1) return success('missing placeholder');
      repairSignal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    };
    const result = await scope().request({ type: 'TRANSLATE_BATCH', payload: { items: [
      { id: 1, text: 'deadline-repair {{0}}' }, { id: 2, text: 'deadline-repair plain' }
    ] } });
    assert.equal(result.timedOut, true);
    assert.equal(attempts, 2);
    assert.equal(repairSignal.aborted, true);
    const after = await getUsageStats();
    assert.equal(after.totalParagraphs, before.totalParagraphs);
    assert.equal(after.estimatedCharsTranslated, before.estimatedCharsTranslated);
  });
});

test('legacy message entry and image download obey the same total budget', async () => {
  await withShortBudget(async () => {
    let signal, count = 0, replies = 0;
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      count++; signal = init.signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const response = await new Promise(resolve => chrome.runtime.onMessage.emit({ type: 'TRANSLATE_IMAGE',
      payload: { imageUrl: 'https://mock.invalid/deadline-image.png' } }, {}, value => { replies++; resolve(value); }));
    assert.equal(response.timedOut, true);
    assert.equal(response.cancelled, false);
    assert.equal(signal.aborted, true);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(replies, 1);
    assert.equal(count, 1, 'expired download must never start the model request');
  });
});

test('compatibility endpoint fallback shares the deadline and aborts its active response', async () => {
  await withShortBudget(async () => {
    await saveSettings({ apiBaseUrl: 'https://mock.invalid' });
    const urls = [];
    let fallbackSignal;
    try {
      globalThis.fetch = async (url, init) => {
        urls.push(url);
        if (urls.length === 1) return new Response('not found', { status: 404 });
        fallbackSignal = init.signal;
        return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      };
      const result = await scope().request(batch('deadline-fallback'));
      assert.equal(result.timedOut, true);
      assert.deepEqual(urls, ['https://mock.invalid/v1/chat/completions', 'https://mock.invalid/chat/completions']);
      assert.equal(fallbackSignal.aborted, true);
    } finally { await saveSettings({ apiBaseUrl: 'https://mock.invalid/v1' }); }
  });
});

test('a non-cooperative late fetch cannot populate the cache or completed statistics after timeout', async () => {
  await withShortBudget(async () => {
    const { getUsageStats } = await import('../shared/storage.js');
    const before = await getUsageStats();
    let finish, attempts = 0;
    globalThis.fetch = () => { attempts++; return new Promise(resolve => { finish = resolve; }); };
    const a = scope();
    assert.equal((await a.request(batch('deadline-late-fetch'))).timedOut, true);
    finish(success('late result'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await getUsageStats()).totalParagraphs, before.totalParagraphs);
    globalThis.fetch = async () => { attempts++; return success('fresh result'); };
    const retry = await a.request(batch('deadline-late-fetch'));
    assert.equal(retry.data.translations[0].translation, 'fresh result');
    assert.equal(retry.data.translations[0].cached, false);
    assert.equal(attempts, 2);
  });
});

test('actual queued request expires without sending or cancelling the active scope', async () => {
  await withShortBudget(async () => {
    await saveSettings({ requestBudgetSeconds: 300 });
    let attempts = 0, activeSignal;
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      attempts++; activeSignal = init.signal;
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    const activeScope = scope(), active = activeScope.request(batch('longer-budget-active'));
    try {
      await until(() => attempts === 1);
      await saveSettings({ requestBudgetSeconds: 30 });
      const waiting = await scope().request(batch('shorter-budget-queued'));
      assert.equal(waiting.timedOut, true);
      assert.equal(attempts, 1);
      assert.equal(activeSignal.aborted, false);
    } finally { activeScope.cancel(); await active; }
    globalThis.fetch = async () => success('available');
    assert.equal((await scope().request(batch('after-queued-timeout'))).ok, true);
  });
});

test('statistics read stall expires without holding a slot or blocking later statistics; late read cannot write', async () => {
  await withShortBudget(async () => {
    await saveSettings({ enableCache: false, maxConcurrency: 1 });
    const nativeGet = chrome.storage.local.get;
    let release, calls = 0, stalled = false;
    chrome.storage.local.get = async key => {
      if (key === 'immersive_gemini_stats_v1' && !stalled) {
        stalled = true;
        await new Promise(resolve => { release = resolve; });
      }
      return nativeGet(key);
    };
    globalThis.fetch = async () => { calls++; return success('healthy result'); };
    try {
      assert.equal((await scope().request(batch('stats-stall-first'))).timedOut, true);
      const next = await scope().request(batch('stats-stall-next'));
      assert.equal(next.ok, true);
      assert.equal(calls, 2);
      const snapshot = structuredClone(storage.immersive_gemini_stats_v1);
      release();
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.deepEqual(storage.immersive_gemini_stats_v1, snapshot, 'expired read must not write stale counters');
    } finally { chrome.storage.local.get = nativeGet; release?.(); await saveSettings({ enableCache: true }); }
  });
});

test('statistics write stall releases the request slot on cancellation and later work can run', async () => {
  const nativeSet = chrome.storage.local.set;
  let release, stalled = false;
  chrome.storage.local.set = async value => {
    if (value.immersive_gemini_stats_v1 && !stalled) {
      stalled = true;
      await new Promise(resolve => { release = resolve; });
      return; // Fixture has not committed: already-started real writes cannot be rolled back.
    }
    return nativeSet(value);
  };
  globalThis.fetch = async () => success('healthy result');
  const firstScope = scope();
  try {
    const pending = firstScope.request(batch('stats-write-stall'));
    await until(() => release);
    firstScope.cancel();
    assert.equal((await pending).cancelled, true);
    assert.equal((await scope().request(batch('stats-write-after-cancel'))).ok, true);
  } finally { chrome.storage.local.set = nativeSet; release?.(); }
});

test('failed statistics reads or writes do not discard successful output and subsequent statistics recover', async () => {
  const nativeGet = chrome.storage.local.get, nativeSet = chrome.storage.local.set;
  const key = 'immersive_gemini_stats_v1';
  globalThis.fetch = async () => success('preserved output');
  try {
    for (const method of ['get', 'set']) {
      let failed = false;
      chrome.storage.local.get = async name => {
        if (method === 'get' && name === key && !failed) { failed = true; throw Error('storage unavailable'); }
        return nativeGet(name);
      };
      chrome.storage.local.set = async value => {
        if (method === 'set' && value[key] && !failed) { failed = true; throw Error('storage unavailable'); }
        return nativeSet(value);
      };
      const result = await scope().request(batch(`stats-${method}-failure`));
      assert.equal(result.ok, true);
      assert.equal(result.data.translations[0].translation, 'preserved output');
      assert.equal(failed, true);
      const before = storage[key]?.totalParagraphs || 0;
      assert.equal((await scope().request(batch(`stats-${method}-recovered`))).ok, true);
      assert.equal(storage[key].totalParagraphs, before + 1);
    }
  } finally { chrome.storage.local.get = nativeGet; chrome.storage.local.set = nativeSet; }
});

test('unexpected worker port disconnect reconnects once automatically and ignores keepalive frames', async () => {
  let attempts = 0;
  let disconnectOnSecondAttempt = false;
  globalThis.fetch = (_url, init) => new Promise((resolve, reject) => {
    attempts++;
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    if (attempts === 1 || disconnectOnSecondAttempt) {
      const activeServer = lastConnectedPair.server;
      setTimeout(() => {
        activeServer.postMessage({ type: 'keepalive' });
        activeServer.disconnect();
      }, 5);
      return;
    }
    setTimeout(() => resolve(success('重连恢复成功')), 5);
  });

  const firstScope = scope();
  const recovered = await firstScope.request(batch('reconnect-once-success'));
  assert.equal(recovered.ok, true);
  assert.equal(recovered.data.translations[0].translation, '重连恢复成功');
  assert.equal(attempts, 2);

  attempts = 0;
  disconnectOnSecondAttempt = true;
  const secondScope = scope();
  const failed = await secondScope.request(batch('reconnect-twice-fails'));
  assert.equal(failed.ok, false);
  assert.equal(Boolean(failed.cancelled), false);
  assert.equal(failed.error, '请求连接已关闭');
  assert.equal(attempts, 2);
});
