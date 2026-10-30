import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { makePdfFixture } from '../tests/pdf-fixture.mjs';

export async function verifyAcademicTableBrowser(context, sw) {
  const key='immersive_gemini_settings_v1', saved=await sw.evaluate(key=>chrome.storage.local.get(key),key);
  const checks=[],errors=[],calls=[],pages=[];
  const original='Method | Fixed grid | Mass balance | No global solve | Large time step | Multi-cell transport mechanism\nLocal explicit | ✓ | ✓ | ✓ | Limited | Sequential accumulation of small steps\nImplicit | ✓ | Varies by method | — | ✓ | Global coupled-system solve\nSemi-Lagrangian | Varies by method | Varies by method | Varies by method | ✓ | Flow-following trajectory tracing\nLarge-time-step Godunov | ✓ | ✓ | ✓ | ✓ | Hand-designed multi-cell wave propagation\n**CFL-conditioned attention** | ✓ | ✓ | ✓ | ✓ | Learned selection conditioned on CFL-based transport scale';
  const translation='| 方法 | 固定网格 | 质量守恒 | 无全局求解 | 大时间步长 | 多网格输运机制 |\n| :--- | :---: | :---: | :---: | :---: | :--- |\n| 局部显式波捕捉 | ✓ | ✓ | ✓ | 受限 | 小步长依序累积 |\n| 隐式格式 | ✓ | 视具体方法而定 | — | ✓ | 全局耦合系统求解 |\n| 半拉格朗日法 | 视具体方法而定 | 视具体方法而定 | 视具体方法而定 | ✓ | 沿流动的轨迹追踪 |\n| 大时间步长 Godunov | ✓ | ✓ | ✓ | ✓ | 人工设计的多网格波传播 |\n| **基于 CFL 条件的注意力机制** | ✓ | ✓ | ✓ | ✓ | 基于 CFL 输运尺度的条件依赖模型选择 |';
  const equation='$$\\frac{\\partial u}{\\partial t}+\\frac{\\partial f(u)}{\\partial x}=0\\tag{1}$$';
  const server=http.createServer(async(req,res)=>{
    const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'};
    if(req.method==='OPTIONS'){res.writeHead(204,cors);res.end();return;}
    try {
      const parts=[];for await(const part of req)parts.push(part);
      const body=JSON.parse(Buffer.concat(parts)),prompt=body.contents[0].parts.map(p=>p.text||'').join('');
      assert.match(prompt,/complete Markdown pipe tables/);calls.push(body);
      const page=Number(prompt.match(/academic page \(Page (\d+)/)?.[1]||1);
      const blocks=[{page,type:'table',original,translation},{page,type:'equation',original:equation,translation:equation}];
      res.writeHead(200,{...cors,'Content-Type':'application/json'});res.end(JSON.stringify({candidates:[{finishReason:'STOP',content:{role:'model',parts:[{text:JSON.stringify(blocks)}]}}]}));
    }catch(e){errors.push(e.message);res.writeHead(400,cors);res.end('{}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const check=label=>{checks.push(label);console.log(`  ✓ ${label}`);};
  const createPage=async()=>{const p=await context.newPage();p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));pages.push(p);return p;};
  const verifyGrid=async table=>{
    assert.equal(await table.locator('thead th').count(),6);assert.equal(await table.locator('tbody tr').count(),5);assert.equal(await table.locator('tbody td').count(),30);
    const rows=await table.locator('tr').evaluateAll(rows=>rows.map(row=>[...row.cells].map(c=>{const r=c.getBoundingClientRect();return {x:r.x,w:r.width};})));
    for(const row of rows.slice(1))for(let c=0;c<6;c++){assert.ok(Math.abs(row[c].x-rows[0][c].x)<1);assert.ok(Math.abs(row[c].w-rows[0][c].w)<1);}
  };
  const color=locator=>locator.evaluate(el=>getComputedStyle(el).color);
  try {
    await sw.evaluate(({key,base})=>chrome.storage.local.set({[key]:{providerId:'custom',apiProtocol:'gemini',apiBaseUrl:base+'/v1beta',apiKey:'fixture',modelId:'gemini-table-fixture',targetLang:'zh-CN',enableCache:false,enableFloatingBall:false,autoTranslateAllPages:false}}),{key,base});
    const page=await createPage();await page.setViewportSize({width:1700,height:1200});
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/studio/studio.html`);
    await page.locator('#fileInput').setInputFiles({name:'academic-table.pdf',mimeType:'application/pdf',buffer:makePdfFixture()});
    await page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='ready');
    await page.locator('#startTranslateDocBtn').click();
    await page.waitForFunction(()=>document.querySelector('#progressCounterBadge').textContent==='2 / 2 页');
    const first=page.locator('.paper-sheet-page').first();
    await verifyGrid(first.locator('.stream-orig .academic-table'));await verifyGrid(first.locator('.stream-trans .academic-table'));
    assert.equal(await first.locator('.stream-trans .academic-table tbody tr').last().locator('strong').textContent(),'基于 CFL 条件的注意力机制');
    assert.equal(await first.locator('.stream-trans .academic-table tbody tr').first().locator('td').nth(1).evaluate(el=>getComputedStyle(el).textAlign),'center');
    check('Actual PDF upload through native Gemini renders legacy original and Markdown translation as aligned six-column tables, preserving all values and emphasis');

    assert.equal(await color(first.locator('.paper-table-block .stream-orig')),'rgb(71, 85, 105)');
    assert.equal(await color(first.locator('.paper-table-block .stream-trans')),'rgb(51, 95, 101)');
    assert.equal(await color(first.locator('.paper-equation-block .math-expr')),'rgb(51, 95, 101)');
    assert.equal(await first.locator('.paper-equation-block .stream-orig').count(),0);
    assert.ok(await first.locator('.paper-equation-block .math-frac').count()>=2);
    await fs.mkdir(new URL('../dist/browser-verification/',import.meta.url),{recursive:true});
    await first.screenshot({path:new URL('../dist/browser-verification/academic-table.png',import.meta.url).pathname});
    check('Paper tables use readable grey originals and muted teal translations; identical formulas appear once in teal with fraction structure intact');

    const before=calls.length;
    await page.locator('#layoutStyleSelect').selectOption('card-stream');
    for(const mode of ['bilingual','translation-only']){
      await page.locator('#viewModeSelect').selectOption(mode);
      assert.equal(await color(page.locator('.stream-block-card.is-table .stream-trans').first()),'rgb(168, 197, 201)');
      assert.equal(await color(page.locator('.stream-block-card.is-equation .stream-trans').first()),'rgb(168, 197, 201)');
    }
    await page.locator('#layoutStyleSelect').selectOption('paper-layout');
    await page.locator('#viewModeSelect').selectOption('translation-full-width');
    await verifyGrid(page.locator('.paper-sheet-page').first().locator('.stream-trans .academic-table'));
    assert.equal(await page.locator('.paper-table-block .stream-orig').first().isVisible(),false);
    await page.locator('#viewModeSelect').selectOption('bilingual');assert.equal(calls.length,before);
    check('Dark stream and translation-only modes retain comfortable table/formula colors and column structure without retranslating');

    await page.evaluate(()=>{window.__tablePrint=null;window.print=()=>{
      const sheet=document.querySelector('.paper-sheet-page'),table=sheet.querySelector('.stream-trans table');
      window.__tablePrint={tableColor:getComputedStyle(sheet.querySelector('.paper-table-block .stream-trans')).color,
        originalColor:getComputedStyle(sheet.querySelector('.paper-table-block .stream-orig')).color,
        formulaColor:getComputedStyle(sheet.querySelector('.paper-equation-block .math-expr')).color,
        tableWidth:table.getBoundingClientRect().width,availableWidth:table.parentElement.clientWidth,
        columns:[...table.rows].map(row=>[...row.cells].map(cell=>cell.getBoundingClientRect().left))};
    };});
    await page.locator('#exportMenuBtn').click();await page.locator('[data-export="pdf-bilingual"]').click();
    await page.locator('input[name="pdfExportScope"][value="all"]').check();
    await page.emulateMedia({media:'print'});
    await page.locator('#confirmPdfExportBtn').evaluate(button=>button.click());
    await page.waitForFunction(()=>window.__tablePrint);
    const printed=await page.evaluate(()=>window.__tablePrint);
    assert.equal(printed.tableColor,'rgb(51, 95, 101)');assert.equal(printed.formulaColor,'rgb(51, 95, 101)');
    assert.equal(printed.originalColor,'rgb(71, 85, 105)');assert.ok(printed.tableWidth<=printed.availableWidth+1);
    for(const row of printed.columns.slice(1))for(let c=0;c<6;c++)assert.ok(Math.abs(row[c]-printed.columns[0][c])<1);
    await page.emulateMedia({media:'screen'});
    await page.waitForTimeout(450);
    check('The actual PDF export confirmation reaches print with aligned, unclipped table columns and explicit muted teal colors despite generic print color rules');

    const event=page.waitForEvent('download');await page.locator('#exportMenuBtn').click();await page.locator('[data-export="html"]').click();
    const html=await fs.readFile(await(await event).path(),'utf8');
    await fs.writeFile(new URL('../dist/browser-verification/academic-table.html',import.meta.url),html);
    const exported=await createPage();await exported.setContent(html);
    const sheet=exported.locator('.paper-sheet-page').first();
    await verifyGrid(sheet.locator('.stream-trans .academic-table'));
    assert.equal(await color(sheet.locator('.paper-table-block .stream-trans')),'rgb(51, 95, 101)');
    assert.equal(await color(sheet.locator('.paper-equation-block .math-expr')),'rgb(51, 95, 101)');
    assert.equal(await sheet.locator('.math-frac .math-num').first().evaluate(el=>getComputedStyle(el).borderBottomWidth),'1px');
    await exported.locator('.toggle-label').click();
    assert.equal(await sheet.locator('.paper-table-block .stream-orig').isVisible(),false);
    await verifyGrid(sheet.locator('.stream-trans .academic-table'));
    await exported.emulateMedia({media:'print'});
    await verifyGrid(sheet.locator('.stream-trans .academic-table'));
    assert.equal(await color(sheet.locator('.paper-equation-block .math-expr')),'rgb(51, 95, 101)');
    assert.equal(await sheet.locator('.math-frac .math-num').first().evaluate(el=>getComputedStyle(el).borderBottomWidth),'1px');
    assert.equal(await sheet.locator('.paper-table-block .stream-trans').evaluate(el=>getComputedStyle(el).textIndent),'0px');
    await exported.emulateMedia({media:'screen'});
    await sheet.screenshot({path:new URL('../dist/browser-verification/academic-table-export.png',import.meta.url).pathname});
    check('Actual downloaded HTML retains semantic tables, alignment, equation colors and pure-translation behavior under screen and print media');
    assert.deepEqual(errors,[]);return {checks,errors};
  } finally {await Promise.all(pages.map(p=>p.close()));await sw.evaluate(saved=>chrome.storage.local.set(saved),saved);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
