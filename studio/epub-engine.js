/**
 * Native Web-API EPUB (ZIP + OPF + XHTML) Parser and Bilingual EPUB Builder.
 * Uses browser native DecompressionStream('deflate-raw') / CompressionStream('deflate-raw')
 * with zero external library dependencies.
 */

async function inflateRaw(compressedBytes) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const writePromise = writer.write(compressedBytes).catch(() => {});
  const closePromise = writer.close().catch(() => {});
  const resp = new Response(ds.readable);
  const ab = await resp.arrayBuffer();
  await Promise.all([writePromise, closePromise]);
  return new Uint8Array(ab);
}

/**
 * Parse a ZIP archive ArrayBuffer into an array of entry descriptors and raw/decompressed bytes.
 */
export async function readZipArchive(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  // Locate End of Central Directory (EOCD) signature 0x06054b50
  let eocdOffset = -1;
  const minEocd = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('无效的 EPUB/ZIP 文件结构（未找到中央目录签名）');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const entries = new Map();
  let ptr = cdOffset;
  const decoder = new TextDecoder('utf-8');

  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) break;
    const compressionMethod = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const uncompressedSize = view.getUint32(ptr + 24, true);
    const fileNameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);

    const fileName = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + fileNameLen));
    ptr += 46 + fileNameLen + extraLen + commentLen;

    // Read local file header to find actual data start
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawSlice = bytes.subarray(dataStart, dataStart + compressedSize);

    entries.set(fileName, {
      fileName,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      rawSlice,
      async getBytes() {
        if (compressionMethod === 0) return rawSlice;
        if (compressionMethod === 8) return await inflateRaw(rawSlice);
        throw new Error(`不支持的 ZIP 压缩算法: ${compressionMethod}`);
      },
      async getText() {
        const b = await this.getBytes();
        return decoder.decode(b);
      }
    });
  }

  return entries;
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

/**
 * Parse an EPUB file into structured metadata, chapters, and extracted blocks for translation.
 */
export async function parseEpubFile(arrayBuffer) {
  const entries = await readZipArchive(arrayBuffer);
  const containerEntry = entries.get('META-INF/container.xml');
  if (!containerEntry) {
    throw new Error('EPUB 缺少 META-INF/container.xml');
  }

  const domParser = new DOMParser();
  const containerXml = domParser.parseFromString(await containerEntry.getText(), 'application/xml');
  const rootfileEl = containerXml.querySelector('rootfile');
  const opfPath = rootfileEl?.getAttribute('full-path');
  if (!opfPath || !entries.has(opfPath)) {
    throw new Error(`找不到 EPUB OPF 描述文件: ${opfPath}`);
  }

  const opfXml = domParser.parseFromString(await entries.get(opfPath).getText(), 'application/xml');
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
      manifestMap.set(id, {
        id,
        href,
        fullPath: resolveRelativePath(opfPath, decodeURIComponent(href)),
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
    const item = manifestMap.get(spineIds[cIdx]);
    const zipEntry = entries.get(item.fullPath) || entries.get(item.href);
    if (!zipEntry) continue;

    const htmlText = await zipEntry.getText();
    const doc = domParser.parseFromString(htmlText, 'text/html');
    const chapterTitle =
      doc.querySelector('h1, h2, h3, title')?.textContent?.replace(/\s+/g, ' ').trim() ||
      `第 ${cIdx + 1} 章`;

    const chapterBlocks = [];
    const blockEls = doc.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, blockquote');
    blockEls.forEach((el) => {
      if (el.querySelector('p')) return;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 3) return;
      const tag = el.tagName.toLowerCase();
      const type = tag.startsWith('h') ? 'heading' : tag === 'blockquote' ? 'quote' : 'paragraph';
      const blockObj = {
        id: allBlocks.length,
        chapterIndex: cIdx,
        chapterTitle,
        type,
        original: text,
        translation: ''
      };
      chapterBlocks.push(blockObj);
      allBlocks.push(blockObj);
    });

    if (chapterBlocks.length > 0) {
      chapters.push({
        index: cIdx,
        title: chapterTitle,
        path: item.fullPath,
        blocks: chapterBlocks
      });
    }
  }

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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
