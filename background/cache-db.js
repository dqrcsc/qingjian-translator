/**
 * Two-tier translation cache (In-Memory Map + IndexedDB) for zero-token instant re-rendering.
 */

import { hashString } from '../shared/utils.js';

const DB_NAME = 'ImmersiveGeminiCacheDB';
const DB_VERSION = 1;
const STORE_NAME = 'translations';
const MAX_MEM_ITEMS = 2500;
const MAX_IDB_ITEMS = 15000;
const IDB_PRUNE_BATCH = 1000;

const memCache = new Map();
let dbPromise = null;
let writesSinceLastPrune = 0;
let prunedInThisSession = false;

function setMemoryEntry(key, translation) {
  memCache.delete(key);
  memCache.set(key, translation);
  while (memCache.size > MAX_MEM_ITEMS) memCache.delete(memCache.keys().next().value);
}

function openCacheDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (db) {
        db.onversionchange = () => {
          try { db.close(); } catch {}
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
      }
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

export function buildStyleSignature(settings = {}) {
  const tone = String(settings.tonePreset || 'standard').trim();
  const glossary = String(settings.glossaryText || '').trim();
  const customPrompt = String(settings.customSystemPrompt || '').trim();
  return hashString(JSON.stringify(['v2', settings.providerId || '', settings.apiProtocol || '',
    String(settings.apiBaseUrl || '').trim().replace(/\/+$/, ''), settings.temperature ?? 0.2, tone, glossary, customPrompt]));
}

export function buildCacheKey(sourceText, targetLang, modelId, glossarySignature = '', context = '') {
  const normalized = String(sourceText || '').trim();
  return hashString(JSON.stringify(['v2', targetLang, modelId, glossarySignature, context, normalized]));
}

export async function getCachedTranslations(keys) {
  const resultMap = new Map();
  const missingKeys = [];

  for (const key of keys) {
    if (memCache.has(key)) {
      const val = memCache.get(key);
      // Refresh LRU order in memory
      memCache.delete(key);
      memCache.set(key, val);
      resultMap.set(key, val);
    } else {
      missingKeys.push(key);
    }
  }

  if (missingKeys.length === 0) {
    return resultMap;
  }

  try {
    const db = await openCacheDB();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      let remaining = missingKeys.length;

      for (const key of missingKeys) {
        const req = store.get(key);
        req.onsuccess = () => {
          if (req.result && typeof req.result.translation === 'string') {
            resultMap.set(key, req.result.translation);
            setMemoryEntry(key, req.result.translation);
          }
          remaining--;
          if (remaining === 0) resolve();
        };
        req.onerror = () => {
          remaining--;
          if (remaining === 0) resolve();
        };
      }
    });
  } catch {
    // fallback to in-memory cache silently
  }

  return resultMap;
}

export async function setCachedTranslations(entries) {
  if (!entries || entries.length === 0) return;

  const now = Date.now();
  for (const { key, translation } of entries) {
    if (!key || typeof translation !== 'string') continue;
    setMemoryEntry(key, translation);
  }

  try {
    const db = await openCacheDB();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const { key, translation } of entries) {
        if (!key || typeof translation !== 'string') continue;
        store.put({ key, translation, updatedAt: now });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });

    writesSinceLastPrune += entries.length;
    if (!prunedInThisSession || writesSinceLastPrune >= 80) {
      prunedInThisSession = true;
      writesSinceLastPrune = 0;
      pruneIndexedDbIfNeeded(db).catch(() => {});
    }
  } catch {
    // fallback to in-memory cache silently
  }
}

async function pruneIndexedDbIfNeeded(db) {
  await new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const total = countReq.result || 0;
      if (total <= MAX_IDB_ITEMS) {
        resolve();
        return;
      }
      const toDelete = Math.min(total - MAX_IDB_ITEMS + IDB_PRUNE_BATCH, total);
      const idx = store.index('updatedAt');
      let deleted = 0;
      const cursorReq = idx.openCursor();
      cursorReq.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && deleted < toDelete) {
          cursor.delete();
          deleted++;
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => resolve();
    };
    countReq.onerror = () => resolve();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function getCacheStats() {
  try {
    const db = await openCacheDB();
    const count = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).count();
      let count = 0;
      req.onsuccess = () => { count = req.result || 0; };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(count);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('缓存读取失败'));
    });
    return { indexedDbCount: count, memoryCount: memCache.size, indexedDbAvailable: true };
  } catch {
    return { indexedDbCount: null, memoryCount: memCache.size, indexedDbAvailable: false };
  }
}

export async function clearAllCache() {
  memCache.clear();
  try {
    const db = await openCacheDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).clear();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('缓存清理失败'));
    });
    return { cleared: true, memoryCleared: true, indexedDbCleared: true };
  } catch {
    return { cleared: false, memoryCleared: true, indexedDbCleared: false };
  }
}
