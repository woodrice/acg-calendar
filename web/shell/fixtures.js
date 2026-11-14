'use strict';
/* Isolated, fixed-date sample data for the Android shell's development page and tests. It follows
   the shape of the real adapter (web/shell-source.js, docs/android-shell-source.md):
     status          'loading' | 'ready' | 'error'
     snapshot()      read-only view: games, scope, filters, upcoming, deadlineDays, events, plans, sync
     event(id)       one activity regardless of scope and filters, or null
     subscribe(fn)   called after every change; returns an unsubscribe function
     act(name, args) named operation -> Promise<{ok, error?, undo?}>
     reload()        retry after an error
     helpers         display formatting in the display time zone (countdown, time, date)
   Nothing here talks to the network or the real backend. */
window.PlaytimeShellFixtures=(()=>{
  const NOW=Date.parse('2026-11-07T04:00:00Z'); // 12:00 in Asia/Shanghai
  const games=[
    {id:'endfield-cn',name:'明日方舟：终末地',short:'终末地',mono:'EF',color:'#A38337',source:'国服 · 官方公告'},
    {id:'arknights-cn',name:'明日方舟',short:'明日方舟',mono:'AK',color:'#477E9F',source:'国服 · 官网活动预告'},
    {id:'zzz-cn',name:'绝区零',short:'绝区零',mono:'ZZZ',color:'#E2731B',source:'国服 · 官网公告'},
    {id:'nikke-global',name:'胜利女神：NIKKE',short:'NIKKE',mono:'NK',color:'#A0566B',source:'国际服 · 社区来源'},
    {id:'azurlane-cn',name:'碧蓝航线',short:'碧蓝航线',mono:'AL',color:'#3E7BC4',source:'国服 · BWIKI'}
  ];
  const ev=(id,game,title,category,start,end,extra={})=>({id,game,title,category,start:{at:start,state:extra.estimated?'estimated':'exact'},end:{at:end,state:'exact'},completed:false,starred:false,...extra});
  const baseEvents=[
    ev('z1','zzz-cn','琳琅鎏心','gacha','2026-10-21T03:00:00Z','2026-11-11T03:59:00Z',{estimated:true,subtype:'调频'}),
    ev('z2','zzz-cn','凛风吟仪','gacha','2026-10-21T03:00:00Z','2026-11-11T03:59:00Z',{estimated:true,subtype:'调频',description:'限定调频活动（演示说明）。具体规则以游戏内公告为准。',phases:[{title:'第一期',at:'2026-10-21T03:00:00Z'},{title:'第二期',at:'2026-10-31T03:00:00Z'}]}),
    ev('z3','zzz-cn','倾掷浮生','gacha','2026-10-21T03:00:00Z','2026-11-11T03:59:00Z',{estimated:true,subtype:'调频'}),
    ev('e1','endfield-cn','予众魂的新光影趣味活动','event','2026-10-24T02:00:00Z','2026-11-13T20:00:00Z',{subtype:'趣味'}),
    ev('e2','endfield-cn','百趣演武挑战活动','event','2026-11-10T02:00:00Z','2026-11-18T20:00:00Z',{subtype:'挑战'}),
    ev('a1','arknights-cn','感谢庆典2026限时签到','event','2026-10-31T16:00:00Z','2026-11-13T19:59:00Z',{subtype:'签到'}),
    ev('a2','arknights-cn','将雪投火','gacha','2026-11-01T08:00:00Z','2026-11-14T19:59:00Z',{subtype:'寻访'}),
    ev('a3','arknights-cn','联合行动','event','2026-11-05T08:00:00Z',null,{subtype:'活动'})
  ].map(e=>({artwork:null,sourceUrl:'https://example.com/notice/'+e.id,description:'',warnings:[],phases:[],...e})); // A sample's own fields win over these defaults.
  const deadlines=events=>{
    const days={};
    for(const e of events){if(e.completed||!e.end.at)continue;const day=new Date(Date.parse(e.end.at)+8*3600e3).toISOString().slice(0,10);(days[day]=days[day]||[]).push({event_id:e.id,kind:'activity',at:e.end.at,title:e.title});}
    return days;
  };
  const pad=n=>String(n).padStart(2,'0');
  const local=iso=>new Date(Date.parse(iso)+8*3600e3);
  const helpers={
    zone:'Asia/Shanghai',
    time:iso=>{if(!iso)return '待定';const d=local(iso);return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;},
    date:iso=>{if(!iso)return '待定';const d=local(iso);return `${pad(d.getUTCMonth()+1)}/${pad(d.getUTCDate())}`;},
    dayLabel:day=>{const d=new Date(day+'T00:00:00Z');return `${d.getUTCMonth()+1}/${d.getUTCDate()} 周${'日一二三四五六'[d.getUTCDay()]}`;},
    day:iso=>local(iso).toISOString().slice(0,10),
    localInput:iso=>iso?local(iso).toISOString().slice(0,16):'',
    countdown:(iso,now=NOW)=>{if(!iso)return '';const m=Math.max(0,Math.round((Date.parse(iso)-now)/60000));return m>=1440?`${Math.floor(m/1440)}天 ${Math.floor(m%1440/60)}小时`:m>=60?`${Math.floor(m/60)}小时 ${m%60}分`:`${Math.max(1,m)}分钟`;}
  };

  // Instants that show this wall time in the zone, earliest first (fold 0 = earlier), as the plan
  // API resolves them: none in a spring-forward gap, two in a fall-back hour.
  function zoneOffset(ms,zone){
    const p={};for(const x of new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(ms))p[x.type]=x.value;
    return (Date.UTC(+p.year,p.month-1,+p.day,+p.hour%24,+p.minute,+p.second)-Math.floor(ms/1000)*1000)/60000;
  }
  function wallTimes(local,zone){
    const naive=Date.parse(local+':00Z');if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local||'')||isNaN(naive))return null;
    try{
      const out=new Set();
      for(const probe of [naive-432e5,naive+432e5]){const o=zoneOffset(probe,zone),c=naive-o*60000;if(zoneOffset(c,zone)===o)out.add(c);}
      return [...out].sort((a,b)=>a-b);
    }catch{return null;}
  }

  // A copy of the bundled presets (acg_calendar/workspace.py THEMES), the fields the shell reads.
  const PRESET_NAMES={light:'标准 · 游时',dark:'深色 · 静夜',arknights:'明日方舟 · 战术黑青',endfield:'终末地 · 工业白黄',nikke:'NIKKE · 绯红',azurlane:'碧蓝航线 · 海蓝',zzz:'绝区零 · 街头荧光'};
  const P=(accent,accent_text,background,surface,panel_alt,text,muted,border)=>({accent,accent_text,background,surface,panel_alt,text,muted,border});
  const PALETTES={light:P('#FFFA00','#111111','#FAFAF8','#FFFFFF','#F0F0EC','#111111','#62625D','#D3D3CC'),dark:P('#B8D77A','#182010','#1B221A','#252D23','#303A2C','#E3EBDD','#B2BDAA','#4A5843'),
    arknights:P('#00C8E8','#091013','#101214','#1B1E22','#252A2F','#F0F4F6','#ABB6BF','#424B52'),endfield:P('#FFFA00','#111111','#FAFAF8','#FFFFFF','#F0F0EC','#111111','#62625D','#D3D3CC'),
    nikke:P('#A43B33','#FFFFFF','#FCF2EF','#FFFBF9','#F6E9E6','#433037','#805B60','#DFC3BF'),azurlane:P('#266491','#FFFFFF','#EFF5FC','#FCFDFF','#E5EEF9','#283346','#5A6C85','#C1D2E4'),
    zzz:P('#D8FA00','#11130A','#E8EAE4','#FAFBF6','#EEF0E7','#171A12','#59604D','#BFC6B1')};
  // A local wall time in the zone as the plan API resolves it; `fallback` (an ISO instant) when absent.
  function resolveLocal(value,fold,zone,fallback){
    if(value===undefined||value===null)return fallback?{iso:new Date(Date.parse(fallback)).toISOString()}:{ok:false,code:'invalid',error:'请填写名称和起止时间'};
    const times=wallTimes(value,zone);
    if(!times)return {ok:false,code:'invalid',error:'请输入有效的当地日期、分钟和 IANA 时区'};
    if(!times.length)return {ok:false,code:'nonexistent_time',error:'该当地时刻因夏令时切换不存在，请调整时间'};
    if(times.length>1&&fold==null)return {ok:false,code:'ambiguous_time',error:'该当地时刻因夏令时重复，请选择较早或较晚的一次'};
    return {iso:new Date(times[fold===1&&times.length>1?1:0]).toISOString()};
  }
  // planZone: the zone plans are entered in (helpers.zone); display stays UTC+8.
  function create({mode='ready',failAction=null,holdAction=null,planZone=null,stalePlan=false}={}){
    let events=baseEvents.map(e=>({...e,start:{...e.start},end:{...e.end}}));
    let plans=[{id:'p1',title:'赶琳琅鎏心最后一抽',game_id:'zzz-cn',start:'2026-11-10T13:00:00Z',end:'2026-11-10T15:00:00Z',timezone:'Asia/Shanghai'}];
    // stalePlan: an older plan whose game has since been uninstalled (the API will not save it again).
    if(stalePlan)plans.push({id:'p-old',title:'旧游戏的计划',game_id:'retired-game',event_id:null,notes:'旧备注',start:'2026-11-12T12:00:00Z',end:'2026-11-12T13:00:00Z',timezone:'Asia/Shanghai'});
    let scope={mode:'selected',games:['endfield-cn','arknights-cn','zzz-cn']};
    let filters={types:{event:true,gacha:true,exchange:true,update:true,maintenance:true},hideCompleted:true,showPending:true,hideFuture:false,sort:'end'};
    const listeners=new Set();let revision=0;
    // Sync status as the source reports it: stages in order, a site wait, a result, then a cooldown.
    const gameSync=()=>Object.fromEntries(games.map(g=>[g.id,{running:false,stage:null,label:'',waiting:null,lastSuccess:'2026-11-07T03:50:00Z',error:g.id==='arknights-cn'?'上次读取超时，已保留缓存':null,result:null}]));
    let appearance='system',preset='light',unread=2;
    let sync={games:gameSync(),running:false,stage:null,lastSuccess:'2026-11-07T03:50:00Z',paused:false,sites:[{site:'示例公告',paused:false,active:false,requests:4,failures:0,error:null,next_allowed_at:null},{site:'示例图库',paused:false,active:false,requests:12,failures:1,error:'上次请求超时',next_allowed_at:new Date(NOW+600000).toISOString()}]},cooldownUntil=0,requestIds=new Map();
    const source={status:mode==='loading'?'loading':mode==='error'?'error':'ready',now:()=>NOW,helpers:planZone?{...helpers,zone:planZone}:helpers};
    const emit=()=>{revision++;for(const fn of [...listeners])fn();};
    const visible=()=>events.filter(e=>(scope.mode==='all'||scope.games.includes(e.game))&&filters.types[e.category]!==false&&!(filters.hideCompleted&&e.completed));
    source.snapshot=()=>{
      if(source.status!=='ready')return null;
      const shown=mode==='empty'?[]:visible();
      const days=deadlines(shown);
      const upcoming=Object.keys(days).sort().map(day=>({day,label:helpers.dayLabel(day),items:days[day].map(n=>({...shown.find(e=>e.id===n.event_id),at:n.at,deadlineTitle:n.title,kind:n.kind})).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))}));
      const uncertain=shown.filter(e=>!e.end.at&&!e.completed);
      const off=Object.values(filters.types).filter(v=>!v).length+(filters.hideFuture?1:0)+(filters.hideCompleted?0:1)+(filters.showPending?0:1);
      return Object.freeze({revision,today:helpers.day(new Date(NOW).toISOString()),games,scope:{...scope,games:[...scope.games]},filters:{...filters,types:{...filters.types},activeCount:off},
        events:shown,upcoming,uncertain,deadlineDays:days,plans:plans.map(p=>({...p})),
        sync:JSON.parse(JSON.stringify(sync)),appearance:{mode:appearance,preset,presets:PRESET_NAMES,palettes:PALETTES},
        connectionError:null,app:{version:'0.2.7',calendarVersion:'selected',unread}});
    };
    source.subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
    // One activity regardless of scope and filters (a detail page stays put after "complete").
    source.event=id=>{const e=events.find(x=>x.id===id);return e?{...e,start:{...e.start},end:{...e.end}}:null;};
    source.reload=()=>{source.status='loading';emit();setTimeout(()=>{source.status='ready';mode=mode==='error'?'ready':mode;emit();},300);};
    if(mode==='loading')setTimeout(()=>{source.status='ready';mode='ready';emit();},600);
    const settle=(result,delay=150)=>new Promise(r=>setTimeout(()=>r(result),delay));
    const find=id=>events.find(e=>e.id===id);
    const actions={
      setStarred:({id,value})=>{const e=find(id);if(!e)return {ok:false,error:'活动已不在本地日历'};const before=e.starred;e.starred=value;return {ok:true,undo:()=>source.act('setStarred',{id,value:before})};},
      setCompleted:({id,value})=>{const e=find(id);if(!e)return {ok:false,error:'活动已不在本地日历'};const before=e.completed;e.completed=value;return {ok:true,undo:()=>source.act('setCompleted',{id,value:before})};},
      // Same codes as the adapter: busy, cooldown (with until), paused; results arrive per game.
      sync:()=>{
        const now=Date.now(),ids=scope.mode==='all'?games.map(g=>g.id):scope.games;
        if(sync.paused)return {ok:false,code:'paused',error:'联网已暂停'};
        if(sync.running)return {ok:false,code:'busy',error:'所选游戏已有同步在进行'};
        if(now<cooldownUntil)return {ok:false,code:'cooldown',until:new Date(cooldownUntil).toISOString(),error:'刚刚已尝试同步，请稍候'};
        const stage=(label,running=true,extra={})=>{for(const id of ids)sync.games[id]={...sync.games[id],running,label,stage:running?{label}:null,...extra};sync.running=running;sync.stage=running?label:null;emit();};
        stage('读取公告…');
        setTimeout(()=>stage('整理日期…'),500);
        setTimeout(()=>stage('日历已更新 · 补齐活动图片… · 等待 示例图库 请求间隔约 10 秒'),1000);
        setTimeout(()=>{
          const results={'zzz-cn':{calendar:{added:2,updated:0},images:{added:2,failed:0}},'endfield-cn':{calendar:{added:0,updated:1},images:{added:1,failed:0}}};
          for(const id of ids)sync.games[id]={...sync.games[id],running:false,label:'',stage:null,error:null,lastSuccess:new Date(NOW+60000).toISOString(),result:results[id]||{calendar:{added:0,updated:0},images:{added:0,failed:0}}};
          sync.running=false;sync.stage=null;sync.lastSuccess=new Date(NOW+60000).toISOString();cooldownUntil=Date.now()+30000;emit();
        },1600);
        return {ok:true,accepted:ids,requested:ids};
      },
      setScope:({mode:m,games:g})=>{scope={mode:m,games:g?[...g]:scope.games};return {ok:true};},
      setFilters:patch=>{filters={...filters,...patch,types:{...filters.types,...(patch.types||{})}};return {ok:true};},
      resetFilters:()=>{filters={types:{event:true,gacha:true,exchange:true,update:true,maintenance:true},hideCompleted:true,showPending:true,hideFuture:false,sort:'end'};return {ok:true};},
      // Same fields and answers as the plan API: local wall times plus an IANA zone, with
      // fold_start / fold_end (0 earlier, 1 later) chosen separately for repeated wall times.
      // Also takes UTC start / end instead of local times (undo of a delete saves the same instants).
      createPlan:({title,notes,local_start,local_end,start:startIso,end:endIso,timezone,game_id,event_id,request_id,fold_start,fold_end})=>{
        if(request_id&&requestIds.has(request_id))return {ok:true,id:requestIds.get(request_id)}; // a retry of the same draft
        if(!title||!(local_start||startIso)||!(local_end||endIso))return {ok:false,code:'invalid',error:'请填写名称和起止时间'};
        // As the plan API: a new plan must point at an installed game and a known event of that game.
        if(game_id&&!games.some(g=>g.id===game_id))return {ok:false,code:'invalid',error:'计划关联游戏不存在'};
        if(event_id){const e=events.find(x=>x.id===event_id);if(!e||(game_id&&e.game!==game_id))return {ok:false,code:'invalid',error:'关联活动不存在'};}
        const r1=resolveLocal(local_start,fold_start,timezone,startIso);if(r1.error)return r1;
        const r2=resolveLocal(local_end,fold_end,timezone,endIso);if(r2.error)return r2;
        const [start,end]=[r1.iso,r2.iso];
        if(Date.parse(end)<=Date.parse(start))return {ok:false,code:'invalid',error:'结束时间必须晚于开始时间'};
        const plan={id:'p'+(plans.length+1)+'-'+revision,title,start,end,timezone,game_id:game_id||null,event_id:event_id||null,...(notes?{notes}:{})};plans=[plan,...plans];if(request_id)requestIds.set(request_id,plan.id);return {ok:true,id:plan.id};
      }
    };
    Object.assign(actions,{
      setAppearance:({mode,preset:next})=>{if((mode!==undefined&&!['system','light','dark'].includes(mode))||(next!==undefined&&!PALETTES[next]))return {ok:false,code:'invalid',error:'主题设置无效'};if(mode!==undefined)appearance=mode;if(next!==undefined)preset=next;return {ok:true};},
      markNoticesRead:()=>{unread=0;return {ok:true};},
      updatePlan:({id,title,notes,local_start,local_end,fold_start,fold_end})=>{
        const old=plans.find(x=>x.id===id);if(!old)return {ok:false,code:'invalid',error:'个人计划不存在'};
        const zone=old.timezone||helpers.zone;
        const r1=resolveLocal(local_start,fold_start,zone,old.start);if(r1.error)return r1;
        const r2=resolveLocal(local_end,fold_end,zone,old.end);if(r2.error)return r2;
        if(title!==undefined&&!title)return {ok:false,code:'invalid',error:'计划标题不能为空'};
        if(Date.parse(r2.iso)<=Date.parse(r1.iso))return {ok:false,code:'invalid',error:'计划结束时间需晚于开始'};
        plans=plans.map(x=>x.id===id?{...x,title:title??x.title,...(notes!==undefined?{notes}:{}),start:r1.iso,end:r2.iso}:x);return {ok:true,id};
      },
      deletePlan:({id})=>{if(!plans.some(x=>x.id===id))return {ok:false,code:'invalid',error:'个人计划不存在'};plans=plans.filter(x=>x.id!==id);return {ok:true};}
    });
    // holdAction keeps that request pending until release(ok) (tests use it for late responses).
    let held=null;source.release=ok=>{const h=held;held=null;h?.(ok);};
    // Tests: an event leaves the calendar, as a sync that no longer finds it would do.
    source.dropEvent=id=>{events=events.filter(e=>e.id!==id);emit();};
    source.act=async(name,args={})=>{
      if(holdAction===name){const ok=await new Promise(r=>held=r);if(!ok)return {ok:false,error:'保存失败：请求超时（演示）'};}
      if(failAction===name)return settle({ok:false,error:'保存失败：本地服务暂时不可用（演示）'});
      const run=actions[name];if(!run)return settle({ok:false,error:'不支持的操作：'+name});
      const result=run(args);if(result.ok)emit();return settle(result);
    };
    return source;
  }
  return {create,NOW};
})();
