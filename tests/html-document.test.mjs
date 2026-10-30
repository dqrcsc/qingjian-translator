import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../studio/studio.js',import.meta.url),'utf8');
const text=value=>({nodeType:3,nodeValue:value});
const el=(tag,children=[],attrs={})=>({nodeType:1,tagName:tag.toUpperCase(),childNodes:children.map(c=>typeof c==='string'?text(c):c),style:attrs.style||{},hasAttribute:k=>k in attrs,getAttribute:k=>attrs[k]??null});
function parse(root){
 const context=vm.createContext({DOMParser:class{parseFromString(){return {body:root};}}});
 vm.runInContext(src.slice(src.indexOf('function parseHtmlDocumentToBlocks('),src.indexOf('// 1B. Left Original PDF')),context);
 return JSON.parse(JSON.stringify(context.parseHtmlDocumentToBlocks('controlled DOM')));
}
test('HTML traversal emits root/container/table text once and in document order',()=>{
 const root=el('body',['ROOT',el('div',['DIV']),el('table',[el('tr',[el('td',['CELL A']),el('td',[el('p',['CELL B'])])])]),el('ul',[el('li',['PARENT',el('ul',[el('li',['CHILD'])]),'TAIL'])])]);
 assert.deepEqual(parse(root).map(b=>b.original),['ROOT','DIV','CELL A','CELL B','PARENT','CHILD','TAIL']);
});
test('HTML inline text preserves adjacency and code preserves whitespace',()=>{
 const blocks=parse(el('body',[el('h1',['X']),el('p',['Hello ',el('strong',['world']),'.',el('br'),'Next']),el('pre',['  const x = 1;\n',el('code',['  x++;\n'])])]));
 assert.deepEqual(blocks.map(b=>[b.type,b.original]),[['heading','X'],['paragraph','Hello world. Next'],['code','  const x = 1;\n  x++;\n']]);
 assert.equal(blocks[2].translation,blocks[2].original);
});
test('HTML ignores non-content and explicit hidden subtrees, including inside inline nodes',()=>{
 const hidden=[el('script',['script']),el('style',['css']),el('template',['template']),el('div',['hide'],{hidden:''}),el('span',['aria'],{'aria-hidden':'true'}),el('div',['none'],{style:{display:'none'}}),el('span',['invisible'],{style:{visibility:'hidden'}})];
 assert.deepEqual(parse(el('body',[...hidden,el('p',['Visible',...hidden])])).map(b=>b.original),['Visible']);
 assert.deepEqual(parse(el('body',hidden)),[]);
 assert.deepEqual(parse(el('body',['Invisible document'],{hidden:''})),[]);
});
