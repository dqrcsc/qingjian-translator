import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRichAcademicHtml } from '../studio/math-renderer.js';
const render = text => renderRichAcademicHtml(text, {blockType:'table',pageNum:2});
test('legacy rectangular pipe tables render semantic headers and aligned cells without losing values',()=>{
 const html=render('Method | Fixed grid | Mechanism\nExplicit | ✓ | Local solve\nImplicit | — | Coupled solve');
 assert.match(html,/<table/); assert.equal((html.match(/<th\b/g)||[]).length,3); assert.equal((html.match(/<td\b/g)||[]).length,6);
 for(const value of ['Method','Explicit','✓','Implicit','—','Coupled solve'])assert(html.includes(value));
});
test('Markdown separator alignment, optional outer pipes and empty cells are retained',()=>{
 const html=render('| Name | Value | Note |\n| :--- | ---: | :---: |\n| A | 1 | |\n| B | 2 | Yes |');
 assert.equal((html.match(/<tr>/g)||[]).length,3);assert.equal((html.match(/<td\b/g)||[]).length,6);
 assert.match(html,/class="academic-align-right">1<\/td>/);assert.match(html,/class="academic-align-center"><\/td>/);
 assert(!html.includes('---'));
});
test('table cells protect math, code and escaped pipes and still escape hostile HTML',()=>{
 const html=render('Expression | Label\n$P(x|y)$ | `a|b`\nA\\|B | <img src=x onerror=alert(1)>');
 assert.match(html,/<table/);assert.equal((html.match(/<td\b/g)||[]).length,4);
 assert.match(html,/inline-code-chip">a\|b/);assert.match(html,/A\|B/);assert.match(html,/&lt;img/);assert(!html.includes('<img'));
 assert.match(html,/math-expr/);
 const bracketed=render(String.raw`Expression | Label
\(\|x\|\) | z`);
 assert.match(bracketed,/<table/);assert.match(bracketed,/math-expr/);
 assert.equal((bracketed.match(/<td\b/g)||[]).length,2);
});
test('ragged or ambiguous table output keeps all text without fabricating a grid',()=>{
 for(const text of ['A | B\n1 | 2 | 3','A | B\nonly one cell','A | B\n$x|y | value','A | B\n`x|y | value','only prose','A | B\n--- | ---']){
  const html=render(text);assert(!html.includes('<table'),text);assert.equal(html.replaceAll('<br />','\n'),text);
 }
});
test('ordinary prose containing pipes is not reinterpreted as a table',()=>{
 assert(!renderRichAcademicHtml('A | B\n1 | 2',{blockType:'paragraph'}).includes('<table'));
});
