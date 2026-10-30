import test from 'node:test';
import assert from 'node:assert/strict';
import { SITE_PAUSE_KEY, sitePauseScope, getSitePause, setSitePause, sitePauseRequestUrl } from '../background/site-pause.js';
const stored = {};
let fail = false;
globalThis.chrome = { storage: { session: { async get(k) {return {[k]:structuredClone(stored[k])};}, async set(v) {if(fail)throw Error('quota fixture');Object.assign(stored,structuredClone(v));} } }, tabs: { async get(id) {assert.equal(id,7);return {url:'https://arxiv.org/abs/1'};} } };
test('site scopes use explicitly configured parent only and respect hostname boundaries',()=>{
 assert.equal(sitePauseScope('https://export.arxiv.org/pdf/1','arxiv.org\nexport.arxiv.org'),'arxiv.org');
 assert.equal(sitePauseScope('https://evilarxiv.org','arxiv.org'),'evilarxiv.org');
 assert.equal(sitePauseScope('https://a.github.io',''),'a.github.io');
 assert.equal(sitePauseScope('https://b.github.io',''),'b.github.io');
 assert.throws(()=>sitePauseScope('chrome://settings'),/不支持/);
});
test('session pause serializes concurrent changes and survives module recreation without changing rules',async()=>{
 await Promise.all([setSitePause('https://arxiv.org','arxiv.org',true),setSitePause('https://example.org','',true)]);
 assert.deepEqual(stored[SITE_PAUSE_KEY],{'arxiv.org':true,'example.org':true});
 const fresh=await import('../background/site-pause.js?restart=1');
 assert.equal((await fresh.getSitePause('https://export.arxiv.org','arxiv.org')).paused,true);
 await Promise.all([setSitePause('https://arxiv.org','arxiv.org',false),setSitePause('https://arxiv.org','arxiv.org',true),setSitePause('https://arxiv.org','arxiv.org',false)]);
 assert.equal((await getSitePause('https://arxiv.org','arxiv.org')).paused,false);
 assert.equal((await getSitePause('https://example.org','')).paused,true);
 delete stored[SITE_PAUSE_KEY];assert.equal((await getSitePause('https://example.org','')).paused,false);
});
test('failed and invalid writes reject visibly and do not poison later session updates',async()=>{
 await assert.rejects(()=>setSitePause('https://arxiv.org','','yes'),/无效/);
 fail=true;await assert.rejects(()=>setSitePause('https://arxiv.org','',true),/quota/);fail=false;
 assert.equal((await getSitePause('https://arxiv.org','')).paused,false);
 await setSitePause('https://arxiv.org','',true);assert.equal((await getSitePause('https://arxiv.org','')).paused,true);
});
test('sender URL owns content requests; only the exact popup may resolve a tab ID',async()=>{
 const root='chrome-extension://fixture/';
 assert.equal(await sitePauseRequestUrl({url:'https://arxiv.org/abs/2',tab:{id:3}},{url:'https://victim.org',tabId:7},root),'https://arxiv.org/abs/2');
 assert.equal(await sitePauseRequestUrl({url:root+'popup/popup.html'},{tabId:7},root),'https://arxiv.org/abs/1');
 await assert.rejects(()=>sitePauseRequestUrl({url:root+'studio/studio.html'},{tabId:7},root),/仅支持/);
 await assert.rejects(()=>sitePauseRequestUrl({url:root+'popup/popup.html'},{url:'https://victim.org'},root),/标签页/);
});
