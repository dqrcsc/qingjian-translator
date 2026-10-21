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
