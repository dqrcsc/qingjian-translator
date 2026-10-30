import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';

export async function verifyHtmlDocumentBrowser(context, sw) {
  const checks=[],errors=[],pages=[];
  const check=name=>{checks.push(name);console.log(`  ✓ ${name}`);};
  const server=http.createServer(async(req,res)=>{
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'});res.end();return;}
    const chunks=[];for await(const c of req)chunks.push(c);
    const body=JSON.parse(Buffer.concat(chunks));
    const items=[...body.messages.at(-1).content.matchAll(/"id"\s*:\s*(\d+)/g)].map(m=>({id:Number(m[1]),translation:`HTML translation ${m[1]}`}));
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(items)}}]}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const page=await context.newPage();pages.push(page);page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  const upload=async(name,text)=>{await page.locator('#fileInput').setInputFiles({name,mimeType:'text/html',buffer:Buffer.from(text)});};
  const ready=()=>page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='ready');
  const download=async format=>{const event=page.waitForEvent('download');await page.locator('#exportMenuBtn').click();await page.locator(`[data-export="${format}"]`).click();return fs.readFile(await(await event).path(),'utf8');};
  try {
    await sw.evaluate(url=>chrome.storage.local.set({immersive_gemini_settings_v1:{providerId:'custom',apiProtocol:'openai',apiBaseUrl:url,apiKey:'local-only',modelId:'html-fixture',targetLang:'zh-CN',enableCache:false}}),`http://127.0.0.1:${server.address().port}/v1`);
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/studio/studio.html`);
    const fixture='<!doctype html><body>ROOT_TEXT<div>DIV_BODY</div><table><tr><td>CELL_A</td><td><p>CELL_B</p></td></tr></table><ul><li>PARENT_ENTRY<ul><li>CHILD_ENTRY</li></ul>TAIL_TEXT</li></ul><blockquote>QUOTE_BEFORE<p>QUOTE_P</p>QUOTE_AFTER</blockquote><h2>X</h2><p>Hello <b>world</b>.</p><pre>  code();\n  next();</pre><script>SECRET_SCRIPT</script><style>SECRET_STYLE</style><div hidden>SECRET_HIDDEN</div><span style="display:none">SECRET_NONE</span><template>SECRET_TEMPLATE</template>';
    await upload('semantic.html',fixture);await ready();
    const expected=['ROOT_TEXT','DIV_BODY','CELL_A','CELL_B','PARENT_ENTRY','CHILD_ENTRY','TAIL_TEXT','QUOTE_BEFORE','QUOTE_P','QUOTE_AFTER','X','Hello world.'];
    assert.deepEqual(await page.locator('#bilingualStreamContainer .stream-orig').allTextContents(),expected);
    assert.equal(await page.locator('#bilingualStreamContainer pre').textContent(),'  code();\n  next();');
    await page.locator('#startTranslateDocBtn').click();await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('文档双语翻译已完成'));
    const md=await download('md');for(const text of expected.filter(t=>t!=='X'))assert.equal(md.split(text).length-1,1,text);
    assert.doesNotMatch(md,/SECRET_/);assert.match(md,/  code\(\);\n  next\(\);/);
    const full=await download('html');assert.doesNotMatch(full,/SECRET_/);for(const text of expected.filter(t=>t!=='X'))assert.ok(full.includes(text),text);
    check('Actual HTML upload preserves root/div/table/nested-list/quote text once, single-character headings and code; translations and downloaded MD/HTML retain complete source');
    await upload('empty.html','<!doctype html><script>hidden text</script><div hidden>hidden</div>');
    await page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='error');
    assert.match(await page.locator('#docStatusSubtitle').textContent(),/没有可提取的正文/);assert.equal(await page.locator('#startTranslateDocBtn').isDisabled(),true);
    check('HTML with no extractable body reports an import error and disables translation instead of claiming success');
    await upload('columns.md','# Spanning title\n\n'+Array.from({length:8},(_,i)=>`Paragraph ${i} has complete source text.`).join('\n\n'));await ready();
    await page.locator('#paperColumnModeSelect').selectOption('two-column');
    const html=await download('html');const exported=await context.newPage();pages.push(exported);exported.on('pageerror',e=>errors.push(e.message));await exported.setContent(html);
    const normalize='.paper-sheet-body{width:600px!important}.paper-block{height:60px!important;margin:0 0 15px!important}.paper-block .stream-orig,.paper-block .stream-trans{font:14px/20px sans-serif!important;margin:0!important}';
    await page.addStyleTag({content:normalize});await exported.addStyleTag({content:normalize});
    const measure=p=>p.locator('.paper-sheet-body').evaluate(el=>{const origin=el.getBoundingClientRect();return {columns:getComputedStyle(el).columnCount,gap:getComputedStyle(el).columnGap,span:getComputedStyle(el.querySelector('.is-heading')).columnSpan,positions:[...el.querySelectorAll('.paper-block')].map(n=>{const b=n.getBoundingClientRect();return [Math.round(b.x-origin.x),Math.round(b.y-origin.y)];})};});
    const preview=await measure(page),output=await measure(exported);assert.equal(preview.columns,'2');assert.equal(output.span,'all');assert.deepEqual(output,preview);
    await exported.locator('label[for="exportModeToggle"]').click();assert.equal(await exported.locator('.stream-orig').first().isVisible(),false);
    await exported.locator('label[for="exportModeToggle"]').click();assert.equal(await exported.locator('.stream-orig').first().isVisible(),true);
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/studio/studio.html`);
    await page.locator('#emptyDemoBtn').click();await ready();
    await page.locator('#paperColumnModeSelect').selectOption('two-column');
    const demoHtml=await download('html');await exported.setContent(demoHtml);
    const figureSpans=p=>p.locator('.paper-figure-box').evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).columnSpan));
    const spans=await figureSpans(page);assert.ok(spans.length>0);assert.ok(spans.every(s=>s==='all'));assert.deepEqual(await figureSpans(exported),spans);
    // The demo contains labels without an inpainted background bitmap. Their
    // absolute coordinates require a real canvas height in the exported file.
    const canvasWidth='.paper-figure-canvas{width:600px!important}';
    await page.addStyleTag({content:canvasWidth});await exported.addStyleTag({content:canvasWidth});
    const labels=p=>p.locator('.paper-fig-label-box').evaluateAll(nodes=>nodes.map(n=>{const style=getComputedStyle(n),r=n.getBoundingClientRect(),parent=n.parentElement.getBoundingClientRect();return {position:style.position,font:style.fontSize,lineHeight:style.lineHeight,background:style.backgroundColor,x:Math.round(r.x-parent.x),y:Math.round(r.y-parent.y),width:Math.round(r.width),height:Math.round(r.height)};}));
    const previewLabels=await labels(page);assert.ok(previewLabels.length>0);assert.ok(previewLabels.every(l=>l.position==='absolute'));assert.deepEqual(await labels(exported),previewLabels);
    check('Downloaded HTML reopens with matching same-width column flow, spanning headings and figures; full-text bilingual/translation-only toggle still works');
    check('Actual demo HTML export preserves label-only figure overlay coordinates, canvas height and text styling');
  } finally {await Promise.all(pages.map(p=>p.close()));server.closeAllConnections();await new Promise(r=>server.close(r));}
  assert.deepEqual(errors,[]);return {checks,errors};
}
