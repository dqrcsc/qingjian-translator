import assert from 'node:assert/strict';
import http from 'node:http';

// Uses manifest-injected scripts and real keyboard/input, storage, HTTP and DOM.
export async function verifyContentEditingBrowser(context, sw) {
  const checks=[],errors=[],calls=[],held=[];
  let hold=false;
  const check=label=>{checks.push(label);console.log(`  ✓ ${label}`);};
  const server=http.createServer(async(req,res)=>{
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'});res.end();return;}
    if(req.method==='GET'){
      res.writeHead(200,{'Content-Type':'text/html'});
      res.end('<!doctype html><title>Editing regression</title><style>p{font:18px/30px sans-serif}textarea,input,[contenteditable]{display:block;width:500px;min-height:40px}</style><textarea id="textarea"></textarea><input id="input"><div id="rich" contenteditable="true"></div><button id="other">Other focus target</button><div id="outside">Outside must remain intact</div><p id="source">Original English paragraph with an unchanged and complete meaning.</p>');return;
    }
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());
    const prompt=body.messages.at(-1).content;
    const input=body.messages.some(m=>typeof m.content==='string'&&m.content.includes('real-time input box translator'));
    const call={input,prompt,res};calls.push(call);
    const answer=input?'Translated draft':JSON.stringify([...prompt.matchAll(/"id"\s*:\s*(\d+)/g)].map(m=>({id:Number(m[1]),translation:`译文版本 ${calls.length}`})));
    const reply=()=>{res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify({choices:[{message:{content:answer}}]}));};
    if(hold)held.push(reply);else reply();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const settings={providerId:'custom',apiProtocol:'openai',apiBaseUrl:`${base}/v1`,apiKey:'fixture-only',modelId:'fixture-editing',targetLang:'zh-CN',inputTargetLang:'en',enableCache:false,enableTripleSpaceInput:true,enableFloatingBall:false,autoTranslateAllPages:false,autoTranslatePageImages:false,enableImageTranslate:false,neverTranslateDomains:''};
  const store=x=>sw.evaluate(x=>chrome.storage.local.set({immersive_gemini_settings_v1:x}),x);
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
  const wait=async(predicate,label)=>{const until=Date.now()+12000;while(!await predicate()){if(Date.now()>until)throw Error(`Editing timeout: ${label}`);await new Promise(r=>setTimeout(r,20));}};
  const trigger=async(selector)=>{const before=calls.length;await page.locator(selector).press('Space');await page.locator(selector).press('Space');await page.locator(selector).press('Space');await wait(()=>calls.length>before,'input request');};
  const read=selector=>page.locator(selector).evaluate(el=>'value'in el?el.value:el.textContent);
  try{
    await store(settings);await page.goto(`${base}/fixture`);
    const cdp=await context.newCDPSession(page);const worlds=[];
    cdp.on('Runtime.executionContextCreated',({context})=>worlds.push(context));await cdp.send('Runtime.enable');
    await wait(async()=>{for(const world of worlds.filter(w=>!w.auxData?.isDefault)){try{const r=await cdp.send('Runtime.evaluate',{contextId:world.id,expression:'Boolean(globalThis.__IMMERSIVE_GEMINI_CONTENT_LOADED__)',returnByValue:true});if(r.result.value)return true;}catch{}}return false;},'content injection');
    // Each editing host keeps the new user value while a stale model result arrives.
    for(const selector of ['#textarea','#input','#rich']){
      hold=true;await page.locator(selector).fill('Original draft');await trigger(selector);
      await page.locator(selector).fill('User added important new words');held.shift()();
      await page.waitForTimeout(80);assert.equal(await read(selector),'User added important new words');
      assert(!await page.locator(selector).evaluate(el=>el.classList.contains('ig-input-translating')));
    }
    check('Triple-space real input/textarea/contenteditable entries preserve edits made while an old model response is pending');

    hold=true;await page.locator('#input').fill('Clear after submit');await trigger('#input');
    await page.locator('#input').fill('');held.shift()();await page.waitForTimeout(80);assert.equal(await read('#input'),'');
    await page.locator('#rich').fill('Old rich focus');await trigger('#rich');const richBeforeBlur=await read('#rich');await page.locator('#other').focus();held.shift()();await page.waitForTimeout(80);
    assert.equal(await read('#rich'),richBeforeBlur);assert.equal(await page.locator('#other').evaluate(el=>el===document.activeElement),true);
    await page.locator('#input').fill('Removed input');await trigger('#input');await page.locator('#input').evaluate(el=>{globalThis.detachedInput=el;el.remove();});held.shift()();await page.waitForTimeout(80);
    assert.equal(await page.evaluate(()=>globalThis.detachedInput.value),'Removed input  ');
    check('Submitting/clearing, focus changes and detached inputs invalidate old results without restoring text or stealing focus');

    hold=false;await page.locator('#textarea').fill('Composition must not translate');
    const composingBefore=calls.length;await page.locator('#textarea').evaluate(el=>{for(let i=0;i<3;i++)el.dispatchEvent(new KeyboardEvent('keydown',{key:' ',isComposing:true,bubbles:true}));});await page.waitForTimeout(100);assert.equal(calls.length,composingBefore);
    await page.locator('#rich').fill('Safe rich replacement');await trigger('#rich');await wait(async()=>await read('#rich')==='Translated draft','scoped rich replacement');assert.equal(await page.locator('#outside').textContent(),'Outside must remain intact');
    await page.locator('#textarea').fill('Safe textarea replacement');await trigger('#textarea');await wait(async()=>await read('#textarea')==='Translated draft','textarea replacement');
    check('Composition keys never request translation; successful rich-text replacement is scoped to its own editor and ordinary input still translates');

    const tabId=await sw.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,page.url());
    await sw.evaluate(({tabId})=>chrome.tabs.sendMessage(tabId,{type:'TOGGLE_PAGE_TRANSLATION'}),{tabId});
    await page.locator('#source[data-ig-status="done"]').waitFor();
    const initial=await page.locator('#source .ig-trans-node').textContent();
    const settled=calls.length;await page.waitForTimeout(250);assert.equal(calls.length,settled,'extension rendering must not requeue itself');
    await page.locator('#source').evaluate(el=>{el.querySelector('.ig-orig-text').firstChild.nodeValue='Changed source after a live site update with different meaning.';});
    await wait(async()=>await page.locator('#source .ig-trans-node').count()===1&&(await page.locator('#source .ig-trans-node').textContent())!==initial,'changed characterData retranslated');
    const changed=await page.locator('#source .ig-trans-node').textContent();
    assert(calls.some(c=>typeof c.prompt==='string'&&c.prompt.includes('Changed source after')));
    const afterChanged=calls.length;await page.waitForTimeout(250);assert.equal(calls.length,afterChanged);
    check('Changed original text nodes automatically invalidate and retranslate once; generated translation nodes do not cause observer loops');

    hold=true;await page.locator('#source').evaluate(el=>{el.textContent='In-flight intermediate source replaced before the model returns.';});
    await wait(()=>held.length===1,'held intermediate paragraph');
    await page.locator('#source').evaluate(el=>{el.textContent='Newest final source must own the visible translated paragraph.';});
    await wait(()=>held.length===2,'new source request');
    const old=held.shift(),latest=held.shift();latest();await page.locator('#source[data-ig-status="done"]').waitFor();
    const latestText=await page.locator('#source .ig-trans-node').textContent();old();await page.waitForTimeout(120);assert.equal(await page.locator('#source .ig-trans-node').textContent(),latestText);assert.notEqual(latestText,changed);
    assert.equal(await page.locator('#source .ig-trans-node').count(),1);
    check('Whole-node reuse and in-flight source changes reject late batch output without duplicate translations');

    hold=false;await store({...settings,translationStyle:'translation-only'});
    await page.waitForFunction(()=>document.documentElement.dataset.igStyle==='translation-only');
    assert.equal(await page.locator('#source .ig-orig-text').first().evaluate(el=>getComputedStyle(el).display),'none');
    await page.locator('#source').evaluate(el=>{el.querySelector('.ig-orig-text').firstChild.nodeValue='Final updated source remains correct while original wrappers are hidden.';});
    await wait(async()=>await page.locator('#source .ig-trans-node').count()===1&&(await page.locator('#source .ig-trans-node').textContent())!==latestText,'wrapper-hidden source update');
    assert(calls.some(c=>typeof c.prompt==='string'&&c.prompt.includes('Final updated source')));
    assert.equal(errors.length,0,errors.join('\n'));
    check('Source changes remain trackable through original-text wrappers after style changes');
    return {checks,errors};
  }finally{await page.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
