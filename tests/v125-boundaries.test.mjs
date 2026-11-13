import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFigureLabelsToCrop } from '../studio/pdf-engine.js';
import { readResponseBytes, fetchWithTimeoutAndRetry } from '../background/gemini-client.js';

for (const count of [0, 1, 16, 17, 20, 50]) test(`all ${count} non-overlapping translated figure labels survive cleaning`, () => {
  const labels=Array.from({length:count},(_,i)=>({original:`Label ${i}`,translation:`标签${i}`,box_2d:[10+Math.floor(i/5)*90,10+(i%5)*190,60+Math.floor(i/5)*90,150+(i%5)*190]}));
  assert.equal(normalizeFigureLabelsToCrop(labels,[0,0,1000,1000]).length,count);
});
for(const header of [null,'1']) test(`stream byte budget enforces actual bytes with declared length ${header}`,async()=>{
  let cancelled=false,pulls=0;
  const response=new Response(new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(6));},cancel(){cancelled=true;}}),{headers:header?{'Content-Length':header}:{}});
  await assert.rejects(readResponseBytes(response,10),{name:'ResponseLimitError'});
  assert.equal(cancelled,true);assert.ok(pulls<=3);
});
test('response exactly at limit succeeds; declared oversized body is cancelled before reading',async()=>{
  assert.equal((await readResponseBytes(new Response(new Uint8Array(10)),10)).byteLength,10);
  let cancelled=false;
  const response=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Length':'11'}});
  await assert.rejects(readResponseBytes(response,10),{name:'ResponseLimitError'});assert.equal(cancelled,true);
});
test('oversized success or retryable error response is never retried',async()=>{
  const saved=globalThis.fetch;
  try{for(const status of [200,503]){let calls=0;globalThis.fetch=async()=>{calls++;return new Response(new Uint8Array(11),{status});};
    await assert.rejects(fetchWithTimeoutAndRetry('https://fixture.invalid',{}, {maxResponseBytes:10,baseDelayMs:1}),{name:'ResponseLimitError'});assert.equal(calls,1);
  }}finally{globalThis.fetch=saved;}
});
