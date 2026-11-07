import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { makeAcademicPdfFixture } from '../tests/academic-pdf-fixture.mjs';
import { makePdfFixture } from '../tests/pdf-fixture.mjs';

export async function verifyV124IntegrityBrowser(context, sw) {
  const key='immersive_gemini_settings_v1', saved=await sw.evaluate(key=>chrome.storage.local.get(key),key);
  const pages=[],checks=[],errors=[],calls=[]; let mode='batch',failCount=0;
  const check=label=>{checks.push(label);console.log(`  ✓ ${label}`);};
  const server=http.createServer(async(req,res)=>{
    const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'};
    if(req.method==='OPTIONS'){res.writeHead(204,cors);res.end();return;}
    try {
      const chunks=[];for await(const c of req)chunks.push(c);
      const body=JSON.parse(Buffer.concat(chunks)),gemini=!!body.contents;
      const content=gemini?body.contents[0].parts:body.messages.at(-1).content;
      const vision=Array.isArray(content)&&content.some(p=>p.inlineData||p.type==='image_url');
      const prompt=Array.isArray(content)?content.map(p=>p.text||'').join(''):content;
      const call={vision,gemini,at:Date.now(),closed:false,mode};calls.push(call);
      res.on('close',()=>{if(!res.writableEnded)call.closed=true;});
      let answer;
      if(mode==='formula') {
        const page=Number(prompt.match(/academic page \(Page (\d+)/)?.[1]||1);
        answer=[{page,type:'equation',original:String.raw`\frac{a}{b}+\sqrt{c}`,translation:''},
          {page,type:'paragraph',original:'A real paragraph for this page.',translation:'本页有效段落。'}];
      } else if(vision) {
        if(mode==='figure-fail'){res.writeHead(400,cors);res.end('{"error":{"message":"fixture model does not support vision"}}');return;}
        answer={hasText:true,summaryTranslation:'位图文字已识别',regions:[{original:'Raster chart label',translation:'图表标签',box_2d:[100,100,350,850]}]};
      } else {
        const items=JSON.parse(prompt.split('Input JSON:\n')[1]);call.items=items;
        if(mode==='fail') {
          failCount++;
          if(failCount===1){res.writeHead(401,cors);res.end('{}');return;}
          // Keep response consumption in flight until page-scoped cancellation.
          res.writeHead(200,{...cors,'Content-Type':'application/json'});res.write('{"choices":[');return;
        }
        answer=items.map(x=>({id:x.id,translation:x.text.startsWith('|')?x.text.replace('Method','方法'):`译文：${x.text}`}));
      }
      res.writeHead(200,{...cors,'Content-Type':'application/json'});
      res.end(JSON.stringify(gemini?{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(answer)}]}}]}:{choices:[{message:{content:JSON.stringify(answer)}}]}));
    }catch(e){errors.push(e.message);res.writeHead(400,cors);res.end('{}');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`,id=new URL(sw.url()).host;
  const settings={providerId:'custom',apiProtocol:'openai',apiBaseUrl:base+'/v1',apiKey:'fixture',modelId:'fixture',availableModels:[{id:'fixture'}],targetLang:'zh-CN',enableCache:false,enableFloatingBall:true,enableImageTranslate:false,autoTranslatePageImages:false,autoTranslateAllPages:false,alwaysTranslateDomains:'audit.example'};
  const save=values=>sw.evaluate(({key,values})=>chrome.storage.local.set({[key]:values}),{key,values});
  const page=await context.newPage();pages.push(page);page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  const upload=async(buffer,name)=>{
    await page.goto(`chrome-extension://${id}/studio/studio.html`);
    await page.locator('#fileInput').setInputFiles({name,mimeType:'application/pdf',buffer});
    await page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='ready');
    await page.locator('#startTranslateDocBtn').click();
  };
  const done=()=>page.waitForFunction(()=>document.querySelector('#progressCounterBadge').textContent.startsWith('1 / 1 页'));
  const exportHtml=async()=>{
    const download=page.waitForEvent('download');await page.locator('#exportMenuBtn').click();await page.locator('[data-export="html"]').click();
    return fs.readFile(await(await download).path(),'utf8');
  };
  const route=route=>route.fulfill({status:200,contentType:'text/html',body:'<p>This is a sufficiently long English paragraph that should translate automatically on the configured website.</p>'});
  try {
    await save(settings);
    await upload(makeAcademicPdfFixture({blankScore:true}),'blank-cell.pdf');await done();
    const expected=[['Method','Score','Cost'],['Alpha','','4'],['Beta','24','8']];
    const rows=await page.locator('.paper-table-block .stream-orig tr').evaluateAll(rows=>rows.map(r=>[...r.cells].map(c=>c.textContent.trim())));
    assert.deepEqual(rows,expected);
    assert.ok(calls.some(c=>c.items?.some(i=>i.text.includes('| Alpha |  | 4 |'))),'model receives an intact blank cell');
    const html=await exportHtml();
    const exported=await context.newPage();pages.push(exported);await exported.setContent(html);
    assert.deepEqual(await exported.locator('.paper-table-block .stream-orig tr').evaluateAll(rows=>rows.map(r=>[...r.cells].map(c=>c.textContent.trim()))),expected);
    await exported.emulateMedia({media:'print'});assert.equal(await exported.locator('table').first().isVisible(),true);
    check('Real PDF blank cell survives extraction, model input, reading and downloaded HTML/print layout without swallowing a data row');

    for(const maxConcurrency of [1,3]) {
      mode='fail';failCount=0;await save({...settings,batchMaxItems:1,maxConcurrency});
      const offset=calls.length;await upload(makeAcademicPdfFixture(),'failed-batches.pdf');
      await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('翻译失败'));
      const atFailure=calls.length;
      const abortDeadline=Date.now()+5000;
      while(calls.slice(offset+1).some(c=>!c.closed)&&Date.now()<abortDeadline)await page.waitForTimeout(25);
      await page.waitForTimeout(100);
      assert.equal(calls.length,atFailure,'no sibling starts after visible page failure');
      assert.ok(calls.slice(offset+1).every(c=>c.closed),'in-flight sibling HTTP bodies aborted');
      assert.ok(calls.length-offset<6,'not every queued batch reaches API');
      mode='batch';await page.locator('#startTranslateDocBtn').click();await done();
      check(`Page failure cancels queued/active siblings at concurrency ${maxConcurrency}; explicit retry completes through the real PDF entry`);
    }

    mode='formula';await save({...settings,apiProtocol:'gemini',apiBaseUrl:base+'/v1beta'});
    await upload(makePdfFixture(),'bare-formula.pdf');
    await page.waitForFunction(()=>document.querySelector('#progressCounterBadge').textContent==='2 / 2 页');
    assert.equal(await page.locator('.paper-equation-block .math-frac').count(),2);
    assert.equal(await page.locator('.paper-equation-block .math-sqrt').count(),2);
    await exported.setContent(await exportHtml());await exported.emulateMedia({media:'print'});
    assert.equal(await exported.locator('.paper-equation-block .math-frac').count(),2);
    assert.equal(await exported.locator('.math-sqrt-body').first().evaluate(e=>getComputedStyle(e).borderTopWidth),'1px');
    check('Gemini native bare equation renders fractions/radicals in Studio and actual HTML export including print media');

    const jpeg=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=600;c.height=260;const g=c.getContext('2d');g.fillStyle='white';g.fillRect(0,0,600,260);g.fillStyle='black';g.font='28px sans-serif';g.fillText('Raster chart label',60,70);g.fillRect(60,120,100,80);return c.toDataURL('image/jpeg').split(',')[1];});
    const rasterPdf=makeAcademicPdfFixture({rasterJpeg:Buffer.from(jpeg,'base64')});
    for(const protocol of ['openai','gemini']) {
      mode='batch';await save({...settings,apiProtocol:protocol,apiBaseUrl:base+(protocol==='gemini'?'/v1beta':'/v1')});
      const offset=calls.length;await upload(rasterPdf,'rich-text-raster-chart.pdf');await done();
      const batchCalls=calls.slice(offset).filter(c=>!c.vision),visionCalls=calls.slice(offset).filter(c=>c.vision);
      assert.ok(batchCalls.length>0,'rich body uses actual local text extraction');assert.equal(visionCalls.length,1,'one cropped figure OCR');
      assert.equal(visionCalls[0].gemini,protocol==='gemini');
      const figure=page.locator('.paper-figure-box');assert.match(await figure.textContent(),/1 处/);
      const images=await figure.locator('.paper-fig-bg-img').evaluate(e=>[e.src,e.dataset.originalSrc]);assert.notEqual(...images);
      assert.match(await exportHtml(),/图表标签/);
      check(`Real rich-text PDF with embedded JPEG uses ${protocol} cropped-figure OCR and retains translated labels in HTML`);
    }
    mode='figure-fail';await upload(rasterPdf,'unsupported-figure.pdf');await done();
    await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('图中文字尚未完成'));
    assert.match(await page.locator('.paper-figure-box [role="status"]').textContent(),/尚未完成/);
    const original=await page.locator('.paper-fig-bg-img').evaluate(e=>[e.src,e.dataset.originalSrc]);assert.equal(...original);
    assert.match(await exportHtml(),/图中文字尚未完成/);
    const offset=calls.length;mode='batch';await page.locator('[data-retry-figure]').click();
    await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('此图文字处理完成'));
    assert.equal(calls.length-offset,1,'retry only requests the missing figure, not whole page');
    assert.equal(await page.locator('.paper-figure-box [role="status"]').count(),0);
    check('Unsupported raster vision retains body/original, exposes partial status in screen/export and recovers with a single figure retry');

    mode='batch';await save(settings);await context.route('https://*.audit.example/**',route);
    const host=await context.newPage();pages.push(host);host.on('pageerror',e=>errors.push(e.message));await host.goto('https://sub.audit.example/article');await host.locator('.ig-trans-node').waitFor();
    assert.match(await host.locator('[data-domain-rule-label]').textContent(),/继承 audit.example/);
    // Drawer is hover-controlled; exercise its real checkbox change handler.
    await host.locator('.ig-check-domain').evaluate(el=>{el.checked=false;el.dispatchEvent(new Event('change',{bubbles:true}));});
    await host.waitForTimeout(150);
    assert.equal(await sw.evaluate(key=>chrome.storage.local.get(key).then(x=>x[key].alwaysTranslateDomains),key),'');
    await host.reload();await host.locator('.ig-ball-main').waitFor();await host.waitForTimeout(150);assert.equal(await host.locator('.ig-trans-node').count(),0);
    await save(settings);await host.reload();await host.locator('.ig-trans-node').waitFor();
    const popup=await context.newPage();pages.push(popup);popup.on('pageerror',e=>errors.push(e.message));await popup.goto(`chrome-extension://${id}/popup/popup.html`);
    await host.bringToFront();await popup.reload();await popup.waitForFunction(()=>document.querySelector('#currentDomainText').textContent.includes('继承 audit.example'));
    await popup.locator('#autoTranslateDomainCheckbox').uncheck();await host.waitForTimeout(150);
    assert.equal(await sw.evaluate(key=>chrome.storage.local.get(key).then(x=>x[key].alwaysTranslateDomains),key),'');
    await host.goto('https://sibling.audit.example/article');await host.locator('.ig-ball-main').waitFor();await host.waitForTimeout(150);assert.equal(await host.locator('.ig-trans-node').count(),0);
    check('Drawer and popup both expose inherited parent scope, remove the same persistent rule, and keep reloaded/sibling pages off');
    assert.deepEqual(errors,[]);return {checks,errors};
  } finally {
    for(const p of pages)await p.close();
    await context.unroute('https://*.audit.example/**',route);
    server.closeAllConnections();await new Promise(r=>server.close(r));await sw.evaluate(saved=>chrome.storage.local.set(saved),saved);
  }
}
