// Untrusted plugin text and personal notes must remain text, never DOM or executable code.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const folder=path.resolve('logs/security-web');await fs.mkdir(folder,{recursive:true});const dir=await fs.mkdtemp(path.join(folder,'test-'));
  const plugin=path.join(dir,'plugins/sample-game');await fs.cp('examples/plugins/sample-game',plugin,{recursive:true});
  const attack='\"><img id="pt-xss" src="x" onerror="window.__injected=true">',note='<script id="pt-note">window.__injected=true</script>';
  const feed=JSON.parse(await fs.readFile(path.join(plugin,'events.json'),'utf8'));feed.versions[0].events[0].title=attack;feed.versions[0].events[0].description=note;await fs.writeFile(path.join(plugin,'events.json'),JSON.stringify(feed));
  const port=await require('./free-port.cjs')(),base='http://127.0.0.1:'+port;
  const server=spawn(process.env.CALENDAR_PYTHON||'python',['app.py','--port',String(port),'--data-dir',dir,'--no-sync','--no-desktop'],{windowsHide:true,stdio:'ignore'});let browser;
  try{
    for(let i=0;i<60;i++){if(await fetch(base+'/api/health').then(r=>r.ok,()=>false))break;if(i===59)throw Error('Server not ready');await new Promise(r=>setTimeout(r,150));}
    browser=await chromium.launch({channel:process.env.CALENDAR_BROWSER||'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:950},reducedMotion:'reduce'}),errors=[],external=[];
    await page.clock.setFixedTime(new Date('2026-10-27T20:00:00Z'));page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){external.push(new URL(route.request().url()).host);return route.abort();}return route.continue();});
    await page.goto(base+'/?game=sample-game&view=list');const title=page.locator('#calendar [data-event]').filter({hasText:attack}).first();await title.click();
    assert.equal(await page.locator('#detail-title').innerText(),attack);await page.locator('.detail-explanation summary').click();assert.match(await page.locator('.detail-explanation').innerText(),/<script/);
    await page.locator('[data-plan-for-event]').click();await page.locator('#plan-title').fill('安全回归计划');await page.locator('#plan-notes').fill(note);await page.locator('#plan-form button[type=submit]').click();await page.locator('#detail-dialog[open]').waitFor();
    await page.locator('#detail-dialog [data-close]').click();await page.locator('#rail-plans').click();assert.equal(await page.locator('.plan-summary-notes').innerText(),note);
    assert.equal(await page.locator('#pt-xss,#pt-note,img[onerror]').count(),0);assert.equal(await page.evaluate(()=>!!window.__injected),false);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
    console.log('PASS: plugin HTML, activity descriptions and saved plan notes are escaped; no injected DOM/code or external requests');
  }finally{if(browser)await browser.close();server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
