'use strict';
// The Android shell sees a read model and named commands. The calendar host owns state,
// filtering, credentials and polling. Neither the raw state nor the host API is exported.
window.PlaytimeShellSource = (() => {
  function freeze(value) {
    if(value&&typeof value==='object'){
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  const copy=value=>freeze(JSON.parse(JSON.stringify(value)));
  const ok=extra=>({ok:true,...extra});
  const fail=(code,error,extra)=>({ok:false,code,error,...extra});
  const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]+$/.test(id);
  const validPlan=id=>typeof id==='string'&&/^plan-[a-f0-9]{32}$/.test(id);
  const localImage=path=>/^(?:\/assets\/[a-zA-Z0-9_.-]+|\/api\/artwork\/[a-f0-9]{32}\.(?:png|jpg|webp))$/.test(path||'')?path:null;
  function sourceLink(value){
    try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}
    catch{return null;}
  }
  function activity(e){
    return {id:e.id,game:e.game,title:e.title,category:e.category,subtype:e.subtype,
      start:e.start,end:e.end,starred:!!e.starred,completed:!!e.completed,versionId:e.version_id,
      artwork:localImage(e.artwork?.path),sourceUrl:sourceLink(e.source?.url),description:e.description||'',
      warnings:e.warnings||[],phases:e.phases||[],timeKind:e.time_kind,reminderMinutes:e.reminder_minutes??null};
  }

  function create(host){
    const listeners=new Set();
    let revision=0,cache=null,queue=Promise.resolve(),nextBoundary=Infinity;
    const publish=()=>{
      revision++;cache=null;
      for(const fn of listeners){try{fn();}catch(error){console.error('安卓界面订阅更新失败',error);}}
    };
    const day=at=>{
      const p=host.dateParts(at);
      return `${p.year}-${p.month}-${p.day}`;
    };
    const localInput=at=>{
      if(!at)return '';
      const p=host.dateParts(at);
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    };
    const dayLabel=value=>{
      if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return '日期待定';
      const weekday=new Date(value+'T00:00:00Z').getUTCDay();
      return value.slice(5).replace('-','/')+' 周'+'日一二三四五六'[weekday];
    };
    const helpers=Object.freeze({get zone(){return host.zone();},
      time:at=>at?localInput(at).slice(11):'待定',date:at=>host.format(at,{dateOnly:true}),
      day,dayLabel,localInput,countdown:host.countdown});
    const event=id=>host.data()?.events.find(e=>e.id===id);

    function snapshot(){
      const data=host.data();if(!data)return null;
      if(cache)return cache;
      const base=host.baseEvents(), order=new Map(data.event_order.map((id,index)=>[id,index]));
      const events=[...base].sort((a,b)=>(order.get(a.id)??Infinity)-(order.get(b.id)??Infinity)).map(activity);
      const {byId,nodes,uncertain}=host.upcoming(host.upcomingEvents());
      const groups=new Map(),deadlineDays=Object.create(null);
      for(const node of nodes){
        const key=day(node.at);
        if(!groups.has(key))groups.set(key,{day:key,label:dayLabel(key),items:[]});
        groups.get(key).items.push({...activity(byId.get(node.event_id)),at:node.at,deadlineTitle:node.title,kind:node.kind});
      }
      for(const node of host.deadlines())(deadlineDays[day(node.at)]??=[]).push(node);
      for(const rows of Object.values(deadlineDays))rows.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
      const view=data.workspace.view,game=host.game();
      const games=data.games.map(g=>({id:g.id,name:g.name,short:g.short_name,mono:g.monogram,color:g.color,
        icon:localImage(g.icon),source:[g.server,g.source_label].filter(Boolean).join(' · ')}));
      const scope={mode:game==='all'?'all':game==='selected'?'selected':'single',
        games:game==='all'?games.map(g=>g.id):game==='selected'?view.selected_games:[game]};
      const syncGames=Object.fromEntries(games.map(({id})=>{
        const s=data.sync_by_game[id]||{};
        return [id,{running:!!s.running,stage:s.stage??null,label:host.progress(s),waiting:s.waiting??null,
          lastSuccess:s.last_success??null,error:s.error??null,result:s.result??null}];
      }));
      const syncRows=scope.games.map(id=>syncGames[id]).filter(Boolean);
      const activeSync=syncRows.find(s=>s.running);
      const filters=host.filters();
      const current=host.now();
      nextBoundary=Infinity;
      const boundaries=[...nodes.map(n=>n.at),...uncertain.map(e=>e.end.at)];
      if(filters.hideFuture)boundaries.push(...host.scopeEvents().map(e=>e.start.at));
      for(const at of boundaries){const time=Date.parse(at);if(time>current&&time<nextBoundary)nextBoundary=time;}
      const activeCount=Object.values(filters.types).filter(v=>!v).length+Number(filters.hideCompleted)+Number(filters.hideFuture)+Number(!filters.showPending)+Number(!!filters.search);
      const planList=[...data.plans].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)||a.id.localeCompare(b.id));
      cache=copy({revision,today:day(host.now()),games,scope,filters:{...filters,activeCount},events,
        upcoming:[...groups.values()],uncertain:uncertain.map(activity),deadlineDays,plans:planList,
        sync:{games:syncGames,running:!!activeSync,stage:activeSync?.label||null,
          lastSuccess:syncRows.map(s=>s.lastSuccess).filter(Boolean).sort().pop()||null,
          paused:!!data.network.paused,sites:data.network.sites},
        appearance:{mode:host.appearance(),preset:data.workspace.theme.preset,presets:data.workspace_defaults.theme_names,
          // Read-only colour tokens per preset, for the Android shell's 外观 (Claude, M2).
          palettes:Object.fromEntries(Object.entries(data.workspace_defaults.themes).map(([k,t])=>[k,Object.fromEntries(['accent','accent_text','background','surface','panel_alt','text','muted','border'].map(f=>[f,t[f]]))]))},
        connectionError:host.error(),app:{version:data.app_version,calendarVersion:host.version(),
          unread:data.notifications.filter(n=>!n.read).length}});
      return cache;
    }

    async function mark(field,{id,value},undoOf){
      if(!validId(id)||!event(id))return fail('not_found','活动已不在本地日历');
      if(typeof value!=='boolean')return fail('invalid','标记值须为布尔值');
      const before=!!event(id)[field];
      if(undoOf!==undefined&&before!==undoOf)return fail('conflict','标记已经改变，请查看当前状态');
      if(before===value)return ok();
      await host.write('/api/events/'+id,'PATCH',{[field]:value});
      return ok({undo:()=>enqueue(()=>mark(field,{id,value:before},value))});
    }

    const reset={showPending:true,hideFuture:false,hideCompleted:false,clearSearch:true};
    const actions={
      setStarred:args=>mark('starred',args),
      setCompleted:args=>mark('completed',args),
      async setScope({mode,games}){
        const allowed=host.data().games.map(g=>g.id);
        if(mode==='custom')mode='selected'; // M0 fixture compatibility.
        if(mode==='all'){await host.selectScope('all');return ok();}
        const ids=games;
        if(!['selected','single'].includes(mode)||!Array.isArray(ids)||ids.length>100||
          new Set(ids).size!==ids.length||ids.some(id=>!allowed.includes(id))||(mode==='single'&&ids.length!==1))
          return fail('invalid','请选择已安装的游戏');
        await host.selectScope(mode==='single'?ids[0]:mode,ids);
        return ok();
      },
      async setFilters(patch){
        const {types,sort,hideCompleted,hideFuture,showPending}=patch;
        const categories=Object.keys(host.filters().types);
        if(Object.keys(patch).some(key=>!['types','sort','hideCompleted','hideFuture','showPending'].includes(key))||
          ('types' in patch&&(!types||typeof types!=='object'||Array.isArray(types)||Object.entries(types).some(([key,value])=>!categories.includes(key)||typeof value!=='boolean')))||
          ('sort' in patch&&!['start','remaining','title','manual'].includes(sort))||
          ['hideCompleted','hideFuture','showPending'].some(key=>key in patch&&typeof patch[key]!=='boolean'))
          return fail('invalid','筛选条件无效');
        await host.filtersWrite(patch);
        return ok();
      },
      async resetFilters(){
        await host.filtersWrite({...reset,types:Object.fromEntries(Object.keys(host.filters().types).map(id=>[id,true]))});
        return ok();
      },
      async createPlan(fields){
        const data=await host.write('/api/plans','POST',fields);
        return ok({id:data.saved_plan});
      },
      async updatePlan({id,...fields}){
        if(!validPlan(id))return fail('invalid','个人计划 ID 无效');
        await host.write('/api/plans/'+id,'PATCH',fields);
        return ok({id});
      },
      async deletePlan({id}){
        if(!validPlan(id))return fail('invalid','个人计划 ID 无效');
        await host.write('/api/plans/'+id,'DELETE');
        return ok();
      },
      async markNoticesRead(){await host.write('/api/notifications/read','POST');return ok();},
      async setAppearance({mode,preset}){
        const themes=host.data().workspace_defaults.themes;
        if((mode!==undefined&&!['system','light','dark'].includes(mode))||
          (preset!==undefined&&!Object.hasOwn(themes,preset)))return fail('invalid','主题设置无效');
        if(preset!==undefined)await host.write('/api/workspace','PATCH',{theme:themes[preset]});
        if(mode!==undefined){host.saveAppearance(mode);publish();}
        return ok();
      },
      async sync({scope=host.game()}){
        const data=host.data();
        if(scope&&typeof scope==='object'){
          const {mode,games}=scope;
          if(mode==='selected'&&(!Array.isArray(games)||games.length!==data.workspace.view.selected_games.length||
            data.workspace.view.selected_games.some(id=>!games.includes(id))))
            return fail('conflict','游戏组合已改变，请重新同步');
          scope=mode==='single'?games?.[0]:mode;
        }
        if(!['all','selected',...data.games.map(g=>g.id)].includes(scope))return fail('invalid','同步范围无效');
        if(data.network.paused)return fail('paused','联网已暂停');
        const result=await host.write('/api/sync','POST',{game:scope});
        const {requested,accepted}=result.sync_request;
        if(accepted.length)return ok({accepted,requested});
        if(!requested.length)return fail('empty_scope','请选择需要同步的游戏');
        const localError=requested.find(id=>data.games.find(g=>g.id===id)?.plugin_kind==='local-json'&&result.sync_by_game[id]?.error);
        if(localError)return fail('not_started',result.sync_by_game[localError].error);
        const statuses=requested.map(id=>result.sync_by_game[id]||{});
        if(statuses.some(s=>s.running))return fail('busy','所选游戏已有同步在进行');
        const lastAttempts=statuses.map(s=>Date.parse(s.last_attempt)+30000).filter(at=>at>host.now());
        if(lastAttempts.length===statuses.length){
          return fail('cooldown','刚刚已尝试同步，请稍候',{until:new Date(Math.min(...lastAttempts)).toISOString()});
        }
        return fail('not_started',statuses.find(s=>s.error)?.error||'当前无法开始同步');
      }
    };

    function enqueue(task){
      const run=queue.then(async()=>{
        if(!host.data())return fail('unavailable','本地日历尚未就绪');
        try{return await task();}
        catch(error){return fail(error.code||(error.status===404?'not_found':error.status===400?'invalid':'request_failed'),error.message);}
      });
      queue=run;
      return run;
    }
    const source=Object.freeze({
      get status(){return host.data()?'ready':host.error()?'error':'loading';},
      get error(){return host.error();},
      now:host.now,helpers,snapshot,
      event(id){const e=event(id);return e?copy(activity(e)):null;},
      subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
      reload:host.refresh,
      mountTimeline:host.mountTimeline,
      act(name,args={}){
        if(!Object.hasOwn(actions,name))return Promise.resolve(fail('unsupported','不支持的操作'));
        return enqueue(()=>actions[name](args));
      }
    });
    return {source,publish,tick(){if(cache&&(host.now()>=nextBoundary||day(host.now())!==cache.today))publish();}};
  }
  return Object.freeze({create});
})();
