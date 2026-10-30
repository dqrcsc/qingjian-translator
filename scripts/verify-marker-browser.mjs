import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';

// Verify painted pixels, not only CSS values: a gradient on a block can have the
// right colors but still paint only the bottom half of a multiline paragraph.
export async function verifyMarkerBrowser(context, sw) {
  const key = 'immersive_gemini_settings_v1';
  const saved = await sw.evaluate(key => chrome.storage.local.get(key), key);
  const checks = [], errors = [];
  let calls = 0, page;
  const text = '这是一段用于检查荧光马克样式的长译文，每一行都应该沿着文字显示浅黄色高亮，行尾空白应保持干净。'.repeat(3) + '\n最后一行。';
  const server = http.createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><style>
        body{margin:28px;background:white;color:#17202a;font:20px/1.5 Arial,sans-serif}
        main{width:610px}p{margin:20px 0}a{color:#2463ab}button{font:inherit;background:white;border:1px solid #ccc}
        </style><main><p id="long">A long original paragraph about language models and reading translated text, with a <a href="#destination">reference link</a>, should retain its layout when highlighting translated lines.</p>
        <button id="label">Following</button><div id="destination"></div></main>`);
      return;
    }
    calls++;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const prompt = JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content;
    const items = JSON.parse(prompt.split('Input JSON:\n').at(-1));
    const answer = items.map(item => ({ id: item.id, translation: item.text.includes('Following') ? '正在关注' : `${(item.text.match(/\{\{\d+\}\}/g) || []).join(' ')} ${text}` }));
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const check = label => { checks.push(label); console.log(`  ✓ ${label}`); };
  const output = new URL('../dist/browser-verification/', import.meta.url);
  await fs.mkdir(output, { recursive: true });
  // Text rectangles are measured independently of the highlight element.
  const paintedLines = async selector => {
    const el = page.locator(selector);
    const geometry = await el.evaluate(el => {
      const box = el.getBoundingClientRect(), range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 1);
      const lines = [];
      for (const r of rects) {
        let line = lines.find(l => Math.abs(l.top - r.top) < 2);
        if (!line) { line = { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; lines.push(line); }
        else { line.left = Math.min(line.left, r.left); line.right = Math.max(line.right, r.right); }
      }
      return { box: { left: box.left, top: box.top, width: box.width }, lines: lines.sort((a,b) => a.top-b.top) };
    });
    const screenshot = await el.screenshot();
    return page.evaluate(async ({ png, geometry }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const yellow = (x,y) => {
        const i = (Math.floor(y)*canvas.width+Math.floor(x))*4;
        return pixels[i] > 230 && pixels[i+1] > 220 && pixels[i+2] < pixels[i+1]-15;
      };
      return geometry.lines.map(line => {
        const y = Math.floor(line.bottom-geometry.box.top-2);
        const left = Math.max(0,Math.ceil(line.left-geometry.box.left));
        const right = Math.min(canvas.width,Math.floor(line.right-geometry.box.left));
        let painted = 0;
        for (let x=left;x<right;x++) if (yellow(x,y)) painted++;
        const after = right+12;
        return { painted, width:right-left, trailingYellow:after<canvas.width?yellow(after,y):false };
      });
    }, { png: screenshot.toString('base64'), geometry });
  };
  try {
    await sw.evaluate(({key,base}) => chrome.storage.local.set({[key]: {
      providerId:'custom',apiProtocol:'openai',apiBaseUrl:base+'/v1',apiKey:'local-only',modelId:'fixture',enableCache:false,
      translationStyle:'marker',autoTranslateAllPages:false,autoTranslatePageImages:false,enableFloatingBall:false,neverTranslateDomains:''
    }}), {key,base});
    page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({width:900,height:1000});
    await page.goto(base);
    await page.waitForFunction(() => document.documentElement.dataset.igStyle === 'marker');
    const tabId = await sw.evaluate(async url => (await chrome.tabs.query({})).find(t=>t.url===url).id,page.url());
    const send = message => sw.evaluate(({tabId,message})=>chrome.tabs.sendMessage(tabId,message),{tabId,message});
    await send({type:'TOGGLE_PAGE_TRANSLATION'});
    await page.locator('#long[data-ig-status="done"] .ig-trans-node').waitFor();
    await page.locator('#label .ig-trans-inline').waitFor();
    await page.screenshot({path:new URL('marker-wide.png',output).pathname,fullPage:true});
    const wide = await paintedLines('#long .ig-trans-node');
    assert.ok(wide.length>=4, 'fixture must wrap over several lines');
    assert.ok(wide.every(line=>line.painted>5), `every line needs marker paint: ${JSON.stringify(wide)}`);
    assert.ok(wide.every(line=>!line.trailingYellow), 'line-end whitespace must not be highlighted');
    assert.ok((await paintedLines('#label .ig-trans-node')).every(line=>line.painted>5));
    check('Marker paints every wrapped and explicit-newline text line, leaves trailing space clear and keeps short UI labels highlighted');

    await page.locator('main').evaluate(el=>el.style.width='310px');
    const narrow = await paintedLines('#long .ig-trans-node');
    assert.ok(narrow.length>wide.length);
    assert.ok(narrow.every(line=>line.painted>5 && !line.trailingYellow));
    await page.screenshot({path:new URL('marker-narrow.png',output).pathname,fullPage:true});
    await page.locator('#long .ig-trans-node a').click();
    assert.equal(new URL(page.url()).hash,'#destination');
    check('Narrow-layout reflow retains per-line marker paint and the translated link remains clickable');

    const count=calls;
    for(const style of ['clean','blockquote','underline','mask','translation-only','marker']) {
      await send({type:'SET_TRANSLATION_STYLE',payload:{style}});
      await page.waitForFunction(style=>document.documentElement.dataset.igStyle===style,style);
      assert.equal(await page.locator('#long .ig-trans-node').count(),1);
      if(style!=='marker') assert.equal(await page.locator('#long .ig-trans-text').evaluate(el=>getComputedStyle(el).backgroundImage),'none');
    }
    assert.equal(calls,count,'style changes must not request another translation');
    assert.ok((await paintedLines('#long .ig-trans-node')).every(line=>line.painted>5));
    await send({type:'TOGGLE_PAGE_TRANSLATION'});
    await page.waitForFunction(()=>!document.querySelector('.ig-trans-node,.ig-trans-text'));
    assert.equal(await page.locator('.ig-trans-node,.ig-trans-text').count(),0);
    assert.equal(await page.locator('#long > a').getAttribute('href'),'#destination');
    check('All six styles reuse the translation without leaking marker paint; disabling restores the original link and removes highlight wrappers');
    assert.deepEqual(errors,[]);
    return {checks,errors};
  } finally {
    await page?.close();
    await sw.evaluate(saved=>chrome.storage.local.set(saved),saved);
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
  }
}
