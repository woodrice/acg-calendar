// Android shell (M0) on its development page with fixed-date sample data: no backend, no network.
// Covers: inert without the Android marker; tabs and routes; Back order; drawers; detail page with
// undoable actions; plan draft keeping and discarding; loading / empty / error states; deep links.
const path=require('node:path'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const page_=path.resolve('web/shell/dev.html').split(path.sep).join('/'),url=q=>'file:///'+page_+(q||'');
(async()=>{
  const output=path.resolve('logs/android-shell-e2e');fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({channel:process.env.CALENDAR_BROWSER||'msedge',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2.6,isMobile:true,hasTouch:true,locale:'zh-CN',reducedMotion:'reduce'});
    const errors=[];context.on('weberror',e=>errors.push(e.error().message));
    // Stands in for the Android host's bar-colour bridge (MainActivity.Host).
    await context.addInitScript(()=>{window.__bars=[];window.PlaytimeHost={setBars:(top,bottom)=>window.__bars.push([top,bottom])};});
    const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));
    const back=()=>p.evaluate(()=>PlaytimeShell.back());
    const shell=s=>p.locator('#pt-shell '+s);

    // 1. Without the Android marker the shell stays inert.
    await p.goto(url('?plain=1'));
    assert.equal(await p.evaluate(()=>document.documentElement.dataset.shell),undefined);
    assert.equal(await p.locator('#pt-shell').innerHTML(),'');assert.equal(await p.locator('#plain-page').isVisible(),true);

    // 2. Home: four tabs, the next deadline first, grouped rows; touch-sized, no sideways scroll.
    await p.goto(url());await shell('.ps-next').waitFor();
    assert.deepEqual(await shell('.ps-tabs button').allInnerTexts(),['近期','日历','计划','我的']);
    assert.equal(await shell('.ps-tabs [aria-current="page"]').innerText(),'近期');
    assert.match(await shell('.ps-next').innerText(),/下一个截止[\s\S]*琳琅鎏心 等 3 项[\s\S]*11\/11 周三 11:59/);
    assert.ok(await shell('.ps-row').count()>=5,'Expected at least five activities on the first screen');
    const small=await p.evaluate(()=>[...document.querySelectorAll('#pt-shell button')].filter(b=>b.checkVisibility()).map(b=>[b.textContent.trim().slice(0,8)||b.getAttribute('aria-label'),b.getBoundingClientRect().height]).filter(([,h])=>h<40));
    assert.deepEqual(small,[],'Touch targets under 40px');
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await p.screenshot({path:path.join(output,'home.png')});

    // 3. Detail page: star with undo, complete keeps the page, Back returns focus to the row.
    await shell('[data-open-event="z1"]').tap();await shell('.ps-page-layer').waitFor();
    assert.match(p.url(),/#\/upcoming\?event=z1$/);
    await shell('[data-act="star"]').tap();await shell('.ps-toast.ps-on').waitFor();
    assert.equal(await shell('[data-act="star"]').getAttribute('aria-pressed'),'true');
    await shell('.ps-undo').tap();await p.waitForFunction(()=>document.querySelector('#pt-shell [data-act="star"]').getAttribute('aria-pressed')==='false');
    await shell('[data-act="complete"]').tap();await p.waitForFunction(()=>/撤销完成/.test(document.querySelector('#pt-shell [data-act="complete"]').textContent));
    assert.match(await shell('.ps-detail-t').innerText(),/琳琅鎏心/,'Completing hid the open detail');
    await p.screenshot({path:path.join(output,'detail.png')});
    assert.equal(await back(),true);await shell('.ps-page-layer').waitFor({state:'detached'});
    assert.equal(await shell('[data-open-event="z1"]').count(),0,'A completed activity should leave the list (hide completed)');
    await shell('.ps-undo').tap().catch(()=>{});
    assert.equal(await back(),false,'Back on 近期 with no layer should let the app exit');

    // 4. Calendar month: whole-cell fill relative to the month peak, count bottom-right; day drawer.
    await shell('[data-tab="calendar"]').tap();assert.match(p.url(),/#\/calendar\/month$/);
    const cell=shell('[data-open-day="2026-11-11"]');
    assert.match(await cell.getAttribute('aria-label'),/截止 3 项/);assert.equal(await cell.locator('.ps-cell-n').innerText(),'3');
    assert.match(await cell.getAttribute('style'),/--fill:100%/);
    assert.match(await shell('[data-open-day="2026-11-14"]').getAttribute('style'),/--fill:66\.6/); // 19:59/20:00 UTC on 11/13 fall on 11/14 locally
    assert.match(await shell('[data-open-day="2026-11-15"]').getAttribute('style'),/--fill:33\.3/);
    await cell.tap();await shell('.ps-sheet').waitFor();assert.equal(await shell('.ps-sheet .ps-row').count(),3);
    await p.screenshot({path:path.join(output,'month-day.png')});
    assert.equal(await back(),true);await shell('.ps-sheet').waitFor({state:'detached'});
    assert.equal(await p.evaluate(()=>document.activeElement?.dataset.openDay),'2026-11-11','Focus did not return to the day');
    await shell('[data-cal="timeline"]').tap();await shell('#ps-timeline-mount').waitFor();
    assert.equal(await back(),true);assert.equal(await shell('.ps-tabs [aria-current="page"]').innerText(),'近期','Back from a tab goes to 近期');

    // 5. Scope and filter drawers act through the source; the badge counts active filters.
    await shell('[data-sheet="scope"]').tap();await shell('[data-scope-game="zzz-cn"]').tap();
    await p.waitForFunction(()=>/2 款/.test(document.querySelector('#pt-shell .ps-scope').textContent));
    await back();await shell('[data-sheet="filter"]').tap();await shell('[data-filter-type="gacha"]').tap();
    await p.waitForFunction(()=>document.querySelector('#pt-shell .ps-badge')?.textContent==='1');
    await shell('[data-filter-reset]').tap();await p.waitForFunction(()=>!document.querySelector('#pt-shell .ps-badge'));
    await back();

    // Live updates to the game list must keep a scrolled drawer in place, without replaying entry.
    const narrow=await context.newPage();
    await narrow.setViewportSize({width:390,height:390});
    await narrow.emulateMedia({reducedMotion:'no-preference'});
    await narrow.goto(url());
    await narrow.locator('.ps-scope').tap();
    const scrollBefore=await narrow.locator('.ps-sheet').evaluate(async sheet=>{
      await Promise.all(sheet.getAnimations().map(animation=>animation.finished));
      sheet.scrollTop=60;
      return sheet.scrollTop;
    });
    assert.ok(scrollBefore>0,'Expected a scrollable game drawer');
    const scopeUpdate=await narrow.evaluate(async()=>{
      const s=window.__source,act=s.act.bind(s);
      // Hold the first write for a tick, as the real loopback API does.
      s.act=async(...args)=>{await Promise.resolve();return act(...args);};
      const state=()=>__source.snapshot().scope.games;
      const first=document.querySelector('[data-scope-game="endfield-cn"]');
      const second=document.querySelector('[data-scope-game="arknights-cn"]');
      const seen=[];
      const off=s.subscribe(()=>{
        const sheet=document.querySelector('.ps-sheet');
        seen.push({scroll:sheet.scrollTop,animation:getComputedStyle(sheet).animationName,games:state()});
      });
      first.click();second.click();
      const until=performance.now()+2500;
      while(seen.length<2&&performance.now()<until)await new Promise(resolve=>setTimeout(resolve,20));
      off();
      return seen;
    });
    assert.equal(scopeUpdate.length,2);
    assert.deepEqual(scopeUpdate.at(-1).games,['zzz-cn'],'A rapid toggle overwrote the previous selection');
    assert.ok(scopeUpdate.every(s=>s.scroll===scrollBefore&&s.animation==='none'),'Game selection moved or reanimated the open drawer');
    await narrow.close();

    // 6. Plans: validation keeps the input; Back with a draft asks first; saving adds the plan.
    await shell('[data-tab="plans"]').tap();
    const fab=shell('.ps-fab');
    assert.match(await fab.innerText(),/新建计划/);
    assert.ok(await fab.evaluate(button=>{
      const style=getComputedStyle(button);
      return style.color!==style.backgroundColor;
    }),'New plan text and button background have the same color');
    await fab.tap();await shell('.ps-sheet [name="title"]').waitFor();
    // The form starts on the source's today; the sample plan is set for the next evening.
    assert.equal(await shell('[name="start"]').inputValue(),'2026-11-07T20:00');
    await shell('[name="title"]').fill('周末刷寻访');await shell('[name="start"]').fill('2026-11-08T20:00');await shell('[name="end"]').fill('2026-11-08T19:00');
    await shell('[data-plan-save]').tap();await shell('.ps-error').waitFor();
    assert.match(await shell('.ps-error').innerText(),/结束时间必须晚于开始时间/);assert.equal(await shell('[name="title"]').inputValue(),'周末刷寻访');
    assert.equal(await back(),true);await shell('.ps-confirm').waitFor();
    await shell('[data-draft="keep"]').tap();await shell('.ps-confirm').waitFor({state:'detached'});
    assert.equal(await shell('[name="title"]').inputValue(),'周末刷寻访','Keeping the draft lost the input');
    // Back on the discard question returns to the draft (it used to close the form and lose it).
    assert.equal(await back(),true);await shell('.ps-confirm').waitFor();
    assert.equal(await back(),true);await shell('.ps-confirm').waitFor({state:'detached'});
    assert.equal(await shell('[name="title"]').inputValue(),'周末刷寻访','Back on the question lost the draft');
    // The browser's own history Back goes through the same guard.
    await p.goBack();await shell('.ps-confirm').waitFor();
    assert.equal(await shell('.ps-sheet [name="title"]').inputValue(),'周末刷寻访','History Back closed the draft');
    // A second history Back closes the question like Android Back does, and keeps the draft.
    await p.goBack();await shell('.ps-confirm').waitFor({state:'detached'});
    assert.equal(await shell('.ps-sheet [name="title"]').inputValue(),'周末刷寻访','Second history Back lost the draft');
    await shell('[name="end"]').fill('2026-11-08T23:00');await shell('[data-plan-save]').tap();
    await shell('.ps-sheet').waitFor({state:'detached'});await shell('.ps-toast.ps-on').waitFor();
    assert.match(await shell('.ps-cards').innerText(),/周末刷寻访/);
    const [toastBox,fabBox]=[await shell('.ps-toast').boundingBox(),await shell('.ps-fab').boundingBox()];
    assert.ok(toastBox.y+toastBox.height<=fabBox.y,'The toast covers the 新建计划 button');
    await p.screenshot({path:path.join(output,'plans.png')});

    // The plan went out as local wall times plus the IANA zone and was stored as that instant.
    const saved=await p.evaluate(()=>__source.snapshot().plans.find(x=>x.title==='周末刷寻访'));
    assert.deepEqual([saved.timezone,saved.start,saved.end],['Asia/Shanghai','2026-11-08T12:00:00.000Z','2026-11-08T15:00:00.000Z']);

    // 6a. Repeated wall times: start and end each get their own 较早/较晚 choice. On the New York
    // fall-back day, the earlier 01:45 (EDT) to the later 01:15 (EST) is a valid 30-minute plan.
    await p.goto(url('?zone=America/New_York#/plans'));await shell('.ps-fab').tap();
    await shell('[name="title"]').fill('回拨夜');
    await shell('[name="start"]').fill('2026-11-01T01:45');await shell('[name="end"]').fill('2026-11-01T01:15');
    await shell('[data-plan-save]').tap();await shell('.ps-error').waitFor();
    assert.match(await shell('.ps-error').innerText(),/夏令时重复/);
    assert.deepEqual(await shell('.ps-fold-h').allInnerTexts(),['开始 01:45 在当地出现两次','结束 01:15 在当地出现两次']);
    await shell('[data-fold-field="start"][data-fold="0"]').tap();await shell('[data-fold-field="end"][data-fold="1"]').tap();
    assert.equal(await shell('[data-fold-field="start"][data-fold="0"]').getAttribute('aria-checked'),'true');
    assert.equal(await shell('[data-fold-field="end"][data-fold="1"]').getAttribute('aria-checked'),'true');
    assert.equal(await shell('[data-fold-field="start"][data-fold="1"]').getAttribute('aria-checked'),'false','One choice was written to both fields');
    await p.screenshot({path:path.join(output,'plan-fold.png')});
    await shell('[data-plan-save]').tap();await shell('.ps-sheet').waitFor({state:'detached'});
    const fallBack=await p.evaluate(()=>__source.snapshot().plans.find(x=>x.title==='回拨夜'));
    assert.deepEqual([fallBack.timezone,fallBack.start,fallBack.end],['America/New_York','2026-11-01T05:45:00.000Z','2026-11-01T06:15:00.000Z']);
    // Only the field that repeats asks; a changed time drops its old choice.
    await shell('.ps-fab').tap();await shell('[name="title"]').fill('只有结束重复');
    await shell('[name="start"]').fill('2026-11-01T00:30');await shell('[name="end"]').fill('2026-11-01T01:30');
    await shell('[data-plan-save]').tap();await shell('.ps-error').waitFor();
    assert.deepEqual(await shell('.ps-fold-h').allInnerTexts(),['结束 01:30 在当地出现两次']);
    await shell('[data-fold-field="end"][data-fold="1"]').tap();
    await shell('[name="end"]').fill('2026-11-01T01:40');
    assert.equal(await shell('[data-fold-field="end"][aria-checked="true"]').count(),0,'An old choice was kept for a new time');
    await shell('[data-fold-field="end"][data-fold="0"]').tap();await shell('[data-plan-save]').tap();await shell('.ps-sheet').waitFor({state:'detached'});
    const endOnly=await p.evaluate(()=>__source.snapshot().plans.find(x=>x.title==='只有结束重复'));
    assert.deepEqual([endOnly.start,endOnly.end],['2026-11-01T04:30:00.000Z','2026-11-01T05:40:00.000Z']);
    // A spring-forward gap is refused with the API's reason.
    await shell('.ps-fab').tap();await shell('[name="title"]').fill('不存在');
    await shell('[name="start"]').fill('2027-03-14T02:30');await shell('[name="end"]').fill('2027-03-14T04:00');
    await shell('[data-plan-save]').tap();await shell('.ps-error').waitFor();
    assert.match(await shell('.ps-error').innerText(),/不存在/);assert.equal(await shell('.ps-fold').count(),0);

    // 6c. Editing a plan: the card opens it filled in; only what changed is sent; Back on a changed
    // draft asks first; delete has an undo that brings the same plan back.
    await p.goto(url('#/plans'));await shell('[data-edit-plan="p1"]').tap();
    assert.equal(await shell('.ps-sheet .ps-title').innerText(),'编辑计划');
    assert.deepEqual([await shell('[name="title"]').inputValue(),await shell('[name="start"]').inputValue(),await shell('[name="end"]').inputValue()],['赶琳琅鎏心最后一抽','2026-11-10T21:00','2026-11-10T23:00']);
    await shell('[name="title"]').fill('赶最后一抽');assert.equal(await back(),true);
    await shell('.ps-confirm').waitFor();await shell('[data-draft="keep"]').tap();
    await shell('[data-plan-save]').tap();await shell('.ps-sheet').waitFor({state:'detached'});
    await p.waitForFunction(()=>/计划已更新/.test(document.querySelector('#pt-shell .ps-toast').textContent));
    let edited=await p.evaluate(()=>__source.snapshot().plans.find(x=>x.id==='p1'));
    assert.deepEqual([edited.title,edited.start,edited.end],['赶最后一抽','2026-11-10T13:00:00.000Z','2026-11-10T15:00:00.000Z']);
    await shell('[data-edit-plan="p1"]').tap();
    assert.equal(await shell('.ps-toast.ps-on').count(),0,'The last toast covers the new sheet');
    await shell('[name="end"]').fill('2026-11-10T23:30');
    await shell('[data-plan-save]').tap();await shell('.ps-sheet').waitFor({state:'detached'});
    edited=await p.evaluate(()=>__source.snapshot().plans.find(x=>x.id==='p1'));assert.equal(edited.end,'2026-11-10T15:30:00.000Z');
    // An unchanged save just closes.
    await shell('[data-edit-plan="p1"]').tap();await shell('[data-plan-save]').tap();await shell('.ps-sheet').waitFor({state:'detached'});
    // Delete, then undo.
    await shell('[data-edit-plan="p1"]').tap();await shell('[data-plan-delete]').tap();await shell('.ps-sheet').waitFor({state:'detached'});
    await p.waitForFunction(()=>/计划已删除/.test(document.querySelector('#pt-shell .ps-toast').textContent));
    assert.equal(await shell('[data-edit-plan]').count(),0);
    await shell('.ps-undo').tap();await shell('[data-edit-plan]').waitFor();
    const restored=await p.evaluate(()=>__source.snapshot().plans[0]);
    assert.deepEqual([restored.title,restored.start,restored.end,restored.timezone],['赶最后一抽','2026-11-10T13:00:00.000Z','2026-11-10T15:30:00.000Z','Asia/Shanghai']);
    // A plan kept in another zone is edited in that zone, and an untouched repeated time keeps
    // the occurrence it was saved with (here the later 01:30 in New York).
    await p.evaluate(()=>__source.act('createPlan',{title:'回拨后',local_start:'2026-11-01T01:30',fold_start:1,local_end:'2026-11-01T02:30',timezone:'America/New_York',request_id:'f'.repeat(32)}));
    const ny=await p.evaluate(()=>__source.snapshot().plans.find(x=>x.title==='回拨后'));
    assert.equal(ny.start,'2026-11-01T06:30:00.000Z');
    await shell(`[data-edit-plan="${ny.id}"]`).tap();
    assert.equal(await shell('[name="start"]').inputValue(),'2026-11-01T01:30');
    assert.match(await shell('.ps-sheet').innerText(),/按计划的时区 America\/New_York 填写/);
    await shell('[name="title"]').fill('回拨后·改名');await shell('[data-plan-save]').tap();await shell('.ps-sheet').waitFor({state:'detached'});
    const ny2=await p.evaluate(id=>__source.snapshot().plans.find(x=>x.id===id),ny.id);
    assert.deepEqual([ny2.title,ny2.start,ny2.end],['回拨后·改名','2026-11-01T06:30:00.000Z','2026-11-01T07:30:00.000Z']);
    // A plan whose game is no longer installed cannot be saved again, so delete asks first (Back
    // and 保留 keep it) and offers no undo.
    await p.goto(url('?stale=1#/plans'));await shell('[data-edit-plan="p-old"]').tap();
    await shell('[data-plan-delete]').tap();await shell('.ps-confirm').waitFor();
    assert.match(await shell('.ps-confirm').innerText(),/删除后无法撤销/);
    assert.equal(await back(),true);await shell('.ps-confirm').waitFor({state:'detached'});assert.equal(await shell('.ps-sheet').count(),1);
    await shell('[data-plan-delete]').tap();await shell('[data-delete-keep]').tap();await shell('.ps-confirm').waitFor({state:'detached'});
    assert.equal(await p.evaluate(()=>__source.snapshot().plans.some(x=>x.id==='p-old')),true);
    await shell('[data-plan-delete]').tap();await shell('[data-delete-confirm]').tap();await shell('.ps-sheet').waitFor({state:'detached'});
    await p.waitForFunction(()=>/计划已删除/.test(document.querySelector('#pt-shell .ps-toast').textContent));
    assert.equal(await shell('.ps-undo').count(),0,'Offered an undo that the plan API would refuse');
    assert.equal(await p.evaluate(()=>__source.snapshot().plans.some(x=>x.id==='p-old')),false);
    // An ordinary plan still deletes at once with an undo.
    await shell('[data-edit-plan="p1"]').tap();await shell('[data-plan-delete]').tap();await shell('.ps-sheet').waitFor({state:'detached'});
    await shell('.ps-undo').waitFor();await shell('.ps-undo').tap();await shell('[data-edit-plan]').waitFor();
    // The event goes away between delete and undo (a sync removed it): undo still brings the plan
    // back, with its title, times, zone and notes, and without the link that no longer exists.
    const zGame=await p.evaluate(()=>__source.event('z2').game);
    await p.evaluate(g=>__source.act('createPlan',{title:'跟活动的计划',local_start:'2026-11-09T20:00',local_end:'2026-11-09T21:00',timezone:'Asia/Shanghai',game_id:g,event_id:'z2',request_id:'e'.repeat(32)}),zGame);
    const linked=await p.evaluate(()=>__source.snapshot().plans.find(x=>x.title==='跟活动的计划'));
    await shell(`[data-edit-plan="${linked.id}"]`).tap();await shell('[data-plan-delete]').tap();await shell('.ps-sheet').waitFor({state:'detached'});
    await shell('.ps-undo').waitFor();
    await p.evaluate(()=>__source.dropEvent('z2'));
    await shell('.ps-undo').tap();
    await p.waitForFunction(()=>/计划已恢复，原关联的活动已不在本地日历/.test(document.querySelector('#pt-shell .ps-toast').textContent));
    const back2=await p.evaluate(()=>__source.snapshot().plans.find(x=>x.title==='跟活动的计划'));
    assert.deepEqual([back2.start,back2.end,back2.timezone,back2.game_id,back2.event_id],[linked.start,linked.end,'Asia/Shanghai',zGame,null]);
    // A change saved elsewhere while the sheet was open is what undo brings back, not the copy the
    // sheet opened with.
    await p.evaluate(()=>__source.act('createPlan',{title:'有备注的计划',notes:'旧备注',local_start:'2026-11-09T18:00',local_end:'2026-11-09T19:00',timezone:'Asia/Shanghai',request_id:'d'.repeat(32)}));
    const noted=await p.evaluate(()=>__source.snapshot().plans.find(x=>x.title==='有备注的计划'));
    await shell(`[data-edit-plan="${noted.id}"]`).tap();await shell('[data-plan-delete]').waitFor();
    await p.evaluate(id=>__source.act('updatePlan',{id,notes:'打开面板后改的新备注'}),noted.id);
    await shell('[data-plan-delete]').tap();await shell('.ps-sheet').waitFor({state:'detached'});
    await shell('.ps-undo').tap();await p.waitForFunction(()=>__source.snapshot().plans.some(x=>x.title==='有备注的计划'));
    assert.equal(await p.evaluate(()=>__source.snapshot().plans.find(x=>x.title==='有备注的计划').notes),'打开面板后改的新备注');
    // A plan that is gone says so instead of an empty form.
    await p.goto(url('#/plans?sheet=plan-edit&item=missing'));await shell('.ps-sheet').waitFor();
    assert.match(await shell('.ps-sheet').innerText(),/计划不可用/);

    // 6b. A save in flight keeps the sheet; its late answer is applied to the draft that sent it.
    await p.goto(url('?hold=createPlan#/plans'));await shell('.ps-fab').tap();
    await shell('[name="title"]').fill('慢保存');await shell('[data-plan-save]').tap();
    await p.waitForFunction(()=>document.querySelector('#pt-shell [data-plan-save]').disabled);
    assert.equal(await back(),true);await shell('.ps-toast.ps-on').waitFor();
    assert.match(await shell('.ps-toast').innerText(),/正在保存/);assert.equal(await shell('.ps-sheet').count(),1,'Back closed a sheet that is still saving');
    await p.goBack();await p.waitForTimeout(200);assert.equal(await shell('.ps-sheet').count(),1,'History Back closed a sheet that is still saving');
    await p.evaluate(()=>__source.release(false));await shell('.ps-error').waitFor();
    assert.match(await shell('.ps-error').innerText(),/请求超时/);assert.equal(await shell('[name="title"]').inputValue(),'慢保存');
    await shell('[data-plan-save]').tap();await p.waitForFunction(()=>document.querySelector('#pt-shell [data-plan-save]').disabled);
    // While it saves, the fields are locked, so nothing typed now can be lost when it succeeds.
    assert.equal(await shell('.ps-fields').evaluate(f=>f.disabled),true,'Fields stay editable during a save');
    assert.equal(await shell('[name="title"]').isEditable(),false);
    await p.evaluate(()=>__source.release(true));await shell('.ps-sheet').waitFor({state:'detached'});
    assert.match(await shell('.ps-cards').innerText(),/慢保存/);
    assert.equal(await p.evaluate(()=>__source.snapshot().plans.filter(x=>x.title==='慢保存').length),1,'The plan was saved more or less than once');
    await p.goto(url());await shell('.ps-next').waitFor();

    // 7. 我的 sub-page: Back goes to 我的 first, then to 近期.
    await shell('[data-tab="me"]').tap();await shell('[data-me="sync"]').tap();await shell('.ps-sub-h').waitFor();
    assert.equal(await back(),true);assert.equal(await shell('.ps-sub-h').count(),0);
    assert.equal(await back(),true);assert.equal(await shell('.ps-tabs [aria-current="page"]').innerText(),'近期');

    // 7b. 我的 pages: appearance (follows the system until chosen), games scope, notices, sync detail.
    await p.goto(url('#/me/appearance'));await shell('[data-appearance]').first().waitFor();
    const theme=()=>p.evaluate(()=>document.querySelector('#pt-shell').dataset.theme);
    await p.emulateMedia({colorScheme:'dark'});await p.waitForFunction(()=>document.querySelector('#pt-shell').dataset.theme==='dark');
    await p.emulateMedia({colorScheme:'light'});await p.waitForFunction(()=>document.querySelector('#pt-shell').dataset.theme==='light');
    await shell('[data-appearance="dark"]').tap();await p.waitForFunction(()=>document.querySelector('#pt-shell').dataset.theme==='dark');
    assert.equal(await shell('[data-appearance="dark"]').getAttribute('aria-checked'),'true');
    assert.equal(await p.evaluate(()=>getComputedStyle(document.querySelector('#pt-shell')).backgroundColor),'rgb(18, 19, 17)');
    await shell('[data-appearance="light"]').tap();await p.waitForFunction(()=>document.querySelector('#pt-shell').dataset.theme==='light');
    await p.emulateMedia({colorScheme:'dark'});await p.waitForTimeout(100);assert.equal(await theme(),'light','An explicit 浅色 followed the system');
    await shell('[data-appearance="system"]').tap();await p.waitForFunction(()=>document.querySelector('#pt-shell').dataset.theme==='dark');
    await p.emulateMedia({colorScheme:'light'});
    // On Android the host reports the system setting live (the page is not recreated), so a plan
    // being typed keeps its text through a system light/dark switch.
    await p.goto(url('#/plans'));await shell('.ps-fab').tap();await shell('[name="title"]').fill('切换主题时在写');
    const host=dark=>p.evaluate(v=>{document.documentElement.dataset.systemDark=v;dispatchEvent(new Event('playtime-system-theme'));},dark?'1':'0');
    await host(true);await p.waitForFunction(()=>document.querySelector('#pt-shell').dataset.theme==='dark');
    assert.equal(await shell('[name="title"]').inputValue(),'切换主题时在写');
    await host(false);await p.waitForFunction(()=>document.querySelector('#pt-shell').dataset.theme==='light');
    assert.equal(await shell('[name="title"]').inputValue(),'切换主题时在写');
    await p.evaluate(()=>{delete document.documentElement.dataset.systemDark;});
    assert.equal(await back(),true);await shell('[data-draft="discard"]').tap();await shell('.ps-sheet').waitFor({state:'detached'});
    await p.goto(url('#/me/appearance'));await shell('[data-appearance]').first().waitFor();
    // Presets: shown whole in their own mode, accent only in the other; 标准 is the shell's own look.
    const tokens=()=>p.evaluate(()=>{const s=getComputedStyle(document.querySelector('#pt-shell'));return ['--ps-page','--ps-accent','--ps-accent-ink','--ps-on-inverse','--ps-fill-opacity'].map(k=>s.getPropertyValue(k).trim());});
    await shell('[data-appearance="light"]').tap();
    // 终末地 has the same colours as 标准 (the desktop differs in shape only), so it is not listed twice.
    assert.equal(await shell('[data-preset]').count(),6);assert.equal(await shell('[data-preset="endfield"]').count(),0);
    await shell('[data-preset="nikke"]').tap();await p.waitForFunction(()=>document.querySelector('#pt-shell').dataset.preset==='nikke');
    assert.equal(await shell('[data-preset="nikke"]').getAttribute('aria-checked'),'true');
    assert.deepEqual((await tokens()).slice(0,4),['#FCF2EF','#A43B33','#FFFFFF','#FFFBF9'],'NIKKE in light: its own page, red accent, readable text on dark blocks');
    await shell('[data-appearance="dark"]').tap();await p.waitForFunction(()=>document.querySelector('#pt-shell').dataset.theme==='dark');
    assert.deepEqual((await tokens()).slice(0,4),['#121311','#A43B33','#FFFFFF','#F4F4EF'],'NIKKE in dark: shell dark page with the red accent');
    // Month day numbers on a full fill reach 4.5:1 in every preset and mode, measured from the
    // rendered colours (cell background, fill colour and opacity, number colour).
    for(const mode of ['light','dark'])for(const preset of ['light','dark','arknights','endfield','nikke','azurlane','zzz']){
      await p.evaluate(([m,k])=>__source.act('setAppearance',{mode:m,preset:k}),[mode,preset]);
      await p.goto(url('#/calendar/month'));await shell('.ps-cell[style*="--fill:100%"] .ps-cell-fill').first().waitFor();
      const ratio=await p.evaluate(()=>{
        const rgb=c=>c.match(/[\d.]+/g).slice(0,3).map(Number),lin=v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;};
        const L=a=>.2126*lin(a[0])+.7152*lin(a[1])+.0722*lin(a[2]);
        const fill=document.querySelector('#pt-shell .ps-cell[style*="--fill:100%"] .ps-cell-fill'),cell=fill.closest('.ps-cell'),num=cell.querySelector('.ps-cell-d');
        const op=Number(getComputedStyle(fill).opacity),f=rgb(getComputedStyle(fill).backgroundColor),b=rgb(getComputedStyle(cell).backgroundColor);
        const blend=b.map((v,i)=>v+(f[i]-v)*op),x=L(blend),y=L(rgb(getComputedStyle(num).color));
        return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
      });
      assert.ok(ratio>=4.5,`${preset} in ${mode}: full-fill day number ${ratio.toFixed(2)}:1`);
    }
    await p.evaluate(()=>__source.act('setAppearance',{mode:'dark',preset:'nikke'}));await p.goto(url('#/me/appearance'));await shell('[data-preset]').first().waitFor();
    await shell('[data-preset="arknights"]').tap();await p.waitForFunction(()=>document.querySelector('#pt-shell').dataset.preset==='arknights');
    assert.deepEqual((await tokens()).slice(0,2),['#101214','#00C8E8'],'明日方舟 in dark: its own dark page');
    await shell('[data-preset="light"]').tap();await p.waitForFunction(()=>document.querySelector('#pt-shell').dataset.preset==='light');
    // The host is told the bar colour (the top bar / tab bar surface), once per change.
    await shell('[data-appearance="dark"]').tap();await p.waitForFunction(()=>window.__bars.at(-1)?.[0]==='#1C1D1A');
    await shell('[data-preset="arknights"]').tap();await p.waitForFunction(()=>window.__bars.at(-1)?.[0]==='#1B1E22');
    const calls=await p.evaluate(()=>window.__bars.length);await shell('[data-tab="upcoming"]').tap();await p.waitForTimeout(200);
    assert.equal(await p.evaluate(()=>window.__bars.length),calls,'Bar colours were sent again without a change');
    await p.goto(url('#/me/appearance'));await shell('[data-preset="light"]').tap();await p.waitForFunction(()=>document.querySelector('#pt-shell').dataset.preset==='light');
    await shell('[data-appearance="light"]').tap();await p.waitForFunction(()=>window.__bars.at(-1)?.[0]==='#FFFFFF');
    assert.equal(await p.evaluate(()=>document.querySelector('#pt-shell').style.getPropertyValue('--ps-accent')),'','标准 left preset colours behind');
    await shell('[data-appearance="system"]').tap();await p.waitForFunction(()=>document.querySelector('#pt-shell').dataset.theme==='light');
    await p.goto(url('#/me/games'));await shell('[data-scope-game="nikke-global"]').waitFor();
    assert.equal(await shell('.ps-main [data-back]').count(),0,'The scope sheet\'s 完成 button leaked into 我的 → 游戏');
    await shell('[data-scope-game="nikke-global"]').tap();
    await p.waitForFunction(()=>__source.snapshot().scope.games.includes('nikke-global'));
    await p.goto(url('#/me/reminders'));await shell('[data-mark-read]').tap();
    await p.waitForFunction(()=>__source.snapshot().app.unread===0);await shell('[data-mark-read]').waitFor({state:'detached'});
    assert.match(await shell('.ps-main').innerText(),/没有未读/);
    await p.goto(url('#/me/sync'));
    const syncText=await shell('.ps-main').innerText();
    assert.match(syncText,/上次读取超时，已保留缓存/);assert.match(syncText,/示例图库/);assert.match(syncText,/后可再请求/);
    await p.goto(url('#/me/about'));assert.equal(await shell('a.ps-source').getAttribute('href'),'https://github.com/woodrice/acg-calendar');

    // 7c. Readability and touch (U14): text 4.5:1 and control outlines 3:1 in every preset and
    // mode; every control at least 44px; filter chips that are on say so without colour; date
    // fields take the full width (the time is not cut off at large text sizes).
    for(const mode of ['light','dark'])for(const preset of ['light','dark','arknights','endfield','nikke','azurlane','zzz']){
      await p.evaluate(([m,k])=>__source.act('setAppearance',{mode:m,preset:k}),[mode,preset]);await p.waitForTimeout(40);
      const low=await p.evaluate(()=>{
        const cs=getComputedStyle(document.querySelector('#pt-shell')),v=n=>cs.getPropertyValue(n).trim();
        const lin=x=>{x/=255;return x<=.03928?x/12.92:((x+.055)/1.055)**2.4;},L=h=>{const [r,g,b]=[1,3,5].map(i=>lin(parseInt(h.slice(i,i+2),16)));return .2126*r+.7152*g+.0722*b;};
        const c=(a,b)=>{const x=L(v(a)),y=L(v(b));return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
        return [['--ps-ink','--ps-page',4.5],['--ps-ink','--ps-surface',4.5],['--ps-muted','--ps-page',4.5],['--ps-muted','--ps-surface',4.5],['--ps-muted','--ps-soft',4.5],['--ps-accent-ink','--ps-accent',4.5],
          ['--ps-on-inverse','--ps-inverse',4.5],['--ps-inverse-ink','--ps-inverse',4.5],['--ps-inverse-muted','--ps-inverse',4.5],['--ps-danger','--ps-surface',4.5],['--ps-warn-ink','--ps-warn-bg',4.5],['--ps-edge','--ps-surface',3]]
          .filter(([f,b,min])=>c(f,b)<min).map(([f,b])=>`${f} on ${b} ${c(f,b).toFixed(2)}`);
      });
      assert.deepEqual(low,[],`${preset} in ${mode}`);
    }
    await p.evaluate(()=>__source.act('setAppearance',{mode:'system',preset:'light'}));
    for(const v of ['#/upcoming','#/upcoming?event=z2','#/upcoming?sheet=scope','#/upcoming?sheet=filter','#/calendar/month','#/plans','#/plans?sheet=plan-new','#/me','#/me/sync','#/me/appearance','#/me/about']){
      await p.goto(url(v));await p.waitForTimeout(150);
      const small=await p.evaluate(()=>[...document.querySelectorAll('#pt-shell button,#pt-shell a,#pt-shell input,#pt-shell summary,#pt-shell select,#pt-shell [role="button"],#pt-shell [tabindex]:not([tabindex="-1"])')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.height<44||r.width<44);}).map(e=>e.className+' '+(e.innerText||e.getAttribute('aria-label')||'').trim()));
      assert.deepEqual(small,[],`Controls under 44px on ${v}`);
      if(v.includes('event=z2'))assert.equal(await shell('.ps-more summary').count(),2,'The sample detail lost its 阶段 / 活动说明 sections, so their size is not checked');
    }
    await p.goto(url('#/upcoming?sheet=filter'));await shell('[data-filter-type="event"]').waitFor();
    assert.match(await shell('[data-filter-type="event"]').innerText(),/^✓/);
    await shell('[data-filter-type="event"]').tap();await p.waitForFunction(()=>!/✓/.test(document.querySelector('#pt-shell [data-filter-type="event"]').innerText));
    await shell('[data-filter-type="event"]').tap();
    await p.goto(url('#/plans?sheet=plan-new'));await shell('[name="start"]').waitFor();
    assert.equal(await shell('[name="start"]').evaluate(i=>Math.round(i.getBoundingClientRect().width)===Math.round(i.parentElement.getBoundingClientRect().width)),true,'The date field is narrower than its row');
    await p.goto(url());await shell('.ps-next').waitFor();

    // 8. A failed action keeps the old state and says why.
    await p.goto(url('?fail=setStarred#/upcoming?event=z2'));await shell('.ps-page-layer').waitFor();
    await shell('[data-act="star"]').tap();await shell('.ps-toast.ps-on').waitFor();
    assert.match(await shell('.ps-toast').innerText(),/保存失败/);assert.equal(await shell('[data-act="star"]').getAttribute('aria-pressed'),'false');
    // Deep link: Back closes the layer in place instead of leaving the app.
    assert.equal(await back(),true);await shell('.ps-page-layer').waitFor({state:'detached'});
    assert.match(p.url(),/dev\.html\?fail=setStarred#\/upcoming$/);

    // 9. Loading, error with retry, and empty data.
    await p.goto(url('?state=loading'));await shell('.ps-empty').waitFor();assert.match(await shell('.ps-empty').innerText(),/正在读取/);
    await shell('.ps-next').waitFor();
    await p.goto(url('?state=error'));assert.match(await shell('.ps-empty').innerText(),/读取本地日历失败/);
    await shell('[data-reload]').tap();await shell('.ps-next').waitFor();
    await p.goto(url('?state=empty'));assert.match(await shell('.ps-empty').innerText(),/当前没有可用的活动/);

    assert.deepEqual(errors,[]);
    console.log('PASS: Android shell M0 — inert without marker, tabs/routes, Back order, drawers, detail with undo, plan draft rules, states, deep link');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
