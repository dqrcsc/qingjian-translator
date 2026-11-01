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
  let navigationGeneration = 0;
  let navigationPending = false;
  let trackController = new AbortController();

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
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
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

  function resetVideoSession() {
    navigationGeneration++;
    lastVideoId = getVideoIdFromUrl();
    lastDispatchedTrackUrl = '';
    lastDispatchedPayload = null;
    lastKnownPot = '';
    lastKnownClient = '';
    for (const key of Object.keys(lastKnownSessionParams)) delete lastKnownSessionParams[key];
    trackController.abort();
    trackController = new AbortController();
  }

  function captureVideoSession() {
    if (getVideoIdFromUrl() !== lastVideoId) resetVideoSession();
    return { videoId: lastVideoId, generation: navigationGeneration, signal: trackController.signal };
  }

  function isCurrentVideoSession(session) {
    captureVideoSession();
    return Boolean(session?.videoId) && !navigationPending &&
      session.videoId === lastVideoId && session.generation === navigationGeneration;
  }

  function isCurrentTrackRequest(session, rawUrl) {
    if (!isCurrentVideoSession(session)) return false;
    try {
      const sourceVideoId = new URL(rawUrl, window.location.origin).searchParams.get('v');
      return !sourceVideoId || sourceVideoId === session.videoId;
    } catch {
      return false;
    }
  }

  function getCaptionTracklist() {
    try {
      const videoId = getVideoIdFromUrl();
      const player = document.getElementById('movie_player');
      let response = player?.getPlayerResponse?.();
      if (response?.videoDetails?.videoId !== videoId) response = window.ytInitialPlayerResponse;
      if (!videoId || response?.videoDetails?.videoId !== videoId) return [];
      return response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    } catch {
      return [];
    }
  }

  function isAsrTrack(track) {
    return track?.kind === 'asr' || track?.vssId?.startsWith('a.');
  }

  function selectPreferredOriginalTrack(tracklist) {
    if (!Array.isArray(tracklist) || tracklist.length === 0) return null;
    // ASR metadata is a useful source-language hint, not a guarantee for every video.
    const asrTrack = tracklist.find(isAsrTrack);
    const originalLanguage = asrTrack?.languageCode?.split('-')[0]?.toLowerCase();
    const explicitOriginal = tracklist.find((track) => {
      const label = (track.name?.simpleText || track.name?.runs?.[0]?.text || '').toLowerCase();
      return label.includes('original') || label.includes('原声');
    });
    return explicitOriginal ||
      (originalLanguage && tracklist.find((track) => !isAsrTrack(track) &&
        track.languageCode?.split('-')[0]?.toLowerCase() === originalLanguage)) ||
      asrTrack || tracklist[0];
  }

  function matchSelectedTrack(tracklist, selected) {
    if (!selected?.languageCode) return null;
    if (selected.vssId) {
      const exact = tracklist.find((track) => track.vssId === selected.vssId);
      if (exact) return exact;
    }
    return tracklist.find((track) => track.languageCode === selected.languageCode &&
      Boolean(isAsrTrack(track)) === Boolean(isAsrTrack(selected))) || null;
  }

  function selectCaptionTrack(tracklist = getCaptionTracklist()) {
    try {
      const selected = document.getElementById('movie_player')?.getOption?.('captions', 'track');
      const matching = matchSelectedTrack(tracklist, selected);
      if (matching) return matching;
    } catch {
      // Player options can be temporarily unavailable while navigating.
    }
    return selectPreferredOriginalTrack(tracklist);
  }

  function isSelectedSource(trackMeta) {
    const selected = selectCaptionTrack();
    if (!selected || !trackMeta?.languageCode) return true;
    return selected.languageCode === trackMeta.languageCode &&
      Boolean(isAsrTrack(selected)) === Boolean(isAsrTrack(trackMeta));
  }

  function dispatchCuesToContentScript(cues, trackMeta, sourceUrl, session) {
    if (!isCurrentTrackRequest(session, sourceUrl) || !isSelectedSource(trackMeta)) return false;
    if (!Array.isArray(cues) || !cues.some((cue) => cue.text?.trim())) return false;
    lastDispatchedTrackUrl = sourceUrl;
    lastDispatchedPayload = {
      videoId: session.videoId,
      videoTitle: document.title.replace(/\s*-\s*YouTube$/i, ''),
      languageCode: trackMeta.languageCode || 'auto',
      trackName: trackMeta.name?.simpleText || trackMeta.name?.runs?.[0]?.text || '',
      isAutoGenerated: Boolean(isAsrTrack(trackMeta)),
      cues
    };
    window.postMessage({ source: 'IG_YT_MAIN_BRIDGE', type: 'YT_CUES_LOADED', payload: lastDispatchedPayload }, '*');
    return true;
  }

  async function fetchAndDispatchTrack(baseUrl, trackMeta = {}, session = captureVideoSession()) {
    if (!baseUrl || !isCurrentTrackRequest(session, baseUrl)) return false;
    try {
      capturePotFromTimedTextUrl(baseUrl);
      const urlObj = new URL(baseUrl, window.location.origin);
      urlObj.searchParams.set('fmt', 'json3');
      // Translate the chosen base track ourselves; leave the player's display choice intact.
      urlObj.searchParams.delete('tlang');
      applySessionParamsToUrl(urlObj);
      const finalUrl = urlObj.toString();
      if (finalUrl === lastDispatchedTrackUrl && lastDispatchedPayload && isSelectedSource(trackMeta)) {
        window.postMessage({ source: 'IG_YT_MAIN_BRIDGE', type: 'YT_CUES_LOADED', payload: lastDispatchedPayload }, '*');
        return true;
      }

      // Bypass our fetch interceptor instead of suppressing unrelated concurrent requests.
      const response = await origFetch.call(window, finalUrl, { credentials: 'same-origin', signal: session.signal });
      if (!isCurrentTrackRequest(session, baseUrl)) return false;
      if (response.ok) {
        const rawText = await response.text();
        if (!isCurrentTrackRequest(session, baseUrl)) return false;
        const cues = parseTimedTextPayload(rawText);
        if (cues.length) return dispatchCuesToContentScript(cues, trackMeta, finalUrl, session);
      }

      const fallbackUrl = new URL(baseUrl, window.location.origin);
      fallbackUrl.searchParams.delete('tlang');
      applySessionParamsToUrl(fallbackUrl);
      const fallbackResponse = await origFetch.call(window, fallbackUrl.toString(), {
        credentials: 'same-origin', signal: session.signal
      });
      if (!isCurrentTrackRequest(session, baseUrl)) return false;
      if (fallbackResponse.ok) {
        const rawText = await fallbackResponse.text();
        return dispatchCuesToContentScript(parseTimedTextPayload(rawText), trackMeta, finalUrl, session);
      }
    } catch {
      // Navigation aborts and temporary timedtext failures are recovered by the next extraction.
    }
    return false;
  }

  async function extractCaptionTracksFromPlayer(session = captureVideoSession()) {
    try {
      if (!isCurrentVideoSession(session)) return;
      const tracklist = getCaptionTracklist();
      const preferred = selectCaptionTrack(tracklist);
      const player = document.getElementById('movie_player');
      if (!Array.isArray(tracklist) || tracklist.length === 0) {
        window.postMessage({
          source: 'IG_YT_MAIN_BRIDGE', type: 'YT_NO_CAPTIONS_AVAILABLE',
          payload: { videoId: session.videoId, videoTitle: document.title.replace(/\s*-\s*YouTube$/i, '') }
        }, '*');
        return;
      }
      if (preferred?.baseUrl) {
        ensurePlayerCaptionTrack(player, preferred, session);
        await fetchAndDispatchTrack(preferred.baseUrl, preferred, session);
      }
    } catch {
      // Ignore transient player state errors.
    }
  }

  function ensurePlayerCaptionTrack(player, preferred, session, retryCount = 0) {
    if (!isCurrentVideoSession(session) || !player || !preferred?.languageCode) return;
    try {
      // A valid active track belongs to the viewer; don't force another language or clear translation settings.
      if (matchSelectedTrack(getCaptionTracklist(), player.getOption?.('captions', 'track'))) return;
      player.loadModule?.('captions');
      if (typeof player.getOption !== 'function' || typeof player.setOption !== 'function') return;
      const runtimeTracklist = player.getOption('captions', 'tracklist') || [];
      if (!Array.isArray(runtimeTracklist) || !runtimeTracklist.length) {
        if (retryCount < 3) setTimeout(() => ensurePlayerCaptionTrack(player, preferred, session, retryCount + 1), 380);
        return;
      }
      const matching = matchSelectedTrack(runtimeTracklist, preferred);
      if (matching) player.setOption('captions', 'track', { ...matching });
    } catch {
      // Ignore transient caption-module state errors.
    }
  }

  function handleInterceptedTimedText(reqUrl, rawResponseText, session) {
    if (!isCurrentTrackRequest(session, reqUrl)) return;
    try {
      capturePotFromTimedTextUrl(reqUrl);
      const url = new URL(reqUrl, window.location.origin);
      const requestLanguage = url.searchParams.get('lang') || '';
      const preferred = selectCaptionTrack();
      const requestTrack = {
        languageCode: requestLanguage || 'auto',
        kind: url.searchParams.get('kind') || undefined,
        vssId: url.searchParams.get('vssId') || undefined
      };
      if (url.searchParams.has('tlang') || !isSelectedSource(requestTrack)) {
        if (preferred?.baseUrl) fetchAndDispatchTrack(preferred.baseUrl, preferred, session);
        else if (url.searchParams.has('tlang')) fetchAndDispatchTrack(reqUrl, requestTrack, session);
        return;
      }
      const cues = parseTimedTextPayload(rawResponseText);
      if (cues.length && dispatchCuesToContentScript(cues, preferred || requestTrack, reqUrl, session)) return;
      if (reqUrl !== lastDispatchedTrackUrl) fetchAndDispatchTrack(reqUrl, preferred || requestTrack, session);
    } catch {
      // Ignore malformed URLs/responses from the player.
    }
  }

  // Bind identity before asynchronous work starts, including the response-body read.
  const origOpen = XMLHttpRequest.prototype.open;
  const xhrHandlers = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const previous = xhrHandlers.get(this);
    if (previous) this.removeEventListener('load', previous);
    if (typeof url === 'string' && url.includes('/api/timedtext')) {
      const session = captureVideoSession();
      if (isCurrentTrackRequest(session, url)) capturePotFromTimedTextUrl(url);
      const onLoad = () => {
        try {
          if (!this.responseType || this.responseType === 'text') {
            handleInterceptedTimedText(url, this.responseText, session);
          }
        } catch {
          // ignore non-text responseType access
        }
      };
      xhrHandlers.set(this, onLoad);
      this.addEventListener('load', onLoad, { once: true });
    }
    return origOpen.call(this, method, url, ...rest);
  };

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (...args) {
      const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || String(args[0] || '');
      const session = captureVideoSession();
      const intercept = reqUrl.includes('/api/timedtext') && isCurrentTrackRequest(session, reqUrl);
      if (intercept) capturePotFromTimedTextUrl(reqUrl);
      const response = await origFetch.apply(this, args);
      if (intercept && isCurrentTrackRequest(session, reqUrl)) {
        try {
          response.clone().text().then((rawText) => handleInterceptedTimedText(reqUrl, rawText, session)).catch(() => {});
        } catch {
          // Opaque or already consumed responses cannot be inspected.
        }
      }
      return response;
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

  function scheduleExtraction(delays) {
    const session = captureVideoSession();
    for (const delay of delays) setTimeout(() => extractCaptionTracksFromPlayer(session), delay);
  }

  function checkVideoChange() {
    if (getVideoIdFromUrl() !== lastVideoId) {
      resetVideoSession();
      scheduleExtraction([500, 1800]);
    }
  }

  window.addEventListener('yt-navigate-start', () => {
    navigationPending = true;
    resetVideoSession();
  });
  window.addEventListener('yt-navigate-finish', () => {
    navigationPending = false;
    resetVideoSession();
    scheduleExtraction([450, 1600]);
  });
  window.addEventListener('popstate', () => {
    navigationPending = false;
    resetVideoSession();
    scheduleExtraction([500, 1800]);
  });
  window.addEventListener('load', () => scheduleExtraction([600]));
  setInterval(checkVideoChange, 1200);
})();
