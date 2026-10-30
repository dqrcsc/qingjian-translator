import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';

export async function verifyDocumentRoundtripBrowser(context,sw) {
  const checks=[],errors=[],calls=[];
  const server=http.createServer(async(req,res)=>{
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'});res.end();return;}
    const chunks=[];for await(const c of req)chunks.push(c);
    const body=JSON.parse(Buffer.concat(chunks));const prompt=body.messages.at(-1).content;calls.push(prompt);
    const data=[...prompt.matchAll(/"id"\s*:\s*(\d+)/g)].map(m=>({id:Number(m[1]),translation:'正文译文'}));
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(data)}}]}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
  const check=text=>{checks.push(text);console.log(`  ✓ ${text}`);};
  const upload=async(name,content)=>{await page.locator('#fileInput').setInputFiles({name,mimeType:'application/octet-stream',buffer:Buffer.isBuffer(content)?content:Buffer.from(content)});};
  const ready=()=>page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='ready');
  const download=async format=>{const event=page.waitForEvent('download');await page.locator('#exportMenuBtn').click();await page.locator(`[data-export="${format}"]`).click();return fs.readFile(await(await event).path(),'utf8');};
  try{
    await sw.evaluate(url=>chrome.storage.local.set({immersive_gemini_settings_v1:{providerId:'custom',apiProtocol:'openai',apiBaseUrl:url,apiKey:'fixture-only',modelId:'roundtrip-fixture',targetLang:'zh-CN',enableCache:false}}),`http://127.0.0.1:${server.address().port}/v1`);
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/studio/studio.html`);
    const code='  CODE_SENTINEL();\n```\n  nested();\n```\n';
    const epub=Buffer.from(await page.evaluate(async code=>{const {buildBilingualEpubBlob}=await import('./epub-engine.js');return [...new Uint8Array(await buildBilingualEpubBlob({bookTitle:'Code fixture',bookAuthor:'Test',blocks:[{type:'paragraph',original:'Source prose before the program.'},{type:'code',original:code}]}).arrayBuffer())];},code));
    for(const [name,source] of [
      ['code.html',`<p>Source prose before the program.</p><pre><code>${code}</code></pre>`],
      ['code.epub',epub],
      ['code.md',`Source prose before the program.\n\n~~~~js\n${code}\n~~~~`]
    ]){
      for(const mode of ['bilingual','translation-full-width']){
        await upload(name,source);await ready();await page.locator('#viewModeSelect').selectOption(mode);
        assert.equal(await page.locator('#bilingualStreamContainer pre').count(),1);
        const md=await download('md');await upload('roundtrip.md',md);await ready();
        assert.equal(await page.locator('#bilingualStreamContainer pre').count(),1);
        const before=await page.locator('#bilingualStreamContainer pre').textContent();assert(before.includes(code));
        const count=calls.length;await page.locator('#startTranslateDocBtn').click();await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('文档双语翻译已完成'));
        assert(calls.length>count);assert(!calls.slice(count).some(prompt=>prompt.includes('CODE_SENTINEL')));
        assert.equal(await page.locator('#bilingualStreamContainer pre').textContent(),before);
      }
      check(`Actual ${name.split('.').at(-1).toUpperCase()} → downloaded MD → upload preserves code and whitespace in bilingual/full-width views; code never reaches the HTTP model`);
    }
    await upload('unclosed.md','Source prose.\n\n```js\n  UNFINISHED_SENTINEL();');await ready();
    const closed=await download('md');assert.match(closed,/UNFINISHED_SENTINEL\(\);\n```$/);
    await upload('closed.md',closed+'\n\nFollowing prose outside code.');await ready();
    assert.equal(await page.locator('#bilingualStreamContainer pre').count(),1);
    assert.match((await page.locator('#bilingualStreamContainer .stream-orig').allTextContents()).join(' '),/Following prose outside code/);
    check('Actual unterminated Markdown code export gains a closing fence without swallowing subsequently appended prose');

    for(const [name,text] of [['empty.srt',''],['header.vtt','WEBVTT\n\n'],['note.vtt','WEBVTT\n\nNOTE no cues\n'],['style.vtt','WEBVTT\n\nSTYLE\n::cue { color:red }\n'],['bad.srt','1\ninvalid --> invalid\nUnusable subtitle'],['reversed.srt','1\n00:00:02,000 --> 00:00:01,000\nReverse time']]){
      await upload(name,text);await page.waitForFunction(()=>document.querySelector('#workspaceSplitMain').dataset.documentState==='error');
      assert.match(await page.locator('#docStatusSubtitle').textContent(),/没有可翻译字幕/);
      assert.equal(await page.locator('#startTranslateDocBtn').isDisabled(),true);assert.equal(await page.locator('#exportMenuBtn').isDisabled(),true);
    }
    check('Empty SRT/VTT, header/NOTE/STYLE-only files and invalid/reversed timing reject import and disable start/export');
    for(const [name,text] of [['valid.srt','1\n00:00:01,000 --> 00:00:02,000\nValid English caption'],['valid.vtt','WEBVTT\n\nNOTE metadata\n\n00:01.000 --> 00:02.000\nValid English caption']]){
      await upload(name,text);await ready();await page.locator('#startTranslateDocBtn').click();await page.waitForFunction(()=>document.querySelector('#docStatusSubtitle').textContent.includes('文档双语翻译已完成'));
      const srt=await download('srt');assert.match(srt,/00:00:01,000 --> 00:00:02,000/);assert.match(srt,/Valid English caption\n正文译文/);
    }
    check('A valid SRT/VTT uploaded after failures recovers and downloads actual bilingual subtitles with preserved times');
    assert.deepEqual(errors,[]);return {checks,errors};
  }finally{await page.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
