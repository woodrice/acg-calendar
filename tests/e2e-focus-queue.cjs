// A date picked while "clear filters" is resetting the view survives the reset, whichever of the
// reset's two requests is still in flight (the second one used to clear the newer pick).
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const port=await require('./free-port.cjs')(),base='http://127.0.0.1:'+port;
  const dir=path.resolve('logs/focus-queue-e2e','data-'+Date.now());await fs.mkdir(dir,{recursive:true});
  await fs.cp('examples/plugins/sample-game',path.join(dir,'plugins/sample-game'),{recursive:true});
  const server=spawn(process.env.CALENDAR_PYTHON||'python',['app.py','--port',String(port),'--data-dir',dir,'--no-sync','--no-desktop'],{windowsHide:true,stdio:'ignore'});let browser;
  try{
    for(let i=0;i<50;i++){try{if(await fetch(base+'/api/health').then(async r=>{await r.text();return r.ok;}))break;}catch{}if(i===49)throw Error('Server failed');await new Promise(r=>setTimeout(r,200));}
    const state=async()=>await(await fetch(base+'/api/state')).json(),token=(await state()).csrf_token;
    // Drain the full state response: status alone leaves Undici's parser paused at teardown.
    const update=async(p,b)=>{const r=await fetch(base+p,{method:'PATCH',headers:{'Content-Type':'application/json','X-Calendar-Token':token},body:JSON.stringify(b)});const body=await r.text();assert.equal(r.status,200,body);};
    browser=await chromium.launch({channel:process.env.CALENDAR_BROWSER||'msedge',headless:true});
    // hold(url, body) picks the one request to pause; it is released by window.__release().
    async function run(label,hold){
      await update('/api/settings',{view:'timeline',hide_completed:false,active_game:'sample-game'});
      await update('/api/workspace',{view:{scope:'single',selected_games:['sample-game'],focus:{date:null,event_id:null}}});
      const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN',timezoneId:'America/New_York'}),errors=[];
      await page.clock.setFixedTime(new Date('2026-10-27T20:00:00Z'));
      page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(()=>{const original=setInterval;window.setInterval=(fn,ms,...args)=>ms===10000?0:original(fn,ms,...args);}); // No timed polls.
      await page.goto(base);await page.locator('#calendar .event-name').first().waitFor();
      await page.evaluate(source=>{
        const original=window.fetch,hold=new Function('url','body','return ('+source+')(url,body);');
        window.fetch=async(url,options)=>{
          const body=options&&options.body?JSON.parse(options.body):null;
          if(!window.__held&&options&&options.method&&options.method!=='GET'&&hold(String(url),body)){window.__held=true;await new Promise(r=>window.__release=r);}
          return original(url,options);
        };
      },hold.toString());
      await page.locator('#reset-filters').click();await page.waitForFunction(()=>typeof window.__release==='function');
      await page.evaluate(()=>PlaytimePlanner.deadlines('2026-11-09'));
      await page.locator('[data-only-day]').click();
      await page.waitForTimeout(200);await page.evaluate(()=>window.__release());
      await page.waitForFunction(()=>!document.querySelector('#deadlines-dialog').open);await page.waitForTimeout(300);
      const result={browser:await page.evaluate(()=>PlaytimeWorkspace.view.focus.date),database:(await state()).workspace.view.focus.date};
      assert.deepEqual(result,{browser:'2026-11-09',database:'2026-11-09'},label+': the reset cleared the newer date');
      assert.deepEqual(errors,[]);await page.close();
    }
    await run('first reset request (settings) in flight',(url,body)=>url==='/api/settings'&&body.hide_completed===false);
    await run('second reset request (focus clear) in flight',(url,body)=>url==='/api/workspace'&&body.view&&body.view.hide_future===false);
    console.log('PASS: a date picked during either step of a view reset is kept in the page and the database');
  }finally{if(browser)await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
