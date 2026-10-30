import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_SETTINGS } from '../shared/constants.js';
const source=fs.readFileSync(new URL('../content/content-main.js',import.meta.url),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)+a.length));
function harness(){
 let listener;const effects=[];
 const ctx=vm.createContext({QingJianSettings:{resolveProtocol:r=>r?.apiProtocol||(!r?.providerId||r.providerId==='google'?'gemini':'openai')},chrome:{storage:{onChanged:{addListener:fn=>listener=fn}}},
 isExtensionContextValid:()=>true,STORAGE_KEY:'settings',settingsRevision:0,settings:{},isPageTranslated:true,
 document:{querySelector:()=>null},selectionCardEl:{style:{}},selectionRequests:{cancel:()=>effects.push('selection')},inputRequests:{cancel:()=>effects.push('input')},
 invalidateYoutubeTranslations:()=>effects.push('youtube'),disablePageTranslation:()=>effects.push('page'),invalidateInputTranslation:()=>effects.push('draft'),
 showPageToast:m=>effects.push(m),sanitizeContentSettings:x=>x,syncYoutubePreferences(){},applyStyleAttribute(){},applyYoutubeCssVariables(){},updateFloatingBallVisibility(){},updateFloatingBallStatus(){}});
 vm.runInContext(section('  function translationConfigSignature(','\n  function applyStyleAttribute('),ctx);
 return {effects,change:(before,after)=>listener({settings:{oldValue:before,newValue:after}},'local')};
}
test('translation configuration changes invalidate every old request surface and ask for restart',()=>{
 for(const field of ['targetLang','modelId','tonePreset','temperature','glossaryText','customSystemPrompt']){
  const h=harness();h.change({[field]:'old'},{[field]:'new'});
  for(const expected of ['youtube','page','selection','draft','input'])assert(h.effects.includes(expected),field+expected);
  assert(h.effects.some(x=>x.includes('重新开启')));
 }
});
test('default normalization matches persisted defaults without clearing output',()=>{
 const h=harness();h.change({}, {...DEFAULT_SETTINGS,providerId:'google',apiProtocol:'gemini',apiBaseUrl:'https://generativelanguage.googleapis.com/v1beta',apiKey:'',modelId:'',customModelId:'',targetLang:'zh-CN',tonePreset:'standard',temperature:0.2,customSystemPrompt:'',translationStyle:'mask',inputTargetLang:'en'});assert.deepEqual(h.effects,[]);
});
test('styling and equivalent model arrays do not discard translations; input language invalidates drafts only',()=>{
 const h=harness();h.change({availableModels:[{id:'x'}],translationStyle:'clean'},{availableModels:[{id:'x'}],translationStyle:'mask'});assert.deepEqual(h.effects,[]);
 h.change({inputTargetLang:'en'},{inputTargetLang:'ja'});assert.deepEqual(h.effects,['draft','input']);
});
test('content saves only a patch through the runtime and exposes unsuccessful persistence',async()=>{
 const calls=[],toasts=[];const ctx=vm.createContext({isExtensionContextValid:()=>true,chrome:{runtime:{sendMessage:async m=>{calls.push(m);return {ok:false,error:'storage unavailable'};}}},showPageToast:m=>toasts.push(m)});
 vm.runInContext(section('  async function safeUpdateStorage(', '\n  async function loadSettings('),ctx);
 await ctx.safeUpdateStorage({translationStyle:'mask'});
 assert.equal(calls[0].type,'UPDATE_CONTENT_SETTINGS');assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload)),{translationStyle:'mask'});assert.match(toasts[0],/storage unavailable/);
 assert(!source.includes('chrome.storage.local.set('));
});
