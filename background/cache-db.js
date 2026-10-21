/**
 * Two-tier translation cache (In-Memory Map + IndexedDB) for zero-token instant re-rendering.
 */

import { hashString } from '../shared/utils.js';

const DB_NAME = 'ImmersiveGeminiCacheDB';
const DB_VERSION = 1;
const STORE_NAME = 'translations';
const MAX_MEM_ITEMS = 2500;

const memCache = new Map();
let dbPromise = null;

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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

export function buildCacheKey(sourceText, targetLang, modelId, glossarySignature = '') {
  const normalized = String(sourceText || '').trim();
  return hashString(`${targetLang}|${modelId}|${glossarySignature}|${normalized}`);
}

export async function getCachedTranslations(keys) {
  const resultMap = new Map();
  const missingKeys = [];

  for (const key of keys) {
    if (memCache.has(key)) {
      resultMap.set(key, memCache.get(key));
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
            memCache.set(key, req.result.translation);
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
    if (memCache.size >= MAX_MEM_ITEMS) {
      const oldestKey = memCache.keys().next().value;
      memCache.delete(oldestKey);
    }
    memCache.set(key, translation);
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
  } catch {
    // fallback to in-memory cache silently
  }
}

export async function getCacheStats() {
  try {
    const db = await openCacheDB();
    const count = await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(memCache.size);
    });
    return { indexedDbCount: count, memoryCount: memCache.size };
  } catch {
    return { indexedDbCount: memCache.size, memoryCount: memCache.size };
  }
}

export async function clearAllCache() {
  memCache.clear();
  try {
    const db = await openCacheDB();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore IndexedDB clear errors
  }
  return { cleared: true };
}
