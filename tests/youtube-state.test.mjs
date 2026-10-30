import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../content/content-main.js', import.meta.url), 'utf8');
function section(a,b) { const start=source.indexOf(a), end=source.indexOf(b,start+a.length); assert.ok(start>=0 && end>start); return source.slice(start,end); }

for (const failure of ['invalid-context', 'reject', 'empty']) {
  test(`YouTube transport ${failure} is an explicit failure, never an empty model result`, async () => {
    const ctx=vm.createContext({ isExtensionContextValid:()=>failure!=='invalid-context',
      sendModelRequest:()=>failure==='reject'?Promise.reject(Error('Extension context invalidated.')):Promise.resolve(null),
      chrome:{runtime:{sendMessage(){throw Error('not subtitle transport');}}} });
    vm.runInContext(section('  function safeRuntimeSendMessage(', '\n  async function safeUpdateStorage('),ctx);
    const result=await ctx.safeRuntimeSendMessage({type:'TRANSLATE_YOUTUBE_CUES'});
    assert.equal(result?.ok,false);
    assert.ok(result.error);
    if(failure!=='empty') assert.equal(result.code,'EXTENSION_CONTEXT_INVALIDATED');
  });
}

function harness() {
  const children=[], buttons=[];
  const el=()=>({style:{},setAttribute(){},appendChild(n){buttons.push(n);},remove(){this.isConnected=false;},addEventListener(type,fn){this.click=fn;}});
  const ctx=vm.createContext({ settings:{}, subtitleRequests:{cancel(){}},document:{createElement:el,querySelector:()=>({appendChild(n){children.push(n);}})},
    window:{location:{reload(){ctx.reloads++;}}},reloads:0, Date });
  vm.runInContext(section('  let ytCues =', '\n  function getCurrentYoutubeVideoId('),ctx);
  return {ctx,children,buttons};
}

test('invalidated context stops immediately and offers refresh instead of futile retry',()=>{
  const h=harness();
  h.ctx.recordYoutubeTranslationFailure({code:'EXTENSION_CONTEXT_INVALIDATED',error:'扩展连接失效，请刷新页面'});
  assert.equal(h.ctx.canRequestYoutubeTranslation(),false);
  assert.match(h.children[0].textContent,/刷新/);
  assert.equal(h.buttons[0].textContent,'刷新页面');
  h.buttons[0].click(); assert.equal(h.ctx.reloads,1);
});

test('overlay status differentiates paused, retry backoff and active work; reset permits recovery',()=>{
  const h=harness();
  assert.equal(typeof h.ctx.youtubePendingTranslationText,'function');
  h.ctx.recordYoutubeTranslationFailure('HTTP 503');
  assert.match(h.ctx.youtubePendingTranslationText(),/重试/);
  h.ctx.recordYoutubeTranslationFailure('HTTP 401');
  assert.match(h.ctx.youtubePendingTranslationText(),/暂停/);
  assert.doesNotMatch(h.ctx.youtubePendingTranslationText(),/正在.*翻译/);
  h.ctx.resetYoutubeTranslationSession();
  assert.equal(h.ctx.canRequestYoutubeTranslation(),true);
  assert.doesNotMatch(h.ctx.youtubePendingTranslationText(),/暂停/);
});
