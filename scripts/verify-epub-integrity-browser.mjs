import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readZipArchive } from '../studio/epub-engine.js';
import { EPUB_CODE, EPUB_SOURCE_TEXT, makeEpubIntegrityFixture } from '../tests/epub-integrity-fixture.mjs';

export async function verifyEpubIntegrityBrowser(context, sw) {
  const checks = [], errors = [];
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(`EPUB integrity page: ${error.message}`));
  const run = async (label, action) => {
    try { await action(); checks.push(label); }
    catch (error) { errors.push(`${label}: ${error.message}`); }
  };
  try {
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/studio/studio.html`);
    const fixture = makeEpubIntegrityFixture();
    await run('F5 EPUB parser preserves code/table/captions/short text/nested lists and quotes in source order exactly once', async () => {
      const parsed = await page.evaluate(async bytes => {
        const { parseEpubFile } = await import('./epub-engine.js');
        return parseEpubFile(new Uint8Array(bytes).buffer);
      }, [...fixture]);
      assert.deepEqual(parsed.blocks.map(block => block.original), EPUB_SOURCE_TEXT);
      assert.deepEqual(parsed.blocks.map(block => block.id), EPUB_SOURCE_TEXT.map((_, index) => index));
      assert.equal(parsed.blocks[3].type, 'code');
      assert.equal(parsed.blocks[3].translation, EPUB_CODE);
      for (const text of ['Quote before', 'Quoted paragraph', 'Nested quote', 'Quote after'])
        assert.equal(parsed.blocks.find(block => block.original === text).type, 'quote');
    });
    await page.locator('#fileInput').setInputFiles({ name: 'source-integrity.epub', mimeType: 'application/epub+zip', buffer: fixture });
    await page.waitForFunction(() => document.querySelector('#workspaceSplitMain').dataset.documentState === 'ready');
    await run(`F5 real EPUB file input renders all ${EPUB_SOURCE_TEXT.length} source blocks and exact code whitespace in both reader layouts`, async () => {
      const source = await page.locator('#sourceOutlineViewer .source-outline-item').allTextContents();
      assert.deepEqual(source.map(text => text.replace(/\s+/g, ' ').trim()), EPUB_SOURCE_TEXT.map(text => text.replace(/\s+/g, ' ').trim()));
      for (const layout of ['paper-layout', 'card-stream']) {
        await page.locator('#layoutStyleSelect').selectOption(layout);
        assert.equal(await page.locator('#bilingualStreamContainer [data-block-id]').count(), EPUB_SOURCE_TEXT.length);
        assert.equal(await page.locator('#bilingualStreamContainer pre').textContent(), EPUB_CODE);
        assert.equal(await page.locator('#bilingualStreamContainer pre tag').count(), 0, 'code must remain inert escaped text');
      }
    });
    for (const mode of ['bilingual', 'translation-full-width']) {
      await run(`F5 real ${mode} EPUB export downloads valid XHTML with escaped pre/code and complete prose`, async () => {
        await page.locator('#viewModeSelect').selectOption(mode);
        const pending = page.waitForEvent('download');
        await page.locator('#exportMenuBtn').click();
        await page.locator('[data-export="epub"]').click();
        const artifact = await pending;
        assert.equal(await artifact.failure(), null);
        const bytes = await fs.readFile(await artifact.path());
        const archive = await readZipArchive(Uint8Array.from(bytes).buffer);
        assert.equal(await archive.get('mimetype').getText(), 'application/epub+zip');
        const html = await archive.get('OEBPS/chapter.xhtml').getText();
        const result = await page.evaluate(html => {
          const doc = new DOMParser().parseFromString(html, 'application/xhtml+xml');
          return {
            invalid: Boolean(doc.querySelector('parsererror')),
            code: [...doc.querySelectorAll('pre > code')].map(node => node.textContent),
            originals: [...doc.querySelectorAll('.orig')].map(node => node.textContent),
            text: doc.querySelector('body')?.textContent,
            accidentalMarkup: doc.querySelectorAll('pre tag').length
          };
        }, html);
        assert.equal(result.invalid, false);
        assert.deepEqual(result.code, [EPUB_CODE]);
        assert.equal(result.accidentalMarkup, 0);
        if (mode === 'bilingual') assert.deepEqual(result.originals, EPUB_SOURCE_TEXT.filter(text => text !== EPUB_CODE));
        else {
          assert.deepEqual(result.originals, []);
          for (const text of EPUB_SOURCE_TEXT) assert.ok(result.text.includes(text), `missing exported text: ${text}`);
        }
      });
    }
  } catch (error) { errors.push(`EPUB integrity setup: ${error.message}`); }
  finally { await page.close(); }
  return { checks, errors };
}
