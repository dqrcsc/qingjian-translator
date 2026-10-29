import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../content/content-main.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start); return source.slice(a, b);
}
function element(tag = 'font') {
  return { tagName: tag.toUpperCase(), children: [], style: {}, attributes: {},
    appendChild(n) { this.children.push(n); }, setAttribute(k, v) { this.attributes[k] = v; } };
}

test('link restoration keeps identity through reordering and never trusts unsafe href or markup', () => {
  const ctx = vm.createContext({ URL, document: { baseURI: 'https://fixture.test/page',
    createDocumentFragment: () => element('fragment'), createElement: element, createTextNode: text => ({ textContent: text }) } });
  // The helper is intentionally included with the restore function once implemented.
  if (source.includes('  function safeOriginalLinkHref(')) vm.runInContext(section('  function safeOriginalLinkHref(', '\n  function extractTextWithPlaceholders('), ctx);
  vm.runInContext(section('  function restorePlaceholdersToFragment(', '\n  function '), ctx);
  const result = ctx.restorePlaceholdersToFragment('{{1}} and {{0}} {{2}}', [
    { type: 'link', text: '<img onerror=alert(1)>', href: '#inside', title: 'source title', target: '_blank' },
    { type: 'link', text: 'Documentation', href: 'https://fixture.test/docs' },
    { type: 'link', text: 'Unsafe', href: 'javascript:alert(1)' }
  ]);
  const links = result.children.filter(n => n.tagName === 'A');
  assert.equal(links.length, 2);
  assert.equal(links[0].textContent, 'Documentation');
  assert.equal(links[0].href, 'https://fixture.test/docs');
  assert.equal(links[1].textContent, '<img onerror=alert(1)>');
  assert.equal(links[1].href, 'https://fixture.test/page#inside');
  assert.match(links[1].rel, /noopener/);
  assert.ok(result.children.some(n => n.textContent === 'Unsafe'));
  assert.equal(links[1].children.length, 0, 'link label is text, never parsed HTML');
  for (const href of ['mailto:reader@example.com', 'tel:+123456', '#section', '/relative']) assert.ok(ctx.safeOriginalLinkHref(href));
  for (const href of ['javascript:alert(1)', 'data:text/html,bad', 'file:///tmp/x']) assert.equal(ctx.safeOriginalLinkHref(href), null);
});

test('Alt keydown waits for release and chords, repeats, blur and editing never toggle hovered content', () => {
  const listeners = {}, queued = [], reset = [];
  const hover = { dataset: {}, classList: { add() {}, remove() {} } };
  const document = { activeElement: { tagName: 'BODY' }, addEventListener: (event, handler) => { listeners[event] = handler; } };
  const ctx = vm.createContext({ settings: { enableHoverTranslate: true }, hoveredElement: hover, BLOCK_SELECTOR: 'p', document,
    window: { addEventListener: (event, handler) => { listeners[event] = handler; } },
    queueParagraphForTranslation: el => queued.push(el), resetElementTranslationState: el => reset.push(el) });
  vm.runInContext(section("  let altHoverGesture =", '\n  // ============================================================================\n  // 5.'), ctx);
  const key = (name, key, extra = {}) => listeners[name]({ key, ...extra });
  key('keydown', 'Alt'); assert.equal(queued.length, 0);
  key('keyup', 'Alt'); assert.equal(queued.length, 1);
  for (const letter of ['a', 's']) { key('keydown', 'Alt'); key('keydown', letter, { altKey: true }); key('keyup', 'Alt'); }
  assert.equal(queued.length, 1);
  // Chrome can consume the letter keydown while its keyup still reaches the page.
  for (const letter of ['a', 's']) { key('keydown', 'Alt'); key('keyup', letter, { altKey: true }); key('keyup', 'Alt'); }
  assert.equal(queued.length, 1);
  key('keydown', 'Alt'); key('keydown', 'Alt', { repeat: true }); key('keyup', 'Alt');
  assert.equal(queued.length, 2);
  key('keydown', 'Alt'); listeners.blur(); key('keyup', 'Alt'); assert.equal(queued.length, 2);
  document.activeElement = { tagName: 'TEXTAREA' };
  key('keydown', 'Alt'); key('keyup', 'Alt'); assert.equal(queued.length, 2);
  document.activeElement = { tagName: 'DIV', isContentEditable: true };
  key('keydown', 'Alt'); key('keyup', 'Alt'); assert.equal(queued.length, 2);
  document.activeElement = { tagName: 'BODY' }; hover.dataset.igStatus = 'done';
  key('keydown', 'Alt'); key('keyup', 'Alt'); assert.equal(reset.length, 1);
});

test('only successful segment source nodes are passed to the hiding layer; identical results are left intact', async () => {
  const nodes = [{ label: 'first text' }], wrappers = [];
  const el = { dataset: {}, querySelectorAll: () => [] };
  const records = new Map([[1, { element: el, text: 'first', sourceNodes: nodes, isMultiSeg: true }], [2, { element: el, text: 'identical', sourceNodes: [{ label: 'second' }], isMultiSeg: true }]]);
  const ctx = vm.createContext({ blockMap: records, requestAnimationFrame: fn => fn(),
    wrapOriginalTextNodes: (...args) => wrappers.push(args), shouldUseInlineMode: () => false,
    document: { createElement: () => ({ dataset: {}, setAttribute() {}, appendChild() {} }) },
    restorePlaceholdersToFragment: () => ({}), insertNodeAfterSegmentAnchor() {}, totalTranslatedCount: 0, updateFloatingBallStatus() {} });
  vm.runInContext(section('  function normalizeForComparison(', '\n  async function renderBatchErrorWithRAF('), ctx);
  await ctx.renderBatchResultsWithRAF([{ id: 1, translation: '译文' }, { id: 2, translation: 'identical' }]);
  assert.equal(wrappers.length, 1); assert.equal(wrappers[0][1], nodes);
});
