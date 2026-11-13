// Diagnostic observations only: isolated MV3 extension + real file/UI/HTTP entries.
import fs from 'node:fs/promises';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {makeAcademicPdfFixture} from '../../../tests/academic-pdf-fixture.mjs';
import {makeLongPdfFixture} from '../../../tests/long-pdf-fixture.mjs';
import {readZipArchive} from '../../../studio/epub-engine.js';
import {normalizeFigureLabelsToCrop} from '../../../studio/pdf-engine.js';
const root=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
const out=process.env.AUDIT_OUTPUT || '/tmp/qj125-audit-combinations.json';
const results={errors:[]},calls=[];let mode='empty-selection',releaseHeld,heldSeen;let heldOnce=false;const heldArrival=new Promise(r=>heldSeen=r);
const labels=[{original:'Up',translation:'Arriba',box_2d:[50,50,160,250]},{original:'Go',translation:'Ir',box_2d:[300,50,410,250]},{original:'AI',translation:'IA',box_2d:[550,50,660,250]}];
results.shortLabels={input:labels,spanish:normalizeFigureLabelsToCrop(labels,[0,0,1000,1000]),chinese:normalizeFigureLabelsToCrop(labels.map(x=>({...x,translation:'有效中文'})),[0,0,1000,1000])};
const server=http.createServer(async(req,res)=>{
 const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Content-Type':'application/json'};
 if(req.method==='OPTIONS'){res.writeHead(204,headers);res.end();return;}
 try{const parts=[];for await(const c of req)parts.push(c);const body=JSON.parse(Buffer.concat(parts));const gemini=!!body.contents;
 const content=gemini?body.contents[0].parts:body.messages.at(-1).content;
 const prompt=Array.isArray(content)?content.map(x=>x.text||'').join(''):content;
 let answer;
 if(prompt.includes('Selected Text:'))answer={};
 else if(prompt.includes('Carefully read the attached academic page'))answer=[{page:1,type:'figure',column:'full',original:'Twenty labels',translation:'二十标签图',figureBox2d:[100,100,900,900],figureLabels:Array.from({length:10},(_,i)=>({original:`Label ${i}`,translation:`标签${i}`,box_2d:[150+Math.floor(i/5)*300,120+(i%5)*140,250+Math.floor(i/5)*300,240+(i%5)*140]}))}];
 else if(Array.isArray(content))answer=mode==='short-labels'?{hasText:true,regions:labels,summaryTranslation:'Arriba Ir IA'}:{hasText:false,regions:[],summaryTranslation:''};
 else answer=JSON.parse(prompt.split('Input JSON:\n')[1]).map(x=>({id:x.id,translation:`译文：${x.text}`}));
 calls.push({gemini,prompt,answer,mode});if(mode==='print-race' && prompt.includes('PageSentinel9') && !heldOnce){heldOnce=true;heldSeen();await new Promise(r=>releaseHeld=r);}res.writeHead(200,headers);res.end(JSON.stringify(gemini?{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(answer)}]}}]}:{choices:[{message:{content:JSON.stringify(answer)}}]}));
 }catch(e){results.errors.push(e.message);res.writeHead(500,headers);res.end('{}');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const context=await chromium.launchPersistentContext(await fs.mkdtemp('/tmp/qj125-audit-'),{headless:true,channel:'chromium',...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
try{
 const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=new URL(sw.url()).host;
 const settings={providerId:'custom',apiProtocol:'openai',apiBaseUrl:base+'/v1',apiKey:'fixture',modelId:'audit',targetLang:'zh-CN',enableCache:false,enableSelectionTooltip:true,enableFloatingBall:false,autoTranslateAllPages:false};
 const save=values=>sw.evaluate(v=>chrome.storage.local.set({immersive_gemini_settings_v1:v}),values);
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>results.errors.push(e.message));
 for(const protocol of ['openai','gemini']){
  await save({...settings,apiProtocol:protocol,apiBaseUrl:base+(protocol==='gemini'?'/v1beta':'/v1')});
  await page.route('https://selection.audit.example/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Audit</title><p id="word">The river bank was flooded.</p>'}));
  await page.goto('https://selection.audit.example/test');await page.locator('.ig-sel-trigger').waitFor({state:'attached'});
  const before=await sw.evaluate(()=>chrome.storage.local.get('immersive_gemini_stats_v1'));
  await page.evaluate(()=>{const n=document.querySelector('#word').firstChild,r=document.createRange();r.setStart(n,10);r.setEnd(n,14);getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:80,clientY:80}));});
  await page.locator('.ig-sel-trigger').click();await page.locator('.ig-sel-trans').waitFor();
  results[`selection-${protocol}`]={response:{},card:await page.locator('.ig-sel-card').textContent(),before,after:await sw.evaluate(()=>chrome.storage.local.get('immersive_gemini_stats_v1'))};
 }
 await save(settings);mode='no-text';
 const upload=async(buffer,name)=>{await page.goto(`chrome-extension://${id}/studio/studio.html`);await page.locator('#fileInput').setInputFiles({name,mimeType:'application/pdf',buffer});await page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='ready');};
 const download=async format=>{const done=page.waitForEvent('download');await page.locator('#exportMenuBtn').click();await page.locator(`[data-export="${format}"]`).click();return fs.readFile(await(await done).path(),format==='epub'?undefined:'utf8');};
 await upload(makeAcademicPdfFixture(),'untranslated.pdf');
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=300;c.height=200;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,300,200);x.fillStyle='black';x.fillRect(30,30,100,100);return c.toDataURL().split(',')[1];});
 await page.locator('#figureImageInput').setInputFiles({name:'attached.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('已保留原图'));
 const md=await download('md'),html=await download('html'),epub=await download('epub');
 const zip=await readZipArchive(Uint8Array.from(epub).buffer),epubText=(await Promise.all([...zip].filter(([n])=>n.endsWith('.xhtml')).map(([,v])=>v.getText()))).join('\n');
 results.attachedUntranslatedPdf={progress:await page.locator('#progressCounterBadge').textContent(),md,htmlHasSourceBody:html.includes('This paragraph preserves'),htmlHasMissingPage:html.includes('第 1 / 1 页未翻译'),epubCoverage:epubText.match(/PDF 导出范围[^<]+/g),requests:calls.filter(c=>c.mode==='no-text').length};
 await save({...settings,targetLang:'es'});mode='short-labels';await upload(makeAcademicPdfFixture(),'short-labels.pdf');
 const shortPng=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=300;c.height=200;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,300,200);x.fillStyle='black';x.font='20px sans-serif';['Up','Go','AI'].forEach((t,i)=>x.fillText(t,20,30+i*50));return c.toDataURL().split(',')[1];});
 await page.locator('#figureImageInput').setInputFiles({name:'short.png',mimeType:'image/png',buffer:Buffer.from(shortPng,'base64')});await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('已保留原图'));
 results.shortLabels.uiStatus=await page.locator('#docStatusSubtitle').textContent();results.shortLabels.uiText=await page.locator('#bilingualStreamContainer').textContent();
 await save(settings);mode='normal';await upload(makeLongPdfFixture(17),'window.pdf');await page.locator('#startTranslateDocBtn').click();await page.waitForFunction(()=>document.querySelector('#progressCounterBadge').textContent==='2 / 17 页');
 await page.locator('[data-reading-step="1"]').click();results.windowNext={pageInput:await page.locator('#jumpPageInput').inputValue(),visiblePages:await page.locator('[data-paper-page]').evaluateAll(es=>es.map(e=>e.dataset.paperPage)),pager:await page.locator('[data-reading-status]').textContent()};

 const thinSource=await fs.readFile(root+'/tests/long-pdf-fixture.mjs','utf8');const thinPdf=new Function(thinSource.replace('export function','function').replace('length:14','length:1')+'\nreturn makeLongPdfFixture;')();
 await upload(thinPdf(9),'printing-race.pdf');await page.locator('#startTranslateDocBtn').click();await page.waitForFunction(()=>document.querySelector('#progressCounterBadge').textContent==='2 / 9 页');
 mode='print-race';await page.locator('#jumpPageInput').fill('9');await page.locator('#jumpPageInput').press('Enter');await page.locator('[data-translate-page="9"]').click();await heldArrival;
 await page.evaluate(()=>{window.__auditPrint=null;window.print=()=>window.__auditPrint={pages:[...document.querySelectorAll('.paper-sheet-page:not(.is-print-excluded-page)')].map(e=>e.dataset.paperPage),text:document.querySelector('#bilingualStreamContainer').textContent};});
 await page.locator('#exportMenuBtn').click();await page.locator('[data-export="pdf-bilingual"]').click();await page.locator('input[name="pdfExportScope"][value="translated-only"]').check();
 const confirmedScope=await page.locator('#scopeTranslatedOnlyDescText').textContent();
 await page.locator('#confirmPdfExportBtn').click();await page.waitForFunction(()=>document.title.includes('双语对照排版'));releaseHeld();
 await page.waitForFunction(()=>window.__auditPrint!==null);results.printRace={confirmedScope,...await page.evaluate(()=>window.__auditPrint)};

 const printedPdf=await page.pdf({format:'A4',printBackground:true});await fs.writeFile('/tmp/qj125-audit-print-race.pdf',printedPdf);
 results.printRace.generatedPdf=await page.evaluate(async bytes=>{const {openPdfDocument}=await import('./pdf-engine.js');const {pdfDoc}=await openPdfDocument(new Uint8Array(bytes).buffer);try{const texts=[];for(let n=1;n<=pdfDoc.numPages;n++){const p=await pdfDoc.getPage(n);texts.push((await p.getTextContent()).items.map(i=>i.str).join(' '));p.cleanup();}const text=texts.join(' ');return {pages:pdfDoc.numPages,contains1:text.includes('PageSentinel1 '),contains2:text.includes('PageSentinel2 '),contains9:text.includes('PageSentinel9 ')};}finally{await pdfDoc.destroy();}},[...printedPdf]);
 await page.waitForTimeout(450);
 await save({...settings,apiProtocol:'gemini',apiBaseUrl:base+'/v1beta'});mode='sparse';
 const fixtureSource=await fs.readFile(root+'/tests/academic-pdf-fixture.mjs','utf8');const makeSparse=new Function(fixtureSource.replace('export function','function').replace('(rasterJpeg && !withFormula ? 12 : 5)','0')+'\nreturn makeAcademicPdfFixture;')();
 const jpg=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=600;c.height=260;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,600,260);x.fillStyle='black';x.font='14px sans-serif';for(let i=0;i<20;i++)x.fillText(`Label ${i}`,10+(i%5)*115,30+Math.floor(i/5)*60);return c.toDataURL('image/jpeg').split(',')[1];});
 await upload(makeSparse({rasterJpeg:Buffer.from(jpg,'base64'),withFormula:false}),'sparse.pdf');await page.locator('#startTranslateDocBtn').click();await page.waitForFunction(()=>document.querySelector('#progressCounterBadge').textContent==='1 / 1 页');
 results.nativeSparse={prompt:calls.findLast(c=>c.mode==='sparse')?.prompt,status:await page.locator('#docStatusSubtitle').textContent(),progress:await page.locator('#progressCounterBadge').textContent()};
 results.calls=calls;await fs.writeFile(out,JSON.stringify(results,null,2));console.log(JSON.stringify({...results,calls:undefined},null,2));
}finally{await context.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
