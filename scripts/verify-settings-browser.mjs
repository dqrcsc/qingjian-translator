// Real options controls, background Port and storage fault boundaries; no production hooks.
import assert from 'node:assert/strict';
import http from 'node:http';
export async function verifySettingsBrowser(context, sw) {
  const checks = [], errors = [], calls = [];
  let holdModels = true, releaseModels;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'}); res.end(); return; }
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    calls.push({url:req.url, body:Buffer.concat(chunks).toString()});
    const reply = value => {res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(value));};
    if(req.method==='GET') {
      const run=()=>reply({data:[{id:'a-only-model'}]});
      if(holdModels) releaseModels=run; else run();
    } else {
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const text=body.messages.at(-1).content;
      reply({choices:[{message:{content:JSON.stringify([...text.matchAll(/"id"\s*:\s*(\d+)/g)].map(m=>({id:Number(m[1]),translation:'统计恢复译文'})))}}]});
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/v1`;
  const extensionId=new URL(sw.url()).host;
  const original=await sw.evaluate(()=>chrome.storage.local.get(null));
  const page=await context.newPage();
  let peer;
  page.on('pageerror',error=>errors.push(error.message));
  const save = value=>page.evaluate(async value=>{
    const {saveSettings}=await import('../shared/storage.js');return saveSettings(value);
  },value);
  const get = ()=>page.evaluate(async()=>{const {getSettings}=await import('../shared/storage.js');return getSettings();});
  try {
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);
    await save({providerId:'custom',apiProtocol:'openai',apiBaseUrl:base,apiKey:'local-only',modelId:'a-old',customModelId:'',availableModels:[{id:'a-old'}],
      providerConfigs:{deepseek:{apiProtocol:'openai',apiBaseUrl:base,apiKey:'local-only',modelId:'b-correct',availableModels:[{id:'b-correct'}]}}});
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#modelIdSelect').value==='a-old');
    await page.locator('#fetchModelsBtn').click();
    await page.waitForFunction(()=>document.querySelector('#fetchModelsBtn').disabled);
    const end=Date.now()+10000;while(!releaseModels){if(Date.now()>end)throw Error('model request not started');await new Promise(r=>setTimeout(r,20));}
    await page.locator('#providerSelect').selectOption('deepseek');
    await page.waitForFunction(()=>document.querySelector('#modelIdSelect').value==='b-correct');
    releaseModels();
    await page.waitForTimeout(150);
    const current=await get();
    assert.equal(current.providerId,'deepseek');assert.equal(current.modelId,'b-correct');
    assert.equal(current.providerConfigs.deepseek.modelId,'b-correct');
    holdModels=false;
    await page.locator('#fetchModelsBtn').click();
    await page.waitForFunction(()=>document.querySelector('#apiTestResult').textContent.includes('成功同步'));
    assert.equal((await get()).modelId,'a-only-model');
    checks.push('Actual options delayed model discovery cannot overwrite a switched provider; current refresh persists successfully');

    // Pause the first provider save, then switch again before it can update the UI.
    await page.evaluate(()=>{
      globalThis.__providerNativeSet=chrome.storage.local.set;
      let first=true;
      chrome.storage.local.set=async value=>{
        if(value.immersive_gemini_settings_v1&&first){first=false;await new Promise(r=>{globalThis.__releaseProviderSave=r;});}
        return __providerNativeSet.call(chrome.storage.local,value);
      };
    });
    try {
      await page.locator('#providerSelect').selectOption('google');
      await page.waitForFunction(()=>Boolean(globalThis.__releaseProviderSave));
      await page.locator('#providerSelect').selectOption('custom');
      assert.equal(await page.locator('#modelIdSelect').inputValue(),'a-old');
      await page.evaluate(()=>__releaseProviderSave());
      await page.waitForFunction(async()=>{
        const {getSettings}=await import('../shared/storage.js');return (await getSettings()).providerId==='custom';
      });
      assert.equal(await page.locator('#modelIdSelect').inputValue(),'a-old');
      assert.equal((await get()).modelId,'a-old');
      checks.push('Rapid provider switches snapshot the correct model and ignore earlier delayed save rendering');
    } finally {
      await page.evaluate(()=>{__releaseProviderSave?.();chrome.storage.local.set=__providerNativeSet;delete globalThis.__providerNativeSet;delete globalThis.__releaseProviderSave;});
    }

    // Pause one settings read while a second extension context tries to switch models.
    const expected = await get();
    await page.evaluate(async expected => {
      const { saveSettings } = await import('../shared/storage.js');
      globalThis.__settingsPageGet = chrome.storage.local.get;
      let first = true;
      chrome.storage.local.get = async key => {
        const value = await __settingsPageGet.call(chrome.storage.local, key);
        if (key === 'immersive_gemini_settings_v1' && first) {
          first = false;
          await new Promise(resolve => { globalThis.__releaseSettingsRead = resolve; });
        }
        return value;
      };
      globalThis.__conditionalSave = saveSettings({modelId:'before-switch'}, {expected});
    }, expected);
    await page.waitForFunction(()=>Boolean(globalThis.__releaseSettingsRead));
    peer = await context.newPage();
    await peer.goto(`chrome-extension://${extensionId}/studio/studio.html`);
    const switching = peer.evaluate(async () => {
      const { saveSettings } = await import('../shared/storage.js');
      return saveSettings({modelId:'after-switch'});
    });
    try {
      await page.waitForTimeout(50);
      await page.evaluate(()=>__releaseSettingsRead());
      await page.evaluate(()=>__conditionalSave);
      await switching;
      assert.equal((await get()).modelId,'after-switch');
      checks.push('Settings lock serializes conditional discovery and a concurrent write from another extension context');
    } finally {
      await page.evaluate(()=>{
        __releaseSettingsRead?.();chrome.storage.local.get=__settingsPageGet;
        delete globalThis.__settingsPageGet;delete globalThis.__releaseSettingsRead;delete globalThis.__conditionalSave;
      });
    }

    // Inject failure at the actual IDB transaction boundary, after opening the cache.
    await page.evaluate(()=>chrome.runtime.sendMessage({type:'GET_CACHE_STATS'}));
    await sw.evaluate(()=>{
      globalThis.__settingsNativeTransaction=IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction=function(...args){if(this.name==='ImmersiveGeminiCacheDB')throw new DOMException('fixture failure','UnknownError');return __settingsNativeTransaction.apply(this,args);};
    });
    try {
      await page.locator('#clearCacheBtn').click();
      await page.waitForFunction(()=>document.querySelector('#saveStatusToast').textContent.includes('磁盘缓存清理失败'));
      assert.match(await page.locator('#cacheStatsTitle').textContent(),/磁盘缓存不可用/);
      assert.doesNotMatch(await page.locator('#saveStatusToast').textContent(),/✓ 已清空/);
    } finally {
      await sw.evaluate(()=>{IDBDatabase.prototype.transaction=__settingsNativeTransaction;delete globalThis.__settingsNativeTransaction;});
    }
    await page.locator('#clearCacheBtn').click();
    await page.waitForFunction(()=>document.querySelector('#saveStatusToast').textContent.includes('✓ 已清空'));
    checks.push('Actual cache-clear button reports IDB failure and unavailable count, then recovers to success');

    await save({maxConcurrency:1,enableCache:false,requestBudgetSeconds:30});
    await sw.evaluate(()=>{
      globalThis.__settingsNativeGet=chrome.storage.local.get;
      globalThis.__settingsNativeTimeout=setTimeout;
      let held=false;
      chrome.storage.local.get=async key=>{
        const result=await __settingsNativeGet.call(chrome.storage.local,key);
        if(key==='immersive_gemini_stats_v1'&&!held){held=true;await new Promise(resolve=>{globalThis.__releaseStats=resolve;});}
        return result;
      };
      globalThis.setTimeout=(fn,ms,...args)=>__settingsNativeTimeout(fn,ms>29000&&ms<=30000?100:ms,...args);
    });
    try {
      const first=await page.evaluate(()=>QingJianRequests.createScope().request({type:'TRANSLATE_BATCH',payload:{items:[{id:1,text:'stats-stall-browser'}]}}));
      assert.equal(first.timedOut,true);
      const second=await page.evaluate(()=>QingJianRequests.createScope().request({type:'TRANSLATE_BATCH',payload:{items:[{id:1,text:'stats-recover-browser'}]}}));
      assert.equal(second.ok,true);
      const before=await sw.evaluate(()=>chrome.storage.local.get('immersive_gemini_stats_v1'));
      await sw.evaluate(()=>__releaseStats());
      await page.waitForTimeout(50);
      assert.deepEqual(await sw.evaluate(()=>chrome.storage.local.get('immersive_gemini_stats_v1')),before);
      checks.push('Actual background Port releases a stats-stalled request on deadline; healthy request succeeds and late read cannot overwrite counters');
    } finally {
      await sw.evaluate(()=>{
        globalThis.__releaseStats?.();chrome.storage.local.get=__settingsNativeGet;globalThis.setTimeout=__settingsNativeTimeout;
        delete globalThis.__releaseStats;delete globalThis.__settingsNativeGet;delete globalThis.__settingsNativeTimeout;
      });
    }
    assert.deepEqual(errors,[]);
    return checks;
  } finally {
    await peer?.close();
    await page.close();
    await sw.evaluate(value=>chrome.storage.local.set(value),original);
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}
