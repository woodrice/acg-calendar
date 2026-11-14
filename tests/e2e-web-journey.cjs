// Real local API and isolated fixtures: nested task returns and draft/slow-save boundaries.
const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const output=path.resolve('logs/web-journey');await fs.mkdir(output,{recursive:true});
  const dir=await fs.mkdtemp(path.join(output,'test-'));await fs.cp('examples/plugins/sample-game',path.join(dir,'plugins/sample-game'),{recursive:true});
  const feed=path.join(dir,'plugins/sample-game/events.json'),fixture=JSON.parse(await fs.readFile(feed,'utf8'));
  fixture.versions[0].events.push(...Array.from({length:12},(_,i)=>({...fixture.versions[0].events[0],id:'extra-'+i,title:'往返测试活动 '+i})));await fs.writeFile(feed,JSON.stringify(fixture));
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  const base='http://127.0.0.1:'+port,server=spawn(process.env.CALENDAR_PYTHON||'python',['app.py','--port',String(port),'--data-dir',dir,'--no-sync','--no-desktop'],{windowsHide:true,stdio:'ignore'});let browser,page;
  try{
    for(let i=0;i<60;i++){if(await fetch(base+'/api/health').then(async r=>{await r.text();return r.ok;},()=>false))break;if(i===59)throw Error('Server did not start');await new Promise(r=>setTimeout(r,150));}
    browser=await chromium.launch({channel:process.env.CALENDAR_BROWSER||'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:950},timezoneId:'America/New_York',reducedMotion:'reduce'});
    await page.clock.setFixedTime(new Date('2026-10-27T16:00:00Z'));
    const errors=[];page.on('pageerror',e=>errors.push(e.message));const state=()=>fetch(base+'/api/state').then(r=>r.json());
    await page.goto(base+'/?game=sample-game&view=month&date=2026-11-02');await page.locator('.month-cell').first().waitFor();
    const period=await page.locator('#period-title').innerText();
    // Markup uses the explicit full-date key; there is no shared date focus written by this path.
    const dayButton=page.locator('[data-deadline-day="2026-11-02"]');await dayButton.click();
    await page.locator('#deadlines-dialog[open]').waitFor();await page.locator('#deadlines-dialog [data-event]').last().click();
    await page.locator('#detail-dialog[open]').waitFor();assert.equal(await page.locator('dialog[open]').count(),1);
    await page.locator('[data-plan-for-event]').click();await page.locator('#plan-editor-dialog[open]').waitFor();
    await page.locator('#plan-title').fill('从详情安排');await page.locator('#plan-start').fill('2026-11-02T08:00');await page.locator('#plan-end').fill('2026-11-02T09:00');
    await page.locator('#plan-form button[type=submit]').click();await page.locator('#detail-dialog[open]').waitFor();
    await page.locator('#detail-dialog [data-saved-plan]').waitFor();
    assert.equal(await page.locator('#plans-dialog').evaluate(d=>d.open),false);
    await page.locator('#detail-dialog [data-close]').click();await page.locator('#deadlines-dialog[open]').waitFor();
    assert.equal(await page.locator('[data-day-tab="deadlines"]').getAttribute('aria-pressed'),'true');
    assert.ok(await page.locator('#deadlines-dialog').evaluate(d=>d.scrollTop>0||[...d.querySelectorAll('*')].some(n=>n.scrollTop>0)),'Return keeps the scrolled day summary');
    await page.locator('#deadlines-dialog [data-close]').click();await page.locator('#deadlines-dialog').waitFor({state:'hidden'});
    assert.equal(await page.locator('#period-title').innerText(),period);assert.equal((await state()).workspace.view.focus.date,null);
    assert.equal(await dayButton.evaluate(b=>document.activeElement===b),true,'Month trigger focus restored');
    // Day creation returns to its plans tab, rather than opening the global manager.
    await dayButton.click();await page.locator('#deadlines-dialog .day-actions [data-new-plan-day]').click();
    await page.locator('#plan-title').fill('当天新计划');await page.locator('#plan-form button[type=submit]').click();await page.locator('#deadlines-dialog[open]').waitFor();
    assert.equal(await page.locator('[data-day-tab="activities"]').getAttribute('aria-pressed'),'true');assert.match(await page.locator('#deadlines-content').innerText(),/当天新计划/);
    await page.locator('#deadlines-dialog [data-close]').click();
    // Esc and close ask about a dirty form; keep/discard are explicit and failure keeps inputs.
    await page.locator('#rail-plans').click();await page.locator('[data-new-plan]').click();await page.locator('#plan-title').fill('保留我的草稿');
    await page.keyboard.press('Escape');await page.locator('#discard-draft-dialog[open]').waitFor();await page.screenshot({path:path.join(output,'draft-confirm.png')});await page.locator('#keep-draft').click();assert.equal(await page.locator('#plan-title').inputValue(),'保留我的草稿');
    await page.route('**/api/plans',async route=>{if(route.request().method()==='POST'){await route.fetch();await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'测试保存失败'})});}else await route.continue();});
    await page.locator('#plan-form button[type=submit]').click();await page.locator('#plan-error').filter({hasText:'测试保存失败'}).waitFor();assert.equal(await page.locator('#plan-title').inputValue(),'保留我的草稿');
    await page.unroute('**/api/plans');
    // Hold the response: inputs and all ways to close remain locked, then return to manager.
    let release;const gate=new Promise(r=>release=r);let sent=0;
    await page.route('**/api/plans',async route=>{if(route.request().method()==='POST'){sent++;await gate;}await route.continue();});
    await page.locator('#plan-form button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#plan-title').disabled);
    await page.locator('#plan-editor-dialog [data-close]').click();assert.equal(await page.locator('#plan-editor-dialog').evaluate(d=>d.open),true);assert.equal(await page.locator('#discard-draft-dialog').evaluate(d=>d.open),false);
    await page.goBack();assert.equal(await page.locator('#plan-editor-dialog').evaluate(d=>d.open),true);
    release();await page.locator('#plans-dialog[open]').waitFor();await page.unroute('**/api/plans');assert.equal(sent,1);assert.equal((await state()).plans.filter(p=>p.title==='保留我的草稿').length,1,'Lost-response retry must not duplicate a plan');
    await page.locator('[data-new-plan]').click();await page.locator('#plan-title').fill('明确放弃');await page.locator('#plan-editor-dialog [data-close]').click();await page.locator('#discard-draft').click();await page.locator('#plans-dialog[open]').waitFor();
    assert.ok(!(await state()).plans.some(p=>p.title==='明确放弃'));
    await page.locator('#plans-dialog [data-close]').click();
    // A dirty note survives a child task and star refresh, and asks before leaving.
    await dayButton.click();await page.locator('#deadlines-dialog [data-event]').first().click();await page.locator('.edit-section summary').click();await page.locator('#edit-notes').fill('还未保存的备注');
    await page.locator('#toggle-starred').click();await page.waitForFunction(()=>!document.querySelector('#toggle-starred').disabled);assert.equal(await page.locator('#edit-notes').inputValue(),'还未保存的备注');
    await page.locator('[data-plan-for-event]').click();await page.locator('#plan-editor-dialog [data-close]').click();await page.locator('#detail-dialog[open]').waitFor();assert.equal(await page.locator('#edit-notes').inputValue(),'还未保存的备注');
    await page.locator('#detail-dialog [data-close]').click();await page.locator('#discard-draft').click();await page.locator('#deadlines-dialog[open]').waitFor();
    await page.locator('#deadlines-dialog [data-event]').first().click();await page.locator('.edit-section summary').click();assert.notEqual(await page.locator('#edit-notes').inputValue(),'还未保存的备注','Discarded notes must not reappear');
    await page.locator('#detail-dialog [data-close]').click();await page.locator('#deadlines-dialog [data-close]').click();
    // Locate an activity outside the current game and return to the original month and search.
    await page.locator('#event-search').fill('示例节日');
    const target=(await state()).events.find(e=>e.game==='endfield-cn'&&e.start.at&&!e.invalid_interval&&!e.ignored);
    await page.evaluate(id=>document.querySelector('.main-content').insertAdjacentHTML('afterbegin',`<button id="test-locate" data-locate-event="${id}">测试提醒定位入口</button>`),target.id);
    await page.locator('#test-locate').click();await page.locator('#clear-location').waitFor();assert.equal(await page.locator('body').getAttribute('data-game'),'endfield-cn');
    await page.locator('#clear-location').click();await page.waitForFunction(()=>document.body.dataset.game==='sample-game'&&!document.querySelector('#game-select').disabled);
    assert.equal(await page.locator('#month-view').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#period-title').innerText(),period);assert.equal(await page.locator('#event-search').inputValue(),'示例节日');
    assert.equal(await page.locator('#test-locate').evaluate(b=>document.activeElement===b),true);
    // A newer month/date choice wins over a held cross-game location response.
    let held=false,releaseScope;const scopeGate=new Promise(r=>releaseScope=r);
    await page.route('**/api/workspace',async route=>{if(route.request().method()==='PATCH'&&route.request().postDataJSON()?.view?.selected_games?.includes('endfield-cn')){held=true;const response=await route.fetch();await scopeGate;await route.fulfill({response});}else await route.continue();});
    await page.locator('#test-locate').click();for(let i=0;i<100&&!held;i++)await page.waitForTimeout(20);assert.ok(held);
    await page.locator('#next-period').click();const newerPeriod=await page.locator('#period-title').innerText();
    releaseScope();await page.waitForFunction(()=>!document.querySelector('#game-select').disabled);await page.unroute('**/api/workspace');
    assert.equal(await page.locator('#period-title').innerText(),newerPeriod);assert.equal(await page.locator('#month-view').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#location-context').isVisible(),false);
    await page.locator('#game-select').selectOption('sample-game');await page.waitForFunction(()=>!document.querySelector('#game-select').disabled);await page.locator('#previous-period').click();
    // SelectScope reset returns to October; move to the fixture's November deadline month.
    await page.locator('#next-period').click();await page.locator('#next-period').click();
    await page.locator('#test-locate').evaluate(b=>b.remove());
    // Browser Back follows the same source chain; a dirty form first asks about its draft.
    await page.locator('#event-search').fill('');await dayButton.click();await page.locator('#deadlines-dialog [data-event]').first().click();
    await page.goBack();await page.locator('#deadlines-dialog[open]').waitFor();await page.goBack();await page.locator('#deadlines-dialog').waitFor({state:'hidden'});
    await page.locator('#rail-plans').click();await page.locator('[data-new-plan]').click();await page.locator('#plan-title').fill('浏览器返回草稿');await page.goBack();
    await page.locator('#discard-draft-dialog[open]').waitFor();await page.locator('#keep-draft').click();assert.equal(await page.locator('#plan-title').inputValue(),'浏览器返回草稿');
    await page.goBack();await page.locator('#discard-draft').click();await page.locator('#plans-dialog[open]').waitFor();await page.locator('#plans-dialog [data-close]').click();
    // Theme edits use the same discard rule and are kept when coming back from child settings.
    await page.locator('#workspace-button').click();const radius=await page.locator('#theme-radius').inputValue();
    await page.locator('.theme-group summary').filter({hasText:'几何与排版'}).click();
    await page.locator('#theme-radius').fill(String(Number(radius)===12?13:12));await page.locator('#preferences-dialog [data-close]').click();await page.locator('#keep-draft').click();
    assert.notEqual(await page.locator('#theme-radius').inputValue(),radius);
    await page.locator('#preferences-dialog [data-close]').click();await page.locator('#discard-draft').click();await page.locator('#workspace-button').click();assert.equal(await page.locator('#theme-radius').inputValue(),radius);
    await page.locator('#theme-radius').fill(String(Number(radius)===12?13:12));await page.locator('[data-preference-tab="layout"]').click();await page.locator('#sidebar-width').fill('255');await page.locator('#save-layout').click();
    await page.locator('#preferences-error').filter({hasText:'另一个设置分组仍有未保存'}).waitFor();await page.locator('[data-preference-tab="theme"]').click();assert.notEqual(await page.locator('#theme-radius').inputValue(),radius);
    await page.locator('#save-theme').click();await page.locator('#preferences-dialog').waitFor({state:'hidden'});assert.equal((await state()).workspace.layout.sidebar.width,255);
    await page.locator('#timeline-view').click();const bar=page.locator('.personal-plan-bar').filter({hasText:'从详情安排'});await bar.click();await page.locator('#plan-title').fill('在时间轴编辑');await page.locator('#plan-form button[type=submit]').click();await page.locator('#plan-editor-dialog').waitFor({state:'hidden'});
    assert.equal(await page.locator('dialog[open]').count(),0);await page.locator('.personal-plan-bar').filter({hasText:'在时间轴编辑'}).waitFor();
    await page.locator('#calendar .timeline-scroll').evaluate(n=>{n.scrollTop=120;n.scrollLeft=40;});const scroll=await page.locator('#calendar .timeline-scroll').evaluate(n=>[n.scrollTop,n.scrollLeft]);assert.ok(scroll[0]>0);
    await page.evaluate(id=>document.querySelector('.main-content').insertAdjacentHTML('afterbegin',`<button id="scroll-locate" data-locate-event="${id}">查看其他游戏</button>`),target.id);await page.locator('#scroll-locate').click();await page.locator('#clear-location').click();await page.waitForFunction(()=>document.body.dataset.game==='sample-game'&&!document.querySelector('#game-select').disabled);
    assert.deepEqual(await page.locator('#calendar .timeline-scroll').evaluate(n=>[n.scrollTop,n.scrollLeft]),scroll,'Rebuilt timeline restores scroll');await page.locator('#scroll-locate').evaluate(b=>b.remove());
    // Valid direct links open a detail; unknown targets and invalid dates give a usable workbench.
    const detailPage=await browser.newPage({viewport:{width:1440,height:950}});detailPage.on('pageerror',e=>errors.push(e.message));
    await detailPage.goto(base+'/?game=sample-game&view=month&date=2026-11-02&event='+target.id);await detailPage.locator('#detail-dialog[open]').waitFor();await detailPage.locator('#detail-dialog [data-close]').click();assert.equal(await detailPage.locator('#month-view').getAttribute('aria-pressed'),'true');await detailPage.close();
    const invalid=await browser.newPage({viewport:{width:1440,height:950}});invalid.on('pageerror',e=>errors.push(e.message));await invalid.goto(base+'/?event=gone&date=2026-02-31');await invalid.locator('#toast').filter({hasText:'已不在本地日历'}).waitFor();assert.equal(await invalid.locator('dialog[open]').count(),0);await invalid.close();
    const narrow=await browser.newPage({viewport:{width:375,height:812},reducedMotion:'reduce'});narrow.on('pageerror',e=>errors.push(e.message));await narrow.goto(base+'/?planner=1');await narrow.locator('[data-new-plan]').click();await narrow.locator('#plan-title').fill('窄屏草稿');await narrow.keyboard.press('Escape');await narrow.locator('#discard-draft-dialog[open]').waitFor();assert.ok(await narrow.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await narrow.screenshot({path:path.join(output,'draft-narrow.png'),animations:'disabled'});assert.ok(await narrow.locator('#discard-draft-dialog button').evaluateAll(es=>es.every(e=>e.getBoundingClientRect().bottom<=innerHeight+1)));await narrow.locator('#discard-draft').click();await narrow.close();
    assert.deepEqual(errors,[]);await page.screenshot({path:path.join(output,'day-return.png')});
    console.log('PASS: task origin returns, day plan tab, focus, dirty cancel, failed/slow saves, notes/theme drafts, cross-game location return, browser Back');
  }catch(e){if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw e;}
  finally{if(browser)await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
