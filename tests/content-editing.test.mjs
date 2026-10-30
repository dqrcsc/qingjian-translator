import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../content/content-main.js', import.meta.url), 'utf8');
const section = (start, end) => { const a=source.indexOf(start),b=source.indexOf(end,a+start.length); assert(a>=0&&b>a);return source.slice(a,b); };
function inputHarness() {
  const listeners = {}, replies = [], toasts = [], observers = [];
  let cancellations = 0;
  const target = { tagName:'TEXTAREA',type:'text',value:'Initial source  ',innerHTML:'',isConnected:true,
    classes:new Set(),contains(other){return other===this;},dispatchEvent(event){listeners[event.type]?.({target:this});} };
  target.classList={add:c=>target.classes.add(c),remove:c=>target.classes.delete(c)};
  const document={activeElement:target,documentElement:{},addEventListener:(name,fn)=>{listeners[name]=fn;}};
  class Input {} Object.defineProperty(Input.prototype,'value',{set(value){this.value=value;}});
  const ctx=vm.createContext({document,window:{HTMLTextAreaElement:Input,HTMLInputElement:Input},
    settings:{enableTripleSpaceInput:true,inputTargetLang:'en'},Event:class{constructor(type){this.type=type;}},
    MutationObserver:class {constructor(fn){this.fn=fn;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}},
    inputRequests:{cancel(){cancellations++;}},showPageToast:message=>toasts.push(message),
    sendModelRequest:()=>new Promise((resolve,reject)=>replies.push({resolve,reject}))});
  vm.runInContext(section('  let spacePressTimestamps = [];','\n  // ============================================================================\n  // 6.'),ctx);
  const trigger=async(extra={})=>{const e={key:' ',preventDefault(){},...extra};listeners.keydown(e);listeners.keydown(e);const pending=listeners.keydown(e);await Promise.resolve();return {pending};};
  return {ctx,listeners,replies,toasts,observers,target,document,trigger,get cancellations(){return cancellations;}};
}

test('real input handler invalidates the edit generation even when text changes back to the original',async()=>{
 const h=inputHarness();const {pending}=await h.trigger();assert.equal(h.replies.length,1);
 h.listeners.beforeinput({target:h.target});h.target.value='New draft';h.target.value='Initial source  ';
 h.replies[0].resolve({ok:true,data:{translatedText:'Stale'}});await pending;
 assert.equal(h.target.value,'Initial source  ');assert.equal(h.target.classes.size,0);assert(h.cancellations>=2);
 assert(h.observers[0].disconnected);
});

test('programmatic replacement, blur and removal refuse old input responses',async()=>{
 for(const reason of ['programmatic','blur','remove']){
  const h=inputHarness();const {pending}=await h.trigger();
  if(reason==='programmatic')h.target.value='Changed without an input event';
  if(reason==='blur'){h.document.activeElement={};h.listeners.focusout({target:h.target});}
  if(reason==='remove'){h.target.isConnected=false;h.observers[0].fn();}
  const preserved=h.target.value;h.replies[0].resolve({ok:true,data:{translatedText:'Stale'}});await pending;
  assert.equal(h.target.value,preserved);assert.equal(h.target.classes.size,0);assert(h.observers[0].disconnected);
 }
});

test('composition and repeated space do not trigger; a valid response preserves replacement task ownership',async()=>{
 const h=inputHarness();await h.trigger({isComposing:true});await h.trigger({repeat:true});assert.equal(h.replies.length,0);
 const first=await h.trigger();const second=await h.trigger();assert.equal(h.replies.length,2);
 h.replies[0].resolve({ok:true,data:{translatedText:'Old'}});await first.pending;
 assert(h.target.classes.has('ig-input-translating'));
 h.replies[1].resolve({ok:true,data:{translatedText:'Latest'}});await second.pending;
 assert.equal(h.target.value,'Latest');assert.equal(h.target.classes.size,0);
});

function text(value){return {nodeType:3,nodeValue:value};}
function element(tag,children=[],classes=[]){return {nodeType:1,tagName:tag,childNodes:children,isConnected:true,
 matches(selector){return ['SCRIPT','STYLE','NOSCRIPT'].includes(tag)||classes.some(c=>selector.includes('.'+c));},getAttribute(){return null;}};}

test('source signature ignores translation rendering and original wrappers, but catches source-only edits',()=>{
 const ctx=vm.createContext({Node:{ELEMENT_NODE:1,TEXT_NODE:3}});
 vm.runInContext(section('  function originalParagraphSignature(', '\n  function invalidateChangedParagraph('),ctx);
 const source=text('An original sentence');const root=element('P',[source]);const before=ctx.originalParagraphSignature(root);
 root.childNodes=[element('FONT',[source],['ig-orig-text']),element('FONT',[text('译文')],['ig-trans-node'])];
 assert.equal(ctx.originalParagraphSignature(root),before);
 source.nodeValue='Changed original sentence';assert.notEqual(ctx.originalParagraphSignature(root),before);
});

test('invalidating a changed source retires only that paragraph and its queued records',()=>{
 const a=element('P',[text('Old')]),b=element('P',[text('Other')]);const signatures=new WeakMap([[a,'Old'],[b,'Other']]);
 const records=new Map([[1,{element:a}],[2,{element:b}]]),resets=[],scans=[];
 const ctx=vm.createContext({Node:{ELEMENT_NODE:1,TEXT_NODE:3},paragraphSourceSignatures:signatures,blockMap:records,
 pendingParagraphQueue:[{id:1},{id:2}],viewportObserver:{unobserve(){}},
 resetElementTranslationState:el=>{resets.push(el);signatures.delete(el);},scheduleMutationScan:roots=>scans.push(...roots)});
 vm.runInContext(section('  function originalParagraphSignature(', '\n  function handleScrollRescan('),ctx);
 assert.equal(ctx.invalidateChangedParagraph(a),false);a.childNodes[0].nodeValue='New';
 assert.equal(ctx.invalidateChangedParagraph(a),true);assert(!records.has(1));assert(records.has(2));
 assert.deepEqual([...ctx.pendingParagraphQueue].map(x=>x.id),[2]);assert.deepEqual(resets,[a]);assert.deepEqual(scans,[a]);
});
