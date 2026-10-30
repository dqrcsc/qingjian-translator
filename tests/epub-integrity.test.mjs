import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBilingualEpubBlob, readZipArchive } from '../studio/epub-engine.js';
import { EPUB_CODE, makeEpubIntegrityFixture } from './epub-integrity-fixture.mjs';

test('standard EPUB source fixture contains code, table, captions and nested structures', async () => {
  const entries = await readZipArchive(Uint8Array.from(makeEpubIntegrityFixture()).buffer);
  assert.equal(await entries.get('mimetype').getText(), 'application/epub+zip');
  const html = await entries.get('OEBPS/chapter.xhtml').getText();
  for (const tag of ['pre', 'code', 'table', 'caption', 'figcaption', 'blockquote']) assert.match(html, new RegExp(`<${tag}>`));
});

for (const mode of ['bilingual', 'translation-only']) {
  test(`EPUB ${mode} export retains escaped code and exact whitespace once`, async () => {
    const blob = buildBilingualEpubBlob({ bookTitle: 'Code test', blocks: [
      { type: 'code', original: EPUB_CODE, translation: 'MUST_NOT_REPLACE_CODE' },
      { type: 'paragraph', original: 'After code', translation: '代码之后' }
    ] }, mode);
    const entries = await readZipArchive(await blob.arrayBuffer());
    const html = await entries.get('OEBPS/chapter.xhtml').getText();
    assert.ok(html.includes('<pre><code>  if (a &lt; b &amp;&amp; ready) {\n\tconsole.log(&quot;&lt;tag&gt;&quot;);\n  }\n</code></pre>'));
    assert.equal((html.match(/console\.log/g) || []).length, 1);
    assert.doesNotMatch(html, /MUST_NOT_REPLACE_CODE/);
    assert.match(html, /代码之后/);
  });
}
