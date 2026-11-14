const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const out=path.resolve('logs/timeline-motion'),dir=path.join(out,'data-'+Date.now());await fs.mkdir(dir,{recursive:true});
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  const base='http://127.0.0.1:'+port,server=spawn(process.env.CALENDAR_PYTHON||'python',['app.py','--port',String(port),'--data-dir',dir,'--no-sync','--no-desktop'],{windowsHide:true,stdio:'ignore'});
  let browser;
  try{
    for(let i=0;i<60;i++){try{if(await fetch(base+'/api/health').then(async r=>{await r.text();return r.ok;}))break;}catch{}if(i===59)throw Error('QA server did not start');await new Promise(r=>setTimeout(r,150));}
    const state=async()=>await(await fetch(base+'/api/state')).json();
    const request=async(url,body,method='POST')=>{const s=await state(),r=await fetch(base+url,{method,headers:{'content-type':'application/json','X-Calendar-Token':s.csrf_token},body:JSON.stringify(body)});assert.equal(r.ok,true,await r.text());};
    await request('/api/settings',{ui_motion:'standard',hide_completed:true});
    await request('/api/workspace',{view:{group_by:'none'}},'PATCH');
    browser=await chromium.launch({channel:process.env.CALENDAR_BROWSER||'msedge',headless:true});const p=await browser.newPage({viewport:{width:1440,height:1050},locale:'zh-CN',timezoneId:'America/New_York'}),errors=[];
    p.setDefaultTimeout(8000);p.on('pageerror',e=>errors.push(e.message));await p.clock.setFixedTime(new Date('2026-10-27T20:00:00Z'));
    const row=id=>p.locator(`#calendar [data-row-event="${id}"]`),bar=id=>row(id).locator('.event-bar');
    const roots=()=>p.locator('#calendar [data-order-root]').evaluateAll(rows=>rows.filter(n=>n.dataset.orderRoot===n.dataset.rowEvent&&n.querySelector('.event-bar')).map(n=>n.dataset.rowEvent));
    await p.goto(base+'/?game=endfield-cn&view=timeline');await p.locator('#calendar .event-bar').first().waitFor();
    const intro=await p.locator('#calendar .event-bar').evaluateAll(bars=>bars.flatMap(b=>b.getAnimations()).map(a=>a.effect.getTiming()));
    assert.ok(intro.length>1&&intro.some(a=>a.delay>0&&a.duration===420&&a.easing.includes('0.65')),'First reveal is staggered and eased at both ends');
    await p.waitForTimeout(750);
    const original=await roots(),first=original[0],second=original[1];assert.ok(first&&second);
    const time=await bar(second).evaluate(n=>[n.style.getPropertyValue('--bar-left'),n.style.getPropertyValue('--bar-width')]);
    const axis=await p.locator('.day-axis').boundingBox();
    await bar(second).click();const detail=p.locator('#detail-dialog');assert.equal(await detail.evaluate(d=>d.open),true);
    assert.equal(await detail.evaluate(d=>d.getAnimations({subtree:true}).length),0,'Detail must open without animation');
    await p.keyboard.press('Escape');assert.equal(await detail.evaluate(d=>d.open||d.getAnimations({subtree:true}).length>0),false,'Detail must close immediately');
    assert.equal(await bar(second).evaluate(n=>n===document.activeElement),true);

    await bar(second).scrollIntoViewIfNeeded();const from=await bar(second).boundingBox(),target=await row(first).boundingBox();
    await p.mouse.move(from.x+Math.min(30,from.width/2),from.y+from.height/2);await p.mouse.down();await p.waitForTimeout(380);
    await p.locator('#calendar .order-lifted').first().waitFor();await p.mouse.move(from.x+Math.min(30,from.width/2),target.y+10,{steps:8});await p.mouse.up();
    await p.waitForFunction(()=>PlaytimeWorkspace.view.sort==='manual');assert.equal((await roots())[0],second);
    assert.deepEqual(await bar(second).evaluate(n=>[n.style.getPropertyValue('--bar-left'),n.style.getPropertyValue('--bar-width')]),time);
    assert.equal((await p.locator('.day-axis').boundingBox()).x,axis.x);assert.equal(await detail.evaluate(d=>d.open),false);
    const saved=(await state()).workspace.view.manual_order;assert.ok(saved.indexOf(second)<saved.indexOf(first));
    await p.reload();await p.locator('#calendar .event-bar').first().waitFor();assert.equal((await roots())[0],second);await p.waitForTimeout(700);

    await p.route('**/api/workspace',async route=>{const body=route.request().postDataJSON();if(body?.view?.manual_order)await route.fulfill({status:503,json:{error:'排序保存失败测试'}});else await route.continue();});
    await bar(second).focus();await p.keyboard.press('Alt+ArrowDown');await p.waitForFunction(()=>document.querySelector('#toast').textContent.includes('排序保存失败测试'));
    assert.deepEqual((await state()).workspace.view.manual_order,saved);assert.equal((await roots())[0],second);await p.unroute('**/api/workspace');
    await bar(second).focus();await p.keyboard.press('Alt+ArrowDown');await p.getByRole('button',{name:'撤销排序',exact:true}).click();
    await p.waitForFunction(()=>document.querySelector('#toast').textContent.includes('已恢复原顺序'));assert.equal((await roots())[0],second);

    await row(second).locator('[data-event-complete]').click();await row(second).waitFor({state:'detached'});
    await p.getByRole('button',{name:'撤销完成',exact:true}).click();await row(second).waitFor();assert.equal(await row(second).locator('[data-event-complete]').getAttribute('aria-pressed'),'false');
    await p.locator('#event-search').fill('完全不匹配的活动');await row(second).waitFor({state:'detached'});
    assert.ok(await p.locator('.motion-phantom[inert][aria-hidden=true] .timeline-row').count()>0,'Filtered rows leave an inert animation overlay');
    const synthetic={id:'test-locate',event_id:second,title:'定位测试提醒',message:'请定位此活动',created_at:'2026-10-27T20:00:00Z',read:true};
    await p.route('**/api/state',async route=>{const headers={...route.request().headers()};delete headers['if-none-match'];const response=await route.fetch({headers}),data=await response.json();data.notifications=[synthetic];await route.fulfill({response,json:data});});
    await Promise.all([p.waitForResponse(r=>r.url().endsWith('/api/state')),p.evaluate(()=>window.dispatchEvent(new Event('focus')))]);
    await p.locator('#inbox-button').click();await p.locator('[data-locate-event]').click();await p.locator('#calendar .motion-located').waitFor();
    assert.equal(await p.locator('#event-search').inputValue(),'完全不匹配的活动');assert.match(await p.locator('#location-context').innerText(),/临时定位/);
    await p.locator('#clear-location').click();await row(second).waitFor({state:'detached'});await p.locator('#reminder-dialog[open]').waitFor();await p.locator('#reminder-dialog [data-close]').click();await p.locator('#event-search').fill('');

    await p.locator('#calendar-expand').click();await p.waitForFunction(()=>document.body.classList.contains('calendar-focused'));
    assert.ok(await p.locator('[data-frame=calendar]').evaluate(n=>n.getAnimations().some(a=>a.effect.getTiming().duration===275)));
    await p.keyboard.press('Escape');await p.waitForFunction(()=>!document.body.classList.contains('calendar-focused'));await p.waitForTimeout(450);
    assert.equal(await p.locator('.motion-phantom').count(),0);
    await Promise.all([p.waitForResponse(r=>r.url().endsWith('/api/state')),p.evaluate(()=>window.dispatchEvent(new Event('focus')))]);
    assert.equal(await p.locator('#calendar .event-bar').evaluateAll(ns=>ns.some(n=>n.getAnimations().some(a=>a.effect.getTiming().duration===420))),false,'Polling never replays entry');
    assert.deepEqual(errors,[]);
    await p.screenshot({path:path.join(out,'timeline.png')});
    await fs.writeFile(path.join(out,'result.json'),JSON.stringify({ok:true,opening:true,detailNoAnimation:true,pointerAndKeyboardSort:true,sortRollback:true,completeUndo:true,locateWithoutClearingFilters:true,focusExpansion:true,quietPolling:true,errors},null,2));
    console.log('PASS: production timeline motion, immediate detail, persisted drag, keyboard reorder, rollback, undo, locate, focus expansion and quiet polling');
  }finally{if(browser)await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
