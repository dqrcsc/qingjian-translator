// Standard EPUB source markup, deliberately independent of QingJian's exporter.
export const EPUB_CODE = '  if (a < b && ready) {\n\tconsole.log("<tag>");\n  }\n';
export const EPUB_SOURCE_TEXT = [
  'Integrity chapter', 'Opening prose.', 'A', EPUB_CODE,
  'Table caption', 'Heading one', 'Heading two', 'Cell alpha', 'Cell beta',
  'Figure caption', 'Parent before', 'Nested item', 'Parent after',
  'Quote before', 'Quoted paragraph', 'Nested quote', 'Quote after',
  'Standalone container text', 'Final prose.'
];

export function makeEpubIntegrityFixture() {
  const files = [
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book">urn:test:integrity</dc:identifier><dc:title>Integrity fixture</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-30T00:00:00Z</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>'],
    ['OEBPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Chapter</a></li></ol></nav></body></html>'],
    ['OEBPS/chapter.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Integrity fixture</title></head><body>
<h1>Integrity chapter</h1><p>Opening <em>prose.</em></p><p>A</p>
<pre><code>${EPUB_CODE.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</code></pre>
<table><caption>Table caption</caption><thead><tr><th>Heading one</th><th>Heading two</th></tr></thead><tbody><tr><td>Cell alpha</td><td><p>Cell beta</p></td></tr></tbody></table>
<figure><figcaption>Figure <strong>caption</strong></figcaption></figure>
<ul><li>Parent before<ul><li>Nested item</li></ul>Parent after</li></ul>
<blockquote>Quote before<p>Quoted paragraph</p><blockquote>Nested quote</blockquote>Quote after</blockquote>
<div>Standalone <span>container text</span></div><p>Final prose.</p>
<script>SHOULD_NOT_IMPORT_SCRIPT</script><style>.SHOULD_NOT_IMPORT_STYLE{}</style>
</body></html>`]
  ];
  const local = [], central = [];
  let offset = 0;
  for (const [path, text] of files) {
    const name = Buffer.from(path), data = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
