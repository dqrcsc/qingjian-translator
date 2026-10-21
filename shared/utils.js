/**
 * Shared utility helpers: hashing, subtitle parsing/formatting, text chunking, and HTML escaping.
 */

/**
 * Fast, deterministic FNV-1a 64-bit-like hex hash for cache keys.
 */
export function hashString(str) {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format seconds to SRT timestamp (HH:MM:SS,mmm)
 */
export function formatSrtTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return (
    String(hrs).padStart(2, '0') +
    ':' +
    String(mins).padStart(2, '0') +
    ':' +
    String(secs).padStart(2, '0') +
    ',' +
    String(ms).padStart(3, '0')
  );
}

/**
 * Format seconds to human readable MM:SS
 */
export function formatShortTime(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Parse SRT or WebVTT content into structured cue objects.
 */
export function parseSubtitles(rawText) {
  const normalized = rawText.replace(/\r\n/g, '\n').replace(/^WEBVTT[^\n]*\n+/i, '').trim();
  const blocks = normalized.split(/\n{2,}/);
  const cues = [];

  const timeRegex =
    /(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})/;

  const toSec = (h, m, s, ms) =>
    (h ? parseInt(h, 10) : 0) * 3600 +
    parseInt(m, 10) * 60 +
    parseInt(s, 10) +
    parseInt(ms, 10) / 1000;

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    let timeLineIdx = -1;
    let match = null;
    for (let i = 0; i < Math.min(2, lines.length); i++) {
      const m = lines[i].match(timeRegex);
      if (m) {
        timeLineIdx = i;
        match = m;
        break;
      }
    }
    if (timeLineIdx === -1 || !match) continue;

    const start = toSec(match[1], match[2], match[3], match[4]);
    const end = toSec(match[5], match[6], match[7], match[8]);
    const text = lines
      .slice(timeLineIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();

    if (text) {
      cues.push({
        id: cues.length,
        start,
        end,
        text,
        translation: ''
      });
    }
  }
  return cues;
}

/**
 * Group an array of items into batches respecting both maxItems and maxChars.
 */
export function createBatches(items, getTextFn, maxItems = 10, maxChars = 2200) {
  const batches = [];
  let currentBatch = [];
  let currentChars = 0;

  for (const item of items) {
    const text = getTextFn(item) || '';
    const len = text.length;
    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= maxItems || currentChars + len > maxChars)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
    currentBatch.push(item);
    currentChars += len;
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches;
}

/**
 * Detect whether a URL points to an online PDF (e.g., https://arxiv.org/pdf/2610.18672,
 * https://openreview.net/pdf?id=..., or any *.pdf URL).
 */
export function isOnlinePdfUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if ((host === 'arxiv.org' || host.endsWith('.arxiv.org')) && path.startsWith('/pdf/')) {
      return true;
    }
    if (host.includes('openreview.net') && path === '/pdf') {
      return true;
    }
    if (/\.pdf($|\?|#)/i.test(path + u.search)) {
      return true;
    }
    return false;
  } catch {
    return /\.pdf($|\?|#)|arxiv\.org\/pdf\//i.test(rawUrl);
  }
}

/**
 * Normalize arXiv / online PDF URLs into direct downloadable PDF URLs.
 */
export function normalizeOnlinePdfUrl(rawUrl) {
  if (!rawUrl) return '';
  let trimmed = String(rawUrl).trim();
  // Convert https://arxiv.org/abs/XXXX.XXXXX -> https://arxiv.org/pdf/XXXX.XXXXX
  trimmed = trimmed.replace(/^(https?:\/\/(?:export\.)?arxiv\.org)\/abs\//i, '$1/pdf/');
  return trimmed;
}

