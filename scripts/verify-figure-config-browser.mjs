import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';

export async function verifyFigureConfigBrowser(context, sw) {
  const checks = [], errors = [], calls = [];
  let mode = 'ok', heldReply;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks));
    const content = body.messages.at(-1).content;
    const vision = Array.isArray(content);
    const english = JSON.stringify(body.messages).includes('Target Language: English.');
    const items = vision ? [] : [...content.matchAll(/"id"\s*:\s*(\d+),\s*"text"\s*:\s*"([^"\\]*)"/g)].map(m => ({ id: Number(m[1]), text: m[2] }));
    const labels = items.some(item => item.text === 'Hello label');
    calls.push({ vision, labels, english, model: body.model, prompt: content });
    if (mode === 'fail-labels' && labels) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'synthetic label failure' } })); return; }
    const answer = vision ? { hasText: true, summaryTranslation: '中文图注', regions: [{ original: 'Hello label', translation: '旧标签', box_2d: [100, 100, 350, 850] }] }
      : items.map(item => ({ id: item.id, translation: labels ? (english ? 'New English label' : '旧标签') : (english ? 'English caption' : '中文正文') }));
    const reply = () => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] })); };
    if (mode === 'hold-labels' && labels) heldReply = reply; else reply();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = { providerId: 'custom', apiProtocol: 'openai', apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic-only', modelId: 'original-model', targetLang: 'zh-CN', enableCache: false, enableFloatingBall: false, autoTranslateAllPages: false };
  const configure = settings => sw.evaluate(settings => chrome.storage.local.set({ immersive_gemini_settings_v1: settings }), settings);
  const page = await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror', e => errors.push(e.message));
  const check = text => {checks.push(text);console.log(`  ✓ ${text}`);};
  const wait = async predicate => { const until = Date.now()+15000; while (!predicate()) { if (Date.now()>until) throw Error('Figure fixture timeout'); await page.waitForTimeout(20); } };
  const figureState = () => page.locator('.paper-figure-canvas').evaluate(el => ({
    image: el.querySelector('img').src, original: el.querySelector('img').dataset.originalSrc,
    tips: [...el.querySelectorAll('[title]')].map(e => e.title).join(' ')
  }));
  try {
    await configure(original);await page.goto(`chrome-extension://${new URL(sw.url()).host}/studio/studio.html`);
    await page.locator('#fileInput').setInputFiles({name:'figures.md',mimeType:'text/markdown',buffer:Buffer.from('A source paragraph.')});
    await page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='ready');
    const png = await page.evaluate(()=>{const c=document.createElement('canvas');c.width=240;c.height=100;const g=c.getContext('2d');g.fillStyle='white';g.fillRect(0,0,240,100);g.fillStyle='black';g.fillText('Hello label',25,25);return c.toDataURL().split(',')[1];});
    await page.locator('#figureImageInput').setInputFiles({name:'figure.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('图中文字覆盖翻译完成'));
    const old = await figureState();assert.match(old.tips,/旧标签/);assert.notEqual(old.image,old.original);
    await configure({...original,modelId:'new-model',targetLang:'en'});await page.locator('[data-config-new]').click();
    await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('文档双语翻译已完成'));
    const fresh=await figureState();assert.match(fresh.tips,/New English label/);assert.notEqual(fresh.image,old.image);assert.equal(fresh.original,old.original);
    assert.equal(calls.filter(c=>c.vision).length,1,'existing labels need translation, not repeat OCR');
    const labelCall=calls.find(c=>c.labels);assert.equal(labelCall.model,'new-model');assert.equal(labelCall.english,true);
    assert.equal(await page.locator('#progressCounterBadge').textContent(),'2 / 2 段');
    const pending=page.waitForEvent('download');await page.locator('#exportMenuBtn').click();await page.locator('[data-export="html"]').click();
    const html=await fs.readFile(await(await pending).path(),'utf8');assert.match(html,/New English label/);
    check('Real Markdown + image entry: new configuration retranslates labels through bound HTTP and redraws the original image; full HTML retains the new labels');
    await page.locator('[data-config-restore]').click();assert.deepEqual(await figureState(),old);
    check('Restore previous translation recovers the original label text and rendered image together');

    mode='fail-labels';await configure({...original,targetLang:'en',modelId:'failure-model',glossaryText:'Hello=Greeting'});
    await page.locator('[data-config-new]').click();await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('翻译出错'));
    assert.equal(await page.locator('#progressCounterBadge').textContent(),'1 / 2 段');
    assert.match(await page.locator('.paper-figure-box [role="status"]').textContent(),/尚未完成/);
    assert.doesNotMatch(await page.locator('#startTranslateDocBtn').textContent(),/重新翻译/);
    const before=calls.length;await page.waitForTimeout(150);assert.equal(calls.length,before);
    mode='ok';await page.locator('#startTranslateDocBtn').click();await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('文档双语翻译已完成'));
    assert.match((await figureState()).tips,/New English label/);assert.equal(await page.locator('#progressCounterBadge').textContent(),'2 / 2 段');
    check('Failed label translation stays incomplete with a visible status; explicit continue recovers without claiming the caption alone completed the figure');

    mode='hold-labels';await configure({...original,targetLang:'en',modelId:'late-model',glossaryText:'Hello=Late'});await page.locator('[data-config-new]').click();await wait(()=>heldReply);
    await page.locator('#fileInput').setInputFiles({name:'replacement.md',mimeType:'text/markdown',buffer:Buffer.from('Replacement document must remain untouched.')});
    await page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='ready');heldReply();await page.waitForTimeout(150);
    assert.equal(await page.locator('.paper-figure-canvas').count(),0);assert.match(await page.locator('#bilingualStreamContainer').textContent(),/Replacement document/);
    check('Replacing the document cancels pending label translation; a late response cannot restore the old figure');
  } finally {await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  return {checks,errors};
}
