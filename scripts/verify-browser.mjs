#!/usr/bin/env node
// Real MV3 extension smoke test. All model traffic terminates at a local mock server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makePdfFixture } from '../tests/pdf-fixture.mjs';
import { verifyContentBrowser } from './verify-content-browser.mjs';
import { verifyStudioBrowser } from './verify-studio-browser.mjs';
import { verifySettingsBrowser } from './verify-settings-browser.mjs';
import { verifyGeminiBrowser } from './verify-gemini-browser.mjs';
import { verifyReadingContentBrowser } from './verify-reading-content-browser.mjs';
import { verifyReadingStudioBrowser } from './verify-reading-studio-browser.mjs';
import { verifyYoutubeStateBrowser } from './verify-youtube-state-browser.mjs';
import { verifyYoutubeBridgeBrowser } from './verify-youtube-bridge-browser.mjs';
import { verifyEpubIntegrityBrowser } from './verify-epub-integrity-browser.mjs';
import { verifyDocumentBudgetBrowser } from './verify-document-budget-browser.mjs';
import { verifyPdfResourcesBrowser } from './verify-pdf-resources-browser.mjs';
import { verifyYoutubeTimelineBrowser } from './verify-youtube-timeline-browser.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist/browser-verification');
await fs.mkdir(output, { recursive: true });
const fixture = makePdfFixture();
await fs.writeFile(path.join(output, 'fixture.pdf'), fixture);
let mode = 'slow';
const calls = [];
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const call = { url: req.url, body: Buffer.concat(chunks).toString(), closed: false }; calls.push(call);
  console.log(`Mock API request ${calls.length}: ${req.url}`);
  res.on('close', () => { if (!res.writableEnded) call.closed = true; });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  if (mode === 'slow') res.write('{"choices":['); // Headers arrive; body remains pending.
  else {
    const request = JSON.parse(call.body);
    const prompt = request.messages.at(-1).content;
    const ids = [...prompt.matchAll(/"id"\s*:\s*(\d+)/g)].map(match => Number(match[1]));
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ids.map(id => ({ id, translation: `译文 ${id}` }))) } }] }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'qingjian-browser-'));
let context;
const errors = [], workers = [], checks = [];
let stage = 'launch';
const watchdog = setTimeout(() => {
  console.error(`Browser verification timed out at: ${stage}`);
  void context?.close();
}, 240000);
async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
try {
  console.log('Launching isolated Chromium extension test…');
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium',
    ignoreDefaultArgs: ['--disable-extensions'],
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  stage = 'extension worker';
  console.log('Chromium launched; waiting for extension service worker…');
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('worker', worker => workers.push(worker.url()));
  await page.goto(`chrome-extension://${extensionId}/studio/studio.html`);
  stage = 'PDF render';
  console.log('Extension loaded; rendering PDF fixture…');
  const result = await page.evaluate(async bytes => {
    const { openPdfDocument, renderPdfPageToCanvas } = await import('./pdf-engine.js');
    const buffer = new Uint8Array(bytes).buffer;
    const opened = await openPdfDocument(buffer);
    const first = await renderPdfPageToCanvas(opened.pdfDoc, 1, 1);
    const second = await renderPdfPageToCanvas(opened.pdfDoc, 2, 1);
    const pixels = first.canvas.getContext('2d').getImageData(0, 0, first.width, first.height).data;
    let colored = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 240 || pixels[i + 1] < 240 || pixels[i + 2] < 240) colored++;
    const info = { pages: opened.numPages, originalBytes: buffer.byteLength,
      first: [first.width, first.height], rotated: [second.width, second.height],
      text: first.textItems.map(item => item.str).join(' '), colored,
      coordinatesValid: first.textItems.every(item => Number.isFinite(item.x) && item.width > 0) };
    first.canvas.id = 'verification-canvas'; document.body.appendChild(first.canvas);
    await opened.pdfDoc.destroy();
    const controller = new AbortController(); controller.abort();
    try { await openPdfDocument(buffer, { signal: controller.signal }); info.abortRejected = false; }
    catch (err) { info.abortRejected = err.name === 'AbortError'; }
    const loadingController = new AbortController();
    const loading = openPdfDocument(buffer, { signal: loadingController.signal });
    setTimeout(() => loadingController.abort(), 0);
    try { await loading; info.loadingAborted = false; }
    catch { info.loadingAborted = loadingController.signal.aborted; }
    return info;
  }, [...fixture]);
  assert.equal(result.pages, 2);
  assert.equal(result.originalBytes, fixture.length);
  assert.deepEqual(result.first, [300, 400]);
  assert.deepEqual(result.rotated, [400, 300]);
  assert.match(result.text, /Left column.*Right column/);
  assert.ok(result.colored > 10000);
  assert.ok(result.coordinatesValid && result.abortRejected && result.loadingAborted);
  assert.ok(workers.some(url => url.endsWith('/pdf.worker.mjs')), 'real PDF worker must start');
  await page.locator('#verification-canvas').screenshot({ path: path.join(output, 'pdf-render.png') });
  await page.locator('#verification-canvas').evaluate(node => node.remove());
  checks.push('Real module worker, standard-font text, coordinates, rotated page, vector/raster pixels and preserved input bytes');
  stage = 'studio cancellation';
  console.log('PDF rendered; exercising studio cancellation…');

  await page.evaluate(async url => {
    const { saveSettings } = await import('../shared/storage.js');
    await saveSettings({ providerId: 'custom', apiProtocol: 'openai', apiBaseUrl: url,
      apiKey: 'local-test-only', modelId: 'local-model', maxConcurrency: 1, enableCache: true });
  }, baseUrl);
  await page.locator('#fileInput').setInputFiles({ name: 'fixture.pdf', mimeType: 'application/pdf', buffer: fixture });
  await page.waitForFunction(() => document.querySelector('#leftPaneTitle').textContent.includes('共 2 页'));
  await page.locator('#startTranslateDocBtn').click();
  await until(() => calls.length === 1, 'studio request reaches server');
  await page.evaluate(() => {
    globalThis.queuedScope = QingJianRequests.createScope();
    globalThis.queuedResult = queuedScope.request({ type: 'TRANSLATE_BATCH', payload: { items: [{ id: 1, text: 'queued-never-send' }] } });
  });
  await page.evaluate(() => queuedScope.cancel());
  assert.equal((await page.evaluate(() => queuedResult)).cancelled, true);
  await page.locator('#startTranslateDocBtn').dispatchEvent('click'); // Actual pause control.
  await until(() => calls[0].closed, 'pause closes active HTTP response');
  assert.equal(calls.length, 1, 'queued/cancelled request must never reach the server');
  checks.push('Studio pause disconnects active request, aborts response body and removes queued request');

  mode = 'fast';
  const fresh = await page.evaluate(async () => {
    const request = QingJianRequests.createScope();
    return request.request({ type: 'TRANSLATE_BATCH', payload: { items: [{ id: 1, text: 'after-cancellation' }] } });
  });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.data.translations[0].cached, false);
  checks.push('Subsequent real port request runs successfully after cancellation');

  mode = 'slow';
  const before = calls.length;
  await page.locator('#startTranslateDocBtn').click();
  await until(() => calls.length > before, 'resumed studio request');
  await page.locator('#fileInput').setInputFiles({ name: 'replacement.md', mimeType: 'text/markdown', buffer: Buffer.from('New document') });
  await until(() => calls[before].closed, 'document switch closes old HTTP response');
  await page.waitForFunction(() => document.querySelector('#leftPaneTitle').textContent.includes('replacement.md'));
  checks.push('Replacing the document aborts old work and loads the replacement');

  stage = 'total request deadline';
  await page.evaluate(async () => {
    const { saveSettings } = await import('../shared/storage.js');
    await saveSettings({ requestBudgetSeconds: 30 });
  });
  // Accelerate only the configured 30s deadline, not the 45s attempt timeout.
  await sw.evaluate(() => {
    globalThis.__nativeTimeout = setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => __nativeTimeout(fn, ms > 29000 && ms <= 30000 ? 250 : ms, ...args);
  });
  const deadlineStart = calls.length;
  try {
    const timedOut = await page.evaluate(() => QingJianRequests.createScope().request({
      type: 'TRANSLATE_BATCH', payload: { items: [{ id: 1, text: 'real-port-deadline' }] }
    }));
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.cancelled, false);
    assert.match(timedOut.error, /总时间预算/);
    await until(() => calls[deadlineStart]?.closed, 'deadline closes stalled response body');
    assert.equal(calls.length, deadlineStart + 1, 'no request retried after deadline');
    mode = 'fast';
    const retry = await page.evaluate(() => QingJianRequests.createScope().request({
      type: 'TRANSLATE_BATCH', payload: { items: [{ id: 1, text: 'real-port-deadline' }] }
    }));
    assert.equal(retry.ok, true);
    assert.equal(retry.data.translations[0].cached, false);
    checks.push('Actual port deadline: stalled body aborted, explicit timeout delivered, no retry/cache pollution, fresh request succeeds');
  } finally {
    await sw.evaluate(() => { globalThis.setTimeout = __nativeTimeout; delete globalThis.__nativeTimeout; });
    await page.evaluate(async () => {
      const { saveSettings } = await import('../shared/storage.js'); await saveSettings({ requestBudgetSeconds: 90 });
    });
    mode = 'slow';
  }

  const last = calls.length;
  await page.evaluate(() => {
    globalThis.closingScope = QingJianRequests.createScope();
    globalThis.closingResult = closingScope.request({ type: 'TRANSLATE_BATCH', payload: { items: [{ id: 1, text: 'page-close' }] } });
  });
  await until(() => calls.length > last, 'page close request');
  await page.close();
  await until(() => calls[last].closed, 'page close aborts network');
  checks.push('Closing the extension document automatically cancels its active request');
  const popup = await context.newPage();
  popup.on('pageerror', error => errors.push(error.message));
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  const popupStart = calls.length;
  await popup.locator('#quickInput').fill('Popup request to cancel');
  await popup.locator('#quickTranslateBtn').click();
  const findQuickCall = () => calls.slice(popupStart).find(call => call.body.includes('Popup request to cancel'));
  await until(() => findQuickCall(), 'popup quick translation');
  const quickCall = findQuickCall();
  await popup.close();
  await until(() => quickCall.closed, 'popup close aborts quick translation');
  checks.push('Closing popup cancels its actual quick-translation request');
  const options = await context.newPage();
  options.on('pageerror', error => errors.push(error.message));
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  await options.waitForFunction(() => document.querySelector('#requestBudgetInput').value === '90');
  for (const [input, expected] of [['120', 120], ['1', 30], ['999', 300], ['', 90]]) {
    // This section can be hidden by navigation; use the actual input and save handler.
    await options.locator('#requestBudgetInput').evaluate((node, value) => { node.value = value; }, input);
    await options.locator('#saveAllBtn').click();
    await options.waitForFunction(async value => {
      const { getSettings } = await import('../shared/storage.js');
      return (await getSettings()).requestBudgetSeconds === value;
    }, expected);
    await options.reload();
    await options.waitForFunction(value => document.querySelector('#requestBudgetInput').value === String(value), expected);
  }
  await options.close();
  checks.push('Actual settings save/reload persists request budget and clamps 1/999/empty to 30/300/90 seconds');
  stage = 'content lifecycle regressions';
  console.log('Checking actual content-script settings, rapid toggles and delayed image decoding…');
  checks.push(...await verifyContentBrowser(context, sw));
  stage = 'studio security and identity regressions';
  checks.push(...await verifyStudioBrowser(context, sw));
  stage = 'settings and statistics regressions';
  checks.push(...await verifySettingsBrowser(context, sw));
  stage = 'native Gemini regressions';
  checks.push(...await verifyGeminiBrowser(context, sw));
  stage = 'web reading integrity regressions';
  const readingContent = await verifyReadingContentBrowser(context, sw);
  checks.push(...readingContent.checks);
  errors.push(...readingContent.errors);
  stage = 'studio reading and export integrity regressions';
  const readingStudio = await verifyReadingStudioBrowser(context, sw);
  checks.push(...readingStudio.checks);
  errors.push(...readingStudio.errors);
  for (const [label, verify] of [
    ['YouTube saved settings and observed subtitles', verifyYoutubeStateBrowser],
    ['YouTube bridge session and track identity', verifyYoutubeBridgeBrowser],
    ['EPUB source and export integrity', verifyEpubIntegrityBrowser],
    ['Document import budgets', verifyDocumentBudgetBrowser],
    ['PDF preview reclamation', verifyPdfResourcesBrowser],
    ['YouTube timeline virtualization', verifyYoutubeTimelineBrowser]
  ]) {
    stage = label;
    const result = await verify(context, sw);
    checks.push(...result.checks); errors.push(...result.errors);
  }
  assert.deepEqual(errors, [], 'No uncaught page errors or CSP errors');
  const report = { passed: true, browser: context.browser().version(), pdfjs: '6.4.299', checks, pdf: result, workers, errors };
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearTimeout(watchdog);
  await context?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  // Keep the isolated temp profile for diagnostics; never touch the user's browser profile.
}
