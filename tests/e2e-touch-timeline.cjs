// Phone timeline with real touch input: vertical swipes scroll the page, rows stay short, a tap
// opens the detail (where star/complete live), and the edge grip reorders by long-press drag.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base='http://127.0.0.1:8817';
(async()=>{
  const output=path.resolve('logs/touch-timeline-e2e'),dir=path.join(output,'data-'+Date.now());
  await fs.mkdir(dir,{recursive:true});
  const server=spawn(process.env.CALENDAR_PYTHON||'python',['app.py','--port','8817','--data-dir',dir,'--no-sync','--no-desktop'],{windowsHide:true,stdio:'ignore'});let browser;
  try{
    for(let i=0;i<50;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}if(i===49)throw Error('Server failed');await new Promise(r=>setTimeout(r,200));}
    browser=await chromium.launch({channel:'msedge',headless:true});
    const context=await browser.newContext({viewport:{width:412,height:860},deviceScaleFactor:2.6,isMobile:true,hasTouch:true,locale:'zh-CN',timezoneId:'Asia/Shanghai',reducedMotion:'reduce'});
    const page=await context.newPage(),cdp=await context.newCDPSession(page),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.clock.setFixedTime(new Date('2026-10-27T04:00:00Z'));
    await page.goto(base+'/?game=endfield-cn');await page.locator('#timeline-view').tap();
    await page.locator('#calendar .timeline-row[data-row-event]').nth(3).waitFor();
    const touch=(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
    async function drag(x,y,dy,hold=0){await touch('touchStart',x,y);if(hold)await page.waitForTimeout(hold);for(let i=1;i<=12;i++){await touch('touchMove',x,y+dy*i/12);await page.waitForTimeout(16);}await touch('touchEnd');await page.waitForTimeout(400);}
    const center=async locator=>{await locator.evaluate(n=>n.scrollIntoView({block:'center'}));await page.waitForTimeout(200);const b=await locator.boundingBox();return [Math.round(b.x+b.width/2),Math.round(b.y+b.height/2)];};

    // 1. Short rows; per-row star/complete are hidden on touch phones, the grip is a slim edge.
    const heights=await page.locator('#calendar .timeline-row[data-row-event]').evaluateAll(rows=>rows.map(r=>r.getBoundingClientRect().height));
    assert.ok(Math.max(...heights)<=130&&heights.filter(h=>h<=72).length>=heights.length/2,'Rows are too tall: '+heights);
    assert.equal(await page.locator('#calendar [data-event-star]').first().isVisible(),false);
    const grip=await page.locator('#calendar [data-order-handle]').first().boundingBox();
    assert.ok(grip.width<=24&&grip.height>=44,'Grip must be a slim, full-height target: '+JSON.stringify(grip));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Page scrolls sideways');

    // 2. A vertical swipe on a bar or on a name scrolls the page.
    for(const sel of ['#calendar .timeline-row .bar-cell','#calendar .timeline-row .event-name']){
      const [x,y]=await center(page.locator(sel).nth(2)),before=await page.evaluate(()=>scrollY);
      await drag(x,y,-260);
      assert.ok(await page.evaluate(()=>scrollY)>before+100,'A vertical swipe on '+sel+' did not scroll the page');
    }

    // 3. Tap opens the detail; star and complete there, and the row shows the state.
    const name=page.locator('#calendar .timeline-row[data-row-event] .event-name').first(),id=await name.getAttribute('data-event');
    // A tap during a fling only stops it (as on a phone), so let scrolling settle first.
    await page.waitForFunction(()=>new Promise(r=>{const y=scrollY;setTimeout(()=>r(scrollY===y),300);}));
    await name.evaluate(n=>n.scrollIntoView({block:'center'}));await page.waitForTimeout(300);await name.tap();
    await page.locator('#detail-dialog[open]').waitFor();
    await page.locator('#toggle-starred').tap();await page.waitForFunction(id=>document.querySelector(`[data-event-star="${id}"]`)?.getAttribute('aria-pressed')==='true',id);
    await page.locator('#toggle-completed').tap();await page.waitForTimeout(500);
    await page.locator('#detail-dialog [data-close]').first().tap();await page.waitForTimeout(400);
    assert.match(await page.locator(`#calendar [data-row-event="${id}"] .event-name strong`).innerText(),/^★/);
    const marked=(await (await fetch(base+'/api/state')).json()).events.find(e=>e.id===id);
    assert.equal(marked.starred&&marked.completed,true,'Detail buttons did not save the marks');

    // 4. Long-press the grip and drag down: the activity moves within its group.
    const group=await page.locator('#calendar .timeline-row[data-row-event]').evaluateAll(rows=>{const n={};for(const r of rows)if(r.dataset.rowEvent===r.dataset.orderRoot)n[r.dataset.orderGroup]=(n[r.dataset.orderGroup]||0)+1;return Object.entries(n).sort((a,b)=>b[1]-a[1])[0][0];});
    const rootOrder=()=>page.locator('#calendar .timeline-row[data-row-event]').evaluateAll((rows,g)=>rows.filter(r=>r.dataset.rowEvent===r.dataset.orderRoot&&r.dataset.orderGroup===g).map(r=>r.dataset.rowEvent),group);
    const before=await rootOrder();assert.ok(before.length>=3,'Need three rows in one group to reorder');
    const handle=page.locator(`#calendar [data-order-handle="${before[0]}"]`),[hx,hy]=await center(handle);
    const step=(await page.locator(`#calendar [data-row-event="${before[1]}"]`).boundingBox()).height;
    await drag(hx,hy,Math.round(step*1.4),450);await page.waitForTimeout(600);
    const after=await rootOrder();
    assert.notDeepEqual(after,before,'Long-press drag on the grip did not reorder');assert.equal(after.indexOf(before[0]),1);
    await page.screenshot({path:path.join(output,'phone-timeline.png'),fullPage:false});

    // 5. Desktop with a mouse keeps its row tools.
    const desk=await browser.newPage({viewport:{width:1440,height:900},locale:'zh-CN'});
    await desk.goto(base+'/?game=endfield-cn');await desk.locator('#timeline-view').click();
    assert.equal(await desk.locator('#calendar [data-event-star]').first().isVisible(),true,'Desktop lost its star buttons');
    assert.deepEqual(errors,[]);
    console.log('PASS: phone timeline scrolls by touch, short rows, tap opens detail for star/complete, grip long-press reorders; desktop unchanged');
  }finally{if(browser)await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
