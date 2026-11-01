/**
 * Native Web-API EPUB (ZIP + OPF + XHTML) Parser and Bilingual EPUB Builder.
 * Uses browser native DecompressionStream('deflate-raw') / CompressionStream('deflate-raw')
 * with zero external library dependencies.
 */

import { createDocumentBudget, readBoundedStream } from './document-budget.js';

async function inflateRaw(compressedBytes, budget) {
  let offset = 0;
  const input = new ReadableStream({
    pull(controller) {
      if (offset >= compressedBytes.length) { controller.close(); return; }
      const end = Math.min(offset + 65536, compressedBytes.length);
      controller.enqueue(compressedBytes.subarray(offset, end));
      offset = end;
    }
  });
  const stream = input.pipeThrough(new DecompressionStream('deflate-raw'));
  const ab = await readBoundedStream(stream, budget, (count, size) =>
    budget.addExpandedBytes(count, size, compressedBytes.length));
  return new Uint8Array(ab);
}

/**
 * A lazy ZIP reader with one deadline and expansion quota shared by all members.
 * Direct callers can dispose the owned budget with entries.dispose() after reading.
 */
export async function readZipArchive(arrayBuffer, { budget, signal } = {}) {
  const ownsBudget = !budget;
  budget ||= createDocumentBudget({ signal });
  try {
    budget.checkInputBytes(arrayBuffer.byteLength);
    const bytes = new Uint8Array(arrayBuffer), view = new DataView(arrayBuffer);
    const invalid = detail => { throw new Error(`无效的 EPUB/ZIP 文件结构：${detail}`); };
    const within = (offset, size, end = bytes.length) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > end) invalid('目录或文件数据越界/截断');
    };
    let eocdOffset = -1;
    for (let i = bytes.length - 22, min = Math.max(0, bytes.length - 65557); i >= min; i--) {
      if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { eocdOffset = i; break; }
    }
    if (eocdOffset < 0) invalid('未找到完整中央目录结束记录');
    const totalEntries = view.getUint16(eocdOffset + 10, true);
    const cdSize = view.getUint32(eocdOffset + 12, true), cdOffset = view.getUint32(eocdOffset + 16, true);
    if (view.getUint16(eocdOffset + 4, true) || view.getUint16(eocdOffset + 6, true) ||
      view.getUint16(eocdOffset + 8, true) !== totalEntries) invalid('不支持分卷 ZIP');
    if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) invalid('不支持 ZIP64');
    if (totalEntries > budget.limits.maxEntries) budget.fail(`EPUB 条目数量超过上限（${budget.limits.maxEntries} 项）。`);
    within(cdOffset, cdSize, eocdOffset);
    if (cdOffset + cdSize !== eocdOffset) invalid('中央目录长度不一致');
    const entries = new Map(), ranges = [];
    const decoder = new TextDecoder('utf-8');
    let ptr = cdOffset;
    for (let i = 0; i < totalEntries; i++) {
      budget.check();
      within(ptr, 46, eocdOffset);
      if (view.getUint32(ptr, true) !== 0x02014b50) invalid('中央目录条目签名不正确');
      const flags = view.getUint16(ptr + 8, true), compressionMethod = view.getUint16(ptr + 10, true);
      const expectedCrc = view.getUint32(ptr + 16, true);
      const compressedSize = view.getUint32(ptr + 20, true), uncompressedSize = view.getUint32(ptr + 24, true);
      const fileNameLen = view.getUint16(ptr + 28, true), extraLen = view.getUint16(ptr + 30, true), commentLen = view.getUint16(ptr + 32, true);
      const localHeaderOffset = view.getUint32(ptr + 42, true);
      within(ptr, 46 + fileNameLen + extraLen + commentLen, eocdOffset);
      if (flags & 1) invalid('不支持加密 ZIP');
      if (view.getUint16(ptr + 34, true) !== 0 || [compressedSize, uncompressedSize, localHeaderOffset].includes(0xffffffff)) invalid('不支持分卷 ZIP 或 ZIP64');
      if (![0, 8].includes(compressionMethod)) invalid(`不支持的 ZIP 压缩算法 ${compressionMethod}`);
      const fileName = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + fileNameLen));
      if (!fileName || entries.has(fileName)) invalid('文件名为空或重复');
      budget.checkEntryBytes(uncompressedSize, compressedSize);
      ptr += 46 + fileNameLen + extraLen + commentLen;
      within(localHeaderOffset, 30, cdOffset);
      if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) invalid('本地文件头签名不正确');
      const localNameLen = view.getUint16(localHeaderOffset + 26, true), localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      within(localHeaderOffset, 30 + localNameLen + localExtraLen, cdOffset);
      within(dataStart, compressedSize, cdOffset);
      if (view.getUint16(localHeaderOffset + 6, true) !== flags || view.getUint16(localHeaderOffset + 8, true) !== compressionMethod ||
        decoder.decode(bytes.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLen)) !== fileName) invalid('本地文件头与中央目录不一致');
      if (!(flags & 8) && (view.getUint32(localHeaderOffset + 14, true) !== expectedCrc ||
        view.getUint32(localHeaderOffset + 18, true) !== compressedSize || view.getUint32(localHeaderOffset + 22, true) !== uncompressedSize)) invalid('本地文件大小或校验值与目录不一致');
      ranges.push([localHeaderOffset, dataStart + compressedSize]);
      const rawSlice = bytes.subarray(dataStart, dataStart + compressedSize);
      entries.set(fileName, {
        fileName, compressionMethod, compressedSize, uncompressedSize, rawSlice,
        async getBytes() {
          budget.check();
          let result;
          if (compressionMethod === 0) {
            budget.addExpandedBytes(rawSlice.length, rawSlice.length, compressedSize);
            result = rawSlice;
          } else result = await inflateRaw(rawSlice, budget);
          budget.check();
          if (result.length !== uncompressedSize) invalid(`文件解压大小与声明不一致：${fileName}`);
          if (crc32(result) !== expectedCrc) invalid(`文件 CRC 校验失败：${fileName}`);
          budget.check();
          return result;
        },
        async getText() {
          const text = decoder.decode(await this.getBytes());
          budget.check();
          return text;
        }
      });
    }
    if (ptr !== cdOffset + cdSize) invalid('目录条目数量或长度不一致');
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) invalid('文件数据区域重叠');
    budget.check();
    entries.dispose = () => { if (ownsBudget) budget.dispose(); };
    return entries;
  } catch (error) {
    if (ownsBudget) budget.dispose();
    throw error;
  }
}

function resolveRelativePath(baseFile, relHref) {
  if (!relHref) return '';
  const cleanHref = relHref.split('#')[0];
  const baseParts = baseFile.split('/');
  baseParts.pop(); // remove filename
  for (const seg of cleanHref.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') baseParts.pop();
    else baseParts.push(seg);
  }
  return baseParts.join('/');
}

// Visit each text node once. Flushing at structural boundaries retains text before
// and after nested lists/quotes without repeating their descendants as parent text.
function extractChapterBlocks(body, addBlock) {
  const boundaries = new Set(['address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'div', 'dl', 'dt',
    'figcaption', 'figure', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'main',
    'nav', 'ol', 'p', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);
  const ignored = new Set(['script', 'style', 'noscript', 'template']);
  let pending = '';
  const flush = type => {
    const text = pending.replace(/\s+/g, ' ').trim();
    pending = '';
    if (text) addBlock(type, text);
  };
  const visit = (node, type) => {
    if (node.nodeType === 3) { pending += node.textContent; return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (ignored.has(tag)) return;
    if (tag === 'pre') {
      flush(type);
      const code = node.textContent || '';
      if (code.trim()) addBlock('code', code);
      return;
    }
    if (tag === 'br' || tag === 'hr') { pending += '\n'; return; }
    const boundary = boundaries.has(tag);
    if (boundary) flush(type);
    const childType = /^h[1-6]$/.test(tag) ? 'heading' : tag === 'blockquote' ? 'quote' : type;
    for (const child of node.childNodes) visit(child, childType);
    if (boundary) flush(childType);
  };
  visit(body, 'paragraph');
  flush('paragraph');
}

/**
 * Parse an EPUB file into structured metadata, chapters, and extracted blocks for translation.
 */
export async function parseEpubFile(arrayBuffer, { budget, signal } = {}) {
  const ownsBudget = !budget;
  budget ||= createDocumentBudget({ signal });
  try { return await parseEpubWithBudget(arrayBuffer, budget); }
  finally { if (ownsBudget) budget.dispose(); }
}

async function parseEpubWithBudget(arrayBuffer, budget) {
  const entries = await readZipArchive(arrayBuffer, { budget });
  const containerEntry = entries.get('META-INF/container.xml');
  if (!containerEntry) {
    throw new Error('EPUB 缺少 META-INF/container.xml');
  }

  const domParser = new DOMParser();
  const containerXml = domParser.parseFromString(await containerEntry.getText(), 'application/xml');
  budget.check();
  const rootfileEl = containerXml.querySelector('rootfile');
  const opfPath = rootfileEl?.getAttribute('full-path');
  if (!opfPath || !entries.has(opfPath)) {
    throw new Error(`找不到 EPUB OPF 描述文件: ${opfPath}`);
  }

  const opfXml = domParser.parseFromString(await entries.get(opfPath).getText(), 'application/xml');
  budget.check();
  const bookTitle =
    opfXml.querySelector('title, dc\\:title')?.textContent?.trim() || 'EPUB 电子书';
  const bookAuthor =
    opfXml.querySelector('creator, dc\\:creator')?.textContent?.trim() || '';

  const manifestMap = new Map();
  opfXml.querySelectorAll('manifest > item').forEach((item) => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const mediaType = item.getAttribute('media-type') || '';
    if (id && href) {
      let decodedHref = href;
      try {
        decodedHref = decodeURIComponent(href);
      } catch {
        decodedHref = href;
      }
      manifestMap.set(id, {
        id,
        href,
        fullPath: resolveRelativePath(opfPath, decodedHref),
        mediaType
      });
    }
  });

  const spineIds = [];
  opfXml.querySelectorAll('spine > itemref').forEach((ref) => {
    const idref = ref.getAttribute('idref');
    if (idref && manifestMap.has(idref)) {
      spineIds.push(idref);
    }
  });

  const chapters = [];
  const allBlocks = [];

  for (let cIdx = 0; cIdx < spineIds.length; cIdx++) {
    await budget.wait(new Promise(resolve => setTimeout(resolve, 0)));
    budget.check();
    const item = manifestMap.get(spineIds[cIdx]);
    const zipEntry = entries.get(item.fullPath) || entries.get(item.href);
    if (!zipEntry) throw new Error(`EPUB 缺少正文文件：${item.fullPath}`);

    const htmlText = await zipEntry.getText();
    const doc = domParser.parseFromString(htmlText, 'text/html');
    budget.check();
    const chapterTitle =
      doc.querySelector('body h1, body h2, body h3, h1, h2, h3, title')?.textContent?.replace(/\s+/g, ' ').trim() ||
      `第 ${cIdx + 1} 章`;

    const chapterBlocks = [];
    extractChapterBlocks(doc.body, (type, text) => {
      const blockObj = {
        id: allBlocks.length,
        chapterIndex: cIdx,
        chapterTitle,
        type,
        original: text,
        translation: type === 'code' ? text : ''
      };
      chapterBlocks.push(blockObj);
      allBlocks.push(blockObj);
    });

    budget.check();
    if (chapterBlocks.length > 0) {
      chapters.push({
        index: cIdx,
        title: chapterTitle,
        path: item.fullPath,
        blocks: chapterBlocks
      });
    }
  }

  budget.check();
  return {
    bookTitle,
    bookAuthor,
    chapters,
    blocks: allBlocks
  };
}

/**
 * CRC32 lookup table for building valid uncompressed ZIP/EPUB archives.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a downloadable Bilingual EPUB 3 file (.epub) from parsed chapters & blocks.
 */
export function buildBilingualEpubBlob({ bookTitle, bookAuthor, blocks, targetLang = 'zh-CN' }, mode = 'bilingual') {
  const encoder = new TextEncoder();
  const files = [];

  // 1. mimetype MUST be the first file in EPUB and uncompressed
  files.push({
    name: 'mimetype',
    data: encoder.encode('application/epub+zip')
  });

  // 2. META-INF/container.xml
  files.push({
    name: 'META-INF/container.xml',
    data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`)
  });

  // Rebuild text chapters, not the original book's images, styles or footnotes.
  const groups = new Map();
  for (const block of blocks) {
    const key = block.chapterIndex ?? 0;
    if (!groups.has(key)) groups.set(key, { title: block.chapterTitle || bookTitle || '正文', blocks: [] });
    groups.get(key).blocks.push(block);
  }
  if (groups.size === 0) groups.set(0, { title: bookTitle || '正文', blocks: [] });
  const chapters = [...groups.values()];
  const language = escapeXml(targetLang || 'zh-CN');
  const chapterName = index => index === 0 ? 'chapter.xhtml' : `chapter-${index + 1}.xhtml`;
  chapters.forEach((chapter, index) => {
    const bodyHtml = chapter.blocks.map(b => {
      if (b.type === 'code') return `<pre><code>${escapeXml(b.original)}</code></pre>`;
      const tag = b.type === 'heading' ? 'h2' : 'p';
      const original = escapeXml(b.original);
      const translation = escapeXml(b.translation || b.original);
      return mode === 'translation-only'
        ? `<${tag}>${translation}</${tag}>`
        : `<div class="pair"><${tag} class="orig">${original}</${tag}><${tag} class="trans">${translation}</${tag}></div>`;
    }).join('\n');
    files.push({ name: `OEBPS/${chapterName(index)}`, data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${language}" lang="${language}">
<head><title>${escapeXml(chapter.title)}</title><style>
body { font-family: serif; line-height: 1.75; padding: 4%; }
.pair { margin-bottom: 1.1em; } .orig { color: #334155; }
.trans { border-left: 3px solid #6366f1; padding-left: 0.65em; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style></head><body><h1>${escapeXml(chapter.title)}</h1>${bodyHtml}</body></html>`) });
  });
  files.push({ name: 'OEBPS/nav.xhtml', data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}">
<head><title>${escapeXml(bookTitle)}</title></head>
<body><nav epub:type="toc" id="toc"><h1>${escapeXml(bookTitle)}</h1><ol>
${chapters.map((chapter, i) => `<li><a href="${chapterName(i)}">${escapeXml(chapter.title)}</a></li>`).join('\n')}
</ol></nav></body></html>`) });
  files.push({ name: 'OEBPS/content.opf', data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">urn:qingjian:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}</dc:identifier>
    <dc:title>${escapeXml(bookTitle)}</dc:title>
    <dc:creator>${escapeXml(bookAuthor || 'QingJian')}</dc:creator>
    <dc:language>${language}</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${chapters.map((_, i) => `    <item id="ch${i + 1}" href="${chapterName(i)}" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine>
${chapters.map((_, i) => `    <itemref idref="ch${i + 1}"/>`).join('\n')}
  </spine>
</package>`) });

  // Assemble uncompressed ZIP archive
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const crc = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // Store method 0
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, data);

    const cdHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cdHeader.set(nameBytes, 46);

    centralParts.push(cdHeader);
    offset += localHeader.length + data.length;
  }

  const cdSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...localParts, ...centralParts, eocd], {
    type: 'application/epub+zip'
  });
}

function escapeXml(str) {
  return String(str || '')
    // Strip XML 1.0 illegal control characters (e.g. \f form-feed or \x00-\x08 from PDF extraction)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
