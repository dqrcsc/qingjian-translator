import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../content/content-main.js',import.meta.url),'utf8');
function section(a,b){const i=source.indexOf(a),j=source.indexOf(b,i+a.length);assert.ok(i>=0&&j>i);return source.slice(i,j);}
function harness(){
 const ctx=vm.createContext({settings:{},subtitleRequests:{cancel(){}},stopYoutubeAudioListen(){},renderYoutubeTimelineList(){},Date,
 document:{querySelector:()=>null},window:{location:{reload(){}}}});
 vm.runInContext(section('  let ytCues =','\n  function getCurrentYoutubeVideoId('),ctx);return ctx;
}
test('configuration invalidates translations but retains source times; ordinary retry keeps completed results',()=>{
 const h=harness();vm.runInContext("ytCues=[{id:0,start:1,end:2,text:'Hello',translation:'旧译文'}];ytLiveCaptionCache.set('Hello','旧译文');",h);
 h.resetYoutubeTranslationSession();assert.equal(vm.runInContext('ytCues[0].translation',h),'旧译文');
 h.invalidateYoutubeTranslations();
 assert.equal(vm.runInContext('ytCues[0].translation',h),'');assert.equal(vm.runInContext('ytCues[0].start',h),1);
 assert.equal(vm.runInContext('ytLiveCaptionCache.size',h),0);
});
test('live observations deduplicate repeated polling, preserve timing and separate seek gaps',()=>{
 const h=harness();
 const first=h.observeYoutubeLiveCaption('hello',1,'你好');h.observeYoutubeLiveCaption('hello',1,'你好');h.observeYoutubeLiveCaption('hello',1.2,'你好');
 assert.equal(h.getYoutubeTimelineCues().length,1);assert.equal(first.end,1.2);
 h.observeYoutubeLiveCaption('hello',20,'你好');assert.equal(h.getYoutubeTimelineCues().length,2);
 h.observeYoutubeLiveCaption('hello',1.1,'你好');assert.equal(h.getYoutubeTimelineCues().length,2,'revisiting observed interval reuses its cue');
 h.invalidateYoutubeTranslations();assert.ok(h.getYoutubeTimelineCues().every(c=>!c.translation));
});
test('full track replaces observed view without merging partial observations into complete cues',()=>{
 const h=harness();h.observeYoutubeLiveCaption('observed',1,'观察');
 vm.runInContext("ytCues=[{id:0,start:0,end:5,text:'Track',translation:''}];ytCaptionSource='track';",h);
 assert.equal(h.getYoutubeTimelineCues().length,1);assert.equal(h.getYoutubeTimelineCues()[0].text,'Track');
});
test('observation records retain a bounded recent window with explicit dropped count',()=>{
 const h=harness();for(let i=0;i<1005;i++)h.observeYoutubeLiveCaption('line '+i,i*2,'译文');
 assert.equal(h.getYoutubeTimelineCues().length,1000);assert.equal(vm.runInContext('ytObservedDropped',h),5);
});
