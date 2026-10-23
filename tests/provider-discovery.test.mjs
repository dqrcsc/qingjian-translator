import test from 'node:test';
import assert from 'node:assert/strict';
const store = {};
let listener;
const event = { addListener() {} };
globalThis.chrome = {
 storage: {local: {async get(key) {return {[key]:structuredClone(store[key])};}, async set(data) {Object.assign(store, structuredClone(data));}},onChanged:event},
 runtime:{onInstalled:event,onConnect:event,onMessage:{addListener(fn){listener=fn;}},getURL:x=>x},
 tabs:{onUpdated:event},contextMenus:{onClicked:event},commands:{onCommand:event}
};
const {saveSettings,getSettings}=await import('../shared/storage.js');
await import('../background/service-worker.js');
const initial={providerId:'custom',apiProtocol:'openai',apiBaseUrl:'https://a.invalid/v1',apiKey:'fixture-only',modelId:'a-old'};
test('late model discovery cannot mutate the newly selected provider through the real message entry',async()=>{
 await saveSettings(initial);
 let release;
 globalThis.fetch=()=>new Promise(resolve=>{release=()=>resolve(new Response(JSON.stringify({data:[{id:'a-only-model'}]})));});
 const pending=new Promise(resolve=>listener({type:'FETCH_MODELS',payload:initial},{},resolve));
 while(!release) await new Promise(r=>setTimeout(r,1));
 await saveSettings({providerId:'deepseek',apiProtocol:'openai',apiBaseUrl:'https://b.invalid/v1',modelId:'b-correct',availableModels:[{id:'b-correct'}]});
 release();
 const response=await pending;
 assert.equal(response.ok,true);
 assert.equal(response.data.selectedModelId,'a-only-model');
 const current=await getSettings();
 assert.equal(current.modelId,'b-correct');
 assert.equal(current.providerConfigs.deepseek.modelId,'b-correct');
});
test('conditional settings commit rejects stale provider or changed connection while accepting current discovery',async()=>{
 const expected=await saveSettings(initial);
 await saveSettings({apiBaseUrl:'https://changed.invalid/v1'});
 assert.equal(await saveSettings({modelId:'wrong'},{expected}),null);
 assert.equal((await getSettings()).modelId,'a-old');
 const current=await getSettings();
 assert.equal((await saveSettings({modelId:'valid'},{expected:current})).modelId,'valid');
});
