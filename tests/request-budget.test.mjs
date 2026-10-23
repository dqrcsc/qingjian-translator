import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestBudget, normalizeRequestBudgetSeconds } from '../shared/request-budget.js';
import { withConcurrencyLimit } from '../background/request-queue.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('budget settings have a safe default and clamp to supported boundaries', () => {
  for (const value of [undefined, null, '', 'bad', 0, -1, Infinity]) assert.equal(normalizeRequestBudgetSeconds(value), 90);
  assert.equal(normalizeRequestBudgetSeconds('60'), 60);
  assert.equal(normalizeRequestBudgetSeconds(1), 30);
  assert.equal(normalizeRequestBudgetSeconds(999), 300);
});

test('configuration counts time already spent and a disposed budget cannot expire', async () => {
  const budget = createRequestBudget(500);
  await delay(30);
  budget.configure(10);
  assert.equal(budget.signal.aborted, true, 'configuration must not renew the deadline');
  await assert.rejects(budget.wait(Promise.resolve('late')), { name: 'TimeoutError' });
  budget.dispose();
  const success = createRequestBudget(30);
  assert.equal(await success.wait(Promise.resolve('ok')), 'ok');
  success.dispose();
  await delay(50);
  assert.equal(success.signal.aborted, false);
});

test('budget expiration removes queued work without consuming an admission slot', async () => {
  let release;
  const active = withConcurrencyLimit(1, () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  const budget = createRequestBudget(40);
  try {
    const waiting = withConcurrencyLimit(1, () => assert.fail('expired request reached API'), budget.signal);
    await assert.rejects(budget.wait(waiting), { name: 'TimeoutError' });
    await assert.rejects(waiting, { name: 'TimeoutError' });
  } finally { budget.dispose(); release(); await active; }
  assert.equal(await withConcurrencyLimit(1, async () => 'available'), 'available');
});

test('budget bounds non-cooperative work and ignores a late completion', async () => {
  const budget = createRequestBudget(30);
  let finish;
  const underlying = new Promise(resolve => { finish = resolve; });
  const result = budget.wait(underlying);
  await assert.rejects(result, { name: 'TimeoutError' });
  finish('late response');
  budget.dispose();
  await assert.rejects(result, { name: 'TimeoutError' });
});
