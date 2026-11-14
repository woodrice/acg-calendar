'use strict';
/* Android app shell: bottom tabs, routing, drawers and a detail page, drawn from a data source
   (web/shell-source.js; contract in docs/android-shell-source.md; fixtures.js mirrors it). It only runs when the page is marked
   <html data-shell="android"> and a source is passed to start(); ordinary web pages and the
   Windows desktop never start it. It reads nothing private from the web page and never
   clicks hidden web controls: everything goes through source.snapshot() and source.act(). */
window.PlaytimeShell=(()=>{
  const E=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const TABS=[['upcoming','近期','M12 7v5l3 2M4 12a8 8 0 1 0 16 0 8 8 0 1 0-16 0'],['calendar','日历','M4 5h16v15H4zM4 10h16M8 3v4M16 3v4'],['plans','计划','M12 3l9 9-9 9-9-9z'],['me','我的','M8 8a4 4 0 1 0 8 0 4 4 0 1 0-8 0M4 21c1-4 4-6 8-6s7 2 8 6']];
  const icon=(d,label)=>`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" ${label?`role="img" aria-label="${E(label)}"`:'aria-hidden="true"'}><path d="${d}"/></svg>`;
  let wasSyncing=false,monthOffset=0,minuteTimer,root,frame,toastBox,source,unsubscribe,route,returnFocus=[],toastTimer,draft=null,pending=new Set(),lastLayer='',pushed=0;
  let lastEvent=null,lastSheet='',scopeWrite=Promise.resolve();
  let timeline=null,timelineElement=null,timelineDate=null;

  const enabled=()=>document.documentElement.dataset.shell==='android';

  // ---- routing: #/<tab>[/<sub>][?event=<id>|sheet=<name>] ; overlays are history entries ----
  function parse(hash=location.hash){
    const [path,query='']=hash.replace(/^#\/?/,'').split('?');
    const [tab='upcoming',sub='']=path.split('/');
    const q=new URLSearchParams(query);
    return {tab:TABS.some(t=>t[0]===tab)?tab:'upcoming',sub:sub||(tab==='calendar'?'month':''),event:q.get('event'),sheet:q.get('sheet'),day:q.get('day'),item:q.get('item')};
  }
  function hashOf(r){
    const q=new URLSearchParams();if(r.event)q.set('event',r.event);if(r.sheet)q.set('sheet',r.sheet);if(r.day)q.set('day',r.day);if(r.item)q.set('item',r.item);
    return '#/'+r.tab+(r.sub?'/'+r.sub:'')+(q.toString()?'?'+q:'');
  }
  const overlay=r=>!!(r.event||r.sheet);
  // The two sheets that hold a plan draft: a new plan, or an existing one being edited (item = plan id).
  const formSheet=r=>r.sheet==='plan-new'||r.sheet==='plan-edit';
  function go(next,{push=false}={}){
    const r={...route,...next};
    if(push)history.pushState(null,'',hashOf(r));else history.replaceState(null,'',hashOf(r));
    route=r;render();
  }
  // Only entries the shell pushed are popped with history.back(); a layer reached by a deep link
  // is closed in place, so Back never leaves the app from inside a layer.
  // A toast belongs to the screen it was shown on; a new layer would otherwise sit under it.
  function open(layer,trigger){root.querySelector(".ps-toast")?.classList.remove("ps-on");returnFocus.push(keyOf(trigger||document.activeElement));pushed++;go({...route,...layer},{push:true});}
  function closeLayer(){if(pushed>0)history.back();else{returnFocus.pop();go({event:null,sheet:null,day:null,item:null});draft=null;focusMain();}}
  /** Android back: closes the top layer, then returns to 近期, then lets the app exit (false). */
  function back(){
    if(!root)return false;
    if(formSheet(route)&&draft&&holdDraft())return true;
    if(overlay(route)){closeLayer();return true;}
    if(route.tab==='me'&&route.sub){go({sub:''});focusMain();return true;}
    if(route.tab!=='upcoming'){go({tab:'upcoming',sub:'',event:null,sheet:null,day:null,item:null});focusMain();return true;}
    return false;
  }
  // A plan draft decides before its sheet closes, whichever Back was used: a save in flight keeps
  // the sheet open; Back on the discard question returns to the draft; otherwise it asks first.
  function holdDraft(){
    if(draft.saving){toast('正在保存，请稍候');return true;}
    if(draft.confirming){draft.confirming=false;render();return true;}
    if(draft.confirmDelete){draft.confirmDelete=false;render();return true;}
    if(draft.dirty){draft.confirming=true;render();return true;}
    return false;
  }
  function onPop(){
    const prev=route,next=parse();
    if(formSheet(prev)&&!(next.sheet===prev.sheet&&next.item===prev.item)&&draft&&!draft.leaving&&(draft.saving||draft.dirty)){
      history.pushState(null,'',hashOf(prev)); // Undo the browser's step; the draft decides first.
      route=prev;holdDraft();return;
    }
    if(pushed>0)pushed--;
    const had=overlay(route);route=parse();if(!formSheet(route))draft=null;render();
    // The trigger was re-rendered, so it is found again by its key; gone (e.g. filtered out) -> the title.
    if(had&&!overlay(route)){const key=returnFocus.pop(),t=key&&root.querySelector(key);if(t)t.focus({preventScroll:true});else focusMain();}
  }
  function focusMain(){root.querySelector('.ps-title')?.focus({preventScroll:true});}

  // ---- pages ----
  const snap=()=>source.snapshot();
  const gameOf=(s,id)=>s.games.find(g=>g.id===id)||{short:id,mono:'?',color:'#8A8D86'};
  function row(s,e){
    const g=gameOf(s,e.game),h=source.helpers,at=e.at||e.end?.at;
    const extra=(e.kind==='exchange'?' · 兑换截止':'')+(e.deadlineTitle&&e.deadlineTitle!==e.title?' · '+e.deadlineTitle:'');
    return `<div class="ps-swipe" data-swipe="${E(e.id)}"><span class="ps-swipe-bg ps-swipe-done" aria-hidden="true">${e.completed?'↶ 撤销完成':'✓ 完成'}</span><span class="ps-swipe-bg ps-swipe-star" aria-hidden="true">${e.starred?'☆ 取消收藏':'★ 收藏'}</span><button type="button" class="ps-row" data-open-event="${E(e.id)}" aria-describedby="ps-gesture-hint" style="--game:${E(g.color)}">
      ${mono(g)}
      <span class="ps-row-main"><span class="ps-row-title">${e.starred?'★ ':''}${E(e.title)}</span><span class="ps-row-sub">${E(g.short)} · ${E(e.subtype||'活动')}${E(extra)}${e.completed?' · 已完成':''}</span></span>
      <span class="ps-row-end"><span class="ps-time">${at?E(h.time(at)):'截止待定'}</span><span class="ps-left">${at?E(h.countdown(at,source.now())):''}</span></span></button></div>`;
  }
  const mono=g=>g.icon?`<span class="ps-mono ps-mono-img" aria-hidden="true"><img src="${E(g.icon)}" alt=""></span>`:`<span class="ps-mono" aria-hidden="true">${E(g.mono)}</span>`;
  function uncertainSection(s){return s.uncertain?.length?`<section class="ps-group" aria-label="截止待定"><h2 class="ps-group-h"><span>截止待定</span><span>${s.uncertain.length} 项</span></h2><div class="ps-list">${s.uncertain.map(e=>row(s,{...e,at:null})).join('')}</div></section>`:'';}
  function upcoming(s){
    if(!s.upcoming.length&&s.uncertain?.length)return `<p class="ps-note" id="ps-gesture-hint">左滑完成 · 右滑收藏 · 长按更多操作</p>`+uncertainSection(s);
    if(!s.upcoming.length)return empty('当前范围和筛选下没有已明确的截止','可以调整游戏范围或筛选',`<button type="button" class="ps-btn" data-sheet="filter">调整筛选</button>`);
    const first=s.upcoming[0],h=source.helpers;
    return `<button type="button" class="ps-next" data-open-day="${E(first.day)}"><span class="ps-next-k">下一个截止 · ${E(h.countdown(first.items[0].at,source.now()))}</span><span class="ps-next-t">${E(first.items[0].title)}${first.items.length>1?` 等 ${first.items.length} 项`:''}</span><span class="ps-next-d">${E(first.label)} ${E(h.time(first.items[0].at))}</span></button>`+
      `<p class="ps-note" id="ps-gesture-hint">左滑完成 · 右滑收藏 · 长按更多操作</p>`+s.upcoming.map(g=>`<section class="ps-group" aria-label="${E(g.label)}"><h2 class="ps-group-h"><span>${E(g.label)}</span><span>${g.items.length} 项</span></h2><div class="ps-list">${g.items.map(e=>row(s,e)).join('')}</div></section>`).join('')+uncertainSection(s);
  }
  function calendar(s){
    const tabs=`<div class="ps-seg" role="tablist" aria-label="日历视图">${[['timeline','时间轴'],['month','截止月历']].map(([id,l])=>`<button type="button" role="tab" aria-selected="${route.sub===id}" data-cal="${id}">${l}</button>`).join('')}</div>`;
    if(route.sub==='timeline')return tabs+`<div id="ps-timeline-mount">${source.mountTimeline?'':'<p class="ps-note">开发样本未提供时间轴。</p>'}</div>`;
    return tabs+month(s);
  }
  function month(s){
    // Presentation only: counts come from the source; the fill is the share of this month's peak.
    const [ty,tm]=s.today.split('-').map(Number),base=new Date(Date.UTC(ty,tm-1+monthOffset,1)),y=base.getUTCFullYear(),m=base.getUTCMonth();
    const first=base,lead=(first.getUTCDay()+6)%7,days=new Date(Date.UTC(y,m+1,0)).getUTCDate(),pad=n=>String(n).padStart(2,'0');
    const key=d=>`${y}-${pad(m+1)}-${pad(d)}`,count=d=>(s.deadlineDays[key(d)]||[]).length;
    const peak=Math.max(0,...Array.from({length:days},(_,i)=>count(i+1)));
    let cells='';for(let i=0;i<lead;i++)cells+='<span class="ps-cell ps-out" aria-hidden="true"></span>';
    for(let d=1;d<=days;d++){const n=count(d),day=key(d),today=day===s.today;
      cells+=`<button type="button" class="ps-cell${today?' ps-today':''}" data-open-day="${day}" aria-label="${m+1}月${d}日，截止 ${n} 项${today?'，今天':''}" style="--fill:${peak?n/peak*100:0}%"><span class="ps-cell-fill" aria-hidden="true"></span><span class="ps-cell-d">${d}</span>${n?`<span class="ps-cell-n">${n}</span>`:''}</button>`;}
    return `<div class="ps-month"><div class="ps-month-h"><button type="button" class="ps-icon" data-month="-1" aria-label="上个月">${icon('M15 6l-6 6 6 6')}</button><span>${y} 年 ${m+1} 月</span><button type="button" class="ps-icon" data-month="1" aria-label="下个月">${icon('M9 6l6 6-6 6')}</button>${monthOffset?'<button type="button" class="ps-link" data-month="0">回到本月</button>':''}</div><p class="ps-note">填充越高，当天截止越集中</p><div class="ps-week" aria-hidden="true">${'一二三四五六日'.split('').map(c=>`<span>${c}</span>`).join('')}</div><div class="ps-grid">${cells}</div></div>`;
  }
  function plans(s){
    const h=source.helpers;
    return `<p class="ps-lead">自己的游玩安排，和官方活动分开保存。</p>`+(s.plans.length?`<div class="ps-cards">${s.plans.map(p=>`<button type="button" class="ps-card" data-edit-plan="${E(p.id)}" aria-label="编辑计划 ${E(p.title)}"><span class="ps-card-t">◇ ${E(p.title)}</span><span class="ps-time">${E(h.date(p.start))} ${E(h.time(p.start))} — ${E(h.time(p.end))}</span><span class="ps-row-sub">${E(gameOf(s,p.game_id).short||'未关联游戏')}</span></button>`).join('')}</div>`:empty('还没有个人计划','安排一段游玩时间，到时一眼能看到'))+
      `<button type="button" class="ps-fab" data-sheet="plan-new">${icon('M12 5v14M5 12h14')}新建计划</button>`;
  }
  const ME=[['sync','同步与网络'],['games','游戏'],['backup','备份与恢复'],['reminders','截止提醒'],['appearance','外观'],['about','关于与来源']];
  function me(s){
    if(route.sub)return mePage(s,route.sub);
    const failed=Object.entries(s.sync.games).filter(([,v])=>v.error).map(([id])=>gameOf(s,id).short);
    return `<div class="ps-status-card"><span class="ps-next-k">同步状态</span><span>${E(lastSync(s.sync))}</span>${failed.length?`<span class="ps-row-sub">${E(failed.join('、'))}上次读取失败，已保留缓存</span>`:''}</div>
      <div class="ps-list ps-settings">${ME.map(([id,l])=>`<button type="button" class="ps-set" data-me="${id}"><span>${l}</span>${icon('M9 6l6 6-6 6')}</button>`).join('')}</div><p class="ps-foot">游时 ${E(s.app.version)} · 数据只保存在本机</p>`;
  }
  function mePage(s,id){
    const title=(ME.find(x=>x[0]===id)||[,'设置'])[1],h=source.helpers;
    const at=iso=>iso?`${h.date(iso)} ${h.time(iso)}`:'';
    const info=(label,value,sub='')=>`<div class="ps-set ps-static"><span class="ps-info"><span>${E(label)}</span>${sub?`<span class="ps-row-sub">${E(sub)}</span>`:''}</span><span class="ps-row-sub ps-info-v">${E(value)}</span></div>`;
    let body;
    if(id==='sync'){
      const y=s.sync,now=source.now();
      const gameRows=s.games.map(g=>{const st=y.games[g.id]||{},r=st.result;
        const state=st.running?(st.label||'正在同步'):st.error?st.error:st.lastSuccess?`${at(st.lastSuccess)} 已同步`:'尚未同步';
        const result=!st.running&&!st.error&&r?`上次：新增 ${r.calendar?.added||0} · 更新 ${r.calendar?.updated||0} · 补齐头图 ${r.images?.added||0} 张`:'';
        return `<div class="ps-set ps-static" style="--game:${E(g.color)}">${mono(g)}<span class="ps-info"><span>${E(g.name)}</span><span class="ps-row-sub${st.error?' ps-warn-t':''}">${E(state)}</span>${result?`<span class="ps-row-sub">${E(result)}</span>`:''}</span></div>`;}).join('');
      const sites=(y.sites||[]).map(x=>{const next=x.next_allowed_at&&Date.parse(x.next_allowed_at)>now?`${h.time(x.next_allowed_at)} 后可再请求`:'可请求';
        return info(x.site,x.paused?'已暂停':x.active?'请求中':next,`本小时 ${x.requests||0} 次${x.failures?` · 连续失败 ${x.failures} 次`:''}${x.error?` · ${x.error}`:''}`);}).join('');
      body=`<div class="ps-status-card"><span class="ps-next-k">${y.running?'正在同步':y.paused?'联网已暂停':'同步状态'}</span><span>${E(y.running?(y.stage||'准备中'):lastSync(y))}</span><span class="ps-row-sub">只读取各游戏的公开公告；同一站点请求有间隔，失败时保留已有日历。</span></div>
        <button type="button" class="ps-btn ps-primary ps-wide" data-sync ${y.running||y.paused?'disabled':''}>${y.running?'同步中…':'立即同步当前游戏'}</button>
        ${y.paused?`<p class="ps-note">联网已暂停，安卓测试版暂时不能在这里恢复；本地日历照常可看。</p>`:''}
        <p class="ps-label">各游戏</p><div class="ps-list">${gameRows}</div>
        ${sites?`<p class="ps-label">请求站点</p><div class="ps-list">${sites}</div>`:''}`;
    }else if(id==='games'){
      body=`<p class="ps-lead">近期、日历和同步都只看这里选中的游戏。</p>`+scopeBody(s);
    }else if(id==='backup'){
      body=`<p class="ps-lead">收藏、完成、个人计划和游戏组合只保存在这台手机的应用数据里，不会上传。</p><div class="ps-list">${info('导出备份','暂不支持','安卓测试版还不能导出文件')}${info('从备份恢复','暂不支持','')}</div><p class="ps-note">卸载应用或清除应用数据会删除这些记录；覆盖安装新版本会保留。</p>`;
    }else if(id==='reminders'){
      const unread=s.app.unread||0;
      body=`<p class="ps-lead">安卓测试版暂不发送系统通知。临近截止的活动会排在「近期」最前面。</p><div class="ps-list">${info('应用内通知',unread?`${unread} 条未读`:'没有未读')}</div>${unread?`<button type="button" class="ps-btn ps-wide" data-mark-read>全部标为已读</button>`:''}`;
    }else if(id==='appearance'){
      const mode=s.appearance?.mode||'system';
      const palettes=s.appearance?.palettes||{},current=s.appearance?.preset||'light',seen=new Set();
      // The phone uses only a preset's colours; one that repeats an earlier preset's colours (the desktop
      // differs only in shape and texture) would look identical here, so it is listed only while chosen.
      const names=Object.fromEntries(Object.entries(s.appearance?.presets||{}).filter(([k])=>{const key=JSON.stringify(palettes[k]||k);if(seen.has(key)&&k!==current)return false;seen.add(key);return true;}));
      const swatch=k=>{const t=palettes[k];return t?`<span class="ps-swatch" style="background:${E(t.background)}" aria-hidden="true"><i style="background:${E(t.accent)}"></i></span>`:'';};
      body=`<p class="ps-label">主题</p><div class="ps-seg" role="radiogroup" aria-label="主题">${[['system','跟随系统'],['light','浅色'],['dark','深色']].map(([m,l])=>`<button type="button" role="radio" aria-checked="${mode===m}" data-appearance="${m}">${l}</button>`).join('')}</div>`+
        (Object.keys(names).length>1?`<p class="ps-label" id="ps-preset-h">配色</p><div class="ps-list" role="radiogroup" aria-labelledby="ps-preset-h">${Object.entries(names).map(([k,l])=>`<button type="button" class="ps-row ps-preset" role="radio" aria-checked="${current===k}" data-preset="${E(k)}">${swatch(k)}<span class="ps-row-main"><span class="ps-row-title">${E(l)}</span></span><span class="ps-check" aria-hidden="true">${current===k?'✓':''}</span></button>`).join('')}</div>`:'')+
        `<p class="ps-note">深浅由「主题」决定；配色在与自己底色相同的模式下完整显示，另一种模式只换强调色。只影响这台手机。</p>`;
    }else if(id==='about'){
      body=`<div class="ps-list">${info('版本',`游时 ${s.app.version}`)}${info('数据','只保存在本机')}</div>
        <p class="ps-label">日历来源</p><div class="ps-list">${s.games.map(g=>info(g.name,g.source||'官方公告')).join('')}</div>
        <h3 class="ps-label">免责声明与使用边界</h3>
        <p class="ps-note">游时是独立、非官方的本地时间规划工具，不代表任何游戏运营方或信息网站。活动日期、区服、时区换算、头图、奖励及参与条件可能因源站变更、网络、解析错误或缓存过期而遗漏、延迟或出错。同步成功不代表逐项人工核实。</p>
        <p class="ps-note">重要截止时间请自行核对游戏内及游戏官方最新公告。卡池结束、活动关卡关闭与兑换商店关闭可能是不同时间。提醒可能漏发、延迟或无法送达，勿作为避免错过活动或奖励的唯一依据；请设置必要的备用提醒并备份个人数据。</p>
        <p class="ps-note">在适用法律允许的范围内，软件按现状提供，不保证信息准确、完整、及时或提醒送达；开发者、维护者及贡献者不对因使用或无法使用本工具导致的错过活动、奖励未领取、游戏内资源损失、数据丢失及相关损失承担责任。本声明不排除或限制依法不得排除或限制的责任。</p>
        <p class="ps-note">源码继续适用 MIT License，第三方公告、商标、图片及 Wiki 内容归各自权利人，分别适用其许可。</p>
        <a class="ps-source ps-wide" href="https://github.com/woodrice/acg-calendar" target="_blank" rel="noopener">项目主页与反馈 ↗</a>`;
    }else body=`<p class="ps-note">没有这个页面。</p>`;
    return `<h2 class="ps-sub-h">${E(title)}</h2>${body}`;
  }
  // Game scope controls, used by the scope sheet and by 我的 → 游戏.
  function scopeBody(s){
    return `<div class="ps-seg" role="radiogroup" aria-label="范围">${[['all','全部游戏'],['selected','自选组合']].map(([m,l])=>`<button type="button" role="radio" aria-checked="${m==='all'?s.scope.mode==='all':s.scope.mode!=='all'}" data-scope-mode="${m}">${l}</button>`).join('')}</div>`+
        `<div class="ps-list">${s.games.map(g=>{const on=s.scope.mode==='all'||s.scope.games.includes(g.id);return `<button type="button" class="ps-row" role="checkbox" aria-checked="${on}" data-scope-game="${E(g.id)}" style="--game:${E(g.color)}">${mono(g)}<span class="ps-row-main"><span class="ps-row-title">${E(g.name)}</span><span class="ps-row-sub">${E(g.source)}</span></span><span class="ps-check" aria-hidden="true">${on?'✓':''}</span></button>`;}).join('')}</div>`;
  }
  function syncLine(s){
    const y=s.sync;
    const text=s.connectionError?'本地连接已断开 · 显示上次读取的日历':y.running?`正在同步 · ${y.stage||'准备中'}`:y.paused?'联网已暂停 · 显示本地日历':y.lastSuccess?`${lastSync(y)} · 离线可用`:lastSync(y);
    return `<div class="ps-sync" aria-live="polite"><span class="ps-dot${y.running?' ps-dot-run':''}" aria-hidden="true"></span><span class="ps-sync-t">${E(text)}</span><button type="button" class="ps-link ps-sync-now" data-sync ${y.running?'disabled':''}>立即同步</button>${y.running?'<span class="ps-sync-bar" aria-hidden="true"></span>':''}</div>`;
  }
  function lastSync(y){const h=source.helpers;return y.lastSuccess?`${h.date(y.lastSuccess)} ${h.time(y.lastSuccess)} 已同步`:'尚未同步 · 显示内置日历';}
  // One summary when a run ends, from each game's own result.
  function syncSummary(s){
    let added=0,updated=0,images=0;const failed=[];
    for(const id of s.scope.games){const g=s.sync.games[id];if(!g)continue;if(g.error)failed.push(gameOf(s,id).short);const r=g.result;if(r){added+=r.calendar?.added||0;updated+=r.calendar?.updated||0;images+=r.images?.added||0;}}
    return `本轮同步：新增 ${added} · 更新 ${updated} · 补齐头图 ${images} 张${failed.length?` · ${failed.join('、')}未成功，保留缓存`:''}`;
  }
  function empty(title,text,action=''){return `<div class="ps-empty" role="status"><strong>${E(title)}</strong><span>${E(text)}</span>${action}</div>`;}

  // ---- layers ----
  function detail(s,id){
    const e=source.event(id); // Regardless of filters: completing an activity must not empty its open page.
    if(!e)return `<section class="ps-page-layer" aria-labelledby="ps-detail-h"><header class="ps-bar"><button type="button" class="ps-icon" data-back aria-label="返回">${icon('M15 5l-7 7 7 7')}</button><h2 id="ps-detail-h" class="ps-title" tabindex="-1">活动不可用</h2></header>${empty('这条活动已不在当前日历','可能已被同步移除或被筛选隐藏',`<button type="button" class="ps-btn" data-back>返回</button>`)}</section>`;
    const g=gameOf(s,e.game),h=source.helpers,busy=pending.has(e.id);
    return `<section class="ps-page-layer" aria-labelledby="ps-detail-h" style="--game:${E(g.color)}">
      <header class="ps-bar"><button type="button" class="ps-icon" data-back aria-label="返回">${icon('M15 5l-7 7 7 7')}</button><span class="ps-bar-sub">${E(g.short)} · ${E(e.subtype||'活动')}</span></header>
      <div class="ps-scroll">${e.artwork?`<img class="ps-hero-img" src="${E(e.artwork)}" alt="">`:`<div class="ps-hero" aria-hidden="true"><span>${E(e.title)}</span></div>`}
      <div class="ps-pad"><h2 id="ps-detail-h" class="ps-title ps-detail-t" tabindex="-1">${e.starred?'★ ':''}${E(e.title)}</h2>
      <div class="ps-tags"><span>${E(e.subtype||'活动')}</span>${e.start.state==='estimated'?'<span>开始时间待核实</span>':''}${e.completed?'<span class="ps-tag-on">✓ 已完成</span>':''}</div>
      <div class="ps-times"><div><span class="ps-row-sub">开始${e.start.state==='estimated'?' · 预计':''}</span><span class="ps-time">${e.start.at?`${E(h.date(e.start.at))} ${E(h.time(e.start.at))}`:'待定'}</span></div><div><span class="ps-row-sub">截止${e.end.state==='estimated'?' · 预计':''}</span><span class="ps-time">${e.end.at?`${E(h.date(e.end.at))} ${E(h.time(e.end.at))}`:'待定'}</span></div>${e.end.at&&Date.parse(e.end.at)>source.now()?`<div class="ps-times-left"><span>距离截止</span><span class="ps-time">${E(h.countdown(e.end.at,source.now()))}</span></div>`:''}</div>
      <p class="ps-note">按你的时区（${E(h.zone)}）显示 · 具体以游戏内公告为准</p>
      ${e.warnings?.length?`<ul class="ps-warnings">${e.warnings.map(w=>`<li>${E(w)}</li>`).join('')}</ul>`:''}
      ${e.phases?.length?`<details class="ps-more"><summary>阶段 · ${e.phases.length}</summary><ul>${e.phases.map(ph=>`<li>${E(ph.title||'')} ${ph.at?`<span class="ps-time">${E(h.date(ph.at))} ${E(h.time(ph.at))}</span>`:''}</li>`).join('')}</ul></details>`:''}
      ${e.description?`<details class="ps-more"><summary>活动说明</summary><p>${E(e.description)}</p></details>`:''}
      ${e.sourceUrl?`<a class="ps-source" href="${E(e.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看来源原文 ↗</a>`:''}</div></div>
      <div class="ps-actions"><button type="button" class="ps-btn ps-primary" data-act="complete" data-id="${E(e.id)}" ${busy?'disabled':''}>${e.completed?'↶ 撤销完成':'✓ 标记完成'}</button><button type="button" class="ps-btn" data-act="star" data-id="${E(e.id)}" aria-pressed="${e.starred}" ${busy?'disabled':''}>${e.starred?'★ 已收藏':'☆ 收藏'}</button><button type="button" class="ps-btn" data-sheet="plan-new" data-plan-event="${E(e.id)}">安排</button></div>
    </section>`;
  }
  function sheet(s,name){
    const head=(t,extra='')=>`<div class="ps-grip" aria-hidden="true"></div><div class="ps-sheet-h"><h2 class="ps-title" tabindex="-1" id="ps-sheet-h">${E(t)}</h2>${extra}</div>`;
    let body='';
    if(name==='scope'){
      body=head('显示哪些游戏')+scopeBody(s)+`<button type="button" class="ps-btn ps-primary ps-wide" data-back>完成</button>`;
    }else if(name==='filter'){
      const names={event:'活动',gacha:'寻访与调频',exchange:'兑换',update:'玩法更新',maintenance:'维护'},f=s.filters,types=Object.keys(f.types).map(id=>[id,names[id]||id]);
      const sw=(k,l,hint)=>`<button type="button" class="ps-switch" role="switch" aria-checked="${!!f[k]}" data-filter-flag="${k}"><span><span>${l}</span><span class="ps-row-sub">${hint}</span></span><span class="ps-knob" aria-hidden="true"></span></button>`;
      body=head('筛选',`<button type="button" class="ps-link" data-filter-reset>重置</button>`)+`<p class="ps-label">类型</p><div class="ps-chips">${types.map(([id,l])=>`<button type="button" class="ps-chip" aria-pressed="${f.types[id]!==false}" data-filter-type="${id}">${f.types[id]!==false?'<span aria-hidden="true">✓ </span>':''}${l}</button>`).join('')}</div>`+
        `<p class="ps-label">状态</p>${sw('hideCompleted','隐藏已完成','完成的活动收起，不删除')}${sw('showPending','显示截止待定','公告还没写截止时间的活动')}${sw('hideFuture','只看已开始','隐藏尚未开放的活动')}<button type="button" class="ps-btn ps-primary ps-wide" data-back>查看结果</button>`;
    }else if(name==='actions'){
      const e=source.event(route.item);
      body=e?head(e.title)+`<div class="ps-list ps-menu">
        <button type="button" class="ps-set" data-act="complete" data-id="${E(e.id)}" data-then-close>${e.completed?'↶ 撤销完成':'✓ 标记完成'}</button>
        <button type="button" class="ps-set" data-act="star" data-id="${E(e.id)}" data-then-close>${e.starred?'☆ 取消收藏':'★ 收藏'}</button>
        <button type="button" class="ps-set" data-sheet="plan-new" data-plan-event="${E(e.id)}">◇ 安排游玩</button>
        <button type="button" class="ps-set" data-detail="${E(e.id)}">查看详情</button></div>`:head('活动不可用')+`<p class="ps-note">这条活动已不在当前日历。</p>`;
    }else if(name==='day'){
      const nodes=s.deadlineDays[route.day]||[],h=source.helpers;
      body=head(`${h.dayLabel(route.day)} · ${nodes.length?nodes.length+' 项截止':'没有明确截止'}`)+(nodes.length?`<div class="ps-list">${nodes.map(n=>row(s,{...s.events.find(e=>e.id===n.event_id),at:n.at})).join('')}</div>`:`<p class="ps-note">这一天没有已明确的截止。</p>`);
    }else if(formSheet({sheet:name})){
      const editing=name==='plan-edit',plan=editing&&s.plans.find(x=>x.id===route.item),key=name+':'+(route.item||'');
      if(draft&&draft.key!==key)draft=null;
      if(editing&&!plan&&!draft)return sheetBox(head('计划不可用')+`<p class="ps-note">这个计划已删除或不在本机。</p>`);
      if(!draft&&editing){const zone=plan.timezone||source.helpers.zone,start=wall(plan.start,zone),end=wall(plan.end,zone);
        draft={key,mode:'edit',id:plan.id,zone,title:plan.title,start,end,orig:{title:plan.title,start,end},plan:{...plan},dirty:false,error:'',foldStart:null,foldEnd:null,ambiguous:false};}
      draft=draft||{key,mode:'new',zone:source.helpers.zone,title:'',start:`${s.today}T20:00`,end:`${s.today}T23:00`,dirty:false,error:'',event:route.item||route.event||null,requestId:requestId(),foldStart:null,foldEnd:null,ambiguous:false};
      body=head(draft.mode==='edit'?'编辑计划':'新建计划')+(draft.confirming?`<div class="ps-confirm" role="alertdialog" aria-labelledby="ps-confirm-t"><p id="ps-confirm-t">放弃还没保存的计划？</p><div class="ps-actions-inline"><button type="button" class="ps-btn" data-draft="keep">继续编辑</button><button type="button" class="ps-btn ps-primary" data-draft="discard" ${draft.saving?'disabled':''}>放弃</button></div></div>`:'')+
        `<fieldset class="ps-fields" ${draft.saving?'disabled':''}><legend class="ps-sr">计划内容</legend><label class="ps-field">名称<input name="title" value="${E(draft.title)}" autocomplete="off"></label><div class="ps-two"><label class="ps-field">开始<input name="start" type="datetime-local" value="${E(draft.start)}"></label><label class="ps-field">结束<input name="end" type="datetime-local" value="${E(draft.end)}"></label></div></fieldset>`+
        (draft.zone!==source.helpers.zone?`<p class="ps-note">按计划的时区 ${E(draft.zone)} 填写</p>`:'')+
        foldChoices(draft)+
        `${draft.error?`<p class="ps-error" role="alert">${E(draft.error)}</p>`:''}<div class="ps-actions-inline"><button type="button" class="ps-btn" data-back>取消</button><button type="button" class="ps-btn ps-primary" data-plan-save ${draft.saving?'disabled':''}>${draft.saving?'保存中…':'保存'}</button></div>`;
    }
    if(draft&&draft.mode==='edit'&&name==='plan-edit')body+=draft.confirmDelete?
      `<div class="ps-confirm" role="alertdialog" aria-labelledby="ps-del-t" aria-describedby="ps-del-d"><p id="ps-del-t">删除后无法撤销</p><p class="ps-note" id="ps-del-d">这个计划关联的游戏或活动已不在本机，删除后不能再恢复。</p><div class="ps-actions-inline"><button type="button" class="ps-btn" data-delete-keep>保留</button><button type="button" class="ps-btn ps-primary" data-delete-confirm ${draft.saving?'disabled':''}>删除</button></div></div>`:
      `<button type="button" class="ps-link ps-danger" data-plan-delete ${draft.saving?'disabled':''}>删除计划</button>`;
    return sheetBox(body);
  }
  const sheetBox=body=>`<div class="ps-scrim" data-back aria-hidden="true"></div><section class="ps-sheet" role="dialog" aria-modal="true" aria-labelledby="ps-sheet-h">${body}</section>`;
  // An instant as the wall time a datetime-local field shows in the given zone.
  function wall(iso,zone){
    const p={};for(const x of new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date(iso)))p[x.type]=x.value;
    return `${p.year}-${p.month}-${p.day}T${String(+p.hour%24).padStart(2,'0')}:${p.minute}`;
  }

  // ---- frame ----
  function unmountTimeline(){
    if(!timeline)return;
    timelineDate=timeline.date;timeline.destroy();timeline=null;timelineElement=null;
  }
  function updateTimeline(left){
    const slot=root.querySelector('#ps-timeline-mount');
    if(!slot||!source.mountTimeline){unmountTimeline();return;}
    if(timeline){
      slot.replaceWith(timelineElement);timeline.update();
      const scroller=timelineElement.querySelector('.timeline-scroll');if(scroller)scroller.scrollLeft=left;
      return;
    }
    timelineElement=slot;
    timeline=source.mountTimeline(slot,{date:timelineDate,
      onOpenEvent:(id,button)=>open({event:id,sheet:null,day:null,item:null},button),
      onDay:(day,button)=>open({sheet:'day',day,event:null,item:null},button),
      onOpenPlan:(id,button)=>{draft=null;open({sheet:'plan-edit',item:id,event:null,day:null},button);}
    });
  }
  const darkQuery=window.matchMedia?.('(prefers-color-scheme: dark)');
  const onSystemTheme=()=>render();
  // The Android host reports the phone's light/dark setting (it changes without recreating the
  // page); elsewhere the media query is used.
  const systemDark=()=>{const v=document.documentElement.dataset.systemDark;return v==='1'||(v!=='0'&&!!darkQuery?.matches);};
  let appearanceMode='system';
  // Light or dark comes from 主题; the preset gives the colour family. A preset is shown whole in
  // the mode its own background belongs to, and lends only its accent to the other mode.
  let appearancePreset=null,appearancePalette=null;
  function applyTheme(s){
    if(s?.appearance?.mode)appearanceMode=s.appearance.mode;
    const dark=appearanceMode==='dark'||(appearanceMode==='system'&&systemDark());
    root.dataset.theme=dark?'dark':'light';
    if(s?.appearance){appearancePreset=s.appearance.preset;appearancePalette=s.appearance.palettes?.[appearancePreset]||null;}
    const vars=paletteVars(appearancePreset,appearancePalette,dark);
    vars['--ps-fill-opacity']=fillOpacity(vars['--ps-page']||SHELL_PAGE[dark?'dark':'light'],vars['--ps-ink']||SHELL_INK[dark?'dark':'light'],vars['--ps-accent']||SHELL_ACCENT);
    for(const name of PALETTE_VARS)if(vars[name])root.style.setProperty(name,vars[name]);else root.style.removeProperty(name);
    root.dataset.preset=appearancePreset||'';
    // The Android host colours the status and navigation bars to match (top bar and tab bar).
    const bars=vars['--ps-surface']||(dark?'#1C1D1A':'#FFFFFF');
    if(bars!==lastBars){lastBars=bars;try{window.PlaytimeHost?.setBars(bars,bars);}catch{}}
  }
  let lastBars='';
  const PALETTE_VARS=['--ps-page','--ps-surface','--ps-ink','--ps-muted','--ps-line','--ps-soft','--ps-edge','--ps-accent','--ps-accent-ink','--ps-inverse','--ps-inverse-ink','--ps-inverse-muted','--ps-grip','--ps-on-inverse','--ps-fill-opacity'];
  const SHELL_INVERSE={light:'#141414',dark:'#33352F'},SHELL_INK={light:'#141414',dark:'#ECECE6'},SHELL_PAGE={light:'#F4F4EF',dark:'#121311'},SHELL_ACCENT='#FFF200';
  // Month cells: day numbers sit on the accent fill blended over the cell. The fill is as strong as
  // it can be while the blended colour still gives the numbers 4.5:1 (checked with a little margin).
  function fillOpacity(page,ink,accent){
    for(let op=100;op>=10;op-=2)if(contrast(ink,mix(page,accent,op/100))>=4.6)return String(op/100);
    return '.1';
  }
  const rgb=c=>{const h=String(c||'').replace('#','');return h.length===6?[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)):null;};
  const hexOf=a=>'#'+a.map(v=>Math.round(v).toString(16).padStart(2,'0')).join('').toUpperCase();
  const mix=(a,b,t)=>{const x=rgb(a),y=rgb(b);return hexOf(x.map((v,i)=>v+(y[i]-v)*t));};
  const lum=c=>{const [r,g,b]=rgb(c).map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;});return .2126*r+.7152*g+.0722*b;};
  const contrast=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  // Outlines of inputs and outlined buttons: as light as possible while still 3:1 against the
  // surface they sit on (WCAG non-text contrast), so controls stay findable without heavy lines.
  function edgeColor(border,text,surface){
    for(let k=35;k<=100;k+=5){const e=mix(border,text,k/100);if(contrast(e,surface)>=3.05)return e;}
    return text;
  }
  function paletteVars(preset,t,dark){
    // 标准 is the shell's own look; an unknown or incomplete palette falls back to it.
    if(!preset||preset==='light'||!t||!['accent','accent_text','background','surface','panel_alt','text','muted','border'].every(k=>rgb(t[k])))return {};
    const mode=dark?'dark':'light',v={'--ps-accent':t.accent,'--ps-accent-ink':t.accent_text};
    let inverse=SHELL_INVERSE[mode];
    if((lum(t.background)<.2)===dark){
      const inv=dark?mix(t.surface,t.text,.14):t.text,invInk=dark?t.text:t.surface;
      Object.assign(v,{'--ps-page':t.background,'--ps-surface':t.surface,'--ps-ink':t.text,'--ps-muted':t.muted,'--ps-line':t.border,'--ps-soft':t.panel_alt,
        '--ps-edge':edgeColor(t.border,t.text,t.surface),'--ps-inverse':inv,'--ps-inverse-ink':invInk,'--ps-inverse-muted':mix(invInk,inv,.3),'--ps-grip':mix(t.surface,t.text,.25)});
      inverse=inv;
    }
    // The accent is also text on dark blocks and a fill under day numbers; when it is too dark for
    // that, the block's own text colour is used and the fill turns translucent.
    v['--ps-on-inverse']=contrast(t.accent,inverse)>=4.5?t.accent:(v['--ps-inverse-ink']||(dark?'#F4F4EF':'#FFFFFF'));
    return v;
  }
  function render(){
    if(!root)return;
    const s=source.status==='ready'?snap():null;
    const titles={upcoming:'近期',calendar:'日历',plans:'计划',me:'我的'};
    let page;
    if(source.status==='loading')page=`<div class="ps-empty" role="status"><strong>正在读取本地日历…</strong></div>`;
    else if(source.status==='error')page=empty('读取本地日历失败','本地服务没有响应，已有数据不会丢失',`<button type="button" class="ps-btn" data-reload>重试</button>`);
    else if(!s.events.length&&route.tab==='upcoming')page=empty('当前没有可用的活动','可以调整游戏范围或筛选，或稍后同步',`<button type="button" class="ps-btn" data-sheet="scope">选择游戏</button>`);
    else page={upcoming,calendar,plans,me}[route.tab](s);
    const showTools=s&&['upcoming','calendar'].includes(route.tab);
    const scopeLabel=s?(s.scope.mode==='all'?'全部游戏':s.scope.mode==='single'?gameOf(s,s.scope.games[0]).short:`我的游戏 · ${s.scope.games.length} 款`):'';
    const meBack=route.tab==='me'&&route.sub;
    const pageKey=route.tab+':'+route.sub;
    const eventKey=s?route.event:null;
    const sheetKey=s&&route.sheet?JSON.stringify([route.sheet,route.day,route.item,route.event]):'';
    const sameEvent=eventKey&&eventKey===lastEvent,sameSheet=sheetKey&&sheetKey===lastSheet;
    const keep=captureScroll(),focusKey=keyOf(document.activeElement);
    const timelineLeft=timelineElement?.querySelector('.timeline-scroll')?.scrollLeft||0;
    frame.innerHTML=`<header class="ps-bar ps-top">${meBack?`<button type="button" class="ps-icon" data-me="" aria-label="返回我的">${icon('M15 5l-7 7 7 7')}</button>`:''}<h1 class="ps-title" tabindex="-1">${titles[route.tab]}</h1>
        ${showTools?`<button type="button" class="ps-scope" data-sheet="scope">${E(scopeLabel)} ▾</button><button type="button" class="ps-icon" data-sheet="filter" aria-label="筛选${s.filters.activeCount?`（${s.filters.activeCount} 项生效）`:''}">${icon('M4 6h16M7 12h10M10 18h4')}${s.filters.activeCount?`<span class="ps-badge" aria-hidden="true">${s.filters.activeCount}</span>`:''}</button>`:''}</header>
      ${s&&route.tab==='upcoming'?syncLine(s):''}
      <main class="ps-main" data-page="${route.tab}" data-view-key="${E(pageKey)}">${route.tab==='upcoming'?'<div class="ps-pull" aria-hidden="true"><span>下拉同步</span></div>':''}${page}</main>
      <nav class="ps-tabs" aria-label="主导航">${TABS.map(([id,l,d])=>`<button type="button" data-tab="${id}" ${route.tab===id?'aria-current="page"':''}>${icon(d)}<span>${l}</span></button>`).join('')}</nav>
      ${eventKey?`<div class="ps-layer"${sameEvent?' data-layer-update':''}>${detail(s,eventKey)}</div>`:''}
      ${sheetKey?`<div class="ps-layer ps-layer-sheet"${sameSheet?' data-layer-update':''}>${sheet(s,route.sheet)}</div>`:''}`;
    updateTimeline(timelineLeft);
    root.dataset.layer=route.sheet?'sheet':route.event?'page':'';root.dataset.tab=route.tab;applyTheme(s);
    if(s){if(wasSyncing&&!s.sync.running){const text=syncSummary(s);setTimeout(()=>toast(text),0);}wasSyncing=s.sync.running;}
    const current=scrollRegions();
    if(current.main.dataset.viewKey===keep.page)current.main.scrollTop=keep.main;
    if(sameEvent&&current.detail)current.detail.scrollTop=keep.detail;
    if(sameSheet&&current.sheet)current.sheet.scrollTop=keep.sheet;
    // Focus moves into a layer only when it opens; later re-renders keep the user's focus.
    const layerKey=sheetKey?'sheet:'+sheetKey:eventKey?'event:'+eventKey:'';
    if(layerKey&&layerKey!==lastLayer)(root.querySelector('.ps-layer-sheet .ps-title')||root.querySelector('.ps-layer .ps-title'))?.focus({preventScroll:true});
    else if(focusKey)root.querySelector(focusKey)?.focus({preventScroll:true});
    lastLayer=layerKey;lastEvent=eventKey;lastSheet=sheetKey;
  }
  // A control is found again after a re-render by its data attributes (or field name).
  function keyOf(el){
    if(!el||!root.contains(el)||el===root)return '';
    if(el.name)return `[name="${CSS.escape(el.name)}"]`;
    const a=[...el.attributes].filter(x=>x.name.startsWith('data-')).map(x=>`[${x.name}="${CSS.escape(x.value)}"]`).join('');
    return a?el.tagName.toLowerCase()+a:'';
  }
  // Re-rendering keeps the reading position of the page and of an open layer.
  function scrollRegions(){return {main:root.querySelector('.ps-main'),detail:root.querySelector('.ps-page-layer .ps-scroll'),sheet:root.querySelector('.ps-sheet')};}
  function captureScroll(){
    const {main,detail,sheet}=scrollRegions();
    return {page:main?.dataset.viewKey,main:main?.scrollTop||0,detail:detail?.scrollTop||0,sheet:sheet?.scrollTop||0};
  }

  function toast(text,undo){
    const box=toastBox;clearTimeout(toastTimer);
    box.innerHTML=`<span>${E(text)}</span>${undo?'<button type="button" class="ps-link ps-undo">撤销</button>':''}`;box.classList.add('ps-on');
    if(undo)box.querySelector('.ps-undo').onclick=async()=>{box.classList.remove('ps-on');const r=await undo();if(!r?.ok)toast(r?.error||'撤销失败');};
    toastTimer=setTimeout(()=>box.classList.remove('ps-on'),5000);
  }
  async function act(name,args,doneText){
    pending.add(args.id);render();
    const r=await source.act(name,args);pending.delete(args.id);render();
    if(r.ok)toast(doneText,r.undo);else toast(r.error||'操作失败');
  }

  function onClick(e){
    const t=e.target.closest('button,[data-back]');if(!t||!root.contains(t))return;
    if(performance.now()<suppressClick&&t.closest('.ps-swipe')){e.preventDefault();return;}
    if(swallowClick&&performance.now()<swallowClick){swallowClick=0;e.preventDefault();return;}
    swallowClick=0;
    const s=source.status==='ready'?snap():null,d=t.dataset;
    if('back' in d){back();return;}
    if(d.tab){go({tab:d.tab,sub:d.tab==='calendar'?route.sub||'month':'',event:null,sheet:null,day:null,item:null});focusMain();return;}
    if(d.cal){go({sub:d.cal});return;}
    if('me' in d){go({sub:d.me});focusMain();return;}
    if(d.openEvent){open({event:d.openEvent,sheet:null},t);return;}
    if(d.openDay){open({sheet:'day',day:d.openDay},t);return;}
    if(d.editPlan){draft=null;open({sheet:'plan-edit',item:d.editPlan},t);return;}
    if(d.sheet){if(d.sheet==='plan-new')draft=null;open({sheet:d.sheet,item:d.planEvent||null},t);return;}
    if('reload' in d){source.reload();return;}
    if('sync' in d){requestSync();return;}
    if('thenClose' in d)setTimeout(closeLayer,0);
    if(d.detail){go({sheet:null,item:null,event:d.detail},{push:false});return;}
    if(d.act==='star'){const ev=source.event(d.id);act('setStarred',{id:d.id,value:!ev.starred},ev.starred?'已取消收藏':'已收藏');return;}
    if(d.act==='complete'){const ev=source.event(d.id);act('setCompleted',{id:d.id,value:!ev.completed},ev.completed?'已撤销完成':'已标记完成');return;}
    if(d.scopeMode||d.scopeGame){changeScope(d.scopeMode,d.scopeGame);return;}
    if(d.filterType){source.act('setFilters',{types:{[d.filterType]:!(s.filters.types[d.filterType]!==false)}});return;}
    if(d.filterFlag){source.act('setFilters',{[d.filterFlag]:!s.filters[d.filterFlag]});return;}
    if('filterReset' in d){source.act('resetFilters');return;}
    if(d.draft==='keep'){draft.confirming=false;render();return;}
    if(d.fold!==undefined&&draft){draft[d.foldField==='end'?'foldEnd':'foldStart']=Number(d.fold);draft.error='';render();return;}
    if(d.month!==undefined){monthOffset=d.month==='0'?0:monthOffset+Number(d.month);render();return;}
    if(d.draft==='discard'){if(draft.saving)return;draft.leaving=true;closeLayer();return;}
    if(d.preset){source.act('setAppearance',{preset:d.preset}).then(r=>{if(!r.ok)toast(r.error||'未能保存配色');});return;}
    if(d.appearance){source.act('setAppearance',{mode:d.appearance}).then(r=>{if(!r.ok)toast(r.error||'未能保存外观');});return;}
    if('markRead' in d){source.act('markNoticesRead').then(r=>toast(r.ok?'已全部标为已读':r.error||'操作失败'));return;}
    if('planSave' in d)savePlan();
    if('planDelete' in d)deletePlan();
    if('deleteConfirm' in d)deletePlan(true);
    if('deleteKeep' in d&&draft){draft.confirmDelete=false;render();return;}
  }
  function changeScope(mode,game){
    const origin=source;
    // Each tap reads the scope after the previous write, so rapid toggles compose.
    scopeWrite=scopeWrite.then(async()=>{
      if(source!==origin||origin.status!=='ready')return;
      const {scope}=origin.snapshot();
      const selected=new Set(scope.games);
      if(game){if(selected.has(game))selected.delete(game);else selected.add(game);}
      const result=await origin.act('setScope',{mode:mode||'selected',games:[...selected]});
      if(source===origin&&!result.ok)toast(result.error||'未能保存游戏组合');
    }).catch(error=>{if(source===origin)toast(error.message||'未能保存游戏组合');});
  }
  function onInput(e){
    if(!draft||draft.saving||!e.target.closest('.ps-sheet'))return;
    draft[e.target.name]=e.target.value;draft.dirty=true;
    // A new wall time needs its own choice; the earlier one may not even repeat any more.
    if(e.target.name==='start'||e.target.name==='end'){draft[e.target.name==='start'?'foldStart':'foldEnd']=null;if(draft.ambiguous)render();}
    if(draft.error){draft.error='';root.querySelector('.ps-error')?.remove();}
  }
  // Instants that show this wall time in the zone, earliest first: none in a spring-forward gap,
  // two in a fall-back hour. Used only to say which field repeats; the plan API decides.
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
  // After the plan API answers ambiguous_time: a 较早/较晚 choice for each field whose wall time
  // repeats (both, if the zone cannot be checked here).
  function foldChoices(d){
    if(!d.ambiguous)return '';
    const zone=d.zone,check=[['start','开始',d.start,d.foldStart],['end','结束',d.end,d.foldEnd]];
    const known=check.map(([, , v])=>wallTimes(v,zone));
    const shown=known.some(t=>t===null)?check:check.filter((_,i)=>known[i].length>1);
    if(!shown.length)return '';
    const fmt=v=>(v||'').slice(11,16);
    return shown.map(([field,label,value,chosen])=>`<div class="ps-fold"><p class="ps-fold-h" id="ps-fold-${field}">${label} ${E(fmt(value))} 在当地出现两次</p><div class="ps-seg" role="radiogroup" aria-labelledby="ps-fold-${field}">${[[0,'较早的一次'],[1,'较晚的一次']].map(([v,l])=>`<button type="button" role="radio" aria-checked="${chosen===v}" data-fold="${v}" data-fold-field="${field}" ${d.saving?'disabled':''}>${l}</button>`).join('')}</div></div>`).join('');
  }
  // One id per draft, reused when the same draft is retried, so a retry never creates a second plan.
  const requestId=()=>[...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,'0')).join('');
  // The response belongs to the draft that sent it. Local wall times and the IANA zone go to the
  // source as the plan API expects; it applies the zone and daylight-saving rules.
  async function savePlan(){
    const d=draft;if(!d||d.saving)return;
    d.saving=true;d.error='';render();
    let fields;
    if(d.mode==='edit'){
      // Only what changed is sent; an untouched time keeps its stored instant (and its fold).
      fields={id:d.id};
      if(d.title.trim()!==d.orig.title)fields.title=d.title.trim();
      if(d.start!==d.orig.start)fields.local_start=d.start;
      if(d.end!==d.orig.end)fields.local_end=d.end;
      if(Object.keys(fields).length===1){d.saving=false;d.leaving=true;closeLayer();return;}
    }else{
      const linked=d.event&&source.event(d.event);
      fields={title:d.title.trim(),local_start:d.start,local_end:d.end,timezone:d.zone,game_id:linked?.game||null,event_id:linked?.id||null,request_id:d.requestId};
    }
    // Start and end are chosen separately: across a fall-back hour, the earlier 01:45 to the later
    // 01:15 is a real 30-minute plan.
    if(d.foldStart!==null&&'local_start' in fields)fields.fold_start=d.foldStart;
    if(d.foldEnd!==null&&'local_end' in fields)fields.fold_end=d.foldEnd;
    const r=await source.act(d.mode==='edit'?'updatePlan':'createPlan',fields);
    d.saving=false;
    if(!r.ok&&r.code==='ambiguous_time')d.ambiguous=true;
    const current=root&&draft===d&&formSheet(route);
    if(!r.ok){if(current){d.error=r.error;render();}else if(root)toast('计划没有保存：'+(r.error||'未知原因'));return;} // The input stays for another try.
    if(current){d.leaving=true;closeLayer();}
    if(root)setTimeout(()=>toast(d.mode==='edit'?'计划已更新':'计划已保存'),0);
  }
  // Undo saves the same plan again, which the plan API accepts only while its game is installed and
  // its event is still in the local calendar (and belongs to that game).
  function restorable(s,p){
    if(p.game_id&&!s.games.some(g=>g.id===p.game_id))return false;
    if(p.event_id){const e=source.event(p.event_id);if(!e||(p.game_id&&e.game!==p.game_id))return false;}
    return true;
  }
  // Delete at once with an undo, like the other list actions. A plan that could not be saved again
  // asks first instead, and says it cannot be undone.
  async function deletePlan(confirmed=false){
    const d=draft;if(!d||d.saving||d.mode!=='edit')return;
    // Undo restores the plan as last saved, not as it was when this sheet opened (it may have been
    // changed elsewhere meanwhile). Until the plan API can restore the deleted record itself, the
    // latest snapshot is the closest copy the shell has.
    const latest=snap().plans.find(x=>x.id===d.id)||d.plan;
    const undoable=restorable(snap(),latest);
    if(!undoable&&!confirmed){d.confirmDelete=true;render();return;}
    d.confirmDelete=false;d.saving=true;d.error='';render();
    const r=await source.act('deletePlan',{id:d.id});
    d.saving=false;
    const current=root&&draft===d&&formSheet(route);
    if(!r.ok){if(current){d.error=r.error||'删除失败';render();}else if(root)toast('计划没有删除：'+(r.error||'未知原因'));return;}
    if(current){d.leaving=true;closeLayer();}
    const p=latest;
    if(root&&!undoable){setTimeout(()=>toast('计划已删除'),0);return;}
    if(root)setTimeout(()=>toast('计划已删除',()=>restorePlan(p,d.zone)),0);
  }
  // Undo saves the same plan again. Its game or event can vanish between delete and undo (a sync
  // in between removed the event): the plan is then saved without the link that is gone, so its
  // title, times, zone and notes are never lost. (The plan gets a new id; see section 36.)
  async function restorePlan(p,zone){
    const base={title:p.title,start:p.start,end:p.end,timezone:p.timezone||zone,...(p.notes?{notes:p.notes}:{})};
    const r=await source.act('createPlan',{...base,game_id:p.game_id||null,event_id:p.event_id||null,request_id:requestId()});
    if(r.ok||!/关联(活动|游戏)不存在/.test(r.error||''))return r;
    const s=snap(),game=p.game_id&&s.games.some(g=>g.id===p.game_id)?p.game_id:null;
    const again=await source.act('createPlan',{...base,game_id:game,event_id:null,request_id:requestId()});
    if(again.ok)toast(p.event_id?'计划已恢复，原关联的活动已不在本地日历':'计划已恢复，原关联的游戏已不在本机');
    return again;
  }

  // ---- row gestures: swipe left = complete, swipe right = star (both undoable); long press = menu.
  // Rows allow vertical panning only (touch-action), so the list still scrolls natively. Every
  // gesture has a visible alternative: the detail page and the long-press menu use plain buttons.
  let gesture=null,suppressClick=0,swallowClick=0;
  const SWIPE_COMMIT=96,SWIPE_START=12,LONG_PRESS=500;
  function onPointerDown(e){
    const box=e.target.closest('.ps-swipe');if(!box||!e.isPrimary||e.button>0)return;
    const rowEl=box.querySelector('.ps-row');
    gesture={id:box.dataset.swipe,box,rowEl,x:e.clientX,y:e.clientY,dx:0,mode:'pending',pointer:e.pointerId,
      // The finger is still down when the sheet opens; its release would land on the sheet's
      // backdrop and close it, so the click from that release is swallowed.
      timer:setTimeout(()=>{if(gesture?.mode==='pending'){gesture.mode='done';swallowClick=performance.now()+1500;open({sheet:'actions',item:gesture.id},rowEl);}},LONG_PRESS)};
  }
  function onPointerMove(e){
    const g=gesture;if(!g||e.pointerId!==g.pointer)return;
    const dx=e.clientX-g.x,dy=e.clientY-g.y;
    if(g.mode==='pending'){
      if(Math.abs(dy)>SWIPE_START&&Math.abs(dy)>Math.abs(dx)){clearTimeout(g.timer);gesture=null;return;} // a scroll
      if(Math.abs(dx)>SWIPE_START){clearTimeout(g.timer);g.mode='swipe';g.box.classList.add('ps-swiping');try{g.box.setPointerCapture(e.pointerId);}catch{}}
    }
    if(g.mode!=='swipe')return;
    g.dx=Math.max(-160,Math.min(160,dx));
    g.rowEl.style.transform=`translateX(${g.dx}px)`;
    g.box.dataset.reveal=g.dx<0?'done':'star';g.box.classList.toggle('ps-armed',Math.abs(g.dx)>=SWIPE_COMMIT);
  }
  function onPointerUp(e){
    const g=gesture;if(!g||e.pointerId!==g.pointer)return;
    clearTimeout(g.timer);gesture=null;
    if(g.mode!=='swipe')return;
    suppressClick=performance.now()+400;
    g.rowEl.style.transform='';g.box.classList.remove('ps-swiping','ps-armed');
    if(Math.abs(g.dx)<SWIPE_COMMIT)return;
    const ev=source.event(g.id);if(!ev)return;
    if(g.dx<0)act('setCompleted',{id:g.id,value:!ev.completed},ev.completed?'已撤销完成':'已标记完成');
    else act('setStarred',{id:g.id,value:!ev.starred},ev.starred?'已取消收藏':'已收藏');
  }
  function onPointerCancel(e){const g=gesture;if(!g||e.pointerId!==g.pointer)return;clearTimeout(g.timer);gesture=null;g.rowEl.style.transform='';g.box.classList.remove('ps-swiping','ps-armed');}
  // ---- pull to refresh (touch only; the 立即同步 button is the visible alternative) ----
  let pull=null;const PULL_COMMIT=64;
  function onTouchStart(e){
    const main=e.target.closest('.ps-main');
    if(!main||route.tab!=='upcoming'||overlay(route)||main.scrollTop>0||e.touches.length!==1||source.status!=='ready')return;
    pull={main,y:e.touches[0].clientY,x:e.touches[0].clientX,dy:0,active:false};
  }
  function onTouchMove(e){
    if(!pull)return;
    const dy=e.touches[0].clientY-pull.y,dx=e.touches[0].clientX-pull.x;
    if(!pull.active){if(dy>8&&dy>Math.abs(dx)&&pull.main.scrollTop<=0)pull.active=true;else if(Math.abs(dx)>8||dy<0){pull=null;return;}else return;}
    e.preventDefault();pull.dy=Math.min(120,dy*.5);
    const ind=pull.main.querySelector('.ps-pull');ind.style.height=pull.dy+'px';ind.firstChild.textContent=pull.dy>=PULL_COMMIT?'松开同步':'下拉同步';
  }
  function onTouchEnd(){
    if(!pull)return;const p=pull;pull=null;
    const ind=p.main.querySelector('.ps-pull');if(ind)ind.style.height='0';
    if(p.active&&p.dy>=PULL_COMMIT)requestSync();
  }
  async function requestSync(){
    const s=snap();if(!s)return;
    const r=await source.act('sync',{scope:s.scope});
    if(r.ok)return;
    const h=source.helpers;
    toast(r.code==='cooldown'&&r.until?`刚刚已尝试同步，${h.time(r.until)} 后可再同步`:r.code==='paused'?'联网已暂停，暂时不能同步':r.error||'暂时无法同步');
  }
  function onContextMenu(e){if(e.target.closest('.ps-swipe'))e.preventDefault();} // The long press is ours, not the WebView's.

  function start({root:mount,source:src}){
    if(!enabled())return false;
    stop();root=mount;source=src;route=parse();
    root.id=root.id||'pt-shell';root.classList.add('pt-shell');
    // The toast sits outside the re-rendered frame, so a re-render right after it cannot wipe it.
    root.innerHTML='<div class="ps-frame"></div><div class="ps-toast" role="status" aria-live="polite"></div>';
    frame=root.firstChild;toastBox=root.lastChild;
    root.addEventListener('click',onClick);root.addEventListener('input',onInput);
    root.addEventListener('pointerdown',onPointerDown);root.addEventListener('pointermove',onPointerMove);root.addEventListener('pointerup',onPointerUp);root.addEventListener('pointercancel',onPointerCancel);root.addEventListener('contextmenu',onContextMenu);
    root.addEventListener('touchstart',onTouchStart,{passive:true});root.addEventListener('touchmove',onTouchMove,{passive:false});root.addEventListener('touchend',onTouchEnd);root.addEventListener('touchcancel',onTouchEnd);
    window.addEventListener('popstate',onPop);darkQuery?.addEventListener?.('change',onSystemTheme);window.addEventListener('playtime-system-theme',onSystemTheme);
    unsubscribe=source.subscribe(render);
    minuteTimer=setInterval(()=>{if(!formSheet(route))render();},60000);
    history.replaceState(null,'',hashOf(route));render();
    return true;
  }
  function stop(){
    if(!root)return;
    unmountTimeline();timelineDate=null;
    root.removeEventListener('click',onClick);root.removeEventListener('input',onInput);
    root.removeEventListener('pointerdown',onPointerDown);root.removeEventListener('pointermove',onPointerMove);root.removeEventListener('pointerup',onPointerUp);root.removeEventListener('pointercancel',onPointerCancel);root.removeEventListener('contextmenu',onContextMenu);gesture=null;
    root.removeEventListener('touchstart',onTouchStart);root.removeEventListener('touchmove',onTouchMove);root.removeEventListener('touchend',onTouchEnd);root.removeEventListener('touchcancel',onTouchEnd);pull=null;
    window.removeEventListener('popstate',onPop);darkQuery?.removeEventListener?.('change',onSystemTheme);window.removeEventListener('playtime-system-theme',onSystemTheme);delete root.dataset.theme;delete root.dataset.preset;lastBars='';for(const name of PALETTE_VARS)root.style.removeProperty(name);unsubscribe?.();clearTimeout(toastTimer);clearInterval(minuteTimer);monthOffset=0;
    root.innerHTML='';root=null;source=null;draft=null;returnFocus=[];pending.clear();lastLayer='';lastEvent=null;lastSheet='';scopeWrite=Promise.resolve();pushed=0;
  }
  return {enabled,start,stop,back,get route(){return route&&{...route};}};
})();
