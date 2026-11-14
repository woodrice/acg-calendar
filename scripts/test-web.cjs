// Run only owned, offline fixtures. Never attach to CALENDAR_TEST_URL or scan data/.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const tests=['e2e-web-journey.cjs','e2e-security.cjs','e2e-planner.cjs','e2e-plan-drawing.cjs','e2e-uiux.cjs','e2e-accessibility.cjs','e2e-stale-poll.cjs','e2e-focus-queue.cjs','e2e-timeline-motion.cjs','e2e-month-density.cjs','e2e-shell-source.cjs','e2e-android-shell.cjs','e2e-android-shell-touch.cjs','e2e-artwork-timeline.cjs','e2e-arknights-official.cjs'];
const env={...process.env,PLAYWRIGHT_MODULE:process.env.PLAYWRIGHT_MODULE||path.dirname(require.resolve('playwright/package.json'))};
delete env.CALENDAR_TEST_URL;
const results=[];
async function run(file){
  const start=Date.now();
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[path.join('tests',file)],{env,stdio:'inherit',windowsHide:true});
    child.once('error',error=>resolve({file,ok:false,error:error.message}));
    child.once('exit',(code,signal)=>resolve({file,ok:code===0,code,signal,elapsed_ms:Date.now()-start}));
  });
}
(async()=>{
  const requested=process.argv.slice(2),selected=requested.length?requested:tests;
  if(selected.some(name=>!tests.includes(name)))throw Error('Choose a filename from the documented offline web suite');
  for(const file of selected){
    console.log('\nRunning',file);
    const result=await run(file);results.push(result);
    fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/web-regression-summary.json',JSON.stringify({browser:env.CALENDAR_BROWSER||'msedge',results},null,2));
    if(!result.ok){process.exitCode=1;break;}
  }
  console.log('Browser checks:',results.filter(r=>r.ok).length+'/'+selected.length,'passed');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
