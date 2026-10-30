import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';

function makeLongPdf(pages = 30) {
 const objects=[];const add=text=>objects.push(Buffer.from(text));
 add('<< /Type /Catalog /Pages 2 0 R >>');
 add(`<< /Type /Pages /Kids [${Array.from({length:pages},(_,i)=>`${4+i*2} 0 R`).join(' ')}] /Count ${pages} >>`);
 add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
 for(let page=1;page<=pages;page++){
   const id=4+(page-1)*2;
   add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id+1} 0 R >>`);
   const text=`BT /F1 16 Tf 24 350 Td (Page ${page} resource regression source text.) Tj ET\n0.2 0.4 0.6 rg 24 100 100 120 re f`;
   add(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
 }
 const parts=[Buffer.from('%PDF-1.7\n')], offsets=[0];let size=parts[0].length;
 objects.forEach((obj,i)=>{offsets.push(size);const part=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),obj,Buffer.from('\nendobj\n')]);parts.push(part);size+=part.length;});
 parts.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
 return Buffer.concat(parts);
}

export async function verifyPdfResourcesBrowser(context, sw) {
 const checks=[],errors=[],calls=[];
 const server=http.createServer(async(req,res)=>{
   if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'});res.end();return;}
   const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString());calls.push(body);
   const prompt=body.messages.at(-1).content;
   const answer=[...prompt.matchAll(/"id"\s*:\s*(\d+)/g)].map(m=>({id:Number(m[1]),translation:`资源回归译文 ${m[1]}`}));
   res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(answer)}}]}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 const check=label=>{checks.push(label);console.log(`  ✓ ${label}`);};
 try {
   await sw.evaluate(url=>chrome.storage.local.set({immersive_gemini_settings_v1:{providerId:'custom',apiProtocol:'openai',apiBaseUrl:url,apiKey:'fixture',modelId:'fixture',enableCache:false}}),`http://127.0.0.1:${server.address().port}/v1`);
   await page.setViewportSize({width:1280,height:900});
   await page.goto(`chrome-extension://${new URL(sw.url()).host}/studio/studio.html`);
   await page.locator('#fileInput').setInputFiles({name:'thirty-pages.pdf',mimeType:'application/pdf',buffer:makeLongPdf()});
   await page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='ready');
   await page.waitForFunction(()=>document.querySelector('[data-left-pdf-page="1"] img')?.complete);
   const original=await page.locator('[data-left-pdf-page="1"] img').getAttribute('src');
   const initialHeight=await page.locator('[data-left-pdf-page="1"]').evaluate(el=>el.getBoundingClientRect().height);
   assert.equal(await page.locator('.left-pdf-page-slot').count(),30);
   for(const n of [5,10,15,20,25,30]) {
     await page.locator('#pdfCanvasScrollViewer').evaluate((viewer,n)=>{
       viewer.style.scrollBehavior='auto';const slot=viewer.querySelector(`[data-left-pdf-page="${n}"]`);
       viewer.scrollTop+=slot.getBoundingClientRect().top-viewer.getBoundingClientRect().top;
     },n);
     await page.waitForFunction(n=>document.querySelector(`[data-left-pdf-page="${n}"] img`)?.complete,n);
     assert.ok(await page.locator('.left-pdf-page-img').count()<=6,'at most six attached preview bitmaps');
   }
   assert.equal(await page.locator('[data-left-pdf-page="1"] img').count(),0);
   assert.ok(Math.abs(await page.locator('[data-left-pdf-page="1"]').evaluate(el=>el.getBoundingClientRect().height)-initialHeight)<1,'offscreen placeholder retains rendered geometry');
   const cdp = await context.newCDPSession(page);
   const prototype = await cdp.send('Runtime.evaluate', { expression: 'Object.prototype', objectGroup: 'pdf-resources' });
   const objects = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: 'pdf-resources' });
   const inspection = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId, returnByValue: true,
     functionDeclaration: `function() { return this.filter(s => s && s.records instanceof Map && Array.isArray(s.queue) && typeof s.active === 'number' && typeof s.disposed === 'boolean').map(s => ({ active: s.active, queued: s.queue.length, records: s.records.size, disposed: s.disposed, canvases: [...s.records.values()].filter(e => e.result?.canvas).length })); }` });
   await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'pdf-resources' });
   await cdp.detach();
   const live = inspection.result.value.filter(s => !s.disposed);
   assert.equal(live.length, 1, 'one active PDF render owner');
   assert.ok(live[0].records <= 8 && live[0].canvases <= 8 && live[0].active <= 2 && live[0].queued <= 6);
   assert.equal(calls.length,0,'preview scrolling must not translate');
   check('30-page PDF real input/scroll: previews <= 6, retained renders <= 8, active renders <= 2; offscreen bitmap removed with geometry intact');
   await page.locator('#jumpPageInput').fill('1');await page.locator('#jumpPageInput').dispatchEvent('change');
   await page.waitForFunction(()=>document.querySelector('[data-left-pdf-page="1"] img')?.complete);
   assert.equal(await page.locator('[data-left-pdf-page="1"] img').getAttribute('src'),original);
   assert.equal(calls.length,0);
   check('Actual PDF jump control restores evicted page pixels from original PDF without model requests');
   await page.locator('#translateSinglePageBtn').click();
   await page.waitForFunction(()=>document.querySelector('#bilingualStreamContainer')?.textContent.includes('资源回归译文'));
   for(const n of [15,30]){await page.locator('#jumpPageInput').fill(String(n));await page.locator('#jumpPageInput').dispatchEvent('change');await page.waitForFunction(n=>document.querySelector(`[data-left-pdf-page="${n}"] img`)?.complete,n);}
   const downloadPromise=page.waitForEvent('download');await page.locator('#exportMenuBtn').click();await page.locator('[data-export="html"]').click();
   const download=await downloadPromise;const exported=await fs.readFile(await download.path(),'utf8');
   assert.match(exported,/资源回归译文/);assert.match(exported,/Page 1 resource regression source text/);
   check('Evicting a translated PDF preview preserves completed source/translation in actual HTML export');
   await page.locator('#fileInput').setInputFiles({name:'replacement.md',mimeType:'text/markdown',buffer:Buffer.from('Replacement document resource check.')});
   await page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='ready'&&document.querySelector('#leftPaneTitle').textContent.includes('replacement'));
   assert.equal(await page.locator('.left-pdf-page-img').count(),0);
   assert.equal(await page.locator('#pdfNativeEmbed').getAttribute('src'),null);
   await page.waitForTimeout(200);assert.equal(await page.locator('.left-pdf-page-img').count(),0);
   check('Replacing the long PDF releases old preview DOM and native source; late callbacks do not resurrect it');
   assert.deepEqual(errors,[]);return{checks,errors};
 }finally{await page.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
