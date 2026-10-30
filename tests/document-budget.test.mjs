import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentBudget, readBoundedResponse, readBoundedFile } from '../studio/document-budget.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const withBudget = async (options, run) => {
  const budget = createDocumentBudget(options);
  try { return await run(budget); } finally { budget.dispose(); }
};
function response(chunks, options = {}) {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { chunks.forEach(bytes => controller.enqueue(new Uint8Array(bytes))); if (!options.stall) controller.close(); },
    cancel() { cancelled = true; }
  });
  return { value: new Response(stream, { headers: options.headers }), cancelled: () => cancelled };
}

test('document download checks actual bytes without trusting absent or understated length', async () => {
  for (const headers of [undefined, { 'Content-Length': '2' }]) {
    await withBudget({ maxInputBytes: 5 }, async budget => {
      const fixture = response([[1, 2, 3], [4, 5, 6]], { headers, stall: true });
      await assert.rejects(readBoundedResponse(fixture.value, budget), /文档.*大小|输入.*上限/);
      assert.equal(fixture.cancelled(), true);
      assert.equal(budget.signal.aborted, true);
    });
  }
});

test('declared oversized downloads reject before consuming body and cancel it', async () => {
  await withBudget({ maxInputBytes: 5 }, async budget => {
    const fixture = response([], { headers: { 'Content-Length': '6' }, stall: true });
    await assert.rejects(readBoundedResponse(fixture.value, budget), /文档.*大小|输入.*上限/);
    assert.equal(fixture.cancelled(), true);
  });
});

test('stalled response body expires and cancels its reader', async () => {
  await withBudget({ timeoutMs: 30 }, async budget => {
    const fixture = response([[1]], { stall: true });
    await assert.rejects(readBoundedResponse(fixture.value, budget), error => error.name === 'TimeoutError');
    assert.equal(fixture.cancelled(), true);
  });
});

test('one deadline covers successive stages rather than restarting on each await', async () => {
  await withBudget({ timeoutMs: 70 }, async budget => {
    await budget.wait(delay(45));
    await assert.rejects(budget.wait(delay(45)), error => error.name === 'TimeoutError');
  });
});

test('external cancellation propagates unchanged and removes a stalled body', async () => {
  const controller = new AbortController();
  await withBudget({ signal: controller.signal }, async budget => {
    const fixture = response([], { stall: true });
    const reading = readBoundedResponse(fixture.value, budget);
    controller.abort(new DOMException('user replaced document', 'AbortError'));
    await assert.rejects(reading, /user replaced document/);
    assert.equal(fixture.cancelled(), true);
  });
});

test('bounded local file reads preserve bytes, reject oversize before reading and share deadline', async () => {
  await withBudget({ maxInputBytes: 4 }, async budget => {
    assert.deepEqual(new Uint8Array(await readBoundedFile(new Blob(['abcd']), budget)), new TextEncoder().encode('abcd'));
  });
  await withBudget({ maxInputBytes: 4 }, async budget => {
    let opened = false;
    await assert.rejects(readBoundedFile({ size: 5, stream() { opened = true; } }, budget), /文档.*大小|输入.*上限/);
    assert.equal(opened, false);
  });
});

test('deadline check catches synchronous time spent between awaits; dispose removes external listener', async () => {
  const controller = new AbortController();
  let added = 0, removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { added++; return add(...args); };
  controller.signal.removeEventListener = (...args) => { removed++; return remove(...args); };
  const budget = createDocumentBudget({ signal: controller.signal, timeoutMs: 1 });
  const until = performance.now() + 5; while (performance.now() < until) { /* emulate synchronous parsing */ }
  assert.throws(() => budget.check(), error => error.name === 'TimeoutError');
  budget.dispose(); assert.equal(added, removed);
});

test('cancellation returns promptly even when source cancel never settles', async () => {
  await withBudget({ timeoutMs: 25 }, async budget => {
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
    await assert.rejects(readBoundedResponse(new Response(stream), budget), error => error.name === 'TimeoutError');
    assert.equal(cancelled, true);
  });
});

test('stream read failures release ownership and do not leave pending readers', async () => {
  await withBudget({}, async budget => {
    const stream = new ReadableStream({ pull(controller) { controller.error(new Error('download socket failed')); } });
    await assert.rejects(readBoundedResponse(new Response(stream), budget), /download socket failed/);
    assert.equal(stream.locked, false);
  });
});
