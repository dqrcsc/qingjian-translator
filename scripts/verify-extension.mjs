#!/usr/bin/env node
/**
 * Automated Verification & Unit Test Suite for Immersive Gemini Chrome Extension.
 * Verifies:
 * 1. Manifest V3 structure, permissions, and referenced files existence
 * 2. Exact pixel dimensions of PNG icons (16x16, 48x48, 128x128)
 * 3. Syntax check (`node --check`) across all JS modules and content scripts
 * 4. HTML CSP compliance (no inline <script> code or inline onclick handlers)
 * 5. Functional unit tests for shared utilities, glossary parser, and EPUB round-trip builder/parser
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  hashString,
  parseSubtitles,
  formatSrtTime,
  createBatches,
  isOnlinePdfUrl,
  normalizeOnlinePdfUrl
} from '../shared/utils.js';
import { LLM_PROVIDERS, MESSAGE_TYPES, DEFAULT_SETTINGS } from '../shared/constants.js';
import {
  parseGlossary,
  getProviderDefinition,
  getActiveProtocol,
  getActiveModelId,
  getMergedModelList,
  getUsageStats,
  incrementUsageStats
} from '../shared/storage.js';
import {
  buildCacheKey,
  buildStyleSignature,
  getCachedTranslations,
  setCachedTranslations
} from '../background/cache-db.js';
import { buildBilingualEpubBlob, readZipArchive } from '../studio/epub-engine.js';
import {
  extractPdfBlocksLocally,
  extractStructuredPdfPageBlocks,
  estimatePdfPageCount,
  openPdfDocument,
  cropFigureFromPageCanvas,
  normalizeFigureLabelsToCrop,
  extractFigureVectorTextGroups,
  renderSeamlessFigureTranslation
} from '../studio/pdf-engine.js';
import {
  renderRichAcademicHtml,
  renderLatexMathToHtml,
  isAuthorOrAffiliationBlock
} from '../studio/math-renderer.js';
import {
  redactSensitiveText,
  fetchWithTimeoutAndRetry,
  translateImageWithGemini
} from '../background/gemini-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let passed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${label}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${label}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function readPngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A, IHDR width at offset 16, height at offset 20
  assert.equal(buf[0], 0x89, 'Not a valid PNG signature');
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', 'Not a valid PNG header');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

console.log('\n🔍 Running 青简 · 译读 (QingJian) MV3 Extension Verification Suite...\n');

// 1. Manifest V3 & Referenced Files Check
const manifestPath = path.join(ROOT, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

check('manifest.json uses manifest_version 3 and meets Chrome Web Store metadata limits', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.action?.default_popup, 'action.default_popup must be defined');
  assert.equal(manifest.background?.type, 'module');
  assert.ok(manifest.name && manifest.name.length <= 75, `manifest.name exceeds 75 chars (${manifest.name?.length})`);
  assert.ok(manifest.short_name && manifest.short_name.length <= 12, `manifest.short_name exceeds 12 chars (${manifest.short_name?.length})`);
  assert.ok(manifest.description && manifest.description.length <= 132, `manifest.description exceeds 132 chars (${manifest.description?.length})`);
  assert.ok(fs.existsSync(path.join(ROOT, 'PRIVACY.md')), 'PRIVACY.md must exist for store privacy policy disclosure');
});

check('All icon files exist and match declared pixel dimensions (16, 48, 128)', () => {
  for (const [sizeStr, relPath] of Object.entries(manifest.icons)) {
    const expected = Number(sizeStr);
    const fullPath = path.join(ROOT, relPath);
    assert.ok(fs.existsSync(fullPath), `Missing icon file: ${relPath}`);
    const { width, height } = readPngDimensions(fullPath);
    assert.equal(width, expected, `${relPath} width must be ${expected}`);
    assert.equal(height, expected, `${relPath} height must be ${expected}`);
  }
});

// 2. JS Syntax Validation
const jsFiles = [
  'shared/constants.js',
  'shared/storage.js',
  'shared/utils.js',
  'shared/protocol.js',
  'shared/request-client.js',
  'shared/request-budget.js',
  'background/request-queue.js',
  'background/cache-db.js',
  'background/gemini-client.js',
  'background/service-worker.js',
  'content/youtube-page-bridge.js',
  'content/content-main.js',
  'popup/popup.js',
  'options/options.js',
  'studio/vendor/pdfjs/pdf.worker.mjs',
  'studio/vendor/pdfjs/pdf.mjs',
  'studio/epub-engine.js',
  'studio/pdf-engine.js',
  'studio/math-renderer.js',
  'studio/studio.js'
];

for (const rel of jsFiles) {
  check(`JS syntax valid: ${rel}`, () => {
    const full = path.join(ROOT, rel);
    assert.ok(fs.existsSync(full), `Missing file: ${rel}`);
    execFileSync(process.execPath, ['--check', full]);
  });
}

// 3. HTML CSP Compliance Check
const htmlFiles = ['popup/popup.html', 'options/options.html', 'studio/studio.html'];
for (const rel of htmlFiles) {
  check(`HTML CSP compliant (no inline script code or inline event attributes): ${rel}`, () => {
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!/\son\w+\s*=/i.test(html), `${rel} contains inline event handler`);
    const scriptMatches = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const tag of scriptMatches) {
      assert.ok(/\bsrc\s*=/i.test(tag), `${rel} contains inline <script> without src`);
    }
  });
}

check('PDF.js uses module workers, local assets and evaluation-disabled loading', () => {
  const engine = fs.readFileSync(path.join(ROOT, 'studio/pdf-engine.js'), 'utf8');
  assert.ok(engine.includes('isEvalSupported: false'));
  assert.ok(engine.includes('loadingTask.promise'));
  assert.ok(engine.includes('renderTask.promise'));
  assert.ok(engine.includes('pdf.worker.mjs'));
  assert.ok(!engine.includes('disableWorker = true'));
  assert.ok(!manifest.content_security_policy.extension_pages.includes("'unsafe-eval'"));
  assert.ok(manifest.content_security_policy.extension_pages.includes("worker-src 'self'"));
  // Upstream has guarded evaluation code; actual CSP compatibility is tested in Chromium.
});

// 4. Functional Unit Tests
check('Unit Test: hashString is deterministic and collision-resistant', () => {
  const h1 = hashString('Hello world|zh-CN|gemini-2.5-flash');
  const h2 = hashString('Hello world|zh-CN|gemini-2.5-flash');
  const h3 = hashString('Hello world|ja|gemini-2.5-flash');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(h1.length, 16);
});

check('Unit Test: parseSubtitles parses SRT & WebVTT cues accurately', () => {
  const sampleSrt = `1
00:00:01,500 --> 00:00:04,200
Welcome to Immersive Gemini.

2
00:00:04,500 --> 00:00:08,000
Real-time contextual bilingual subtitles.`;
  const cues = parseSubtitles(sampleSrt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1.5);
  assert.equal(cues[0].end, 4.2);
  assert.equal(cues[0].text, 'Welcome to Immersive Gemini.');
  assert.equal(formatSrtTime(1.5), '00:00:01,500');
});

check('Unit Test: createBatches respects both maxItems and maxChars', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: i,
    text: 'A'.repeat(100)
  }));
  const batches = createBatches(items, (x) => x.text, 5, 350);
  // Each item is 100 chars, so maxChars=350 allows at most 3 items per batch
  assert.equal(batches.length, 4);
  assert.equal(batches[0].length, 3);
});

check('Unit Test: parseGlossary parses key=value and key:value entries', () => {
  const entries = parseGlossary('# comment\nLLM = 大语言模型\nAgent: 智能体\n');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { source: 'LLM', target: '大语言模型' });
  assert.deepEqual(entries[1], { source: 'Agent', target: '智能体' });
});

await checkAsync('Unit Test: EPUB engine builds valid ZIP/EPUB archive and reads it back', async () => {
  const blob = buildBilingualEpubBlob({
    bookTitle: 'Test Book',
    bookAuthor: 'Author',
    blocks: [
      { type: 'heading', original: 'Chapter 1', translation: '第一章' },
      { type: 'paragraph', original: 'Hello world.', translation: '你好，世界。' }
    ]
  });
  const ab = await blob.arrayBuffer();
  const entries = await readZipArchive(ab);
  assert.ok(entries.has('mimetype'));
  assert.ok(entries.has('META-INF/container.xml'));
  assert.ok(entries.has('OEBPS/content.opf'));
  assert.ok(entries.has('OEBPS/chapter.xhtml'));
  const chapterText = await entries.get('OEBPS/chapter.xhtml').getText();
  assert.ok(chapterText.includes('你好，世界。'));
});

check('Unit Test: isOnlinePdfUrl and normalizeOnlinePdfUrl handle arXiv, OpenReview, and .pdf links', () => {
  assert.equal(isOnlinePdfUrl('https://arxiv.org/pdf/2610.18672'), true);
  assert.equal(isOnlinePdfUrl('https://arxiv.org/pdf/2501.12948v1.pdf'), true);
  assert.equal(isOnlinePdfUrl('https://openreview.net/pdf?id=abc123'), true);
  assert.equal(isOnlinePdfUrl('https://example.com/paper.pdf'), true);
  assert.equal(isOnlinePdfUrl('https://news.ycombinator.com/'), false);
  assert.equal(
    normalizeOnlinePdfUrl('https://arxiv.org/abs/2501.12948'),
    'https://arxiv.org/pdf/2501.12948'
  );
});

check('Unit Test: Open BYOK Multi-provider catalog (zero built-in default models, user-configured models only)', () => {
  assert.ok(LLM_PROVIDERS.length >= 8);
  assert.equal(DEFAULT_SETTINGS.modelId, '', 'DEFAULT_SETTINGS.modelId must be empty (no built-in model)');
  for (const p of LLM_PROVIDERS) {
    assert.equal(p.defaultModel, '', `Provider ${p.id} must not hardcode a built-in defaultModel`);
    assert.deepEqual(p.models, [], `Provider ${p.id} must not hardcode built-in models`);
  }

  const deepseek = getProviderDefinition('deepseek');
  assert.equal(deepseek.protocol, 'openai');
  assert.equal(deepseek.defaultBaseUrl, 'https://api.deepseek.com/v1');

  const opencode = getProviderDefinition('opencode');
  assert.equal(opencode.protocol, 'openai');
  assert.ok(opencode.defaultBaseUrl.startsWith('https://'));

  assert.equal(getActiveProtocol({ providerId: 'deepseek' }), 'openai');
  assert.equal(getActiveProtocol({ providerId: 'google' }), 'gemini');
  assert.equal(getActiveProtocol({ providerId: 'custom', apiProtocol: 'openai' }), 'openai');

  // Unconfigured state must return empty model list
  const unconfiguredModels = getMergedModelList({ providerId: 'deepseek', availableModels: [] });
  assert.equal(unconfiguredModels.length, 0);

  // User-configured model (fetched or manually entered) is returned properly
  const configuredModels = getMergedModelList({
    providerId: 'deepseek',
    customModelId: 'deepseek-chat',
    availableModels: []
  });
  assert.ok(configuredModels.some((m) => m.id === 'deepseek-chat'));
});

await checkAsync('Unit Test: PDF DecompressionStream and accurate /Count page detection', async () => {
  const fakePdfText = `%PDF-1.7\n2 0 obj\n<< /Type /Pages /Count 41 >>\nendobj\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n\x78\x9c\x01\x02\x03\x04JUNK_AFTER_END\r\nendstream\nendobj\n`;
  const encoder = new TextEncoder();
  const ab = encoder.encode(fakePdfText).buffer;
  assert.equal(estimatePdfPageCount(ab), 41);
  const opened = await openPdfDocument(ab);
  assert.equal(opened.numPages, 41);
  const blocks = await extractPdfBlocksLocally(ab);
  assert.ok(Array.isArray(blocks));
});

check('Unit Test: normalizeFigureLabelsToCrop filters numeric bar-chart noise and transforms page coords to figure crop coords', () => {
  const rawLabels = [
    { box_2d: [150, 200, 190, 260], original: '85.2', translation: '85.2' },
    { box_2d: [150, 300, 190, 360], original: '100%', translation: '100%' },
    {
      box_2d: [200, 200, 280, 500],
      original: 'Expert Medical Ontology',
      translation: '专家医学本体'
    }
  ];
  // Figure sits in [100, 100, 500, 900] of the page (with 12-unit crop margin -> [88, 88, 512, 912])
  const cleaned = normalizeFigureLabelsToCrop(rawLabels, [100, 100, 500, 900]);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].translation, '专家医学本体');
  assert.ok(cleaned[0].box_2d[0] >= 240 && cleaned[0].box_2d[0] <= 270);
  assert.ok(cleaned[0].box_2d[1] >= 120 && cleaned[0].box_2d[1] <= 145);
});

check('Unit Test: extractFigureVectorTextGroups groups multi-line figure labels and preserves diagram codes', () => {
  const pageTextItems = [
    // Two-line node label: "Diabetes mellitus" + "(DM)"
    { str: 'Diabetes ', x: 120, y: 200, top: 184, bottom: 204, width: 65, height: 20, fontSize: 16 },
    { str: 'mellitus', x: 185, y: 200, top: 184, bottom: 204, width: 55, height: 20, fontSize: 16 },
    { str: '(DM)', x: 160, y: 222, top: 206, bottom: 226, width: 38, height: 20, fontSize: 16 },
    // Pure diagram code "E10" and score "3.3" should be skipped so original vector symbols stay intact
    { str: 'E10', x: 350, y: 200, top: 184, bottom: 204, width: 28, height: 20, fontSize: 16 },
    { str: '3.3', x: 420, y: 200, top: 184, bottom: 204, width: 24, height: 20, fontSize: 16 }
  ];
  const groups = extractFigureVectorTextGroups(pageTextItems, 1000, 1000, [100, 100, 400, 600]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].original, 'Diabetes mellitus (DM)');
  assert.equal(groups[0].lineRects.length, 2);
});

check('Unit Test: extractStructuredPdfPageBlocks reconstructs 2-column academic layout, titles, authors, and figure boxes for DeepSeek/OpenAI models', () => {
  const samplePageRender = {
    width: 1000,
    height: 1400,
    canvas: null,
    textItems: [
      // Page 1 Paper Title (full width, large font)
      { str: 'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs', x: 140, y: 120, top: 92, bottom: 120, width: 720, height: 28, fontSize: 28 },
      // Author & Affiliation on Page 1
      { str: 'Alex Rivera', x: 260, y: 162, top: 144, bottom: 162, width: 110, height: 18, fontSize: 18 },
      { str: '1', x: 372, y: 154, top: 142, bottom: 154, width: 10, height: 12, fontSize: 12 },
      { str: ', Ming-Hao Chen', x: 384, y: 162, top: 144, bottom: 162, width: 100, height: 18, fontSize: 18 },
      { str: 'Department of Computer Science, Example Institute of Technology', x: 210, y: 192, top: 174, bottom: 192, width: 580, height: 18, fontSize: 18 },
      // Left Column Section Heading & Paragraph
      { str: '1 Introduction', x: 80, y: 310, top: 288, bottom: 310, width: 180, height: 22, fontSize: 22 },
      { str: 'Large language models have demonstrated remarkable reasoning', x: 80, y: 350, top: 332, bottom: 350, width: 390, height: 18, fontSize: 18 },
      { str: 'capabilities across complex mathematical and coding tasks.', x: 80, y: 374, top: 356, bottom: 374, width: 385, height: 18, fontSize: 18 },
      // Right Column Diagram Internal Nodes + Figure Caption
      { str: 'Policy Network', x: 580, y: 320, top: 304, bottom: 320, width: 110, height: 16, fontSize: 16 },
      { str: 'Reward Verifier', x: 740, y: 360, top: 344, bottom: 360, width: 120, height: 16, fontSize: 16 },
      { str: 'Figure 1: Overview of the multi-stage reinforcement learning pipeline.', x: 540, y: 430, top: 412, bottom: 430, width: 390, height: 18, fontSize: 18 },
      // Right Column Paragraph below Figure 1
      { str: 'In this section, we evaluate the reinforcement learning pipeline', x: 540, y: 490, top: 472, bottom: 490, width: 390, height: 18, fontSize: 18 },
      { str: 'under zero-shot and few-shot evaluation benchmarks.', x: 540, y: 514, top: 496, bottom: 514, width: 375, height: 18, fontSize: 18 }
    ]
  };

  const blocks = extractStructuredPdfPageBlocks(samplePageRender, 1);
  assert.ok(blocks.length >= 5, `Expected at least 5 structured blocks, got ${blocks.length}`);
  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[0].column, 'full');
  assert.ok(blocks[0].original.includes('DeepSeek-R1'));

  const authorBlock = blocks.find((b) => b.type === 'author');
  assert.ok(authorBlock, 'Should detect Page 1 author/affiliation block');
  assert.equal(authorBlock.column, 'full');

  const figBlock = blocks.find((b) => b.type === 'figure');
  assert.ok(figBlock, 'Should detect Figure 1 block with figureBox2d');
  assert.ok(Array.isArray(figBlock.figureBox2d) && figBlock.figureBox2d.length === 4);
  assert.equal(figBlock.column, 'right');

  const leftPara = blocks.find((b) => b.column === 'left' && b.type === 'paragraph');
  const rightPara = blocks.find((b) => b.column === 'right' && b.type === 'paragraph');
  assert.ok(leftPara && rightPara, 'Should classify left and right column paragraphs accurately');
  assert.ok(
    blocks.indexOf(leftPara) < blocks.indexOf(rightPara),
    'Left column paragraph in the same vertical band must precede right column paragraph'
  );
  // Internal diagram text ("Policy Network") must be consumed by Figure 1 and not leaked as a body paragraph
  assert.ok(
    !blocks.some((b) => b.type === 'paragraph' && b.original.includes('Policy Network')),
    'Internal figure diagram labels must not leak into body paragraphs'
  );
});

check('Unit Test: Academic LaTeX Formula Renderer & Author/Affiliation Superscript Typesetting', () => {
  const sampleAuthorBlock =
    'Alex Rivera$^{1,*}$, Clara Vance$^{2}$, Ming-Hao Chen$^{3}$ $^{1}$示例理工大学计算机科学与技术学院 $^{2}$示例研究院计算生物学系 $^{*}$通讯作者：alex.rivera@example.edu';
  assert.equal(isAuthorOrAffiliationBlock(sampleAuthorBlock, 'paragraph', 1), true);

  const authorHtml = renderRichAcademicHtml(sampleAuthorBlock, {
    blockType: 'author',
    pageNum: 1
  });
  assert.ok(!authorHtml.includes('$^{1,*}$'), 'Raw LaTeX superscripts must be rendered into HTML <sup>');
  assert.ok(authorHtml.includes('<sup class="academic-sup">1,*</sup>'));
  assert.ok(authorHtml.includes('<br />'), 'Affiliation and corresponding author lines should be separated by <br />');

  const eqHtml = renderLatexMathToHtml(
    '\\mathbf{z}_c = \\frac{1}{L}\\sum_{l=1}^{L} \\alpha_l \\mathbf{e}_c^{(l)} \\in \\mathbb{R}^d',
    true
  );
  assert.ok(eqHtml.includes('math-frac'), 'Fraction \\frac must render stacked .math-frac');
  assert.ok(eqHtml.includes('∑'), '\\sum must render summation symbol ∑');
  assert.ok(eqHtml.includes('α'), '\\alpha must render α');
  assert.ok(eqHtml.includes('ℝ'), '\\mathbb{R} must render ℝ');
});

check('Unit Test: Webpage Image OCR, X.com Multi-Paragraph Post Splitting & Seamless Figure Inpainting Pipeline Verification', () => {
  assert.equal(MESSAGE_TYPES.TRANSLATE_IMAGE, 'TRANSLATE_IMAGE');
  assert.equal(DEFAULT_SETTINGS.enableImageTranslate, true);
  assert.equal(typeof renderSeamlessFigureTranslation, 'function');
  const contentMainSrc = fs.readFileSync(path.join(ROOT, 'content/content-main.js'), 'utf-8');
  assert.ok(contentMainSrc.includes('translateImageElement'));
  assert.ok(contentMainSrc.includes('inpaintWebpageImageRegions'));
  assert.ok(contentMainSrc.includes('extractParagraphSegmentsFromElement'));
  assert.ok(contentMainSrc.includes('insertNodeAfterSegmentAnchor'));

  const studioHtmlSrc = fs.readFileSync(path.join(ROOT, 'studio/studio.html'), 'utf-8');
  assert.ok(!studioHtmlSrc.includes('vendor/pdf.js'));
  assert.ok(studioHtmlSrc.includes('type="module" src="studio.js"'));
  assert.ok(studioHtmlSrc.includes('id="layoutStyleSelect"'));
  assert.ok(studioHtmlSrc.includes('id="pdfCanvasScrollViewer"'));

  const studioJsSrc = fs.readFileSync(path.join(ROOT, 'studio/studio.js'), 'utf-8');
  assert.ok(studioJsSrc.includes('INITIAL_EAGER_PDF_PAGES'));
  assert.ok(studioJsSrc.includes('setupLazyPageObserver'));
  assert.ok(studioJsSrc.includes('extractFigureVectorTextGroups'));
  assert.ok(studioJsSrc.includes('renderSeamlessFigureTranslation'));
  assert.ok(studioJsSrc.includes('scrollLeftPdfToPage'));
  assert.ok(studioJsSrc.includes('await budget.wait(initLeftPdfScrollViewer())'));
  assert.ok(studioJsSrc.includes('showNativePdfEmbed'));

  const studioCssSrc = fs.readFileSync(path.join(ROOT, 'studio/studio.css'), 'utf-8');
  assert.ok(
    studioCssSrc.includes('.pdf-canvas-scroll-viewer[hidden]') &&
      studioCssSrc.includes('display: none !important') &&
      studioCssSrc.includes('.left-pdf-page-slot.is-rendered'),
    'studio.css must enforce display: none !important on [hidden] viewers and non-collapsing .left-pdf-page-slot.is-rendered'
  );

  const pdfEngineSrc = fs.readFileSync(path.join(ROOT, 'studio/pdf-engine.js'), 'utf-8');
  assert.ok(
    pdfEngineSrc.includes('jpegDataUrl: dataUrl'),
    'renderPdfPageToCanvas must return jpegDataUrl so ensureLeftPdfPageRendered displays the left PDF page immediately'
  );
  assert.ok(
    pdfEngineSrc.includes("standardFontDataUrl: asset('standard_fonts')") &&
      pdfEngineSrc.includes("cMapUrl: asset('cmaps')") &&
      pdfEngineSrc.includes("intent: 'print'") &&
      pdfEngineSrc.includes('willReadFrequently: true'),
    'pdf-engine.js must configure local fonts/CMaps, print rendering and readable Canvas contexts'
  );
});

check('Unit Test: Extension runtime files do not leak console.warn/console.error, XHR moz-chunked-arraybuffer, or Canvas2D willReadFrequently warnings to chrome://extensions', () => {
  const runtimeFiles = [
    'background/service-worker.js',
    'background/gemini-client.js',
    'background/cache-db.js',
    'content/content-main.js',
    'content/youtube-page-bridge.js',
    'popup/popup.js',
    'options/options.js',
    'studio/studio.js',
    'studio/pdf-engine.js',
    'studio/math-renderer.js'
  ];
  for (const rel of runtimeFiles) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    assert.ok(
      !/console\.(warn|error)\s*\(/.test(src),
      `${rel} must not call console.warn or console.error (prevents chrome://extensions Errors badge)`
    );
  }
  const vendorPdfSrc = fs.readFileSync(path.join(ROOT, 'studio/vendor/pdfjs/pdf.mjs'), 'utf-8');
  assert.ok(
    !vendorPdfSrc.includes('moz-chunked-arraybuffer'),
    'studio/vendor/pdf.js must not assign deprecated moz-chunked-arraybuffer to XMLHttpRequest.responseType'
  );
  const contentMainSrc = fs.readFileSync(path.join(ROOT, 'content/content-main.js'), 'utf-8');
  assert.ok(
    contentMainSrc.includes('function safeRuntimeSendMessage('),
    'content-main.js must guard fire-and-forget chrome.runtime.sendMessage calls with safeRuntimeSendMessage'
  );
});

check('Unit Test: API Key Security Audit — no hardcoded secrets, content-script secret stripping, and error message key redaction', () => {
  assert.equal(DEFAULT_SETTINGS.apiKey, '', 'DEFAULT_SETTINGS.apiKey must be empty');
  assert.deepEqual(DEFAULT_SETTINGS.providerConfigs, {}, 'DEFAULT_SETTINGS.providerConfigs must be empty');

  // Verify no real API keys exist in any repository file
  const filesToScan = [
    'manifest.json',
    'package.json',
    'README.md',
    'CHROMEWEBSTORE.md',
    'shared/constants.js',
    'shared/storage.js',
    'shared/utils.js',
    'background/service-worker.js',
    'background/gemini-client.js',
    'background/cache-db.js',
    'content/content-main.js',
    'content/youtube-page-bridge.js',
    'popup/popup.html',
    'popup/popup.js',
    'options/options.html',
    'options/options.js',
    'studio/studio.html',
    'studio/studio.js',
    'studio/pdf-engine.js',
    'studio/math-renderer.js'
  ];

  for (const rel of filesToScan) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    assert.ok(
      !/AIza[0-9A-Za-z_-]{20,}/.test(src),
      `${rel} must not contain any hardcoded Google AIza... API key`
    );
    assert.ok(
      !/sk-[0-9A-Za-z_-]{16,}/.test(src),
      `${rel} must not contain any hardcoded OpenAI/DeepSeek sk-... API key`
    );
  }

  // Verify content-main.js strips apiKey and providerConfigs from content-script memory
  const contentMainSrc = fs.readFileSync(path.join(ROOT, 'content/content-main.js'), 'utf-8');
  assert.ok(
    contentMainSrc.includes('function sanitizeContentSettings(') &&
      contentMainSrc.includes('delete merged.apiKey') &&
      contentMainSrc.includes('delete merged.providerConfigs'),
    'content-main.js must strip apiKey and providerConfigs from content script memory'
  );

  // Verify MAIN world script (youtube-page-bridge.js) has zero access to apiKey or storage
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'content/youtube-page-bridge.js'), 'utf-8');
  assert.ok(!bridgeSrc.includes('apiKey') && !bridgeSrc.includes('chrome.storage'));

  // Verify redactSensitiveText masks keys in upstream error messages
  const sampleErr =
    'Invalid key AIzaSyB1234567890abcdefghijklmno or sk-9876543210abcdef123456 at ?key=myCustomSecret999';
  const redacted = redactSensitiveText(sampleErr, 'myCustomSecret999');
  assert.ok(!redacted.includes('AIzaSyB1234567890abcdefghijklmno'));
  assert.ok(!redacted.includes('sk-9876543210abcdef123456'));
  assert.ok(!redacted.includes('myCustomSecret999'));
});

check('Unit Test: Cache Signature Differentiation, Image Overlay Safety, Timeout Resilience & UI Completeness', () => {
  // 1. Cache style signature must differentiate tonePreset, glossaryText, and customSystemPrompt
  const sigStandard = buildStyleSignature({
    tonePreset: 'standard',
    glossaryText: 'LLM = 大语言模型',
    customSystemPrompt: ''
  });
  const sigAcademic = buildStyleSignature({
    tonePreset: 'academic',
    glossaryText: 'LLM = 大语言模型',
    customSystemPrompt: ''
  });
  const sigCustomPrompt = buildStyleSignature({
    tonePreset: 'standard',
    glossaryText: 'LLM = 大语言模型',
    customSystemPrompt: 'Keep all acronyms'
  });
  assert.notEqual(sigStandard, sigAcademic, 'Changing tonePreset must change cache signature');
  assert.notEqual(sigStandard, sigCustomPrompt, 'Changing customSystemPrompt must change cache signature');
  assert.notEqual(
    buildCacheKey('Hello', 'zh-CN', 'gemini-2.5-flash', sigStandard),
    buildCacheKey('Hello', 'zh-CN', 'gemini-2.5-flash', sigAcademic)
  );

  // 2. getActiveModelId uses getActiveProtocol consistently
  assert.equal(
    getActiveModelId({
      providerId: 'google',
      apiProtocol: 'gemini',
      modelId: 'models/gemini-2.5-flash'
    }),
    'gemini-2.5-flash'
  );
  assert.equal(
    getActiveModelId({
      providerId: 'openrouter',
      apiProtocol: 'openai',
      modelId: 'google/gemini-2.5-flash'
    }),
    'google/gemini-2.5-flash'
  );

  // 3. content-main.js defines escapeHtml and uses .ig-img-drawer-row
  const contentMainSrc = fs.readFileSync(path.join(ROOT, 'content/content-main.js'), 'utf-8');
  assert.ok(
    contentMainSrc.includes('const escapeHtml = escapeText;'),
    'content-main.js must define escapeHtml alias to prevent ReferenceError in renderImageTranslationOverlay'
  );
  assert.ok(
    contentMainSrc.includes('ig-img-drawer-row') && !contentMainSrc.includes('ig-img-drawer-item'),
    'content-main.js image drawer must use .ig-img-drawer-row matching content.css'
  );

  // 4. gemini-client.js implements timeout/retry and text-only vision guard
  const geminiClientSrc = fs.readFileSync(path.join(ROOT, 'background/gemini-client.js'), 'utf-8');
  assert.ok(
    geminiClientSrc.includes('function fetchWithTimeoutAndRetry(') &&
      geminiClientSrc.includes('new AbortController()'),
    'gemini-client.js must guard network calls with AbortController timeout and retry'
  );
  assert.ok(
    geminiClientSrc.includes('KNOWN_TEXT_ONLY_MODEL_RE'),
    'gemini-client.js must guard multimodal image requests on known text-only models'
  );

  // 5. cache-db.js and studio.js enforce LRU bounds
  const cacheDbSrc = fs.readFileSync(path.join(ROOT, 'background/cache-db.js'), 'utf-8');
  assert.ok(
    cacheDbSrc.includes('MAX_IDB_ITEMS') && cacheDbSrc.includes('pruneIndexedDbIfNeeded'),
    'cache-db.js must enforce IndexedDB capacity bounds'
  );
  const studioJsSrc = fs.readFileSync(path.join(ROOT, 'studio/studio.js'), 'utf-8');
  assert.ok(
    studioJsSrc.includes('MAX_CACHED_PAGE_RENDERS') &&
      studioJsSrc.includes('getActiveProtocol(settings)'),
    'studio.js must cap pageRenderCache and use getActiveProtocol(settings)'
  );
  assert.ok(
    !studioJsSrc.includes('onclick="'),
    'studio.js exported HTML template must not rely on inline onclick attributes'
  );

  // 6. Options & Popup UI expose image translation, cache toggle, and provider switcher
  const optionsHtmlSrc = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf-8');
  assert.ok(optionsHtmlSrc.includes('id="enableImageTranslateCheck"'));
  assert.ok(optionsHtmlSrc.includes('id="autoTranslatePageImagesCheck"'));
  assert.ok(optionsHtmlSrc.includes('id="enableCacheCheck"'));

  const popupHtmlSrc = fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf-8');
  assert.ok(popupHtmlSrc.includes('id="popupProviderSelect"'));
});

await checkAsync('Behavioral Test: incrementUsageStats serializes concurrent updates without race-condition loss', async () => {
  const mockStore = {};
  const prevChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          await new Promise((r) => setTimeout(r, 4));
          return { [key]: mockStore[key] ? { ...mockStore[key] } : undefined };
        },
        async set(obj) {
          await new Promise((r) => setTimeout(r, 4));
          Object.assign(mockStore, obj);
        }
      }
    }
  };
  try {
    await Promise.all(
      Array.from({ length: 12 }, () =>
        incrementUsageStats({ requests: 1, paragraphs: 3, chars: 100, cacheHits: 2 })
      )
    );
    const finalStats = await getUsageStats();
    assert.equal(finalStats.totalRequests, 12, 'All 12 concurrent request increments must be preserved');
    assert.equal(finalStats.totalParagraphs, 36, 'All 36 concurrent paragraph increments must be preserved');
    assert.equal(finalStats.estimatedCharsTranslated, 1200, 'All 1200 concurrent char increments must be preserved');
    assert.equal(finalStats.cacheHits, 24, 'All 24 concurrent cacheHit increments must be preserved');
  } finally {
    globalThis.chrome = prevChrome;
  }
});

await checkAsync('Behavioral Test: fetchWithTimeoutAndRetry retries transient 503/429, skips retry on 401, and aborts on timeout', async () => {
  const origFetch = globalThis.fetch;
  try {
    // 1. Retries on 503 and succeeds on attempt 2
    let attempts503 = 0;
    globalThis.fetch = async () => {
      attempts503++;
      if (attempts503 === 1) {
        return new Response('Service Unavailable', { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const res200 = await fetchWithTimeoutAndRetry('https://example.com/api', {}, { timeoutMs: 500, maxRetries: 2, baseDelayMs: 10 });
    assert.equal(res200.status, 200);
    assert.equal(attempts503, 2);

    // 2. Does NOT retry on non-retryable 401
    let attempts401 = 0;
    globalThis.fetch = async () => {
      attempts401++;
      return new Response('Unauthorized', { status: 401 });
    };
    const res401 = await fetchWithTimeoutAndRetry('https://example.com/api', {}, { timeoutMs: 500, maxRetries: 2, baseDelayMs: 10 });
    assert.equal(res401.status, 401);
    assert.equal(attempts401, 1);

    // 3. Aborts with timeout error when upstream hangs
    globalThis.fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal.reason || new DOMException('Aborted', 'AbortError'));
        });
      });
    await assert.rejects(
      () => fetchWithTimeoutAndRetry('https://example.com/hang', {}, { timeoutMs: 30, maxRetries: 0, baseDelayMs: 5 }),
      /超时/
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

await checkAsync('Behavioral Test: translateImageWithGemini rejects known text-only models (e.g. deepseek-chat) with friendly Chinese guidance', async () => {
  await assert.rejects(
    () =>
      translateImageWithGemini(
        {
          imageBase64: 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=',
          mimeType: 'image/webp',
          targetLang: 'zh-CN'
        },
        {
          providerId: 'deepseek',
          apiProtocol: 'openai',
          apiKey: 'dummy_test_key',
          modelId: 'deepseek-chat'
        }
      ),
    /纯文本模型，不支持图片视觉识别/
  );
});

await checkAsync('Behavioral Test: Two-tier translation cache (setCachedTranslations + getCachedTranslations) preserves and refreshes LRU entries', async () => {
  await setCachedTranslations([
    { key: 'k_alpha', translation: '阿尔法' },
    { key: 'k_beta', translation: '贝塔' }
  ]);
  const map = await getCachedTranslations(['k_alpha', 'k_beta', 'k_missing']);
  assert.equal(map.get('k_alpha'), '阿尔法');
  assert.equal(map.get('k_beta'), '贝塔');
  assert.equal(map.has('k_missing'), false);
});

await checkAsync('Behavioral Test: content-main.js renderImageTranslationOverlay executes cleanly and mounts overlay + .ig-img-drawer-row without ReferenceError', async () => {
  const contentMainSrc = fs.readFileSync(path.join(ROOT, 'content/content-main.js'), 'utf-8');
  const startIdx = contentMainSrc.indexOf('async function renderImageTranslationOverlay(');
  const endIdx = contentMainSrc.indexOf('function cleanupAllImageOverlays(');
  assert.ok(startIdx > 0 && endIdx > startIdx, 'Must locate renderImageTranslationOverlay in content-main.js');
  const fnSource = contentMainSrc.slice(startIdx, endIdx).trim();

  const makeMockEl = (tag) => ({
    tagName: tag.toUpperCase(),
    className: '',
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    hidden: false,
    textContent: '',
    innerHTML: '',
    title: '',
    type: '',
    listeners: {},
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    querySelectorAll() {
      return [];
    },
    querySelector(sel) {
      if (sel === '[data-role="drawer"]') {
        return this.children.find((c) => c.dataset?.role === 'drawer') || null;
      }
      return null;
    },
    addEventListener(evt, cb) {
      this.listeners[evt] = cb;
    },
    classList: {
      classes: new Set(),
      add(c) {
        this.classes.add(c);
      },
      toggle(c, force) {
        if (force) this.classes.add(c);
        else this.classes.delete(c);
      }
    }
  });

  const mockDocument = {
    createElement: (tag) => makeMockEl(tag)
  };
  const escapeText = (str) =>
    String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const escapeHtml = escapeText;
  const inpaintWebpageImageRegions = async () => null;

  // Bind and execute the exact renderImageTranslationOverlay implementation from content-main.js
  const runner = new Function(
    'document',
    'escapeText',
    'escapeHtml',
    'inpaintWebpageImageRegions',
    `return (${fnSource});`
  )(mockDocument, escapeText, escapeHtml, inpaintWebpageImageRegions);

  const host = makeMockEl('div');
  const img = makeMockEl('img');
  const bar = makeMockEl('div');
  const triggerBtn = makeMockEl('button');
  const regions = [
    {
      box_2d: [100, 100, 200, 500],
      original: 'Hello <World> & "AI"',
      translation: '你好 <世界> & "人工智能"'
    }
  ];

  await runner(host, img, { imageDataUrl: '', summaryTranslation: '汇总译文' }, regions, bar, triggerBtn);

  assert.equal(host.children.length, 2, 'Host must contain overlay and bilingual drawer');
  const [overlay, drawer] = host.children;
  assert.ok(overlay.className.includes('ig-img-overlay-layer'));
  assert.equal(overlay.children.length, 1);
  assert.equal(overlay.children[0].style.top, '10.00%');
  assert.equal(overlay.children[0].style.width, '40.00%');

  assert.ok(drawer.className.includes('ig-img-bilingual-drawer'));
  assert.equal(drawer.hidden, true);
  assert.ok(drawer.innerHTML.includes('ig-img-drawer-row'));
  assert.ok(drawer.innerHTML.includes('Hello &lt;World&gt; &amp; &quot;AI&quot;'));
  assert.equal(triggerBtn.textContent, '✓ 译图开启');
  assert.equal(bar.children.length, 1);
  assert.equal(bar.children[0].textContent, '📖 对照文本');
});

console.log(process.exitCode
  ? `\nVerification failed (${passed} checks passed). See failures above.\n`
  : `\nAll ${passed} checks passed. Browser acceptance is a separate check.\n`);
