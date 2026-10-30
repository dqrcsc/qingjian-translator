import assert from 'node:assert/strict';
import http from 'node:http';
import { makePdfFixture } from '../tests/pdf-fixture.mjs';
import { makeEpubIntegrityFixture } from '../tests/epub-integrity-fixture.mjs';

export async function verifyDocumentBudgetBrowser(context, sw) {
  const checks=[],errors=[],pages=[],requests=[],timers=[];
  const pdf=makePdfFixture();
  const server=http.createServer((req,res)=>{
    const record={path:req.url,closed:false};requests.push(record);
    res.on('close',()=>{record.closed=!res.writableEnded;});
    const headers={'Content-Type':'application/pdf','Access-Control-Allow-Origin':'*'};
    if(req.url==='/oversize.pdf'){res.writeHead(200,{...headers,'Content-Length':100*1024*1024+1});res.write('%PDF-1.7\n');return;}
    if(req.url==='/slow.pdf'||req.url==='/replace.pdf'){res.writeHead(200,headers);res.write('%PDF-1.7\n');return;}
    if(req.url==='/staged.pdf'){
      timers.push(setTimeout(()=>{if(res.destroyed)return;res.writeHead(200,headers);res.write(pdf.subarray(0,8));
        timers.push(setTimeout(()=>{if(!res.destroyed)res.end(pdf.subarray(8));},230));},230));return;
    }
    if(req.url==='/invalid.pdf'){res.writeHead(200,headers);res.end('not a PDF');return;}
    res.writeHead(200,headers);res.end(pdf);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const extensionId=new URL(sw.url()).host;
  const wait=async(predicate,label)=>{const end=Date.now()+10000;while(!await predicate()){if(Date.now()>end)throw Error(`Document budget: ${label}`);await new Promise(r=>setTimeout(r,20));}};
  const newPage=async(fast=false)=>{
    const page=await context.newPage();pages.push(page);page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
    if(fast)await page.addInitScript(()=>{const native=setTimeout;globalThis.setTimeout=(fn,ms,...args)=>native(fn,ms===90000?350:ms,...args);});
    await page.goto(`chrome-extension://${extensionId}/studio/studio.html`);return page;
  };
  const open=async(page,path)=>{await page.locator('#onlinePdfUrlInput').fill(base+path);await page.locator('#loadOnlinePdfBtn').click();};
  const check=label=>{checks.push(label);console.log(`  ✓ ${label}`);};
  try{
    for(const path of ['/slow.pdf','/staged.pdf']){
      const page=await newPage(true);await open(page,path);
      await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('总时间预算'));
      await wait(()=>requests.find(r=>r.path===path)?.closed,'deadline cancels network body');
      assert.equal(await page.locator('#exportMenuBtn').isDisabled(),true);
      assert.equal(await page.locator('#startTranslateDocBtn').isDisabled(),true);
      assert.equal(await page.locator('#pdfNativeEmbed').getAttribute('src'),null);
      await page.close();
    }
    check('Actual online PDF entry shares one deadline across headers/body, aborts stalled body and never restarts through native embed');
    const page=await newPage();await open(page,'/oversize.pdf');
    await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('大小超过上限'));
    await wait(()=>requests.find(r=>r.path==='/oversize.pdf')?.closed,'oversize header closes HTTP');
    assert.equal(await page.locator('#pdfNativeEmbed').getAttribute('src'),null);
    check('Declared over-limit PDF is rejected at actual UI entry with HTTP closed and no uncontrolled embed fallback');
    await open(page,'/replace.pdf');await wait(()=>requests.some(r=>r.path==='/replace.pdf'),'pending source');
    await page.locator('#fileInput').setInputFiles({name:'replacement.md',mimeType:'text/plain',buffer:Buffer.from('Replacement source remains readable.')});
    await page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='ready');
    await wait(()=>requests.find(r=>r.path==='/replace.pdf')?.closed,'replacement cancels old download');
    assert.match(await page.locator('#sourceOutlineViewer').textContent(),/Replacement source/);
    check('Replacing a stalled online import cancels HTTP immediately and leaves the new local document ready');
    await open(page,'/invalid.pdf');
    await page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='error');
    assert.equal(await page.locator('#pdfNativeEmbed').getAttribute('src'),null);
    assert.equal(requests.filter(r=>r.path==='/invalid.pdf').length,1);
    check('Invalid PDF cannot bypass the input budget via a second native download');
    const epub=makeEpubIntegrityFixture();
    const central=epub.readUInt32LE(epub.length-22+16);
    epub.writeUInt32LE(32*1024*1024+1,central+24);
    await page.locator('#fileInput').setInputFiles({name:'over-budget.epub',mimeType:'application/epub+zip',buffer:epub});
    await page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='error');
    assert.match(await page.locator('#docStatusSubtitle').textContent(),/上限|大小|ZIP/);
    assert.equal(await page.locator('#startTranslateDocBtn').isDisabled(),true);
    await page.locator('#fileInput').setInputFiles({name:'valid.epub',mimeType:'application/epub+zip',buffer:makeEpubIntegrityFixture()});
    await page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='ready');
    assert.match(await page.locator('#sourceOutlineViewer').textContent(),/Integrity chapter/);
    check('Oversized EPUB metadata fails at real file input; a later normal archive imports with a fresh budget');
    const closedPage=await newPage();await open(closedPage,'/replace.pdf');
    await wait(()=>requests.filter(r=>r.path==='/replace.pdf').length===2,'page-close download');
    await closedPage.close();await wait(()=>requests.filter(r=>r.path==='/replace.pdf')[1].closed,'page close abort');
    check('Closing Studio cancels the actual pending document download');
    assert.deepEqual(errors,[]);return{checks,errors};
  }finally{for(const timer of timers)clearTimeout(timer);for(const page of pages)if(!page.isClosed())await page.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
