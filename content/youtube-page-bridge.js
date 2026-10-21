/**
 * Main World Bridge for YouTube (Manifest V3 world: "MAIN").
 * Intercepts YouTube player caption tracks & timedtext requests and communicates
 * structured subtitle cues to the isolated content script via window.postMessage.
 */

(function initImmersiveGeminiYoutubeBridge() {
  if (window.__IG_YT_BRIDGE_INSTALLED__) return;
  window.__IG_YT_BRIDGE_INSTALLED__ = true;

  let lastVideoId = '';
  let lastDispatchedTrackUrl = '';
  let lastDispatchedPayload = null;
  let isInternalTrackFetch = false;

  function getVideoIdFromUrl() {
    try {
      const url = new URL(window.location.href);
      if (url.pathname.startsWith('/shorts/')) {
        return url.pathname.split('/shorts/')[1]?.split('/')[0] || '';
      }
      return url.searchParams.get('v') || '';
    } catch {
      return '';
    }
  }

  function decodeHtmlEntities(str) {
    return String(str || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)));
  }

  /**
   * Cleans, de-overlaps, and merges short consecutive fragments into sentence-aligned cues.
   */
  function finalizeRawCues(rawCues) {
    const cleaned = [];
    for (let i = 0; i < rawCues.length; i++) {
      const cur = { ...rawCues[i] };
      const next = rawCues[i + 1];
      if (next && cur.end > next.start && next.start > cur.start) {
        cur.end = next.start;
      }
      if (cleaned.length > 0 && cleaned[cleaned.length - 1].text === cur.text) {
        cleaned[cleaned.length - 1].end = Math.max(cleaned[cleaned.length - 1].end, cur.end);
        continue;
      }
      if (
        cleaned.length > 0 &&
        cleaned[cleaned.length - 1].text.length < 44 &&
        cur.text.length < 48 &&
        !/[.?!:;。？！]$/.test(cleaned[cleaned.length - 1].text) &&
        cur.start - cleaned[cleaned.length - 1].end < 0.35 &&
        cleaned[cleaned.length - 1].end - cleaned[cleaned.length - 1].start < 3.2
      ) {
        const prev = cleaned[cleaned.length - 1];
        prev.text = `${prev.text} ${cur.text}`.replace(/\s+/g, ' ').trim();
        prev.end = Number(Math.max(prev.start + 0.8, cur.end).toFixed(2));
        continue;
      }
      cleaned.push({
        id: cleaned.length,
        start: Number(cur.start.toFixed(2)),
        end: Number(Math.max(cur.start + 0.4, cur.end).toFixed(2)),
        text: cur.text
      });
    }
    return cleaned;
  }

  /**
   * Convert YouTube JSON3 timedtext events into clean, sentence-aligned subtitle cues.
   * Handles both manual caption tracks and rolling word-by-word ASR auto-captions.
   */
  function normalizeJson3Events(events) {
    if (!Array.isArray(events)) return [];
    const rawCues = [];

    for (const ev of events) {
      if (!ev || !Array.isArray(ev.segs)) continue;
      const text = ev.segs
        .map((s) => s.utf8 || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || text === '\n') continue;

      const start = (Number(ev.tStartMs) || 0) / 1000;
      const duration = (Number(ev.dDurationMs) || 2500) / 1000;
      rawCues.push({
        start,
        end: start + duration,
        text
      });
    }

    return finalizeRawCues(rawCues);
  }

  /**
   * Parses XML (<text start=".." dur="..">) or SRV3 (<p t=".." d="..">) timedtext payloads.
   */
  function parseXmlOrSrv3TimedText(rawText) {
    const rawCues = [];
    const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    let match;
    while ((match = pRegex.exec(rawText)) !== null) {
      const attrs = match[1] || '';
      const inner = match[2] || '';
      const tMatch = attrs.match(/\bt="(\d+)"/i);
      const dMatch = attrs.match(/\bd="(\d+)"/i);
      if (!tMatch) continue;
      const plain = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
      if (!plain) continue;
      const start = Number(tMatch[1]) / 1000;
      const duration = (dMatch ? Number(dMatch[1]) : 2500) / 1000;
      rawCues.push({ start, end: start + duration, text: plain });
    }

    if (rawCues.length === 0) {
      const textRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
      while ((match = textRegex.exec(rawText)) !== null) {
        const attrs = match[1] || '';
        const inner = match[2] || '';
        const sMatch = attrs.match(/\bstart="([\d.]+)"/i);
        const dMatch = attrs.match(/\bdur="([\d.]+)"/i);
        if (!sMatch) continue;
        const plain = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ' '))
          .replace(/\s+/g, ' ')
          .trim();
        if (!plain) continue;
        const start = Number(sMatch[1]);
        const duration = dMatch ? Number(dMatch[1]) : 2.5;
        rawCues.push({ start, end: start + duration, text: plain });
      }
    }

    return finalizeRawCues(rawCues);
  }

  function parseTimedTextPayload(rawText) {
    if (!rawText || typeof rawText !== 'string') return [];
    const trimmed = rawText.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('{')) {
      try {
        const data = JSON.parse(trimmed);
        return normalizeJson3Events(data?.events || []);
      } catch {
        return [];
      }
    }
    if (trimmed.startsWith('<')) {
      return parseXmlOrSrv3TimedText(trimmed);
    }
    return [];
  }

  let lastKnownPot = '';
  let lastKnownClient = '';
  const lastKnownSessionParams = {};
  const SESSION_PARAM_KEYS = ['pot', 'c', 'cver', 'xorb', 'xobt', 'xovt', 'cbr', 'cbrver', 'cos'];

  function capturePotFromTimedTextUrl(rawUrl) {
    if (!rawUrl) return;
    try {
      const u = new URL(rawUrl, window.location.origin);
      const pot = u.searchParams.get('pot');
      if (pot) {
        lastKnownPot = pot;
      }
      const c = u.searchParams.get('c');
      if (c) {
        lastKnownClient = c;
      }
      for (const k of SESSION_PARAM_KEYS) {
        const val = u.searchParams.get(k);
        if (val) {
          lastKnownSessionParams[k] = val;
        }
      }
    } catch {
      // ignore
    }
  }

  function applySessionParamsToUrl(urlObj) {
    if (lastKnownPot && !urlObj.searchParams.has('pot')) {
      urlObj.searchParams.set('pot', lastKnownPot);
    }
    if (lastKnownClient && !urlObj.searchParams.has('c')) {
      urlObj.searchParams.set('c', lastKnownClient);
    }
    for (const [k, v] of Object.entries(lastKnownSessionParams)) {
      if (v && !urlObj.searchParams.has(k)) {
        urlObj.searchParams.set(k, v);
      }
    }
  }

  function areCuesMatchingPreferredLang(cues, preferred) {
    if (!Array.isArray(cues) || cues.length === 0) return false;
    const sample = cues
      .slice(0, 12)
      .map((c) => c.text || '')
      .join(' ');
    if (!sample) return false;

    const cjkCount = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
    const arabicCount = (sample.match(/[\u0600-\u06ff]/g) || []).length;
    const latinCount = (sample.match(/[a-zA-Z]/g) || []).length;
    const prefLang = (preferred?.languageCode || '').toLowerCase();

    // If preferred original track is English or another Latin-alphabet language, reject Arabic or Chinese cues
    if (/^(en|es|fr|de|pt|it|nl)/i.test(prefLang)) {
      if (arabicCount > 4 || cjkCount / sample.length > 0.15 || latinCount < 4) {
        return false;
      }
    }

    // If video has any non-Chinese track, reject Chinese cues as "original"
    if (cjkCount / sample.length > 0.2 && videoHasNonChineseTrack()) {
      return false;
    }
    return true;
  }

  function getCaptionTracklist() {
    try {
      const videoId = getVideoIdFromUrl();
      const player = document.getElementById('movie_player');
      let playerResponse = null;
      if (player && typeof player.getPlayerResponse === 'function') {
        playerResponse = player.getPlayerResponse();
      }
      if (
        (!playerResponse || playerResponse?.videoDetails?.videoId !== videoId) &&
        window.ytInitialPlayerResponse &&
        window.ytInitialPlayerResponse?.videoDetails?.videoId === videoId
      ) {
        playerResponse = window.ytInitialPlayerResponse;
      }
      if (!playerResponse && window.ytInitialPlayerResponse) {
        playerResponse = window.ytInitialPlayerResponse;
      }
      return playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    } catch {
      return [];
    }
  }

  function selectPreferredOriginalTrack(tracklist) {
    if (!Array.isArray(tracklist) || tracklist.length === 0) return null;
    // 1. ASR track (kind === 'asr' or vssId starting with 'a.') only exists for the video's spoken original audio language
    const asrTrack = tracklist.find(
      (t) => t.kind === 'asr' || (typeof t.vssId === 'string' && t.vssId.startsWith('a.'))
    );
    const origLangPrefix = asrTrack?.languageCode?.split('-')[0]?.toLowerCase() || '';

    // 2. Also check if a track name explicitly says "Original" / "原声"
    const explicitOrigTrack = tracklist.find((t) => {
      const label = (t.name?.simpleText || t.name?.runs?.[0]?.text || '').toLowerCase();
      return label.includes('original') || label.includes('原声');
    });

    return (
      explicitOrigTrack ||
      (origLangPrefix &&
        tracklist.find(
          (t) =>
            t.kind !== 'asr' &&
            typeof t.languageCode === 'string' &&
            t.languageCode.toLowerCase().startsWith(origLangPrefix)
        )) ||
      tracklist.find((t) => t.kind !== 'asr' && /^en/i.test(t.languageCode)) ||
      asrTrack ||
      tracklist.find((t) => /^en/i.test(t.languageCode)) ||
      tracklist.find((t) => !/^(zh|ar)/i.test(t.languageCode)) ||
      tracklist[0]
    );
  }

  function videoHasNonChineseTrack() {
    const tracklist = getCaptionTracklist();
    return tracklist.some((t) => t.languageCode && !/^zh/i.test(t.languageCode));
  }

  function dispatchCuesToContentScript(cues, trackMeta = {}, sourceUrl = '') {
    if (!Array.isArray(cues) || cues.length === 0) return false;
    const preferred = selectPreferredOriginalTrack(getCaptionTracklist());
    if (!areCuesMatchingPreferredLang(cues, preferred)) {
      return false;
    }

    const videoId = getVideoIdFromUrl();
    if (sourceUrl) {
      lastDispatchedTrackUrl = sourceUrl;
    }
    lastDispatchedPayload = {
      videoId,
      videoTitle: document.title.replace(/\s*-\s*YouTube$/i, ''),
      languageCode: trackMeta.languageCode || preferred?.languageCode || 'auto',
      trackName: trackMeta.name?.simpleText || trackMeta.name?.runs?.[0]?.text || '',
      isAutoGenerated: trackMeta.kind === 'asr',
      cues
    };
    window.postMessage(
      {
        source: 'IG_YT_MAIN_BRIDGE',
        type: 'YT_CUES_LOADED',
        payload: lastDispatchedPayload
      },
      '*'
    );
    return true;
  }

  async function fetchAndDispatchTrack(baseUrl, trackMeta = {}) {
    if (!baseUrl) return false;
    try {
      capturePotFromTimedTextUrl(baseUrl);
      const urlObj = new URL(baseUrl, window.location.origin);
      urlObj.searchParams.set('fmt', 'json3');
      // Always remove tlang so YouTube returns the original spoken language track instead of machine-translated Chinese
      urlObj.searchParams.delete('tlang');
      applySessionParamsToUrl(urlObj);
      const finalUrl = urlObj.toString();

      const currentVid = getVideoIdFromUrl();
      const preferred = selectPreferredOriginalTrack(getCaptionTracklist());
      if (
        finalUrl === lastDispatchedTrackUrl &&
        lastDispatchedPayload &&
        lastDispatchedPayload.videoId === currentVid &&
        lastDispatchedPayload.cues?.length > 0 &&
        areCuesMatchingPreferredLang(lastDispatchedPayload.cues, preferred)
      ) {
        window.postMessage(
          {
            source: 'IG_YT_MAIN_BRIDGE',
            type: 'YT_CUES_LOADED',
            payload: lastDispatchedPayload
          },
          '*'
        );
        return true;
      }

      isInternalTrackFetch = true;
      const resp = await window.fetch(finalUrl, { credentials: 'same-origin' });
      isInternalTrackFetch = false;
      if (resp.ok) {
        const rawText = await resp.text();
        const cues = parseTimedTextPayload(rawText);
        if (cues.length > 0) {
          return dispatchCuesToContentScript(cues, trackMeta, finalUrl);
        }
      }

      // Fallback: try without forcing fmt=json3 (still stripping tlang and keeping pot)
      const fallbackUrlObj = new URL(baseUrl, window.location.origin);
      fallbackUrlObj.searchParams.delete('tlang');
      applySessionParamsToUrl(fallbackUrlObj);
      isInternalTrackFetch = true;
      const fallbackResp = await window.fetch(fallbackUrlObj.toString(), {
        credentials: 'same-origin'
      });
      isInternalTrackFetch = false;
      if (fallbackResp.ok) {
        const fallbackText = await fallbackResp.text();
        const fallbackCues = parseTimedTextPayload(fallbackText);
        if (fallbackCues.length > 0) {
          return dispatchCuesToContentScript(fallbackCues, trackMeta, finalUrl);
        }
      }
    } catch {
      isInternalTrackFetch = false;
    }
    return false;
  }

  async function extractCaptionTracksFromPlayer() {
    try {
      const videoId = getVideoIdFromUrl();
      if (!videoId) return;

      const tracklist = getCaptionTracklist();
      const preferred = selectPreferredOriginalTrack(tracklist);

      // If we already have valid original cues for this exact videoId, replay them immediately
      if (
        lastDispatchedPayload &&
        lastDispatchedPayload.videoId === videoId &&
        Array.isArray(lastDispatchedPayload.cues) &&
        lastDispatchedPayload.cues.length > 0 &&
        areCuesMatchingPreferredLang(lastDispatchedPayload.cues, preferred)
      ) {
        window.postMessage(
          {
            source: 'IG_YT_MAIN_BRIDGE',
            type: 'YT_CUES_LOADED',
            payload: lastDispatchedPayload
          },
          '*'
        );
        return;
      }

      const player = document.getElementById('movie_player');

      if (!Array.isArray(tracklist) || tracklist.length === 0) {
        window.postMessage(
          {
            source: 'IG_YT_MAIN_BRIDGE',
            type: 'YT_NO_CAPTIONS_AVAILABLE',
            payload: {
              videoId,
              videoTitle: document.title.replace(/\s*-\s*YouTube$/i, '')
            }
          },
          '*'
        );
        return;
      }

      if (preferred && preferred.baseUrl) {
        ensurePlayerOriginalCaptionTrack(player, preferred);
        const ok = await fetchAndDispatchTrack(preferred.baseUrl, preferred);
        if (!ok) {
          ensurePlayerOriginalCaptionTrack(player, preferred, true);
        }
      }
    } catch {
      // Ignore transient player state errors
    }
  }

  function ensurePlayerOriginalCaptionTrack(player, preferred, forceActivate = false, retryCount = 0) {
    if (!player || !preferred || !preferred.languageCode) return;
    try {
      if (typeof player.loadModule === 'function') {
        player.loadModule('captions');
      }
      if (typeof player.getOption === 'function' && typeof player.setOption === 'function') {
        const runtimeTracklist = player.getOption('captions', 'tracklist') || [];
        if (!Array.isArray(runtimeTracklist) || runtimeTracklist.length === 0) {
          if (retryCount < 3) {
            setTimeout(
              () => ensurePlayerOriginalCaptionTrack(player, preferred, forceActivate, retryCount + 1),
              380
            );
          }
          return;
        }

        const prefPrefix = preferred.languageCode.split('-')[0].toLowerCase();
        // Match the exact full track object from the player's runtime tracklist so YouTube never defaults to tracklist[0] ('ar' Arabic)
        const matchedRuntimeTrack =
          runtimeTracklist.find(
            (t) => t.languageCode === preferred.languageCode && t.kind === preferred.kind
          ) ||
          runtimeTracklist.find((t) => t.languageCode === preferred.languageCode) ||
          runtimeTracklist.find(
            (t) =>
              typeof t.languageCode === 'string' &&
              t.languageCode.toLowerCase().startsWith(prefPrefix) &&
              t.kind !== 'asr'
          ) ||
          runtimeTracklist.find(
            (t) =>
              typeof t.languageCode === 'string' &&
              t.languageCode.toLowerCase().startsWith(prefPrefix)
          );

        if (!matchedRuntimeTrack) return;

        const currentTrack = player.getOption('captions', 'track');
        const hasAutoTrans = Boolean(
          currentTrack &&
            (currentTrack.translationLanguage ||
              currentTrack.translationLanguage?.languageCode)
        );
        const isCurrentWrongLang =
          Boolean(currentTrack?.languageCode) &&
          !currentTrack.languageCode.toLowerCase().startsWith(prefPrefix);
        const isTrackUnset = !currentTrack || !currentTrack.languageCode;

        if (forceActivate || hasAutoTrans || isCurrentWrongLang || isTrackUnset) {
          const cleanTrack = { ...matchedRuntimeTrack };
          delete cleanTrack.translationLanguage;
          player.setOption('captions', 'track', cleanTrack);
        }
      }
    } catch {
      // ignore
    }
  }

  function handleInterceptedTimedText(reqUrl, rawResponseText) {
    try {
      capturePotFromTimedTextUrl(reqUrl);
      const u = new URL(reqUrl, window.location.origin);
      const hasTlang = u.searchParams.has('tlang');
      const reqLang = (u.searchParams.get('lang') || '').toLowerCase();
      const preferred = selectPreferredOriginalTrack(getCaptionTracklist());
      const prefPrefix = preferred?.languageCode?.split('-')[0]?.toLowerCase() || '';
      const isWrongLangTrack =
        Boolean(prefPrefix && reqLang && !reqLang.startsWith(prefPrefix)) ||
        (/^zh/i.test(reqLang) && videoHasNonChineseTrack());

      // If YouTube's player requested a machine-translated track (tlang=...) or a non-original language track (e.g. 'ar' or 'zh' on an 'en' video),
      // DO NOT use rawResponseText directly; instead switch & fetch the original language track!
      if (hasTlang || isWrongLangTrack) {
        const player = document.getElementById('movie_player');
        if (player && preferred) {
          ensurePlayerOriginalCaptionTrack(player, preferred, true);
        }
        if (hasTlang && (!prefPrefix || reqLang.startsWith(prefPrefix))) {
          fetchAndDispatchTrack(reqUrl, { languageCode: reqLang || 'en' });
        } else if (preferred && preferred.baseUrl) {
          fetchAndDispatchTrack(preferred.baseUrl, preferred);
        }
        return;
      }

      if (typeof rawResponseText === 'string' && rawResponseText.length > 10) {
        const cues = parseTimedTextPayload(rawResponseText);
        if (cues.length > 0) {
          const dispatched = dispatchCuesToContentScript(
            cues,
            { languageCode: reqLang || 'detected' },
            reqUrl
          );
          if (dispatched) return;
        }
      }

      if (reqUrl !== lastDispatchedTrackUrl) {
        fetchAndDispatchTrack(reqUrl, { languageCode: reqLang || 'detected' });
      }
    } catch {
      // ignore
    }
  }

  // 1. Intercept XMLHttpRequest for /api/timedtext
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === 'string' && url.includes('/api/timedtext')) {
      capturePotFromTimedTextUrl(url);
      this.addEventListener('load', function () {
        handleInterceptedTimedText(url, this.responseText);
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };

  // 2. Intercept window.fetch for /api/timedtext
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (...args) {
      const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (!isInternalTrackFetch && reqUrl && reqUrl.includes('/api/timedtext')) {
        capturePotFromTimedTextUrl(reqUrl);
      }
      const resp = await origFetch.apply(this, args);
      if (!isInternalTrackFetch && reqUrl && reqUrl.includes('/api/timedtext')) {
        try {
          const clone = resp.clone();
          clone
            .text()
            .then((rawText) => {
              handleInterceptedTimedText(reqUrl, rawText);
            })
            .catch(() => {});
        } catch {
          // ignore
        }
      }
      return resp;
    };
  }

  // Listen for requests from the isolated content script
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source !== 'IG_YT_CONTENT_SCRIPT') return;

    if (event.data.type === 'REQUEST_YT_TRACKS') {
      extractCaptionTracksFromPlayer();
    } else if (event.data.type === 'SEEK_VIDEO_TO') {
      const seconds = Number(event.data.seconds);
      if (!Number.isFinite(seconds)) return;
      const player = document.getElementById('movie_player');
      if (player && typeof player.seekTo === 'function') {
        player.seekTo(seconds, true);
      } else {
        const video = document.querySelector('video');
        if (video) video.currentTime = seconds;
      }
    }
  });

  function checkVideoChange() {
    const vid = getVideoIdFromUrl();
    if (vid && vid !== lastVideoId) {
      lastVideoId = vid;
      lastDispatchedTrackUrl = '';
      lastDispatchedPayload = null;
      setTimeout(extractCaptionTracksFromPlayer, 500);
      setTimeout(extractCaptionTracksFromPlayer, 1800);
    }
  }

  window.addEventListener('yt-navigate-finish', () => {
    const vid = getVideoIdFromUrl();
    if (vid !== lastVideoId) {
      lastVideoId = vid;
      lastDispatchedTrackUrl = '';
      lastDispatchedPayload = null;
    }
    setTimeout(extractCaptionTracksFromPlayer, 450);
    setTimeout(extractCaptionTracksFromPlayer, 1600);
  });

  window.addEventListener('load', () => {
    setTimeout(extractCaptionTracksFromPlayer, 600);
  });

  setInterval(checkVideoChange, 1200);
})();
