const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const out=path.resolve('logs/motion-feedback'),dir=path.join(out,'data-'+Date.now());await fs.mkdir(dir,{recursive:true});
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  const base='http://127.0.0.1:'+port,server=spawn(process.env.CALENDAR_PYTHON||'python',['app.py','--port',String(port),'--data-dir',dir,'--no-sync','--no-desktop'],{windowsHide:true,stdio:'ignore'});
  let browser;
  try {
    for(let i=0;i<70;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}if(i===69)throw Error('QA server did not start');await new Promise(r=>setTimeout(r,150));}
    const state=async()=>await(await fetch(base+'/api/state')).json();
    const request=async(url,body,method='POST')=>{const s=await state(),r=await fetch(base+url,{method,headers:{'content-type':'application/json','X-Calendar-Token':s.csrf_token},body:JSON.stringify(body)});assert.equal(r.ok,true,await r.text());};
    browser=await chromium.launch({channel:'msedge',headless:true});const p=await browser.newPage({viewport:{width:1440,height:900},locale:'zh-CN',timezoneId:'America/New_York'}),errors=[];p.setDefaultTimeout(12000);p.on('pageerror',e=>{errors.push(e.message);console.error('Browser error:',e.message);});
    await p.clock.setFixedTime(new Date('2026-10-27T20:00:00Z'));
    await request('/api/settings',{ui_motion:'standard'});
    await p.goto(base+'/?game=endfield-cn&view=timeline');await p.locator('[data-row-event]').first().waitFor();
    const id=await p.locator('[data-event-star]').nth(2).getAttribute('data-event-star'),star=()=>p.locator(`[data-event-star="${id}"]`);
    const axis=await p.locator('.timeline-head').boundingBox();
    await star().focus();await p.keyboard.press('Enter');await p.waitForFunction(id=>document.querySelector(`[data-event-star="${id}"]`).getAttribute('aria-pressed')==='true',id);
    assert.equal(await star().evaluate(n=>n===document.activeElement),true,'Star action must retain keyboard focus after DOM replacement');
    assert.deepEqual(await p.locator('.timeline-head').boundingBox(),axis,'Date axis must remain stationary');
    await p.waitForTimeout(260);assert.equal(await p.locator('[data-row-event]').evaluateAll(rows=>rows.some(n=>n.getAnimations().length)),false,'No retained row animation after settling');
    await p.route('**/api/events/'+id,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'测试保存失败'})}));
    await star().click();await p.waitForFunction(()=>document.querySelector('.toast')?.textContent.includes('测试保存失败'));
    assert.equal(await star().getAttribute('aria-pressed'),'true','Failed save must not reorder or change the mark');assert.equal(await star().evaluate(n=>n.disabled),false);await p.unroute('**/api/events/'+id);
    await p.route('**/api/events/'+id,async route=>{await new Promise(r=>setTimeout(r,350));await route.continue();});
    await star().click();await p.locator('#event-search').focus();await p.waitForFunction(id=>document.querySelector(`[data-event-star="${id}"]`).getAttribute('aria-pressed')==='false',id);assert.equal(await p.locator('#event-search').evaluate(n=>n===document.activeElement),true,'A slow save must not steal focus from a new user action');await p.unroute('**/api/events/'+id);
    await p.locator(`[data-row-event="${id}"] .event-name`).click();await p.locator('#detail-dialog').waitFor();
    await p.locator('#toggle-completed').focus();await p.keyboard.press('Enter');await p.waitForFunction(()=>document.activeElement?.id==='toggle-completed'&&document.querySelector('#toggle-completed').textContent.includes('撤销'));
    await p.keyboard.press('Escape');await p.waitForFunction(()=>!document.querySelector('#detail-dialog').open);
    assert.equal(await p.locator(`[data-row-event="${id}"] .event-name`).evaluate(n=>n===document.activeElement),true,'Closing details must restore a live opener');
    // A delayed real save must accept only one submission, including repeated keyboard Enter.
    let planRequests=0;await p.route('**/api/plans',async route=>{if(route.request().method()==='POST'){planRequests++;await new Promise(r=>setTimeout(r,350));}await route.continue();});
    await p.locator('#rail-plans').click();await p.locator('[data-new-plan]').click();await p.locator('#plan-title').fill('动效重复确认测试');
    await p.locator('#plan-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});
    await p.waitForFunction(()=>!document.querySelector('#plan-editor-dialog').open);await p.locator('#plan-form').evaluate(form=>form.requestSubmit());await p.waitForTimeout(230);assert.equal(planRequests,1);assert.equal((await state()).plans.filter(x=>x.title==='动效重复确认测试').length,1);
    await p.locator('#plans-dialog [data-close]').click();
    // Use synthetic status metadata only; no collector or external request is started.
    let synthetic=null;await p.route('**/api/state',async route=>{const headers={...route.request().headers()};delete headers['if-none-match'];const response=await route.fetch({headers}),s=await response.json();if(synthetic)s.sync_by_game['endfield-cn']=synthetic;await route.fulfill({response,json:s});});
    async function phase(status){synthetic=status;await Promise.all([p.waitForResponse(r=>r.url().endsWith('/api/state')),p.evaluate(()=>window.dispatchEvent(new Event('focus')))]);}
    await phase({running:true,stage:{name:'fetch',label:'读取公告与来源'}});await p.locator('[data-stage=fetch][aria-current=step]').waitFor();
    await phase({running:true,stage:{name:'images',label:'补齐活动图片'},calendar_saved_at:'2026-10-27T19:00:00Z',waiting:{site:'example.invalid',until:'2026-10-27T20:01:00Z'}});
    await p.locator('[data-stage=images][data-state=waiting]').waitFor();assert.match(await p.locator('#source-status').innerText(),/日历已更新/);
    await phase({running:false,error:'测试超时'});assert.equal(await p.locator('.sync-stage-strip').count(),0,'Failure must not display a completed sequence');
    await phase({running:false,result:{calendar:{added:1,updated:0,removed:0},images:{added:2,failed:0}}});await p.locator('[data-stage=done][aria-current=step]').waitFor();
    const stageBox=await p.locator('.sync-stage-strip').boundingBox(),sourceBox=await p.locator('#source-status').boundingBox();assert.ok(stageBox.y+stageBox.height<=sourceBox.y+sourceBox.height+1,'Phases must not be clipped');
    await p.screenshot({path:path.join(out,'feedback.png')});
    await p.unroute('**/api/state');await request('/api/settings',{ui_motion:'auto'});await p.emulateMedia({reducedMotion:'reduce'});await p.reload();await p.waitForFunction(()=>document.documentElement.dataset.motion==='reduced');
    await p.locator('#workspace-button').click();await p.locator('[data-preference-tab="theme"]').click();await p.locator('#ui-motion').selectOption('off');await p.waitForFunction(()=>document.documentElement.dataset.motion==='off');await p.reload();await p.waitForFunction(()=>document.documentElement.dataset.motion==='off');assert.equal((await state()).settings.ui_motion,'off');
    assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'result.json'),JSON.stringify({ok:true,starFocus:true,dateAxisStable:true,detailFocus:true,singlePlanSave:true,realStageMetadata:true,reducedMotion:true,settingPersisted:true,errors},null,2));console.log('Motion feedback checks passed.');
  } finally {if(browser)await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
