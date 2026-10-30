import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../studio/studio.js',import.meta.url),'utf8');
const context=vm.createContext({});
vm.runInContext(src.slice(src.indexOf('function serializeMarkdownCode('),src.indexOf('function parseHtmlDocumentToBlocks(')),context);
const parse=text=>JSON.parse(JSON.stringify(context.parseMarkdownToBlocks(text)));
const exportCode=block=>context.serializeMarkdownCode(block);
test('raw HTML/EPUB code with internal fences stays a single code block on Markdown roundtrip',()=>{
  for(const source of ['if (a < b) {\n  emit("keep code");\n}', '```js\n  literal fence\n```\n~~~\n`x`', '  first\n\n  last\n']){
    const serialized=exportCode({type:'code',original:source});
    const blocks=parse(serialized+'\n\nFollowing prose.');
    assert.equal(blocks.length,2);assert.equal(blocks[0].type,'code');
    assert.equal(blocks[0].original.split('\n').slice(1,-1).join('\n'),source);
    assert.equal(blocks[1].original,'Following prose.');
  }
});
test('existing backtick/tilde fences and language identifiers survive repeated export',()=>{
  for(const source of ['```js\n  call();\n```','~~~~python\n  pass\n~~~~~']){
    const block=parse(source)[0];assert.equal(exportCode(block),source);
    assert.equal(exportCode(parse(exportCode(block))[0]),source);
  }
});
test('unterminated Markdown fence is closed on export so following content cannot be swallowed',()=>{
  const block=parse('```js\n  unfinished();')[0];
  const output=exportCode(block);assert.equal(output,'```js\n  unfinished();\n```');
  const parsed=parse(output+'\n\nFollowing prose.');assert.equal(parsed.length,2);assert.equal(parsed[1].type,'paragraph');
});
