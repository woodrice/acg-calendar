// Android shell gestures with real touch input (CDP touch events) on the development page:
// swipe left = complete, swipe right = star, short swipe = nothing, vertical drag = scroll only,
// long press = action sheet, pull to refresh = staged sync then a cooldown answer.
const path=require('node:path'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const file=path.resolve('web/shell/dev.html').split(path.sep).join('/');
(async()=>{
  const output=path.resolve('logs/android-shell-e2e');fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({channel:process.env.CALENDAR_BROWSER||'msedge',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2.6,isMobile:true,hasTouch:true,locale:'zh-CN',reducedMotion:'reduce'});
    const p=await context.newPage(),cdp=await context.newCDPSession(p),errors=[];p.on('pageerror',e=>errors.push(e.message));
    await p.goto('file:///'+file);await p.locator('#pt-shell .ps-next').waitFor();
    const touch=(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
    async function drag(x,y,dx,dy,{hold=0,steps=12}={}){await touch('touchStart',x,y);if(hold)await p.waitForTimeout(hold);for(let i=1;i<=steps;i++){await touch('touchMove',x+dx*i/steps,y+dy*i/steps);await p.waitForTimeout(16);}await touch('touchEnd');await p.waitForTimeout(350);}
    const center=async sel=>{const b=await p.locator(sel).boundingBox();return [Math.round(b.x+b.width/2),Math.round(b.y+b.height/2)];};
    const starred=id=>p.evaluate(id=>__source.event(id).starred,id),completed=id=>p.evaluate(id=>__source.event(id).completed,id);

    // A short swipe does nothing and is not taken as a tap.
    let [x,y]=await center('[data-swipe="z2"]');
    await drag(x,y,-40,0);
    assert.equal(await completed('z2'),false);assert.equal(await p.locator('#pt-shell .ps-page-layer').count(),0,'A short swipe opened the detail');
    // Swipe right stars; the title shows it.
    await drag(x,y,150,0);await p.waitForFunction(()=>__source.event('z2').starred);
    assert.match(await p.locator('#pt-shell [data-swipe="z2"] .ps-row-title').innerText(),/^★/);
    assert.equal(await p.locator('#pt-shell .ps-page-layer').count(),0,'A swipe opened the detail');
    // Swipe left completes (the row leaves the list); undo brings it back.
    [x,y]=await center('[data-swipe="z1"]');
    await drag(x,y,-150,0);await p.waitForFunction(()=>__source.event('z1').completed);
    await p.locator('#pt-shell .ps-toast.ps-on').waitFor();assert.match(await p.locator('#pt-shell .ps-toast').innerText(),/已标记完成/);
    assert.equal(await p.locator('#pt-shell [data-swipe="z1"]').count(),0);
    await p.locator('#pt-shell .ps-undo').tap();await p.waitForFunction(()=>!__source.event('z1').completed);
    await p.locator('#pt-shell [data-swipe="z1"]').waitFor();

    // A vertical drag on a row scrolls the list and triggers nothing.
    [x,y]=await center('[data-swipe="a1"]');
    const before=await p.evaluate(()=>document.querySelector('#pt-shell .ps-main').scrollTop);
    await drag(x,y,0,-260);
    assert.ok(await p.evaluate(()=>document.querySelector('#pt-shell .ps-main').scrollTop)>before+80,'A vertical drag did not scroll');
    assert.equal(await starred('a1'),false);assert.equal(await completed('a1'),false);assert.equal(await p.locator('#pt-shell .ps-layer').count(),0);
    await p.evaluate(()=>document.querySelector('#pt-shell .ps-main').scrollTo(0,0));await p.waitForTimeout(200);

    // Long press opens the action sheet; its buttons act and close it.
    [x,y]=await center('[data-swipe="z3"]');
    await touch('touchStart',x,y);await p.waitForTimeout(650);await touch('touchEnd');
    await p.locator('#pt-shell .ps-menu').waitFor();
    assert.deepEqual(await p.locator('#pt-shell .ps-menu button').allInnerTexts(),['✓ 标记完成','★ 收藏','◇ 安排游玩','查看详情']);
    assert.equal(await p.locator('#pt-shell .ps-page-layer').count(),0,'The long-press menu opened the detail page underneath');
    await p.screenshot({path:path.join(output,'long-press-menu.png')});
    await p.locator('#pt-shell .ps-menu [data-detail]').tap();await p.locator('#pt-shell .ps-page-layer').waitFor();
    assert.equal(await p.locator('#pt-shell .ps-menu').count(),0);
    assert.equal(await p.evaluate(()=>PlaytimeShell.back()),true);await p.locator('#pt-shell .ps-page-layer').waitFor({state:'detached'});
    await touch('touchStart',x,y);await p.waitForTimeout(650);await touch('touchEnd');await p.locator('#pt-shell .ps-menu').waitFor();
    await p.locator('#pt-shell .ps-menu [data-act="star"]').tap();
    await p.waitForFunction(()=>__source.event('z3').starred);await p.locator('#pt-shell .ps-menu').waitFor({state:'detached'});

    // Pull to refresh: real stages as text, a site wait, the result once, then a cooldown answer.
    await p.waitForTimeout(400);
    [x,y]=await center('#pt-shell .ps-next');
    await drag(x,y,0,260,{steps:16});
    await p.waitForFunction(()=>/正在同步 · 读取公告/.test(document.querySelector('#pt-shell .ps-sync').textContent));
    assert.equal(await p.locator('#pt-shell [data-sync]').isDisabled(),true,'立即同步 stays enabled while running');
    assert.equal(await p.locator('#pt-shell .ps-sync-bar').count(),1);
    await p.waitForFunction(()=>/补齐活动图片… · 等待 示例图库 请求间隔约 10 秒/.test(document.querySelector('#pt-shell .ps-sync').textContent));
    await p.screenshot({path:path.join(output,'sync-running.png')});
    await p.waitForFunction(()=>/本轮同步：新增 2 · 更新 1 · 补齐头图 3 张/.test(document.querySelector('#pt-shell .ps-toast').textContent));
    assert.match(await p.locator('#pt-shell .ps-sync').innerText(),/已同步/);
    await p.locator('#pt-shell [data-sync]').tap();await p.waitForFunction(()=>/刚刚已尝试同步，\d{2}:\d{2} 后可再同步/.test(document.querySelector('#pt-shell .ps-toast').textContent));

    assert.deepEqual(errors,[]);
    console.log('PASS: Android shell gestures — short swipe ignored, swipe star/complete with undo, vertical scroll untouched, long-press menu, pull-to-refresh stages and cooldown');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
