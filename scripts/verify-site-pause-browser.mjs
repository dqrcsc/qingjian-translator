import assert from 'node:assert/strict';
import http from 'node:http';

export async function verifySitePauseBrowser(context, sw) {
  const key='immersive_gemini_settings_v1', sessionKey='qingjian_site_pause_v1';
  const saved=await sw.evaluate(async ({key,sessionKey})=>({local:await chrome.storage.local.get(key),session:await chrome.storage.session.get(sessionKey)}),{key,sessionKey});
  const pages=[],checks=[],errors=[],calls=[];
  const fixture='<!doctype html><title>Site pause fixture</title><p>This is an English research paragraph with sufficient content to translate during an academic reading session.</p>';
  const route=async route=>route.fulfill({status:200,contentType:'text/html',body:fixture});
  await context.route('https://arxiv.org/**',route);
  await context.route('https://export.arxiv.org/**',route);
  await context.route('https://other-site.example/**',route);
  const server=http.createServer(async(req,res)=>{
    const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'};
    if(req.method==='OPTIONS'){res.writeHead(204,cors);res.end();return;}
    const chunks=[];for await(const c of req)chunks.push(c);
    const prompt=JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content;
    const items=JSON.parse(prompt.split('Input JSON:\n').at(-1));calls.push(items);
    res.writeHead(200,{...cors,'Content-Type':'application/json'});
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(items.map(x=>({id:x.id,translation:'这是用于会话站点暂停回归的有效译文。'})))}}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const settings={providerId:'custom',apiProtocol:'openai',apiBaseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'local-only',modelId:'fixture',availableModels:[{id:'fixture'}],enableCache:false,alwaysTranslateDomains:'arxiv.org',neverTranslateDomains:'',autoTranslateAllPages:true,autoTranslateOnlinePdf:true,autoTranslatePageImages:false,enableFloatingBall:true,enableImageTranslate:false};
  const check=label=>{checks.push(label);console.log(`  ✓ ${label}`);};
  const until=async(fn,label)=>{const end=Date.now()+15000;while(!await fn()){if(Date.now()>end)throw Error(`Site pause timeout: ${label}`);await new Promise(r=>setTimeout(r,25));}};
  const newPage=async url=>{const p=await context.newPage();pages.push(p);p.on('pageerror',e=>errors.push(e.message));await p.goto(url);await p.locator('.ig-ball-main').waitFor();return p;};
  const tabId=page=>sw.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,page.url());
  const send=async(page,message)=>sw.evaluate(({id,message})=>chrome.tabs.sendMessage(id,message),{id:await tabId(page),message});
  const status=page=>send(page,{type:'GET_PAGE_STATUS'});
  const paused=async page=>until(async()=>(await status(page)).siteAutoPaused,'paused state');
  const noTranslation=async page=>{await paused(page);await page.waitForTimeout(180);assert.equal(await page.locator('.ig-trans-node').count(),0);};
  try {
    await sw.evaluate(async({key,sessionKey,settings})=>{await chrome.storage.session.remove(sessionKey);await chrome.storage.local.set({[key]:settings});},{key,sessionKey,settings});
    const first=await newPage('https://arxiv.org/abs/pause-first');await first.locator('.ig-trans-node').waitFor();
    const existing=await newPage('https://arxiv.org/abs/already-reading');await existing.locator('.ig-trans-node').waitFor();
    await first.locator('.ig-ball-main').click();await noTranslation(first);
    assert.match(await first.locator('.ig-toggle-main-text').textContent(),/本次会话已暂停/);
    assert.equal(await existing.locator('.ig-trans-node').count(),1,'other completed page remains readable');
    assert.equal(await sw.evaluate(key=>chrome.storage.local.get(key).then(x=>x[key].alwaysTranslateDomains),key),'arxiv.org');
    check('Actual floating-ball close pauses the site session, preserves persistent domain rules and keeps other completed tabs readable');

    const count=calls.length;
    await first.goto('https://arxiv.org/abs/pause-next');await first.locator('.ig-ball-main').waitFor();await noTranslation(first);
    await first.reload();await first.locator('.ig-ball-main').waitFor();await noTranslation(first);
    const child=await newPage('https://export.arxiv.org/abs/new-tab');await noTranslation(child);
    assert.equal(calls.length,count);
    const other=await newPage('https://other-site.example/article');await other.locator('.ig-trans-node').waitFor();
    check('Same-site navigation, reload and configured subdomain new tabs stay paused without HTTP; unrelated sites still auto-translate');

    await first.bringToFront();
    const popup=await context.newPage();pages.push(popup);
    popup.on('pageerror',e=>errors.push(e.message));
    await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup/popup.html`);
    // Opening popup.html as a full tab changes the active tab; use a real host
    // tab as the active tab while the popup script queries browser state.
    await first.bringToFront();await popup.reload();
    await popup.waitForFunction(()=>document.querySelector('#toggleBtnLabel').textContent.includes('本次会话已暂停'));
    assert.equal(await popup.locator('#autoTranslateDomainCheckbox').isChecked(),true);
    await popup.locator('#toggleTranslateBtn').click();await first.locator('.ig-trans-node').waitFor();
    await until(async()=>!(await status(first)).siteAutoPaused,'manual resume');
    const resumed=await newPage('https://arxiv.org/abs/resumed');await resumed.locator('.ig-trans-node').waitFor();
    check('Popup distinguishes temporary pause from the checked persistent rule; explicit resume restores future same-site automatic translation');

    // Rapid user commands must serialize the session value in invocation order.
    await send(first,{type:'TOGGLE_PAGE_TRANSLATION'});
    await Promise.all([send(first,{type:'TOGGLE_PAGE_TRANSLATION'}),send(first,{type:'TOGGLE_PAGE_TRANSLATION'})]);
    await noTranslation(first);
    const beforePdf=context.pages().length;
    const pdf=await newPage('https://arxiv.org/pdf/2609.13531');await noTranslation(pdf);
    await pdf.waitForTimeout(200);assert.equal(context.pages().length,beforePdf+1,'paused online PDF must not auto-open studio');
    const event=context.waitForEvent('page');
    const opened=await send(pdf,{type:'TOGGLE_PAGE_TRANSLATION'});assert.equal(opened.openedPdfTab,true);
    const studio=await event;pages.push(studio);
    assert.match(studio.url(),/studio\/studio\.html/);
    await until(async()=>!(await status(pdf)).siteAutoPaused,'explicit PDF resume');
    check('Rapid off/on/off commands keep the final pause; automatic PDF opening obeys it while an explicit PDF command opens the Studio and resumes the site');

    await send(first,{type:'TOGGLE_PAGE_TRANSLATION'}); // currently off -> on
    await send(first,{type:'TOGGLE_PAGE_TRANSLATION'}); // on -> paused
    const state=await popup.evaluate(async()=>{
      const mod=await import(chrome.runtime.getURL('background/site-pause.js')+'?fresh-module');
      return mod.getSitePause('https://export.arxiv.org/abs/restored','arxiv.org');
    });
    assert.equal(state.paused,true);
    const fresh=await newPage('https://arxiv.org/abs/worker-restored');await noTranslation(fresh);
    check('A separately initialized extension module and newly injected page read the persisted session pause without relying on previous content state');

    await send(first,{type:'TOGGLE_PAGE_TRANSLATION'});await first.locator('.ig-trans-node').waitFor();
    await sw.evaluate(()=>{
      globalThis.originalSitePauseSet=chrome.storage.session.set.bind(chrome.storage.session);
      chrome.storage.session.set=async data=>{if(data.qingjian_site_pause_v1)throw Error('fixture session write failed');return originalSitePauseSet(data);};
    });
    try {
      await send(first,{type:'TOGGLE_PAGE_TRANSLATION'});
      await first.locator('.ig-toast').filter({hasText:'fixture session write failed'}).waitFor();
      assert.equal((await status(first)).siteAutoPaused,false,'failed write must not pretend the site is paused');
    } finally {
      await sw.evaluate(()=>{chrome.storage.session.set=originalSitePauseSet;delete globalThis.originalSitePauseSet;});
    }
    await first.bringToFront();await popup.reload();
    await popup.locator('#autoTranslateDomainCheckbox').waitFor();
    await popup.locator('#autoTranslateDomainCheckbox').uncheck();
    await popup.evaluate(()=>{
      globalThis.originalSitePauseSend=chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage=(message,...args)=>message.type==='SET_SITE_AUTO_TRANSLATE_STATE'
        ? Promise.reject(Error('fixture invalidated runtime')) : originalSitePauseSend(message,...args);
    });
    await popup.locator('#autoTranslateDomainCheckbox').check();
    await popup.waitForFunction(()=>document.querySelector('#toggleBtnSub').textContent.includes('fixture invalidated runtime'));
    check('Session write rejection and popup transport rejection show visible failure feedback without falsely persisting pause or emitting page exceptions');
    assert.deepEqual(errors,[]);
    return {checks,errors};
  } finally {
    for(const p of pages)if(!p.isClosed())await p.close();
    await context.unroute('https://arxiv.org/**',route);await context.unroute('https://export.arxiv.org/**',route);await context.unroute('https://other-site.example/**',route);
    await sw.evaluate(async({saved,sessionKey})=>{await chrome.storage.local.set(saved.local);if(Object.hasOwn(saved.session,sessionKey))await chrome.storage.session.set(saved.session);else await chrome.storage.session.remove(sessionKey);},{saved,sessionKey});
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}
