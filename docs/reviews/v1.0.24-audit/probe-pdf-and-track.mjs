// Diagnostic probe for v1.0.24; reports observations, not a passing regression test.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';
import {makeAcademicPdfFixture} from '../../../tests/academic-pdf-fixture.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
const fixtureSource=await fs.readFile(root+'/tests/academic-pdf-fixture.mjs','utf8');
const mixedFixture=new Function(fixtureSource.replace('export function','function').replace('if (!rasterJpeg) {','if (true) {').replace('(rasterJpeg ? 12 : 5)','5').replace('(rasterJpeg ? 10 : 16)','16')+'\nreturn makeAcademicPdfFixture;')();
let calls=[],many=false;
const server=http.createServer(async(req,res)=>{const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'};if(req.method==='OPTIONS'){res.writeHead(204,cors);res.end();return;}try{let chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));const content=body.messages.at(-1).content;const vision=Array.isArray(content);const prompt=vision?content.map(x=>x.text||'').join(''):content;let answer;if(vision){answer={hasText:true,regions:Array.from({length:many?20:1},(_,i)=>({original:`Raster label ${i}`,translation:`图中文字${i}`,box_2d:[50+Math.floor(i/5)*220,20+(i%5)*190,150+Math.floor(i/5)*220,180+(i%5)*190]}))};}else{const items=JSON.parse(prompt.split('Input JSON:\n')[1]);answer=items.map(x=>({id:x.id,translation:`译文：${x.text}`}));}calls.push({vision,answer});res.writeHead(200,{...cors,'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(answer)}}]}));}catch(e){res.writeHead(400,cors);res.end(JSON.stringify({error:e.message}));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const context=await chromium.launchPersistentContext(await fs.mkdtemp('/tmp/qj124-extra-'),{headless:true,channel:'chromium',...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
const results={};
try{
const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(sw.url()).host;
await sw.evaluate(url=>chrome.storage.local.set({immersive_gemini_settings_v1:{providerId:'custom',apiProtocol:'openai',apiBaseUrl:url,apiKey:'fixture',modelId:'fixture',targetLang:'zh-CN',enableCache:false,enableYoutubeDualSub:true,youtubeAutoEnable:false,youtubeShowSidebar:true,enableFloatingBall:false,autoTranslateAllPages:false}}),`http://127.0.0.1:${server.address().port}/v1`);
const page=await context.newPage();page.setDefaultTimeout(15000);
const upload=async(buffer,name)=>{await page.goto(`chrome-extension://${id}/studio/studio.html`);await page.locator('#fileInput').setInputFiles({name,mimeType:'application/pdf',buffer});await page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='ready');};
const download=async format=>{const event=page.waitForEvent('download');await page.locator('#exportMenuBtn').click();await page.locator(`[data-export="${format}"]`).click();return fs.readFile(await(await event).path(),'utf8');};
const done=()=>page.waitForFunction(()=>document.querySelector('#progressCounterBadge').textContent.startsWith('1 / 1 页'));
await upload(makeAcademicPdfFixture(),'not-yet-translated.pdf');
results.untranslatedMd={text:await download('md'),status:await page.locator('#docStatusSubtitle').textContent()};
const jpeg=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=600;c.height=260;const g=c.getContext('2d');g.fillStyle='white';g.fillRect(0,0,600,260);g.fillStyle='black';g.font='14px sans-serif';for(let i=0;i<20;i++)g.fillText('Raster label '+i,10+(i%5)*116,30+Math.floor(i/5)*60);return c.toDataURL('image/jpeg').split(',')[1];});
const rasterJpeg=Buffer.from(jpeg,'base64');
many=true;await upload(makeAcademicPdfFixture({rasterJpeg}),'20-labels.pdf');await page.locator('#startTranslateDocBtn').click();await done();
const html=await download('html');
results.labelCap={visionReplies:calls.filter(c=>c.vision).map(c=>c.answer.regions.length),figureText:await page.locator('.paper-figure-box').textContent(),hasFinalLabel:html.includes('图中文字19'),hasSixteenth:html.includes('图中文字15'),status:await page.locator('#docStatusSubtitle').textContent()};
await page.screenshot({path:'/tmp/qj124-label-cap.png',fullPage:true});
const exported=await context.newPage();await exported.setContent(html);const before=await exported.locator('.stream-orig').first().isVisible();await exported.locator('label[for="exportModeToggle"]').click();const hidden=await exported.locator('.stream-orig').first().isVisible();await exported.locator('label[for="exportModeToggle"]').click();results.htmlToggle={before,hidden,after:await exported.locator('.stream-orig').first().isVisible()};
calls=[];many=false;const mixed=mixedFixture({rasterJpeg});await fs.writeFile('/tmp/qj124-formula-and-raster.pdf',mixed);await upload(mixed,'formula-and-raster.pdf');
results.mixedExtraction=await page.evaluate(async bytes=>{const {openPdfDocument,renderPdfPageToCanvas,extractStructuredPdfPageBlocks,extractFigureVectorTextGroups}=await import('./pdf-engine.js');const doc=await openPdfDocument(new Uint8Array(bytes).buffer);const r=await renderPdfPageToCanvas(doc.pdfDoc,1,2);const blocks=extractStructuredPdfPageBlocks(r,1);const data=blocks.map(b=>({type:b.type,original:b.original,figureBox2d:b.figureBox2d,vectorLabels:b.type==='figure'?extractFigureVectorTextGroups(r.textItems,r.width,r.height,b.figureBox2d):undefined}));r.canvas.width=0;r.canvas.height=0;await doc.pdfDoc.destroy();return data;},[...mixed]);
await page.locator('#startTranslateDocBtn').click();await done();results.mixedScreen={equations:await page.locator('.paper-equation-block').count(),visionCalls:calls.filter(c=>c.vision).length,figureText:await page.locator('.paper-figure-box').textContent(),status:await page.locator('#docStatusSubtitle').textContent()};await page.screenshot({path:'/tmp/qj124-formula-raster.png',fullPage:true});
const yt=await context.newPage();await yt.route('https://www.youtube.com/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Audit long track</title><div id="movie_player" class="html5-video-player"><video></video><div class="ytp-right-controls"></div></div>'}));await yt.goto('https://www.youtube.com/watch?v=audit-long');await yt.locator('.ig-yt-timeline-panel').waitFor();await yt.evaluate(()=>window.postMessage({source:'IG_YT_MAIN_BRIDGE',type:'YT_CUES_LOADED',payload:{videoId:'audit-long',cues:Array.from({length:20001},(_,id)=>({id,start:id*2,end:id*2+1.9,text:`Unique audit caption ${id}.`}))}},'*'));
await yt.waitForTimeout(500);await yt.locator('[data-yt-search]').fill('Unique audit caption 20000.');await yt.waitForTimeout(150);results.trackCap={lastRows:await yt.locator('.ig-yt-cue-item').count(),panelText:await yt.locator('.ig-yt-timeline-panel').textContent()};
console.log(JSON.stringify(results,null,2));await fs.writeFile('/tmp/qj124-audit-extra.json',JSON.stringify(results,null,2));
}finally{await context.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
