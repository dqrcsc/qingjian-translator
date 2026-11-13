import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { readZipArchive } from '../studio/epub-engine.js';
import { makeAcademicPdfFixture } from '../tests/academic-pdf-fixture.mjs';
import { makeLongPdfFixture } from '../tests/long-pdf-fixture.mjs';

export async function verifyV125Browser(context, sw) {
  const checks=[],errors=[],pages=[],calls=[],measurements=[];
  const key='immersive_gemini_settings_v1',saved=await sw.evaluate(k=>chrome.storage.local.get(k),key);
  let mode='normal';
  const server=http.createServer(async(req,res)=>{
    const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Content-Type':'application/json'};
    if(req.method==='OPTIONS'){res.writeHead(204,headers);res.end();return;}
    try{
      const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));
      const gemini=!!body.contents, content=gemini?body.contents[0].parts:body.messages.at(-1).content;
      const vision=Array.isArray(content)&&content.some(p=>p.inlineData||p.type==='image_url');
      const prompt=Array.isArray(content)?content.map(p=>p.text||'').join(''):content;
      calls.push({vision,gemini,prompt,mode});
      res.writeHead(200,headers);
      if(mode==='oversized'){res.end(' '.repeat(8*1024*1024+1));return;}
      const answer=vision?{hasText:true,regions:Array.from({length:20},(_,i)=>({original:`Raster label ${i}`,translation:`图中文字${i}`,box_2d:[20+Math.floor(i/5)*220,10+(i%5)*190,170+Math.floor(i/5)*220,180+(i%5)*190]}))}:
        prompt.includes('Selected Text:')?{translation:'河岸',contextualMeaning:'河流岸边',breakdown:[],example:'the river bank 河岸'}:
        JSON.parse(prompt.split('Input JSON:\n')[1]).map(x=>({id:x.id,translation:`译文：${x.text}`}));
      res.end(JSON.stringify(gemini?{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(answer)}]}}]}:{choices:[{message:{content:JSON.stringify(answer)}}]}));
    }catch(e){errors.push(e.message);res.end('{}');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`,id=new URL(sw.url()).host;
  const settings={providerId:'custom',apiProtocol:'openai',apiBaseUrl:base+'/v1',apiKey:'fixture',modelId:'fixture',targetLang:'zh-CN',enableCache:false,enableSelectionTooltip:true,enableYoutubeDualSub:true,youtubeAutoEnable:false,youtubeShowSidebar:true,enableFloatingBall:false,autoTranslateAllPages:false};
  const save=values=>sw.evaluate(({key,values})=>chrome.storage.local.set({[key]:values}),{key,values});
  const check=label=>{checks.push(label);console.log(`  ✓ ${label}`);};
  const newPage=async()=>{const p=await context.newPage();pages.push(p);p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));return p;};
  const page=await newPage();
  const upload=async(buffer,name='fixture.pdf')=>{await page.goto(`chrome-extension://${id}/studio/studio.html`);await page.locator('#fileInput').setInputFiles({name,mimeType:'application/pdf',buffer});await page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='ready');};
  const download=async format=>{const event=page.waitForEvent('download');await page.locator('#exportMenuBtn').click();await page.locator(`[data-export="${format}"]`).click();return fs.readFile(await(await event).path(),format==='epub'?undefined:'utf8');};
  try{
    await save(settings);await upload(makeAcademicPdfFixture());let downloads=0;page.on('download',()=>downloads++);
    for(const format of ['md','epub']) {await page.locator('#exportMenuBtn').click();await page.locator(`[data-export="${format}"]`).click();await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('尚无可导出'));}
    assert.equal(downloads,0);assert.equal(calls.length,0);
    check('Unprocessed real PDF refuses empty MD/EPUB downloads with visible guidance and no model request');
    const jpeg=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=600;c.height=260;const g=c.getContext('2d');g.fillStyle='white';g.fillRect(0,0,600,260);g.fillStyle='black';g.font='13px sans-serif';for(let i=0;i<20;i++)g.fillText(`Raster label ${i}`,10+(i%5)*116,30+Math.floor(i/5)*60);return c.toDataURL('image/jpeg').split(',')[1];});
    for(const protocol of ['openai','gemini']) {
      await save({...settings,apiProtocol:protocol,apiBaseUrl:base+(protocol==='gemini'?'/v1beta':'/v1')});const offset=calls.length;
      await upload(makeAcademicPdfFixture({rasterJpeg:Buffer.from(jpeg,'base64'),withFormula:true}),'formula-and-image.pdf');await page.locator('#startTranslateDocBtn').click();
      await page.waitForFunction(()=>document.querySelector('#progressCounterBadge').textContent==='1 / 1 页');
      assert.equal(await page.locator('.paper-equation-block').count(),1);
      assert.equal(await page.locator('.paper-equation-block .math-frac').count(),1);
      assert.equal(calls.slice(offset).filter(c=>c.vision).length,1);
      assert.match(await page.locator('.paper-figure-box').textContent(),/20 处/);
      const html=await download('html');assert.match(html,/图中文字19/);
      const exported=await newPage();await exported.setContent(html);await exported.emulateMedia({media:'print'});
      assert.equal(await exported.locator('.paper-equation-block .math-frac').count(),1);assert.match(await exported.locator('.paper-figure-box').textContent(),/20 处/);
      check(`${protocol} actual mixed PDF preserves numbered fraction, OCRs the separate raster, and retains all 20 labels in downloaded HTML/print`);
      mode='oversized';const before=calls.length;
      await page.goto(`chrome-extension://${id}/studio/studio.html`);await page.locator('#fileInput').setInputFiles({name:'budget.md',mimeType:'text/markdown',buffer:Buffer.from('Response byte budget regression source.')});await page.locator('#startTranslateDocBtn').click();
      await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('字节预算'));
      assert.equal(calls.length,before+1);mode='normal';await page.locator('#startTranslateDocBtn').click();await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('文档双语翻译已完成'));
      check(`${protocol} real document request rejects oversized body without retry and explicit retry recovers`);
    }
    await save(settings);
    for(const count of [50,200,500]){
      const started=Date.now();await upload(makeLongPdfFixture(count),`long-${count}.pdf`);
      await page.locator('#startTranslateDocBtn').click();await page.waitForFunction(count=>document.querySelector('#progressCounterBadge').textContent===`2 / ${count} 页`,count);
      const mounted=await page.locator('#bilingualStreamContainer [data-paper-page]').count();assert.equal(mounted,8);
      await page.locator('#jumpPageInput').fill(String(count));await page.locator('#jumpPageInput').press('Enter');
      await page.locator(`[data-paper-page="${count}"]`).waitFor();assert.ok(await page.locator('#bilingualStreamContainer [data-paper-page]').count()<=8);
      measurements.push({pages:count,mounted,loadAndJumpMs:Date.now()-started});
    }
    check('Actual 50/200/500-page PDF uploads and distant page jumps keep right-side reading DOM at at most 8 pages');
    await upload(makeLongPdfFixture(9));await page.locator('#startTranslateDocBtn').click();await page.waitForFunction(()=>document.querySelector('#progressCounterBadge').textContent==='2 / 9 页');
    await page.locator('#jumpPageInput').fill('9');await page.locator('#jumpPageInput').press('Enter');
    await page.locator('[data-translate-page="9"]').click();await page.waitForFunction(()=>document.querySelector('[data-paper-page="9"] .stream-trans')?.textContent.includes('PageSentinel9'));
    await page.locator('#streamSearchInput').fill('PageSentinel1 ');await page.waitForFunction(()=>document.querySelector('.stream-trans')?.textContent.includes('PageSentinel1'));
    const offset=calls.length,md=await download('md');assert.match(md,/PageSentinel1/);assert.match(md,/PageSentinel9/);assert.match(md,/未处理或失败页：3, 4, 5, 6, 7, 8/);
    const html=await download('html');assert.match(html,/PageSentinel9/);assert.match(html,/第 8 \/ 9 页未翻译/);assert.equal(calls.length,offset);
    const epub=await download('epub'),entries=await readZipArchive(Uint8Array.from(epub).buffer);
    const epubHtml=(await Promise.all([...entries].filter(([name])=>name.endsWith('.xhtml')).map(([,entry])=>entry.getText()))).join(' ');
    assert.match(epubHtml,/PageSentinel9/);assert.match(epubHtml,/未处理或失败页：3, 4, 5, 6, 7, 8/);assert.equal(calls.length,offset);
    await page.locator('#streamSearchInput').fill('PageSentinel9');await page.waitForFunction(()=>document.querySelector('.stream-trans')?.textContent.includes('PageSentinel9'));
    await page.locator('#layoutStyleSelect').selectOption('card-stream');
    assert.match(await page.locator('#bilingualStreamContainer').textContent(), /PageSentinel9/);
    check('Off-window PDF text remains searchable; actual partial MD/HTML/EPUB downloads include distant translated pages and explicit missing-page coverage without requests');
    await page.evaluate(()=>{window.__v125Print=null;window.print=()=>{window.__v125Print={pages:document.querySelectorAll('#documentPrintSnapshot .paper-sheet-page').length,text:document.querySelector('#documentPrintSnapshot').textContent};};});
    await page.locator('#exportMenuBtn').click();await page.locator('[data-export="pdf-bilingual"]').click();
    await page.locator('input[name="pdfExportScope"][value="all"]').check();await page.locator('#confirmPdfExportBtn').click();
    await page.waitForFunction(()=>window.__v125Print?.pages===9);
    const printed=await page.evaluate(()=>window.__v125Print.text);for(let n=1;n<=9;n++)assert.ok(printed.includes(`PageSentinel${n}`));
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    assert.equal(await page.locator('#documentPrintSnapshot').count(), 0);
    await page.waitForFunction(()=>document.querySelector('#streamSearchInput').value==='PageSentinel9'&&document.querySelectorAll('#bilingualStreamContainer .paper-sheet-page').length===0);
    assert.match(await page.locator('#bilingualStreamContainer').textContent(),/PageSentinel9/);
    check('Actual PDF export confirmation completes all 9 pages beyond the reading window, reaches print with every page, and restores filtered card reading');
    const web=await newPage();const prose='The bank handles money. '.repeat(60)+'The river bank was flooded after the storm.';
    await web.route('https://selection.audit.example/**',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><p id="para">${prose}</p>`}));await web.goto('https://selection.audit.example/article');await web.locator('.ig-sel-trigger').waitFor({state:'attached'});
    await web.evaluate(()=>{const n=document.querySelector('#para').firstChild,p=n.textContent.lastIndexOf('bank'),r=document.createRange();r.setStart(n,p);r.setEnd(n,p+4);getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:100,clientY:100}));});
    await web.locator('.ig-sel-trigger').click();await web.locator('.ig-sel-card').getByText('河岸',{exact:true}).first().waitFor();
    const selection=calls.findLast(c=>c.prompt.includes('Selected Text:'));assert.ok(selection.prompt.includes('The river bank was flooded'));const surrounding=selection.prompt.split('Surrounding Context Paragraph: """')[1].split('"""')[0];assert.ok(surrounding.length<=600);
    check('Actual selection at the end of a long paragraph with repeated bank uses its own surrounding sentence in the HTTP prompt');
    const yt=await newPage();await yt.route('https://www.youtube.com/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Long complete track</title><div id="movie_player" class="html5-video-player"><video></video><div class="ytp-right-controls"></div></div>'}));await yt.goto('https://www.youtube.com/watch?v=v125-track');await yt.locator('.ig-yt-timeline-panel').waitFor();
    for(const count of [19999,20000,20001]) {
      await yt.evaluate(count=>window.postMessage({source:'IG_YT_MAIN_BRIDGE',type:'YT_CUES_LOADED',payload:{videoId:'v125-track',cues:Array.from({length:count},(_,id)=>({id,start:id*2,end:id*2+1.9,text:`Unique caption ${id}.`}))}},'*'),count);
      await yt.locator('[data-yt-search]').fill(`Unique caption ${count-1}.`);await yt.waitForFunction(()=>document.querySelectorAll('.ig-yt-cue-item').length===1);
      assert.match(await yt.locator('.ig-yt-cue-item').textContent(),new RegExp(`Unique caption ${count-1}\\.`));
    }
    const event=yt.waitForEvent('download');await yt.locator('[data-act="export-srt"]').click();await yt.locator('[data-export-fmt="srt"]').click();const text=await fs.readFile(await(await event).path(),'utf8');assert.equal((text.match(/ --> /g)||[]).length,20001);assert.match(text,/Unique caption 20000\./);assert.ok(await yt.locator('.ig-yt-cue-item').count()<=40);
    check('19,999/20,000/20,001 track boundary preserves last-cue search and actual complete SRT download while DOM stays virtualized');
    console.log(`  PDF window measurements: ${JSON.stringify(measurements)}`);
    assert.deepEqual(errors,[]);return {checks,errors,measurements};
  }catch(error){console.log('v125 failure state:',JSON.stringify({status:await page.locator('#docStatusSubtitle').textContent(),body:(await page.locator('#bilingualStreamContainer').textContent()).slice(0,3000),errors,calls:calls.slice(-2)}));throw error;}finally{for(const p of pages)await p.close();server.closeAllConnections();await new Promise(r=>server.close(r));await sw.evaluate(saved=>chrome.storage.local.set(saved),saved);}
}
