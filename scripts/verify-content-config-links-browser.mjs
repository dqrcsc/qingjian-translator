import assert from 'node:assert/strict';
import http from 'node:http';
export async function verifyContentConfigLinksBrowser(context,sw) {
 const checks=[],errors=[],calls=[],held=[];let hold=false,marker='OLD';
 const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'});res.end();return;}
  if(req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><p id="source">Read the complete source at <a id="link" href="https://example.org/old">source link</a> for further detailed information about the topic.</p><div id="more"></div>');return;}
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));const prompt=body.messages.at(-1).content;calls.push(body);
  const tokens=[...new Set(prompt.match(/\{\{\d+\}\}/g)||[])].join(' ');
  const answer=[...prompt.matchAll(/"id"\s*:\s*(\d+)/g)].map(m=>({id:Number(m[1]),translation:marker+tokens}));
  const reply=()=>{res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(answer)}}]}));};if(hold)held.push(reply);else reply();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const settings={providerId:'custom',apiProtocol:'openai',apiBaseUrl:base+'/v1',apiKey:'fixture',modelId:'fixture',targetLang:'zh-CN',enableCache:false,enableFloatingBall:false,autoTranslateAllPages:false,autoTranslatePageImages:false,neverTranslateDomains:''};
 const store=x=>sw.evaluate(x=>chrome.storage.local.set({immersive_gemini_settings_v1:x}),x);
 const wait=async fn=>{const end=Date.now()+12000;while(!await fn()){if(Date.now()>end)throw Error('content config timeout');await new Promise(r=>setTimeout(r,20));}};
 const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));let youtube;
 try{
 await store(settings);await page.goto(base+'/article');await page.waitForTimeout(250);
 const id=await sw.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,page.url());
 const toggle=()=>sw.evaluate(id=>chrome.tabs.sendMessage(id,{type:'TOGGLE_PAGE_TRANSLATION'}),id);
 await toggle();await page.locator('#source[data-ig-status="done"]').waitFor();
 const count=calls.length;await store({...settings,translationStyle:'translation-only'});await page.waitForTimeout(150);assert.equal(calls.length,count);assert.equal(await page.locator('#source .ig-trans-node').count(),1);
 await page.locator('#link').evaluate(el=>{el.href='https://example.org/new';el.target='_blank';el.title='Updated source';});
 await wait(async()=>await page.locator('#source .ig-trans-node a').getAttribute('href')==='https://example.org/new');
 assert.equal(await page.locator('#source .ig-trans-node a').getAttribute('title'),'Updated source');assert.equal(await page.locator('#source .ig-trans-node a').getAttribute('rel'),'noopener noreferrer');
 await page.locator('#link').evaluate(el=>{const next=document.createElement('a');next.id='link';next.href='https://example.org/replaced';next.textContent='source link';el.replaceWith(next);});
 await wait(async()=>await page.locator('#source .ig-trans-node a').getAttribute('href')==='https://example.org/replaced');
 assert.equal(await page.locator('#link').isVisible(),false);
 await page.locator('#link').evaluate(el=>{el.href='javascript:alert(1)';});await wait(async()=>await page.locator('#source .ig-trans-node a').getAttribute('href')===null);
 await page.locator('#link').evaluate(el=>{el.href='https://example.org/safe';});await wait(async()=>await page.locator('#source .ig-trans-node a').getAttribute('href')==='https://example.org/safe');
 await page.waitForTimeout(200);assert.equal(calls.length,count);checks.push('Real translated links track href/target/title and same-text replacement; unsafe URLs lose click capability without any model request');
 hold=true;await page.locator('#more').evaluate(el=>el.innerHTML='<p id="pending">Pending English paragraph during the target language configuration change.</p>');await wait(()=>held.length===1);
 await store({...settings,targetLang:'ja'});held.shift()();hold=false;await wait(async()=>await page.locator('.ig-trans-node').count()===0);
 await page.waitForTimeout(250);const stopped=calls.length;await page.locator('#more').evaluate(el=>el.insertAdjacentHTML('beforeend','<p>Another English paragraph after config change should remain untranslated.</p>'));await page.waitForTimeout(350);assert.equal(calls.length,stopped);
 marker='NEW';await toggle();await page.locator('#source[data-ig-status="done"]').waitFor();assert.match(await page.locator('#source .ig-trans-node').textContent(),/NEW/);checks.push('Language changes cancel in-flight work, restore original and require explicit restart; new content cannot silently mix configurations');
 await toggle();await wait(async()=>await page.locator('.ig-trans-node').count()===0);
 await page.locator('#source').hover();await page.keyboard.press('Alt');await page.locator('#source[data-ig-status="done"]').waitFor();
 const manualCount=calls.length;await page.locator('#link').evaluate(el=>{el.href='https://example.org/manual';});
 await wait(async()=>await page.locator('#source .ig-trans-node a').getAttribute('href')==='https://example.org/manual');
 await page.locator('#more').evaluate(el=>el.insertAdjacentHTML('beforeend','<p>Manual-only translation must not start translating unrelated paragraphs.</p>'));await page.waitForTimeout(250);assert.equal(calls.length,manualCount);checks.push('Alt-only paragraph links update while whole-page translation remains off and unrelated paragraphs stay untouched');
 youtube=await context.newPage();youtube.on('pageerror',e=>errors.push(e.message));await youtube.route('https://www.youtube.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div class="html5-video-player" id="movie_player"><video></video><div class="ytp-right-controls"></div><div class="ytp-caption-window-container"><span class="ytp-caption-segment">An English scientific sentence.</span></div></div>'}));
 const yt={...settings,youtubeAutoEnable:true,enableYoutubeDualSub:true,tonePreset:'standard'};marker='STANDARD';await store(yt);await youtube.goto('https://www.youtube.com/watch?v=v114-tone');await youtube.waitForFunction(()=>document.querySelector('.ig-yt-line-trans')?.textContent==='STANDARD');
 marker='ACADEMIC';await store({...yt,tonePreset:'academic'});await youtube.waitForFunction(()=>document.querySelector('.ig-yt-line-trans')?.textContent==='ACADEMIC');
 marker='TEMPERATURE';await store({...yt,tonePreset:'academic',temperature:0.5});await youtube.waitForFunction(()=>document.querySelector('.ig-yt-line-trans')?.textContent==='TEMPERATURE');
 const ytCount=calls.length;await store({...yt,tonePreset:'academic',temperature:0.5,youtubeSubFontSize:28});await youtube.waitForTimeout(400);assert.equal(calls.length,ytCount);checks.push('YouTube real live-caption entry invalidates tone and temperature changes, while font-only updates keep translations');
 assert.deepEqual(errors,[]);return {checks,errors};
 }finally{await page.close();await youtube?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
