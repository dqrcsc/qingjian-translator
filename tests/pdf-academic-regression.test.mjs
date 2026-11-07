import test from 'node:test';
import assert from 'node:assert/strict';
import { extractStructuredPdfPageBlocks } from '../studio/pdf-engine.js';

const item = (str, x, y, width, extra = {}) => ({ str, x, yBaseline: y, top: y - 8.4,
  bottom: y + 2, width, height: 10.4, fontPx: 10, ...extra });

test('Rotation alone never discards PDF body text, while identifiable arXiv margin stamps are excluded', () => {
  const blocks = extractStructuredPdfPageBlocks({ width: 600, height: 800, textItems: [
    item('arXiv:1706.03762v7 [cs.CL]', 30, 200, 12, { rotated: true }),
    item('Rotated page body must remain readable.', 250, 150, 15, { rotated: true })
  ] }, 2);
  assert.match(blocks.map(b => b.original).join(' '), /Rotated page body must remain readable/);
  assert.ok(blocks.every(b => !b.original.includes('arXiv:')));
});

test('Method table headers remain cells; subsequent prose stays outside the structured table', () => {
  const textItems = [item('Table 1: Comparison of methods.', 180, 325, 150)];
  [['Method', 'Score', 'Cost'], ['Alpha', '12', '4'], ['Beta', '24', '8']].forEach((row, r) => {
    row.forEach((text, c) => textItems.push(item(text, [90,270,440][c], 365+r*24, text.length*5)));
  });
  textItems.push(item('After the table, this paragraph must remain visible and must not become a table row.', 70, 485, 420));
  const blocks = extractStructuredPdfPageBlocks({ width: 600, height: 800, textItems }, 2);
  const tables = blocks.filter(b => b.type === 'table');
  assert.equal(tables.length, 1);
  assert.equal(tables[0].original, '| Method | Score | Cost |\n| --- | --- | --- |\n| Alpha | 12 | 4 |\n| Beta | 24 | 8 |');
  assert.match(blocks.at(-1).original, /^After the table/);
  assert.equal(blocks.at(-1).type, 'paragraph');
});

test('blank data/header cells never merge independent rows or invent dash values', () => {
  for (const cells of [
    [['Method','Score','Cost'],['Alpha','','4'],['Beta','24','8']],
    [['Method','Score','Cost'],['','12','4'],['Beta','24','8']],
    [['','Score','Cost'],['Alpha','12','4'],['Beta','24','8']],
    [['Method','Score','Cost'],['Alpha','12',''],['Beta','—','8']],
    [['Method','','Cost'],['','Score',''],['Alpha','12','4'],['Beta','24','8']]
  ]) {
    const textItems = [item('Table 1: Comparison of methods.', 180, 325, 150)];
    cells.forEach((row,r) => row.forEach((str,c) => {
      if (str) textItems.push(item(str,[90,270,440][c],365+r*24,str.length*5));
    }));
    textItems.push(item('After the table, ordinary text remains outside the table.',70,520,420));
    const table = extractStructuredPdfPageBlocks({width:600,height:800,textItems},2).find(b=>b.type==='table');
    assert.ok(table, JSON.stringify(cells));
    const rows = table.original.split('\n').filter((_,i)=>i!==1).map(line=>line.split('|').slice(1,-1).map(c=>c.trim()));
    assert.deepEqual(rows,cells);
  }
});
