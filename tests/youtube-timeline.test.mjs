import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../content/content-main.js', import.meta.url), 'utf8');
function range() {
  const start = source.indexOf('  function youtubeTimelineRange(');
  const end = source.indexOf('  function createYoutubeTimelineWindow(', start);
  assert.ok(start >= 0 && end > start, 'actual timeline window functions exist');
  const context = vm.createContext({}); vm.runInContext(source.slice(start, end), context);
  return context.youtubeTimelineRange;
}
test('timeline window remains bounded across a 10000-cue track and contains the visible rows', () => {
  const select = range(), offsets = Array.from({ length: 10001 }, (_, i) => i * 80);
  for (const top of [0, 80, 400000, 799500, 900000]) {
    const { start, end } = select(offsets, top, 600);
    assert.ok(end - start <= 40); assert.ok(start >= 0 && end <= 10000);
    assert.ok(offsets[start] <= Math.min(top, 799999));
    assert.ok(offsets[end] >= Math.min(top + 600, 800000));
  }
});
test('dynamic tall rows stay visible without truncation or assuming fixed height', () => {
  const select = range(), offsets = [0, 80, 5080, 5160, 5240];
  for (const top of [81, 3000, 5000]) {
    const result = select(offsets, top, 500);
    assert.ok(result.start <= 1 && result.end > 1);
  }
});
test('empty, short and zero-height viewports produce valid finite windows', () => {
  const select = range();
  assert.deepEqual({ ...select([0], 0, 0) }, { start: 0, end: 0 });
  assert.deepEqual({ ...select([0, 80, 200], 0, 0) }, { start: 0, end: 2 });
});
