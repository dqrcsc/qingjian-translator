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
const server=http.createServer(async(req,res)=>{const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'};if(req.method==='OPTIONS'){res.writeHead(204,cors);res.end();return;}try{let chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));const content=body.messages.at(-1).content;const vision=Array.isArray(content);const prompt=vision?content.map(x=>x.text||'').join(''):content;let answer;if(prompt.includes('Selected Text:')) { calls.push({prompt});res.writeHead(400,cors);res.end('{"error":{"message":"audit captured prompt"}}');return;}if(vision){answer={hasText:true,regions:Array.from({length:many?20:1},(_,i)=>({original:`Raster label ${i}`,translation:`图中文字${i}`,box_2d:[50+Math.floor(i/5)*220,20+(i%5)*190,150+Math.floor(i/5)*220,180+(i%5)*190]}))};}else{const items=JSON.parse(prompt.split('Input JSON:\n')[1]);answer=items.map(x=>({id:x.id,translation:`译文：${x.text}`}));}calls.push({vision,answer});res.writeHead(200,{...cors,'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(answer)}}]}));}catch(e){res.writeHead(400,cors);res.end(JSON.stringify({error:e.message}));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const context=await chromium.launchPersistentContext(await fs.mkdtemp('/tmp/qj124-extra-'),{headless:true,channel:'chromium',...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
const results={};
try{
const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(sw.url()).host;
await sw.evaluate(url=>chrome.storage.local.set({immersive_gemini_settings_v1:{providerId:'custom',apiProtocol:'openai',apiBaseUrl:url,apiKey:'fixture',modelId:'fixture',targetLang:'zh-CN',enableCache:false,enableYoutubeDualSub:true,youtubeAutoEnable:false,youtubeShowSidebar:true,enableFloatingBall:false,autoTranslateAllPages:false,enableSelectionTooltip:true}}),`http://127.0.0.1:${server.address().port}/v1`);
const page=await context.newPage();page.setDefaultTimeout(15000);
const prose='This introductory discussion covers a different topic. '.repeat(30)+'The river bank was flooded after the storm.';
await page.route('https://audit.example/**',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><p id="para">${prose}</p>`}));
await page.goto('https://audit.example/selection');await page.waitForTimeout(700);
await page.evaluate(()=>{const node=document.querySelector('#para').firstChild;const start=node.textContent.lastIndexOf('bank');const range=document.createRange();range.setStart(node,start);range.setEnd(node,start+4);getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:100,clientY:100}));});
await page.locator('.ig-sel-trigger').waitFor();await page.locator('.ig-sel-trigger').dispatchEvent('mousedown');
await page.waitForTimeout(500);
results.selection={sourceLength:prose.length,selectionPosition:prose.indexOf('bank'),requests:calls};
const yt=await context.newPage();await yt.route('https://www.youtube.com/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Audit long track</title><div id="movie_player" class="html5-video-player"><video></video><div class="ytp-right-controls"></div></div>'}));await yt.goto('https://www.youtube.com/watch?v=audit-long');await yt.locator('.ig-yt-timeline-panel').waitFor();await yt.evaluate(()=>window.postMessage({source:'IG_YT_MAIN_BRIDGE',type:'YT_CUES_LOADED',payload:{videoId:'audit-long',cues:Array.from({length:20001},(_,id)=>({id,start:id*2,end:id*2+1.9,text:`Unique audit caption ${id}.`}))}},'*'));await yt.waitForTimeout(500);
const download=yt.waitForEvent('download');await yt.locator('[data-act="export-srt"]').click();await yt.locator('[data-export-fmt="srt"]').click();const file=await download;const text=await fs.readFile(await file.path(),'utf8');results.trackExport={fileName:file.suggestedFilename(),cueCount:(text.match(/ --> /g)||[]).length,hasLast:text.includes('Unique audit caption 20000.')};
console.log(JSON.stringify(results,null,2));await fs.writeFile('/tmp/qj124-audit-followup.json',JSON.stringify(results,null,2));
}finally{await context.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
