import test from 'node:test';
import assert from 'node:assert/strict';

test('cache opening failure reports unavailable disk state and partial clearing',async()=>{
 globalThis.indexedDB={open(){const req={}; queueMicrotask(()=>req.onerror());return req;}};
 const cache=await import('../background/cache-db.js?open-failure');
 await cache.setCachedTranslations([{key:'fixture',translation:'cached'}]);
 const stats=await cache.getCacheStats();
 assert.equal(stats.indexedDbCount,null);
 assert.equal(stats.indexedDbAvailable,false);
 assert.deepEqual(await cache.clearAllCache(),{cleared:false,memoryCleared:true,indexedDbCleared:false});
});

test('cache transaction abort and successful completion return truthful state',async()=>{
 let fail=true;
 const db={transaction(){const req={result:7};const tx={objectStore:()=>({count:()=>req,clear:()=>req})};
   setTimeout(()=>{ if(fail)tx.onabort?.();else {req.onsuccess?.();tx.oncomplete?.();}},0);return tx;}};
 globalThis.indexedDB={open(){const req={result:db};queueMicrotask(()=>req.onsuccess());return req;}};
 const cache=await import('../background/cache-db.js?transaction-failure');
 assert.equal((await cache.getCacheStats()).indexedDbCount,null);
 assert.equal((await cache.clearAllCache()).cleared,false);
 fail=false;
 assert.equal((await cache.getCacheStats()).indexedDbCount,7);
 assert.equal((await cache.clearAllCache()).cleared,true);
});
