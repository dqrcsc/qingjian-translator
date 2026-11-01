/**
 * Hybrid PDF Engine for Document Studio.
 * Supports:
 * 1. Gemini Native Multimodal PDF Extraction & Bilingual Translation (handles complex 2-column papers, formulas, tables, scanned PDFs)
 * 2. Local Fast PDF Stream Decompression & Text Block Parser (using browser DecompressionStream('deflate'))
 */

import { createDocumentBudget, readBoundedStream } from './document-budget.js';

async function decompressFlateStream(rawBytes, sharedBudget) {
  const budget = sharedBudget || createDocumentBudget();
  try {
    let end = rawBytes.length;
    while (end > 0 && (rawBytes[end - 1] === 0x0a || rawBytes[end - 1] === 0x0d || rawBytes[end - 1] === 0x20)) end--;
    const cleanBytes = rawBytes.subarray(0, end);
    if (cleanBytes.length < 2) return null;
    for (const format of ['deflate', 'deflate-raw']) {
      try {
        budget.check();
        const stream = new Blob([cleanBytes]).stream().pipeThrough(new DecompressionStream(format), { signal: budget.signal });
        const ab = await readBoundedStream(stream, budget,
          (count, total) => budget.addExpandedBytes(count, total, cleanBytes.length));
        return new Uint8Array(ab);
      } catch {
        // Only malformed encoding may fall back; exhausted budgets must escape.
        budget.check();
      }
    }
    return null;
  } finally {
    if (!sharedBudget) budget.dispose();
  }
}

function decodePdfLiteralString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\') {
      const next = raw[++i];
      if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else if (/[0-7]/.test(next)) {
        let oct = next;
        if (/[0-7]/.test(raw[i + 1] || '')) oct += raw[++i];
        if (/[0-7]/.test(raw[i + 1] || '')) oct += raw[++i];
        out += String.fromCharCode(parseInt(oct, 8));
      } else if (next) {
        out += next;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function decodePdfHexString(hexRaw) {
  const clean = String(hexRaw || '').replace(/[^0-9a-fA-F]/g, '');
  if (!clean) return '';
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  // Detect UTF-16BE BOM (FEFF)
  if (padded.length >= 4 && /^feff/i.test(padded)) {
    let out16 = '';
    for (let i = 4; i + 3 < padded.length; i += 4) {
      const code = parseInt(padded.slice(i, i + 4), 16);
      if (code > 0) out16 += String.fromCharCode(code);
    }
    return out16;
  }
  let out = '';
  for (let i = 0; i < padded.length; i += 2) {
    const code = parseInt(padded.slice(i, i + 2), 16);
    if (code >= 32 && code <= 126) {
      out += String.fromCharCode(code);
    } else if (code === 9 || code === 10 || code === 13) {
      out += ' ';
    }
  }
  return out;
}

function extractTextFromPdfStreamContent(streamText) {
  const lines = [];
  const btBlocks = streamText.match(/BT[\s\S]*?ET/g) || [];

  for (const block of btBlocks) {
    let currentLine = '';
    // Match (...) Tj, <HEX> Tj, or [ ... ] TJ
    const tjRegex = /\((?:\\.|[^\\)])*\)\s*Tj|<([0-9a-fA-F\s]+)>\s*Tj|\[([\s\S]*?)\]\s*TJ/g;
    let m;
    while ((m = tjRegex.exec(block)) !== null) {
      if (m[2] !== undefined) {
        // TJ array containing (...) literals and/or <HEX> tokens
        const tokenRegex = /\((?:\\.|[^\\)])*\)|<([0-9a-fA-F\s]+)>/g;
        let tk;
        while ((tk = tokenRegex.exec(m[2])) !== null) {
          if (tk[1] !== undefined) {
            currentLine += decodePdfHexString(tk[1]);
          } else {
            currentLine += decodePdfLiteralString(tk[0].slice(1, -1));
          }
        }
      } else if (m[1] !== undefined) {
        currentLine += decodePdfHexString(m[1]);
      } else {
        const litMatch = m[0].match(/\(([\s\S]*)\)\s*Tj/);
        if (litMatch) {
          currentLine += decodePdfLiteralString(litMatch[1]);
        }
      }
    }
    const cleaned = currentLine.replace(/\s+/g, ' ').trim();
    if (cleaned.length > 1) {
      lines.push(cleaned);
    }
  }

  return lines;
}

/**
 * Local fast extraction of text paragraphs from uncompressed & FlateDecode PDF streams.
 */
export async function extractPdfBlocksLocally(arrayBuffer, { budget: sharedBudget } = {}) {
  const budget = sharedBudget || createDocumentBudget();
  try {
  budget.checkInputBytes(arrayBuffer.byteLength);
  const bytes = new Uint8Array(arrayBuffer);
  const latin1Decoder = new TextDecoder('latin1');
  const rawPdfStr = latin1Decoder.decode(bytes);

  const rawLines = [];
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;

  while ((match = streamRegex.exec(rawPdfStr)) !== null) {
    budget.check();
    const startOffset = match.index + match[0].indexOf('\n') + 1;
    const endOffset = match.index + match[0].lastIndexOf('endstream');
    const slice = bytes.subarray(startOffset, endOffset);

    // Check if preceded by /FlateDecode
    const headerContext = rawPdfStr.slice(Math.max(0, match.index - 260), match.index);
    let contentText = '';
    if (headerContext.includes('/FlateDecode')) {
      const decompressed = await decompressFlateStream(slice, budget);
      if (decompressed) {
        contentText = latin1Decoder.decode(decompressed);
      }
    } else if (!headerContext.includes('/DCTDecode') && !headerContext.includes('/Image')) {
      contentText = match[1];
    }

    if (contentText && contentText.includes('BT')) {
      const extracted = extractTextFromPdfStreamContent(contentText);
      rawLines.push(...extracted);
    }
  }

  // Merge broken lines into logical paragraphs
  const paragraphs = [];
  let buffer = '';
  for (const line of rawLines) {
    if (!/[a-zA-Z\u4e00-\u9fa5]/.test(line)) continue;
    if (!buffer) {
      buffer = line;
    } else if (buffer.endsWith('-')) {
      buffer = buffer.slice(0, -1) + line;
    } else if (/[.!?:;。！？]$/.test(buffer) || buffer.length > 380) {
      paragraphs.push(buffer);
      buffer = line;
    } else {
      buffer += ' ' + line;
    }
  }
  if (buffer) paragraphs.push(buffer);

  budget.check();
  return paragraphs
    .filter((p) => p.length >= 4)
    .map((p, idx) => ({
      id: idx,
      page: Math.floor(idx / 6) + 1,
      type: p.length < 90 && !p.endsWith('.') ? 'heading' : 'paragraph',
      original: p,
      translation: ''
    }));
  } finally {
    if (!sharedBudget) budget.dispose();
  }
}

export function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Estimate total page count of a PDF binary from /Type /Page and /Pages /Count entries,
 * including PDF 1.5+ compressed object streams (/ObjStm).
 */
export function estimatePdfPageCount(arrayBuffer) {
  try {
    const bytes = new Uint8Array(arrayBuffer);
    const latin1Decoder = new TextDecoder('latin1');
    const rawPdfStr = latin1Decoder.decode(bytes);
    const countMatches = [...rawPdfStr.matchAll(/\/Count\s+(\d+)/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n > 0 && n <= 1500);
    if (countMatches.length > 0) {
      return Math.max(...countMatches);
    }
    const pageMatches = rawPdfStr.match(/\/Type\s*\/Page\b(?!s)/g);
    if (pageMatches && pageMatches.length > 0) {
      return pageMatches.length;
    }
  } catch {
    // ignore
  }
  return 6;
}

let pdfjsPromise;
async function loadPdfjs() {
  pdfjsPromise ||= import('./vendor/pdfjs/pdf.mjs');
  const pdfjs = await pdfjsPromise;
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
  return pdfjs;
}

/** Opens a PDF with a real module worker; caller keeps ownership of the original bytes. */
export async function openPdfDocument(arrayBuffer, { signal } = {}) {
  signal?.throwIfAborted();
  if (typeof document !== 'undefined') {
    const pdfjs = await loadPdfjs();
    signal?.throwIfAborted();
    const asset = name => new URL(`./vendor/pdfjs/${name}/`, import.meta.url).href;
    // An explicit local worker avoids PDF.js's blob wrapper for extension URLs
    // (their URL.origin can be "null"). Blob workers are not allowed by our CSP.
    const workerPort = new Worker(new URL('./vendor/pdfjs/pdf.worker.mjs', import.meta.url), { type: 'module' });
    const worker = new pdfjs.PDFWorker({ port: workerPort });
    const loadingTask = pdfjs.getDocument({
      worker,
      data: new Uint8Array(arrayBuffer.slice(0)),
      isEvalSupported: false,
      useWorkerFetch: true,
      cMapUrl: asset('cmaps'), cMapPacked: true,
      standardFontDataUrl: asset('standard_fonts'),
      wasmUrl: asset('wasm'), iccUrl: asset('iccs'),
      verbosity: 0
    });
    let destruction;
    const destroy = () => destruction ||= (async () => {
      try { await loadingTask.destroy(); }
      finally { worker.destroy(); workerPort.terminate(); }
    })();
    const onAbort = () => { void destroy().catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const pdfDoc = await loadingTask.promise;
      signal?.throwIfAborted();
      pdfDoc.destroy = destroy;
      return { pdfDoc, numPages: pdfDoc.numPages };
    } catch (err) {
      await destroy().catch(() => {});
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // Fallback: decompress /ObjStm streams to find /Type /Pages /Count N
  try {
    const bytes = new Uint8Array(arrayBuffer);
    const latin1Decoder = new TextDecoder('latin1');
    const rawPdfStr = latin1Decoder.decode(bytes);
    const counts = [...rawPdfStr.matchAll(/\/Count\s+(\d+)/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n > 0 && n <= 1500);

    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match;
    while ((match = streamRegex.exec(rawPdfStr)) !== null) {
      const headerContext = rawPdfStr.slice(Math.max(0, match.index - 260), match.index);
      if (headerContext.includes('/FlateDecode') && (headerContext.includes('/ObjStm') || counts.length === 0)) {
        const startOffset = match.index + match[0].indexOf('\n') + 1;
        const endOffset = match.index + match[0].lastIndexOf('endstream');
        const decompressed = await decompressFlateStream(bytes.subarray(startOffset, endOffset));
        if (decompressed) {
          const text = latin1Decoder.decode(decompressed);
          const innerCounts = [...text.matchAll(/\/Type\s*\/Pages[\s\S]{0,160}?\/Count\s+(\d+)|\/Count\s+(\d+)[\s\S]{0,160}?\/Type\s*\/Pages/g)].map(
            (m) => Number(m[1] || m[2])
          );
          for (const c of innerCounts) {
            if (c > 0 && c <= 1500) counts.push(c);
          }
        }
      }
    }
    if (counts.length > 0) {
      return { pdfDoc: null, numPages: Math.max(...counts) };
    }
  } catch {
    // ignore
  }

  return { pdfDoc: null, numPages: estimatePdfPageCount(arrayBuffer) };
}

/**
 * Renders a single PDF page (1-indexed) onto an HTML <canvas> using bundled PDFJS,
 * and simultaneously extracts exact vector text coordinates from `page.getTextContent()`.
 */
export const PDF_RENDER_LIMITS = Object.freeze({ maxPixels: 4 * 1024 * 1024, maxEdge: 4096, maxPendingPages: 2 });
const pendingPdfPages = new WeakMap();

function waitForPdfWork(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('PDF 渲染已取消', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export async function renderPdfPageToCanvas(pdfDoc, pageNumber, scale = 2.0, { signal } = {}) {
  signal?.throwIfAborted();
  if (!pdfDoc || typeof document === 'undefined') return null;
  // PDF.js getPage has no cancellation API. Keep unfinished acquisitions bounded
  // even after their callers have aborted; late page objects are cleaned below.
  let pending = pendingPdfPages.get(pdfDoc);
  if (!pending) pendingPdfPages.set(pdfDoc, pending = new Set());
  if (pending.size >= PDF_RENDER_LIMITS.maxPendingPages) throw new Error('PDF 取页任务仍在结束，请稍后重试');
  const acquisition = Promise.resolve().then(() => pdfDoc.getPage(pageNumber));
  pending.add(acquisition);
  void acquisition.then(page => { if (signal?.aborted) page.cleanup?.(); }, () => {}).finally(() => pending.delete(acquisition));
  let page, canvas, renderTask, reader, textCancellation, completed = false;
  const cancelText = () => reader ? (textCancellation ||= Promise.resolve(reader.cancel(signal?.reason)).catch(() => {})) : Promise.resolve();
  const onAbort = () => {
    renderTask?.cancel();
    // Keep a lease until underlying cancelled work actually settles. New work
    // is rejected rather than accumulating detached worker jobs indefinitely.
    const draining = Promise.allSettled([renderTask?.promise, cancelText()]);
    pending.add(draining);
    void draining.finally(() => pending.delete(draining));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    page = await waitForPdfWork(acquisition, signal);
    signal?.throwIfAborted();
    const requestedScale = Number.isFinite(scale) && scale > 0 ? scale : 2;
    const requested = page.getViewport({ scale: requestedScale });
    if (![requested.width, requested.height].every(n => Number.isFinite(n) && n > 0)) throw new Error('PDF 页面尺寸无效');
    const factor = Math.min(1, PDF_RENDER_LIMITS.maxEdge / requested.width,
      PDF_RENDER_LIMITS.maxEdge / requested.height,
      Math.sqrt(PDF_RENDER_LIMITS.maxPixels / requested.width / requested.height));
    const viewport = page.getViewport({ scale: requestedScale * factor });
    if (![viewport.width, viewport.height].every(n => Number.isFinite(n) && n > 0)) throw new Error('PDF 缩放后尺寸无效');
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('PDF 页面画布无法分配');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    renderTask = page.render({ canvasContext: ctx, viewport, intent: 'print' });
    await waitForPdfWork(renderTask.promise, signal);
    signal?.throwIfAborted();
    const textItems = [];
    try {
      // Cancelling the stream asks the worker to stop text extraction as well.
      reader = page.streamTextContent().getReader();
      const utilTransform = (await loadPdfjs()).Util.transform;
      while (true) {
        const { done, value: tc } = await waitForPdfWork(reader.read(), signal);
        signal?.throwIfAborted();
        if (done) break;
        for (const item of tc?.items || []) {
          const rawStr = String(item.str || '');
          if (!rawStr.trim()) continue;
          const tx = utilTransform
            ? utilTransform(viewport.transform, item.transform)
            : [scale * 10, 0, 0, -scale * 10, 0, 0];
          const fontPx = Math.max(6, Math.hypot(tx[2], tx[3]));
          const x = tx[4];
          const yBaseline = tx[5];
          const width = Math.max(fontPx * 0.45, (item.width || 0) * viewport.scale);
          const top = yBaseline - fontPx * 0.84;
          const bottom = yBaseline + fontPx * 0.2;
          textItems.push({
            str: rawStr,
            x,
            top,
            right: x + width,
            bottom,
            width,
            height: bottom - top,
            yBaseline,
            fontPx
          });
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      // Text extraction is optional for scanned pages; rendering remains usable.
    }
    signal?.throwIfAborted();
    const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
    if (!dataUrl.startsWith('data:image/')) throw new Error('PDF 页面图像编码失败');
    completed = true;
    return { canvas, width: canvas.width, height: canvas.height,
      jpegDataUrl: dataUrl, jpegBase64: dataUrl.split(',')[1] || '', textItems };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (reader) { void cancelText(); reader.releaseLock(); }
    if (!completed && canvas) { canvas.width = 0; canvas.height = 0; }
    // On cancellation renderTask may settle on its next microtask. PDF.js defers
    // cleanup while rendering and completes it once its own task is finished.
    page?.cleanup?.();
  }
}

/**
 * Crops the original Figure region [ymin, xmin, ymax, xmax] (0-1000 page coordinates)
 * into a dedicated HTMLCanvasElement and returns both the canvas and PNG dataUrl.
 */
export function cropFigureCanvasObject(pageCanvas, figureBox2d) {
  if (!pageCanvas || !Array.isArray(figureBox2d) || figureBox2d.length < 4) return null;
  let [ymin, xmin, ymax, xmax] = figureBox2d.map((n) => Number(n) || 0);
  ymin = Math.max(0, ymin - 12);
  xmin = Math.max(0, xmin - 12);
  ymax = Math.min(1000, ymax + 12);
  xmax = Math.min(1000, xmax + 12);

  if (ymax - ymin < 40 || xmax - xmin < 60) return null;

  const sx = Math.round((xmin / 1000) * pageCanvas.width);
  const sy = Math.round((ymin / 1000) * pageCanvas.height);
  const sw = Math.max(40, Math.round(((xmax - xmin) / 1000) * pageCanvas.width));
  const sh = Math.max(30, Math.round(((ymax - ymin) / 1000) * pageCanvas.height));

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = sw;
  cropCanvas.height = sh;
  const ctx = cropCanvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sw, sh);
  ctx.drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return {
    cropCanvas,
    sx,
    sy,
    sw,
    sh,
    originalDataUrl: cropCanvas.toDataURL('image/png')
  };
}

export function cropFigureFromPageCanvas(pageCanvas, figureBox2d) {
  const obj = cropFigureCanvasObject(pageCanvas, figureBox2d);
  return obj ? obj.originalDataUrl : '';
}

/**
 * Extracts and groups vector PDF text items falling inside a figure's bounding box.
 * Preserves exact line-level pixel bounding boxes, font sizes, and alignment so
 * the original English text can be cleanly erased and redrawn in native figure style.
 */
export function extractFigureVectorTextGroups(pageTextItems, pageWidth, pageHeight, figureBox2d) {
  if (
    !Array.isArray(pageTextItems) ||
    pageTextItems.length === 0 ||
    !Array.isArray(figureBox2d) ||
    figureBox2d.length < 4
  ) {
    return [];
  }

  const ymin = Math.max(0, (Number(figureBox2d[0]) || 0) - 12);
  const xmin = Math.max(0, (Number(figureBox2d[1]) || 0) - 12);
  const ymax = Math.min(1000, (Number(figureBox2d[2]) || 0) + 12);
  const xmax = Math.min(1000, (Number(figureBox2d[3]) || 0) + 12);
  if (ymax - ymin < 40 || xmax - xmin < 60) return [];

  const sx = Math.round((xmin / 1000) * pageWidth);
  const sy = Math.round((ymin / 1000) * pageHeight);
  const sw = Math.max(40, Math.round(((xmax - xmin) / 1000) * pageWidth));
  const sh = Math.max(30, Math.round(((ymax - ymin) / 1000) * pageHeight));

  // 1. Filter text runs inside the cropped figure region and convert to crop-local pixel coords
  const rawRuns = [];
  for (const it of pageTextItems) {
    const cx = it.x + it.width * 0.5;
    const cy = it.top + it.height * 0.5;
    if (cx < sx + 2 || cx > sx + sw - 2 || cy < sy + 2 || cy > sy + sh - 2) continue;
    const itemRight = it.right ?? it.x + it.width;
    const itemBaseline = it.yBaseline ?? it.y ?? it.bottom;
    const itemFontPx = it.fontPx ?? it.fontSize ?? it.height ?? 16;
    rawRuns.push({
      str: it.str,
      x: it.x - sx,
      top: it.top - sy,
      right: itemRight - sx,
      bottom: it.bottom - sy,
      width: it.width,
      height: it.height,
      yBaseline: itemBaseline - sy,
      fontPx: itemFontPx
    });
  }
  if (rawRuns.length === 0) return [];

  // 2. Sort runs by baseline Y then X, and merge adjacent horizontal fragments on the same line
  rawRuns.sort((a, b) => {
    const tol = Math.min(a.fontPx, b.fontPx) * 0.36;
    if (Math.abs(a.yBaseline - b.yBaseline) > tol) {
      return a.yBaseline - b.yBaseline;
    }
    return a.x - b.x;
  });

  const mergedLines = [];
  for (const run of rawRuns) {
    const prev = mergedLines[mergedLines.length - 1];
    if (prev) {
      const sameBaseline =
        Math.abs(run.yBaseline - prev.yBaseline) <= Math.min(run.fontPx, prev.fontPx) * 0.38;
      const gap = run.x - prev.right;
      const maxMergeGap = Math.max(run.fontPx, prev.fontPx) * 0.92;
      if (sameBaseline && gap >= -prev.fontPx * 0.45 && gap <= maxMergeGap) {
        const needSpace =
          gap > prev.fontPx * 0.16 &&
          !prev.str.endsWith(' ') &&
          !prev.str.endsWith('-') &&
          !run.str.startsWith(' ');
        prev.str += (needSpace ? ' ' : '') + run.str;
        prev.right = Math.max(prev.right, run.right);
        prev.x = Math.min(prev.x, run.x);
        prev.top = Math.min(prev.top, run.top);
        prev.bottom = Math.max(prev.bottom, run.bottom);
        prev.width = prev.right - prev.x;
        prev.height = prev.bottom - prev.top;
        prev.fontPx = Math.max(prev.fontPx, run.fontPx);
        continue;
      }
    }
    mergedLines.push({ ...run });
  }

  // 3. Filter out figure caption lines at the bottom or pure numbers/codes
  const diagramLines = mergedLines
    .map((ln) => ({ ...ln, str: ln.str.replace(/\s+/g, ' ').trim() }))
    .filter((ln) => {
      const s = ln.str;
      if (!s) return false;
      if (/^(Figure|Fig\.|Table)\s*\d+\s*[:.]/i.test(s)) return false;
      if (ln.width > sw * 0.65 && s.length > 68) return false;
      return true;
    });

  // 4. Group vertically stacked short lines that belong to the same node/label
  diagramLines.sort((a, b) => a.top - b.top || a.x - b.x);
  const groups = [];
  const used = new Set();

  for (let i = 0; i < diagramLines.length; i++) {
    if (used.has(i)) continue;
    const seed = diagramLines[i];
    used.add(i);

    const groupLines = [seed];
    let gLeft = seed.x;
    let gRight = seed.right;
    let gTop = seed.top;
    let gBottom = seed.bottom;

    // Look ahead for stacked continuation lines of this label
    let changed = true;
    while (changed) {
      changed = false;
      const lastLine = groupLines[groupLines.length - 1];
      for (let j = i + 1; j < diagramLines.length; j++) {
        if (used.has(j)) continue;
        const cand = diagramLines[j];
        const vGap = cand.top - lastLine.bottom;
        if (vGap > lastLine.fontPx * 0.62) break;
        if (vGap < -lastLine.fontPx * 0.28) continue;

        const fontDiff = Math.abs(cand.fontPx - lastLine.fontPx);
        if (fontDiff > Math.max(cand.fontPx, lastLine.fontPx) * 0.18) continue;

        // Do not merge standalone numbered rows like "Level 1: ..." and "Level 2: ..."
        if (/^(Level|Tier|Step|Stage|\([a-z0-9]\))\b/i.test(cand.str)) continue;
        if (/^(Level|Tier|Step|Stage|\([a-z0-9]\))\b/i.test( seed.str ) && seed.width > sw * 0.18) continue;
        // Skip pure numeric/code tokens
        if (/^[\d.+\-*/=()[\],\s]+$/.test(cand.str) || /^[\d.+\-*/=()[\],\s]+$/.test(lastLine.str)) {
          continue;
        }

        const lastCenter = (lastLine.x + lastLine.right) * 0.5;
        const candCenter = (cand.x + cand.right) * 0.5;
        const centerAligned =
          Math.abs(lastCenter - candCenter) <=
          Math.min(lastLine.width, cand.width) * 0.45 + lastLine.fontPx * 0.9;
        const leftAligned =
          Math.abs(lastLine.x - cand.x) <= lastLine.fontPx * 0.75 &&
          Math.min(lastLine.right, cand.right) - Math.max(lastLine.x, cand.x) > 0;

        if (centerAligned || leftAligned) {
          used.add(j);
          groupLines.push(cand);
          gLeft = Math.min(gLeft, cand.x);
          gRight = Math.max(gRight, cand.right);
          gTop = Math.min(gTop, cand.top);
          gBottom = Math.max(gBottom, cand.bottom);
          changed = true;
          break;
        }
      }
    }

    const combinedText = groupLines
      .map((l) => l.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Keep only meaningful English phrases (skip short codes like T1D, T2DM, E10.6, 3.3, etc.)
    if (!/[a-zA-Z]{3,}/.test(combinedText)) continue;
    if (/^[A-Z0-9.\-+()[\],\s]{1,6}$/.test(combinedText)) continue;

    const avgFontPx =
      groupLines.reduce((acc, l) => acc + l.fontPx, 0) / groupLines.length;
    const isLeftAlignedList =
      /^(Level|Tier|Step|Stage)\s*\d+/i.test(combinedText) ||
      (groupLines.length > 1 &&
        Math.abs(groupLines[0].x - groupLines[groupLines.length - 1].x) < avgFontPx * 0.4 &&
        Math.abs(
          (groupLines[0].x + groupLines[0].right) * 0.5 -
            (groupLines[groupLines.length - 1].x + groupLines[groupLines.length - 1].right) * 0.5
        ) > avgFontPx * 0.9);

    groups.push({
      original: combinedText,
      translation: '',
      lines: groupLines,
      lineRects: groupLines,
      x: gLeft,
      top: gTop,
      right: gRight,
      bottom: gBottom,
      width: gRight - gLeft,
      height: gBottom - gTop,
      fontPx: avgFontPx,
      align: isLeftAlignedList ? 'left' : 'center',
      box_2d: [
        Math.round((gTop / sh) * 1000),
        Math.round((gLeft / sw) * 1000),
        Math.round((gBottom / sh) * 1000),
        Math.round((gRight / sw) * 1000)
      ]
    });
  }

  return groups;
}

/**
 * Samples the local background color (bright/perimeter mode) and original text ink color
 * around a pixel rectangle [rx, ry, rw, rh] on a 2D canvas context.
 */
function sampleRegionColorsFromCanvas(ctx, canvasW, canvasH, rx, ry, rw, rh) {
  const x0 = Math.max(0, Math.floor(rx - 2));
  const y0 = Math.max(0, Math.floor(ry - 2));
  const x1 = Math.min(canvasW, Math.ceil(rx + rw + 2));
  const y1 = Math.min(canvasH, Math.ceil(ry + rh + 2));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 1 || h <= 1) {
    return {
      bgRgb: [255, 255, 255],
      bgCss: '#ffffff',
      textCss: '#111827'
    };
  }

  const imgData = ctx.getImageData(x0, y0, w, h).data;
  const perimeterSamples = [];
  const innerSamples = [];

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const idx = (py * w + px) * 4;
      const r = imgData[idx];
      const g = imgData[idx + 1];
      const b = imgData[idx + 2];
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      const isPerimeter = px <= 1 || py <= 1 || px >= w - 2 || py >= h - 2;
      if (isPerimeter) {
        perimeterSamples.push({ r, g, b, lum });
      } else {
        innerSamples.push({ r, g, b, lum });
      }
    }
  }

  // Pick 70th-percentile brightest perimeter pixel so nearby thin lines don't skew background color
  perimeterSamples.sort((a, b) => a.lum - b.lum);
  const bgSample =
    perimeterSamples[Math.min(perimeterSamples.length - 1, Math.floor(perimeterSamples.length * 0.72))] ||
    { r: 255, g: 255, b: 255, lum: 255 };

  // Find original text ink color from highest-contrast inner pixels
  let textSample = { r: 17, g: 24, b: 39 };
  if (innerSamples.length > 0) {
    innerSamples.sort((a, b) => {
      const distA =
        Math.abs(a.r - bgSample.r) + Math.abs(a.g - bgSample.g) + Math.abs(a.b - bgSample.b);
      const distB =
        Math.abs(b.r - bgSample.r) + Math.abs(b.g - bgSample.g) + Math.abs(b.b - bgSample.b);
      return distB - distA;
    });
    const topContrast = innerSamples[Math.floor(innerSamples.length * 0.08)] || innerSamples[0];
    const contrastDist =
      Math.abs(topContrast.r - bgSample.r) +
      Math.abs(topContrast.g - bgSample.g) +
      Math.abs(topContrast.b - bgSample.b);
    if (contrastDist > 65) {
      textSample = topContrast;
    }
  }

  return {
    bgRgb: [bgSample.r, bgSample.g, bgSample.b],
    bgCss: `rgb(${bgSample.r}, ${bgSample.g}, ${bgSample.b})`,
    textCss: `rgb(${textSample.r}, ${textSample.g}, ${textSample.b})`
  };
}

/**
 * Splits a translated string into `targetLineCount` balanced lines, or wraps by `maxWidthPx`.
 */
function wrapTextForFigureRegion(ctx, text, maxWidthPx, targetLineCount = 1) {
  const clean = String(text || '').trim();
  if (!clean) return [];

  if (targetLineCount <= 1 && ctx.measureText(clean).width <= maxWidthPx) {
    return [clean];
  }

  // Tokenize into words/CJK characters
  const tokens = clean.match(/([a-zA-Z0-9.+_-]+|\s+|[^\s])/g) || [clean];
  const lines = [];
  let current = '';

  const effectiveMaxW =
    targetLineCount > 1
      ? Math.min(maxWidthPx, (ctx.measureText(clean).width / targetLineCount) * 1.18)
      : maxWidthPx;

  for (const tok of tokens) {
    const next = current + tok;
    if (current.trim() && ctx.measureText(next.trim()).width > effectiveMaxW) {
      lines.push(current.trim());
      current = tok.trimStart();
    } else {
      current = next;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

/**
 * Inpaints (seamlessly erases) the original English text lines on a figure canvas using their
 * exact local background colors, and draws the translated text in native figure typography
 * (matching font size, color, alignment, with zero borders or shadows).
 */
export function renderSeamlessFigureTranslation(cropCanvas, groupsOrLabels) {
  if (!cropCanvas || typeof document === 'undefined') {
    return {
      translatedDataUrl: '',
      originalDataUrl: '',
      labels: []
    };
  }

  const originalDataUrl = cropCanvas.toDataURL('image/png');
  if (!Array.isArray(groupsOrLabels) || groupsOrLabels.length === 0) {
    return {
      translatedDataUrl: originalDataUrl,
      originalDataUrl,
      labels: []
    };
  }

  const cw = cropCanvas.width;
  const ch = cropCanvas.height;
  const srcCtx = cropCanvas.getContext('2d', { willReadFrequently: true });

  const outCanvas = document.createElement('canvas');
  outCanvas.width = cw;
  outCanvas.height = ch;
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
  outCtx.drawImage(cropCanvas, 0, 0);

  const preparedItems = [];

  // Pass 1: Sample colors & seamlessly erase original text lines on outCtx
  for (const item of groupsOrLabels) {
    const trans = String(item.translation || '').trim();
    if (!trans) continue;

    let gx;
    let gTop;
    let gRight;
    let gBottom;
    let gFontPx;
    let gAlign = item.align || 'center';
    let lineRects = [];

    if (Array.isArray(item.lines) && item.lines.length > 0) {
      gx = item.x;
      gTop = item.top;
      gRight = item.right;
      gBottom = item.bottom;
      gFontPx = item.fontPx || (gBottom - gTop) / item.lines.length;
      lineRects = item.lines.map((l) => ({
        x: l.x,
        top: l.top,
        width: l.width,
        height: l.height
      }));
    } else if (Array.isArray(item.box_2d) && item.box_2d.length === 4) {
      const [ymin, xmin, ymax, xmax] = item.box_2d;
      gx = (xmin / 1000) * cw;
      gTop = (ymin / 1000) * ch;
      gRight = (xmax / 1000) * cw;
      gBottom = (ymax / 1000) * ch;
      gFontPx = Math.min(28, Math.max(12, (gBottom - gTop) * 0.72));
      lineRects = [
        {
          x: gx,
          top: gTop,
          width: Math.max(10, gRight - gx),
          height: Math.max(8, gBottom - gTop)
        }
      ];
    } else {
      continue;
    }

    const gw = Math.max(8, gRight - gx);
    const gh = Math.max(8, gBottom - gTop);
    const colors = sampleRegionColorsFromCanvas(srcCtx, cw, ch, gx, gTop, gw, gh);

    // Erase each individual line rect tightly using its local background color
    for (const lr of lineRects) {
      const lineColors = sampleRegionColorsFromCanvas(srcCtx, cw, ch, lr.x, lr.top, lr.width, lr.height);
      outCtx.fillStyle = lineColors.bgCss;
      // Tight glyph erasure (1px horizontal pad, 0.5px vertical pad) so adjacent borders/arrows are never touched
      outCtx.fillRect(
        Math.max(0, lr.x - 1),
        Math.max(0, lr.top - 0.5),
        Math.min(cw, lr.width + 2),
        Math.min(ch, lr.height + 1)
      );
    }

    preparedItems.push({
      original: item.original || '',
      translation: trans,
      gx,
      gTop,
      gRight,
      gBottom,
      gw,
      gh,
      gFontPx,
      gAlign,
      origLineCount: lineRects.length,
      colors,
      box_2d: item.box_2d || [
        Math.round((gTop / ch) * 1000),
        Math.round((gx / cw) * 1000),
        Math.round((gBottom / ch) * 1000),
        Math.round((gRight / cw) * 1000)
      ]
    });
  }

  // Pass 2: Draw native Chinese text in-place with matched font size, color, and alignment
  const fontFamily = `"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", -apple-system, sans-serif`;

  for (const p of preparedItems) {
    const isSubfigHeader = /^\([a-z0-9]\)/i.test(p.original.trim());
    const fontWeight = isSubfigHeader ? '600' : '500';
    const maxAllowedW = Math.max(p.gw * 1.16, p.gFontPx * 3.8);
    const maxAllowedH = Math.max(p.gh * 1.24, p.gFontPx * 1.28);

    let fontPx = Math.round(p.gFontPx * 0.92);
    const minFontPx = Math.max(10, Math.round(p.gFontPx * 0.64));
    let wrappedLines = [p.translation];

    while (fontPx >= minFontPx) {
      outCtx.font = `${fontWeight} ${fontPx}px ${fontFamily}`;
      wrappedLines = wrapTextForFigureRegion(
        outCtx,
        p.translation,
        maxAllowedW,
        p.origLineCount
      );
      const widest = Math.max(...wrappedLines.map((l) => outCtx.measureText(l).width), 0);
      const totalH = wrappedLines.length * (fontPx * 1.16);
      if (widest <= maxAllowedW * 1.04 && totalH <= maxAllowedH) {
        break;
      }
      fontPx -= 1;
    }

    outCtx.font = `${fontWeight} ${fontPx}px ${fontFamily}`;
    outCtx.fillStyle = p.colors.textCss;
    outCtx.textBaseline = 'middle';

    const lineHeight = fontPx * 1.16;
    const totalTextH = wrappedLines.length * lineHeight;
    const startCenterY = p.gTop + (p.gh - totalTextH) * 0.5 + lineHeight * 0.5;

    for (let idx = 0; idx < wrappedLines.length; idx++) {
      const lineStr = wrappedLines[idx];
      const cy = startCenterY + idx * lineHeight;
      if (p.gAlign === 'left') {
        outCtx.textAlign = 'left';
        outCtx.fillText(lineStr, p.gx, cy);
      } else {
        outCtx.textAlign = 'center';
        outCtx.fillText(lineStr, p.gx + p.gw * 0.5, cy);
      }
    }
  }

  return {
    translatedDataUrl: outCanvas.toDataURL('image/png'),
    originalDataUrl,
    labels: preparedItems.map((p) => ({
      box_2d: p.box_2d,
      original: p.original,
      translation: p.translation
    }))
  };
}

/**
 * Filters out numeric/tick noise (e.g. "85.2", "100%", "0.8") and converts label box_2d
 * coordinates into clean non-overlapping [ymin, xmin, ymax, xmax] (0-1000) relative to the cropped figure.
 */
export function normalizeFigureLabelsToCrop(figureLabels, figureBox2d) {
  if (!Array.isArray(figureLabels) || figureLabels.length === 0) return [];

  const hasValidFigBox =
    Array.isArray(figureBox2d) &&
    figureBox2d.length === 4 &&
    figureBox2d[2] - figureBox2d[0] >= 40 &&
    figureBox2d[3] - figureBox2d[1] >= 60;

  const figYMin = hasValidFigBox ? Math.max(0, figureBox2d[0] - 12) : 0;
  const figXMin = hasValidFigBox ? Math.max(0, figureBox2d[1] - 12) : 0;
  const figHeight = hasValidFigBox ? Math.max(50, Math.min(1000, figureBox2d[2] + 12) - figYMin) : 1000;
  const figWidth = hasValidFigBox ? Math.max(60, Math.min(1000, figureBox2d[3] + 12) - figXMin) : 1000;

  const insideFigBoxCount = hasValidFigBox
    ? figureLabels.filter((l) => {
        const b = l.box_2d;
        return (
          Array.isArray(b) &&
          b[0] >= figYMin - 30 &&
          b[2] <= figYMin + figHeight + 30 &&
          b[1] >= figXMin - 30 &&
          b[3] <= figXMin + figWidth + 30
        );
      }).length
    : 0;
  const usePageRelativeTransform = hasValidFigBox && insideFigBoxCount >= Math.ceil(figureLabels.length * 0.5);

  const cleaned = [];
  for (const raw of figureLabels) {
    const orig = String(raw.original || '').trim();
    const trans = String(raw.translation || '').trim();
    if (!trans) continue;
    if (/^[\d\s.,:%+\-*/=<>()[\]~±×÷]+$/.test(orig || trans)) continue;
    if ((orig || trans).length <= 2 && !/[\u4e00-\u9fa5]/.test(trans)) continue;

    let [ymin, xmin, ymax, xmax] = Array.isArray(raw.box_2d) ? raw.box_2d : [100, 100, 180, 350];
    if (usePageRelativeTransform) {
      ymin = Math.round(((ymin - figYMin) / figHeight) * 1000);
      ymax = Math.round(((ymax - figYMin) / figHeight) * 1000);
      xmin = Math.round(((xmin - figXMin) / figWidth) * 1000);
      xmax = Math.round(((xmax - figXMin) / figWidth) * 1000);
    }

    ymin = Math.max(5, Math.min(950, ymin));
    xmin = Math.max(5, Math.min(950, xmin));
    ymax = Math.max(ymin + 22, Math.min(992, ymax));
    xmax = Math.max(xmin + 35, Math.min(995, xmax));

    const overlapsExisting = cleaned.some((ex) => {
      const [ey1, ex1, ey2, ex2] = ex.box_2d;
      const interY = Math.max(0, Math.min(ymax, ey2) - Math.max(ymin, ey1));
      const interX = Math.max(0, Math.min(xmax, ex2) - Math.max(xmin, ex1));
      const interArea = interY * interX;
      const minArea = Math.min((ymax - ymin) * (xmax - xmin), (ey2 - ey1) * (ex2 - ex1));
      return minArea > 0 && interArea / minArea > 0.4;
    });

    if (!overlapsExisting) {
      cleaned.push({
        box_2d: [ymin, xmin, ymax, xmax],
        original: orig,
        translation: trans
      });
    }
  }

  return cleaned.slice(0, 16);
}

/**
 * Scans a candidate rectangular region on the rendered PDF page canvas for non-white pixels
 * (and/or internal vector text items) to compute a tight normalized [ymin, xmin, ymax, xmax] (0-1000) figureBox2d.
 */
function computeFigureBox2dInRegion(pageCanvas, pageW, pageH, regionLeft, regionTop, regionRight, regionBottom, textItems = []) {
  const x0 = Math.max(0, Math.floor(regionLeft));
  const y0 = Math.max(0, Math.floor(regionTop));
  const x1 = Math.min(pageW, Math.ceil(regionRight));
  const y1 = Math.min(pageH, Math.ceil(regionBottom));
  if (x1 - x0 < 50 || y1 - y0 < 36) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  // 1. Include bounds of any vector text items inside the candidate figure region
  for (const it of textItems) {
    const right = it.right ?? it.x + (it.width || 0);
    const bottom = it.bottom ?? it.top + (it.height || 14);
    const cx = (it.x + right) * 0.5;
    const cy = (it.top + bottom) * 0.5;
    if (cx >= x0 + 4 && cx <= x1 - 4 && cy >= y0 + 4 && cy <= y1 - 4) {
      minX = Math.min(minX, it.x);
      minY = Math.min(minY, it.top);
      maxX = Math.max(maxX, right);
      maxY = Math.max(maxY, bottom);
    }
  }

  // 2. Scan rendered canvas pixels for non-white graphic strokes/fills
  if (pageCanvas && typeof pageCanvas.getContext === 'function') {
    try {
      const ctx = pageCanvas.getContext('2d', { willReadFrequently: true });
      const w = x1 - x0;
      const h = y1 - y0;
      const data = ctx.getImageData(x0, y0, w, h).data;
      const step = 2;
      for (let py = 0; py < h; py += step) {
        for (let px = 0; px < w; px += step) {
          const idx = (py * w + px) * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          const a = data[idx + 3];
          if (a > 25 && (r < 245 || g < 245 || b < 245)) {
            const absX = x0 + px;
            const absY = y0 + py;
            if (absX < minX) minX = absX;
            if (absY < minY) minY = absY;
            if (absX > maxX) maxX = absX;
            if (absY > maxY) maxY = absY;
          }
        }
      }
    } catch {
      // Fallback to region bounds if canvas pixel read is unavailable
    }
  }

  if (!Number.isFinite(minX) || maxX - minX < 45 || maxY - minY < 32) {
    minX = x0;
    minY = y0;
    maxX = x1;
    maxY = y1;
  }

  const ymin = Math.max(0, Math.min(970, Math.round((minY / pageH) * 1000) - 6));
  const xmin = Math.max(0, Math.min(970, Math.round((minX / pageW) * 1000) - 6));
  const ymax = Math.min(1000, Math.max(ymin + 40, Math.round((maxY / pageH) * 1000) + 6));
  const xmax = Math.min(1000, Math.max(xmin + 60, Math.round((maxX / pageW) * 1000) + 6));
  return [ymin, xmin, ymax, xmax];
}

/**
 * Reconstructs layout-preserving academic blocks (headings, authors, 2-column vs full-width paragraphs,
 * equations, figures with figureBox2d, and captions) directly from PDF.js vector text coordinates and canvas.
 * Designed for text-only OpenAI-compatible models (e.g. DeepSeek, Qwen, Kimi, GLM) so they achieve
 * full text extraction and publication-grade paper layout without affecting the Gemini Multimodal pipeline.
 */
export function extractStructuredPdfPageBlocks(pageRender, pageNumber = 1) {
  const rawItems = Array.isArray(pageRender?.textItems) ? pageRender.textItems : [];
  if (rawItems.length === 0) return [];

  const pageW = Math.max(400, Number(pageRender.width) || 1224);
  const pageH = Math.max(500, Number(pageRender.height) || 1584);
  const pageNum = Math.max(1, Number(pageNumber) || 1);

  // 1. Normalize & filter marginal stamps / bare running page numbers
  const normItems = [];
  for (const it of rawItems) {
    const rawStr = String(it.str || '');
    const trimmed = rawStr.trim();
    if (!trimmed) continue;

    const fontPx = Math.max(6, Number(it.fontPx ?? it.fontSize ?? it.height) || 16);
    const x = Number(it.x) || 0;
    const top = Number(it.top) || 0;
    const width = Math.max(fontPx * 0.4, Number(it.width) || trimmed.length * fontPx * 0.5);
    const height = Math.max(fontPx * 0.75, Number(it.height) || fontPx);
    const right = Number(it.right ?? x + width);
    const bottom = Number(it.bottom ?? top + height);
    const yBaseline = Number(it.yBaseline ?? bottom);

    // Filter vertical side-margin arXiv stamps or watermarks along extreme edges
    if (right < pageW * 0.046 || x > pageW * 0.962) continue;
    // Filter bare page numbers at extreme top/bottom margins
    if ((bottom < pageH * 0.042 || top > pageH * 0.955) && /^\d{1,4}$/.test(trimmed)) {
      continue;
    }

    normItems.push({
      str: rawStr,
      trimmed,
      x,
      top,
      right,
      bottom,
      width: right - x,
      height: bottom - top,
      yBaseline,
      fontPx
    });
  }

  if (normItems.length === 0) return [];

  // 2. Snap inline superscripts/subscripts to their host line baseline, bucket into transitive
  //    visual rows, and merge left-to-right runs while preventing merges across the 2-column gutter.
  for (const it of normItems) {
    it.lineY = it.yBaseline;
    it.baseFontPx = it.fontPx;
    it.isScriptCandidate = false;
  }

  normItems.sort((a, b) => a.x - b.x || a.yBaseline - b.yBaseline);

  // Pass 2A-1: Snap script-sized items (e.g. author/affiliation superscripts "1", "1,2,4,*") to nearest host item
  for (let i = 0; i < normItems.length; i++) {
    const it = normItems[i];
    const isPureSupToken = /^[0-9,∗*†‡§*]+$/.test(it.trimmed) && it.trimmed.length <= 16;
    const minHostRatio = isPureSupToken ? 1.08 : 1.14;
    const inTopHeaderBand = pageNum === 1 && it.top < pageH * 0.28;

    let bestHost = null;
    let bestDist = Infinity;

    for (let j = 0; j < normItems.length; j++) {
      if (i === j) continue;
      const host = normItems[j];
      if (host.fontPx < it.fontPx * minHostRatio) continue;
      if (
        it.yBaseline < host.yBaseline - host.fontPx * 0.95 ||
        it.yBaseline > host.yBaseline + host.fontPx * 0.5
      ) {
        continue;
      }
      if (it.x > host.right + host.fontPx * 3.5 || it.right < host.x - host.fontPx * 2.2) {
        continue;
      }
      const hGap = it.x >= host.right ? it.x - host.right : host.x > it.right ? host.x - it.right : 0;
      if (
        !inTopHeaderBand &&
        ((host.right <= pageW * 0.525 && it.x >= pageW * 0.475) ||
          (it.right <= pageW * 0.525 && host.x >= pageW * 0.475)) &&
        hGap > host.fontPx * 0.8
      ) {
        continue;
      }
      // Prefer host immediately to the left (trailing superscript) or right (leading affiliation superscript)
      const weightedDist = hGap + Math.abs(it.yBaseline - host.yBaseline) * 0.25;
      if (weightedDist < bestDist) {
        bestDist = weightedDist;
        bestHost = host;
      }
    }

    if (bestHost) {
      it.lineY = bestHost.yBaseline;
      it.baseFontPx = bestHost.fontPx;
      it.isScriptCandidate = true;
    }
  }

  // Pass 2A-2: Chain multi-piece superscripts (e.g. "1," followed by "*" as separate PDF text items)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < normItems.length; i++) {
      const it = normItems[i];
      if (it.isScriptCandidate) continue;
      if (!/^[0-9,∗*†‡§a-zA-Z+\-()]{1,12}$/.test(it.trimmed)) continue;
      for (let j = 0; j < normItems.length; j++) {
        if (i === j) continue;
        const peer = normItems[j];
        if (!peer.isScriptCandidate) continue;
        if (it.fontPx > peer.baseFontPx * 0.92) continue;
        if (Math.abs(it.yBaseline - peer.yBaseline) > Math.max(it.fontPx, peer.fontPx) * 0.38) continue;
        if (it.x <= peer.right + peer.fontPx * 1.5 && it.right >= peer.x - peer.fontPx * 1.5) {
          it.lineY = peer.lineY;
          it.baseFontPx = peer.baseFontPx;
          it.isScriptCandidate = true;
          break;
        }
      }
    }
  }

  // Pass 2B: Transitive row bucketing by lineY followed by strict left-to-right X sort within each row
  normItems.sort((a, b) => a.lineY - b.lineY || a.x - b.x);
  let currentRowId = 0;
  let currentRowY = normItems[0].lineY;
  let currentRowFont = normItems[0].baseFontPx;
  normItems[0].rowId = 0;

  for (let i = 1; i < normItems.length; i++) {
    const it = normItems[i];
    const rowTol = Math.max(currentRowFont, it.baseFontPx) * 0.45;
    if (Math.abs(it.lineY - currentRowY) <= rowTol) {
      it.rowId = currentRowId;
      if (!it.isScriptCandidate) {
        currentRowY = currentRowY * 0.7 + it.lineY * 0.3;
        currentRowFont = Math.max(currentRowFont, it.baseFontPx);
      }
    } else {
      currentRowId++;
      currentRowY = it.lineY;
      currentRowFont = it.baseFontPx;
      it.rowId = currentRowId;
    }
  }

  normItems.sort((a, b) => a.rowId - b.rowId || a.x - b.x);

  const lines = [];
  for (const run of normItems) {
    const prev = lines[lines.length - 1];
    if (prev) {
      const sameRow = run.rowId === prev.rowId;
      const maxFont = Math.max(prev.baseFontPx || prev.fontPx, run.baseFontPx || run.fontPx);
      const minFont = Math.min(prev.fontPx, run.fontPx);
      const baseDiff = Math.abs(run.lineY - prev.lineY);
      const isSameBaseline = sameRow || baseDiff <= maxFont * 0.45;
      const isInlineScript =
        (run.isScriptCandidate || prev.isScriptCandidate || run.fontPx <= prev.fontPx * 0.88) &&
        run.top < prev.bottom + maxFont * 0.3 &&
        run.bottom > prev.top - maxFont * 0.4 &&
        run.x - prev.right <= maxFont * 1.2;

      const gap = run.x - prev.right;
      const inPage1HeaderBand = pageNum === 1 && run.top < pageH * 0.25;
      // Never merge across the central gutter of a 2-column body layout
      const crossesCenterGutter =
        !inPage1HeaderBand &&
        prev.right <= pageW * 0.525 &&
        run.x >= pageW * 0.475 &&
        gap > maxFont * 0.82;
      const maxAllowedGap = inPage1HeaderBand ? maxFont * 3.2 : maxFont * 1.65;

      if (
        (isSameBaseline || isInlineScript) &&
        !crossesCenterGutter &&
        gap >= -maxFont * 0.55 &&
        gap <= maxAllowedGap
      ) {
        const prevIsLeadingSuperscript =
          !prev.hasMainBaseline &&
          prev.fontPx <= run.fontPx * 0.9 &&
          prev.yBaseline < run.yBaseline - run.fontPx * 0.1 &&
          /^[0-9,∗*†‡§*]{1,10}$/.test(prev.trimmed);

        const isTrailingSuperscript =
          prev.hasMainBaseline &&
          run.fontPx <= prev.fontPx * 0.9 &&
          run.yBaseline < prev.yBaseline - prev.fontPx * 0.1 &&
          /^[0-9,∗*†‡§a-zA-Z+\-()]{1,14}$/.test(run.trimmed);

        if (prevIsLeadingSuperscript) {
          prev.str = `$^{${prev.trimmed}}$ ${run.str.trimStart()}`;
          prev.yBaseline = run.yBaseline;
          prev.lineY = run.lineY;
          prev.fontPx = run.fontPx;
          prev.baseFontPx = run.baseFontPx || run.fontPx;
          prev.hasMainBaseline = true;
        } else if (isTrailingSuperscript && (pageNum === 1 || /^[0-9,∗*†‡§*]+$/.test(run.trimmed))) {
          if (/\$\^\{[^}]+\}\$$/.test(prev.str)) {
            prev.str = prev.str.replace(/\$\^\{([^}]+)\}\$$/, `$^{$1${run.trimmed}}$`);
          } else {
            prev.str = `${prev.str.trimEnd()}$^{${run.trimmed}}$`;
          }
        } else {
          const startsWithClosingPunct = /^[,.;:?!)\]]/.test(run.trimmed);
          const needSpace =
            !startsWithClosingPunct &&
            gap > minFont * 0.15 &&
            !prev.str.endsWith(' ') &&
            !prev.str.endsWith('-') &&
            !run.str.startsWith(' ');
          prev.str += (needSpace ? ' ' : '') + (startsWithClosingPunct ? run.str.trimStart() : run.str);
          if (!run.isScriptCandidate && run.fontPx >= prev.fontPx * 0.92) {
            prev.yBaseline = run.yBaseline;
            prev.lineY = run.lineY;
            prev.fontPx = Math.max(prev.fontPx, run.fontPx);
            prev.baseFontPx = Math.max(prev.baseFontPx || prev.fontPx, run.baseFontPx || run.fontPx);
            prev.hasMainBaseline = true;
          }
        }
        prev.right = Math.max(prev.right, run.right);
        prev.x = Math.min(prev.x, run.x);
        prev.top = Math.min(prev.top, run.top);
        prev.bottom = Math.max(prev.bottom, run.bottom);
        prev.width = prev.right - prev.x;
        prev.height = prev.bottom - prev.top;
        prev.fontPx = Math.max(prev.fontPx, run.fontPx);
        continue;
      }
    }
    const isPureLeadingSup = run.isScriptCandidate && /^[0-9,∗*†‡§*]{1,10}$/.test(run.trimmed);
    lines.push({ ...run, hasMainBaseline: !isPureLeadingSup });
  }

  for (const ln of lines) {
    ln.str = ln.str.replace(/\s+/g, ' ').trim();
  }
  const cleanLines = lines.filter((ln) => {
    if (ln.str.length === 0) return false;
    // Filter out any residual orphan superscript noise line in the Page 1 author band
    if (
      pageNum === 1 &&
      ln.top < pageH * 0.35 &&
      /^[0-9,∗*†‡§*\s]+$/.test(ln.str) &&
      ln.str.replace(/\s+/g, '').length <= 20
    ) {
      return false;
    }
    return true;
  });
  if (cleanLines.length === 0) return [];

  // Compute median body font size
  const proseFontSamples = cleanLines
    .filter((ln) => ln.str.length >= 25)
    .map((ln) => ln.fontPx)
    .sort((a, b) => a - b);
  const medianFontPx =
    proseFontSamples.length > 0
      ? proseFontSamples[Math.floor(proseFontSamples.length * 0.5)]
      : 18;

  const FIG_CAPTION_RE = /^(Figure|Fig\.|FIG\.|Scheme)\s*(\d+|[A-Z]\d*)\s*[:.]/i;
  const TAB_CAPTION_RE = /^(Table|TABLE|Tab\.)\s*(\d+|[A-Z]\d*|[IVX]+)\s*[:.]/i;
  const SECTION_HEADING_RE =
    /^(Abstract|ABSTRACT|Introduction|Related Work|Background|Preliminary|Preliminaries|Method|Methods|Methodology|Approach|Framework|Architecture|Experiments|Experimental Setup|Evaluation|Results|Analysis|Ablation Study|Discussion|Conclusion|Conclusions|Limitations|Broader Impact|Acknowledgments|Acknowledgements|References|Appendix|Appendices)\b|^(\d+(\.\d+){0,2}|[IVX]+\.)\s+[A-Z][A-Za-z0-9\s\-:,/()&']{1,78}$/;

  // 3. Identify solid prose / heading lines (so we can distinguish diagram internal labels from body text)
  const isSolidProseLine = new Array(cleanLines.length).fill(false);
  for (let i = 0; i < cleanLines.length; i++) {
    const ln = cleanLines[i];
    if (FIG_CAPTION_RE.test(ln.str) || TAB_CAPTION_RE.test(ln.str)) continue;
    if (SECTION_HEADING_RE.test(ln.str) && !ln.str.endsWith('.')) {
      isSolidProseLine[i] = true;
      continue;
    }
    if (ln.width >= pageW * 0.32 && ln.str.length >= 36) {
      isSolidProseLine[i] = true;
    }
  }
  // Propagate solid prose status to immediate paragraph continuation lines (e.g. short last line of a paragraph)
  for (let i = 1; i < cleanLines.length; i++) {
    if (isSolidProseLine[i]) continue;
    const prev = cleanLines[i - 1];
    const curr = cleanLines[i];
    if (FIG_CAPTION_RE.test(curr.str) || TAB_CAPTION_RE.test(curr.str)) continue;
    if (
      isSolidProseLine[i - 1] &&
      curr.top - prev.bottom >= -prev.fontPx * 0.25 &&
      curr.top - prev.bottom <= prev.fontPx * 0.72 &&
      Math.abs(curr.x - prev.x) <= prev.fontPx * 1.4 &&
      curr.str.length >= 12
    ) {
      isSolidProseLine[i] = true;
    }
  }

  // 4. Detect Figure Captions, pair each with its visual figureBox2d above it, and consume internal diagram lines
  const consumedLineSet = new Set();
  const positionedSpecialBlocks = []; // Array of { top, bottom, column, block }

  for (let i = 0; i < cleanLines.length; i++) {
    if (consumedLineSet.has(i)) continue;
    const seed = cleanLines[i];
    const isFigCap = FIG_CAPTION_RE.test(seed.str);
    const isTabCap = !isFigCap && TAB_CAPTION_RE.test(seed.str);
    if (!isFigCap && !isTabCap) continue;

    consumedLineSet.add(i);
    const capLines = [seed];
    let capLeft = seed.x;
    let capRight = seed.right;
    let capTop = seed.top;
    let capBottom = seed.bottom;

    for (let j = i + 1; j < cleanLines.length && capLines.length < 8; j++) {
      if (consumedLineSet.has(j)) continue;
      const cand = cleanLines[j];
      if (FIG_CAPTION_RE.test(cand.str) || TAB_CAPTION_RE.test(cand.str) || SECTION_HEADING_RE.test(cand.str)) {
        break;
      }
      const last = capLines[capLines.length - 1];
      const vGap = cand.top - last.bottom;
      if (vGap < -last.fontPx * 0.25 || vGap > last.fontPx * 0.72) break;
      const horizOverlap = Math.min(capRight, cand.right) - Math.max(capLeft, cand.x);
      if (horizOverlap <= 0) break;
      // Do not merge across columns if caption is single-column
      if (capRight <= pageW * 0.535 && cand.x >= pageW * 0.475) break;
      if (capLeft >= pageW * 0.465 && cand.right <= pageW * 0.525) break;

      consumedLineSet.add(j);
      capLines.push(cand);
      capLeft = Math.min(capLeft, cand.x);
      capRight = Math.max(capRight, cand.right);
      capBottom = Math.max(capBottom, cand.bottom);
    }

    let capText = '';
    for (const cl of capLines) {
      if (!capText) {
        capText = cl.str;
      } else if (capText.endsWith('-') && !/--$/.test(capText) && /^[a-z]/.test(cl.str)) {
        capText = capText.slice(0, -1) + cl.str;
      } else {
        capText += ' ' + cl.str;
      }
    }

    const capCenter = (capLeft + capRight) * 0.5;
    const isCenteredOnPage = Math.abs(capCenter - pageW * 0.5) <= pageW * 0.085;
    let col = 'full';
    if (!isCenteredOnPage && capRight <= pageW * 0.54) {
      col = 'left';
    } else if (!isCenteredOnPage && capLeft >= pageW * 0.46) {
      col = 'right';
    }

    if (isFigCap) {
      const bandLeft = col === 'right' ? pageW * 0.49 : pageW * 0.04;
      const bandRight = col === 'left' ? pageW * 0.51 : pageW * 0.96;

      // Find the bottom of the nearest solid prose / heading / previous special block above capTop in this band
      let upperBoundY = pageH * 0.042;
      for (let k = 0; k < cleanLines.length; k++) {
        if (consumedLineSet.has(k) || !isSolidProseLine[k]) continue;
        const pl = cleanLines[k];
        if (pl.bottom <= capTop + 4) {
          const overlapsBand = Math.min(bandRight, pl.right) - Math.max(bandLeft, pl.x) > 12;
          if (overlapsBand) {
            upperBoundY = Math.max(upperBoundY, pl.bottom + 8);
          }
        }
      }
      for (const sb of positionedSpecialBlocks) {
        if (sb.bottom <= capTop + 4) {
          if (col === 'full' || sb.column === 'full' || sb.column === col) {
            upperBoundY = Math.max(upperBoundY, sb.bottom + 8);
          }
        }
      }

      const figSearchBottom = capTop - 4;
      if (figSearchBottom - upperBoundY >= pageH * 0.055) {
        const figureBox2d = computeFigureBox2dInRegion(
          pageRender.canvas,
          pageW,
          pageH,
          bandLeft,
          upperBoundY,
          bandRight,
          figSearchBottom,
          normItems
        );

        if (figureBox2d) {
          const figPxTop = (figureBox2d[0] / 1000) * pageH;
          const figPxLeft = (figureBox2d[1] / 1000) * pageW;
          const figPxBottom = (figureBox2d[2] / 1000) * pageH;
          const figPxRight = (figureBox2d[3] / 1000) * pageW;

          // Consume any text lines inside the figure box so they don't appear as broken body text
          for (let k = 0; k < cleanLines.length; k++) {
            if (consumedLineSet.has(k)) continue;
            const ln = cleanLines[k];
            const cx = (ln.x + ln.right) * 0.5;
            const cy = (ln.top + ln.bottom) * 0.5;
            if (
              cx >= figPxLeft - 8 &&
              cx <= figPxRight + 8 &&
              cy >= figPxTop - 8 &&
              cy <= figPxBottom + 8
            ) {
              consumedLineSet.add(k);
            }
          }

          positionedSpecialBlocks.push({
            top: figPxTop,
            bottom: capBottom,
            column: col,
            block: {
              page: pageNum,
              type: 'figure',
              column: col,
              original: capText,
              translation: '',
              figureBox2d,
              figureLabels: []
            }
          });
          continue;
        }
      }
    }

    positionedSpecialBlocks.push({
      top: capTop,
      bottom: capBottom,
      column: col,
      block: {
        page: pageNum,
        type: 'caption',
        column: col,
        original: capText,
        translation: ''
      }
    });
  }

  // 5. Assign remaining lines to columns ('full', 'left', 'right')
  const remainingLines = cleanLines.filter((_, idx) => !consumedLineSet.has(idx));

  const leftCandidates = remainingLines.filter((l) => l.right <= pageW * 0.535);
  const rightCandidates = remainingLines.filter((l) => l.x >= pageW * 0.465);
  const specialColBlocks = positionedSpecialBlocks.filter(
    (sb) => sb.column === 'left' || sb.column === 'right'
  );
  const isTwoColumnPage =
    (leftCandidates.length >= 2 && rightCandidates.length >= 2) ||
    (leftCandidates.length >= 1 && rightCandidates.length >= 1 && specialColBlocks.length >= 1);

  // Find Y coordinate where 2-column body begins on Page 1
  let twoColStartY = 0;
  if (pageNum === 1 && isTwoColumnPage) {
    const colStartCandidates = [
      ...rightCandidates.map((l) => l.top),
      ...leftCandidates.filter((l) => l.x <= pageW * 0.22).map((l) => l.top),
      ...specialColBlocks.map((sb) => sb.top)
    ];
    const firstColTop =
      colStartCandidates.length > 0 ? Math.min(...colStartCandidates) : pageH * 0.25;
    twoColStartY = Math.max(0, firstColTop - medianFontPx * 1.2);
  }

  const taggedItems = [];
  for (const ln of remainingLines) {
    let col = 'full';
    if (isTwoColumnPage) {
      if (pageNum === 1 && ln.top < twoColStartY) {
        col = 'full';
      } else if (ln.right <= pageW * 0.535) {
        col = 'left';
      } else if (ln.x >= pageW * 0.465) {
        col = 'right';
      } else {
        col = 'full';
      }
    }
    taggedItems.push({ kind: 'line', column: col, top: ln.top, bottom: ln.bottom, line: ln });
  }

  for (const sb of positionedSpecialBlocks) {
    taggedItems.push({
      kind: 'special',
      column: isTwoColumnPage ? sb.column : 'full',
      top: sb.top,
      bottom: sb.bottom,
      block: sb.block
    });
  }

  taggedItems.sort((a, b) => a.top - b.top);

  // 6. Helper to merge a sequence of column items ('full', 'left', or 'right') into semantic blocks
  function flushColumnItemsToBlocks(colItems, colName, outBlocks) {
    if (!colItems || colItems.length === 0) return;

    const lineOnly = colItems.filter((it) => it.kind === 'line').map((it) => it.line);
    const colMinLeft = lineOnly.length > 0 ? Math.min(...lineOnly.map((l) => l.x)) : 0;
    const colMaxRight = lineOnly.length > 0 ? Math.max(...lineOnly.map((l) => l.right)) : pageW;
    const colSpanW = Math.max(120, colMaxRight - colMinLeft);

    let lineBuffer = [];
    let bufferType = 'paragraph';

    const classifySingleLine = (ln) => {
      const s = ln.str;
      if (pageNum === 1 && colName === 'full' && ln.top < pageH * 0.26 && ln.fontPx >= medianFontPx * 1.18) {
        return 'title-heading';
      }
      if (
        pageNum === 1 &&
        colName === 'full' &&
        ln.top < pageH * 0.38 &&
        !SECTION_HEADING_RE.test(s) &&
        (/\$\^\{[0-9*,∗†‡§a-zA-Z+\-()]+\}\$/.test(s) ||
          /University|Institute|Department|School of|Laboratory|College|Academy|Center for|Centre for|Hospital|@|Corresponding author/i.test(s) ||
          /\b[A-Z][a-z]+(?:\s+[A-Z]\.)?\s+[A-Z][a-z]+.*,.*\b(?:and\s+)?[A-Z][a-z]+/.test(s) ||
          (outBlocks.length === 1 && outBlocks[0].type === 'heading' && s.length < 160 && !s.endsWith('.')))
      ) {
        return 'author';
      }
      if (
        (SECTION_HEADING_RE.test(s) && s.length <= 96 && !s.endsWith('.')) ||
        (ln.fontPx >= medianFontPx * 1.14 && s.length <= 96 && !s.endsWith('.'))
      ) {
        return 'heading';
      }
      if (
        s.length <= 120 &&
        ln.width < colSpanW * 0.84 &&
        (/[=∑∏∫∮∈∉≤≥≈≡≠±×÷→←↔∀∃∇∂√]/.test(s) || /\(\d+(\.\d+)?\)$/.test(s)) &&
        !/^(In|The|We|This|For|Where|Here|Note|Table|Figure)\b/.test(s)
      ) {
        return 'equation';
      }
      return 'paragraph';
    };

    const flushLineBuffer = () => {
      if (lineBuffer.length === 0) return;
      let joined = '';
      if (bufferType === 'author') {
        joined = lineBuffer.map((l) => l.str).join('\n');
      } else {
        for (const l of lineBuffer) {
          if (!joined) {
            joined = l.str;
          } else if (joined.endsWith('-') && !/--$/.test(joined) && /^[a-z]/.test(l.str)) {
            joined = joined.slice(0, -1) + l.str;
          } else {
            joined += ' ' + l.str;
          }
        }
      }
      const cleanText = joined.trim();
      lineBuffer = [];
      if (!cleanText) return;
      outBlocks.push({
        page: pageNum,
        type: bufferType === 'title-heading' ? 'heading' : bufferType,
        column: colName,
        original: cleanText,
        translation: ''
      });
    };

    for (const item of colItems) {
      if (item.kind === 'special') {
        flushLineBuffer();
        outBlocks.push(item.block);
        continue;
      }

      const ln = item.line;
      const lnType = classifySingleLine(ln);

      if (lineBuffer.length === 0) {
        bufferType = lnType;
        lineBuffer.push(ln);
        continue;
      }

      const prev = lineBuffer[lineBuffer.length - 1];
      const vGap = ln.top - prev.bottom;
      const maxF = Math.max(prev.fontPx, ln.fontPx);

      // Check if wrapped title or section heading continues on next line
      if (
        (bufferType === 'title-heading' || bufferType === 'heading') &&
        lnType === bufferType &&
        Math.abs(ln.fontPx - prev.fontPx) <= maxF * 0.12 &&
        vGap <= maxF * 0.65
      ) {
        lineBuffer.push(ln);
        continue;
      }

      // Check if author/affiliation lines continue on Page 1
      if (bufferType === 'author' && (lnType === 'author' || (pageNum === 1 && colName === 'full' && vGap <= maxF * 0.9 && !SECTION_HEADING_RE.test(ln.str) && ln.str.length < 140))) {
        lineBuffer.push(ln);
        continue;
      }

      if (bufferType !== 'paragraph' || lnType !== 'paragraph') {
        flushLineBuffer();
        bufferType = lnType;
        lineBuffer.push(ln);
        continue;
      }

      // Both prev and ln are 'paragraph': check if a new paragraph begins
      const isLargeVerticalGap = vGap > maxF * 0.68;
      const prevEndedShort =
        prev.right < colMaxRight - prev.fontPx * 2.2 && /[.?!:。？！]$/.test(prev.str);
      const currIsIndented =
        ln.x > colMinLeft + ln.fontPx * 0.85 &&
        prev.x <= colMinLeft + prev.fontPx * 0.55 &&
        /[.?!:。？！]$/.test(prev.str);
      const currIsListBullet = /^([•·▪▸\-*]|\(\d+\)|\[\d+\])\s+/.test(ln.str);

      if (isLargeVerticalGap || prevEndedShort || currIsIndented || currIsListBullet) {
        flushLineBuffer();
      }
      bufferType = 'paragraph';
      lineBuffer.push(ln);
    }

    flushLineBuffer();
  }

  // 7. Process vertical bands: whenever a 'full' item appears, flush buffered 'left' then 'right' items first
  const finalBlocks = [];
  let fullBatch = [];
  let leftBatch = [];
  let rightBatch = [];

  const flushTwoColBand = () => {
    if (leftBatch.length > 0) {
      flushColumnItemsToBlocks(leftBatch, 'left', finalBlocks);
      leftBatch = [];
    }
    if (rightBatch.length > 0) {
      flushColumnItemsToBlocks(rightBatch, 'right', finalBlocks);
      rightBatch = [];
    }
  };

  const flushFullBand = () => {
    if (fullBatch.length > 0) {
      flushColumnItemsToBlocks(fullBatch, 'full', finalBlocks);
      fullBatch = [];
    }
  };

  for (const item of taggedItems) {
    if (item.column === 'full') {
      flushTwoColBand();
      fullBatch.push(item);
    } else {
      flushFullBand();
      if (item.column === 'left') {
        leftBatch.push(item);
      } else {
        rightBatch.push(item);
      }
    }
  }
  flushFullBand();
  flushTwoColBand();

  return finalBlocks;
}


