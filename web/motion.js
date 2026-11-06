'use strict';
/* Host feedback only. Animation never owns activity state, network timing or persistence. */
window.PlaytimeMotion = (() => {
  const media=matchMedia('(prefers-reduced-motion: reduce)'), active=new Set(), dialogs=new WeakMap(), entrance=new Set();
  let preference='auto', entered=false, planId=null, locateTimer;
  const mode=()=>preference==='auto'?(media.matches?'reduced':'standard'):preference;
  function configure(value='auto') {
    preference=['auto','standard','reduced','off'].includes(value)?value:'auto';
    const root=document.documentElement,next=mode();
    if(root.dataset.motion!==next)for(const animation of active)animation.cancel();
    root.dataset.motion=next;
  }
  media.addEventListener('change',()=>configure(preference));configure();
  function play(node,frames,duration=180,options={}) {
    if(mode()==='off'||!node?.isConnected||!node.checkVisibility()||typeof node.animate!=='function')return;
    const animation=node.animate(frames,{duration:mode()==='reduced'?120:duration,easing:'cubic-bezier(.2,.7,.2,1)',...options});
    active.add(animation);animation.finished.catch(()=>{}).finally(()=>active.delete(animation));return animation;
  }
  const rowKey=node=>node.dataset.rowEvent?'event:'+node.dataset.rowEvent:node.dataset.rowPlan?'plan:'+node.dataset.rowPlan:null;
  const rows=root=>[...root.querySelectorAll('[data-row-event],[data-row-plan]')];
  const starred=node=>node.querySelector('.event-star')?.getAttribute('aria-pressed')==='true';
  function settle(root){for(const a of active)if(root.contains(a.effect?.target))a.cancel();}
  function stopEntrance(){for(const a of entrance)a.cancel();entrance.clear();}
  function enterTimeline(root){
    const scroll=root.querySelector('.timeline-scroll');if(entered||!scroll?.checkVisibility())return;
    const bounds=scroll.getBoundingClientRect(),bars=[...scroll.querySelectorAll('.event-bar,.personal-plan-bar')].filter(bar=>{const r=bar.getBoundingClientRect();return r.width&&r.height&&r.bottom>bounds.top&&r.top<bounds.bottom&&r.right>bounds.left&&r.left<bounds.right;}).slice(0,24);
    if(!bars.length)return;
    entered=true;
    bars.forEach((bar,i)=>{
      const reduce=mode()==='reduced',a=play(bar,reduce?[{opacity:.55},{opacity:1}]:[{clipPath:'inset(0 100% 0 0)'},{clipPath:'inset(0 0 0 0)'}],420,{delay:reduce?0:Math.min(i,7)*34,easing:reduce?'linear':'cubic-bezier(.65,0,.25,1)',fill:'backwards'});
      if(a){entrance.add(a);a.finished.catch(()=>{}).finally(()=>entrance.delete(a));}
    });
  }
  function phantom(node,rect,clip,frames,duration,options={},gridColumns){
    const width=clip.right-clip.left,height=clip.bottom-clip.top;
    if(width<1||height<1)return;
    const cover=document.createElement('div'),clone=node.cloneNode(true);
    cover.className='motion-phantom';cover.inert=true;cover.setAttribute('aria-hidden','true');
    Object.assign(cover.style,{left:clip.left+'px',top:clip.top+'px',width:width+'px',height:height+'px'});
    clone.removeAttribute('id');clone.removeAttribute('data-row-event');clone.removeAttribute('data-row-plan');clone.removeAttribute('data-frame');
    clone.querySelectorAll('[id]').forEach(n=>n.removeAttribute('id'));
    for(const control of clone.querySelectorAll('button,a,input,select,textarea')){
      for(const name of control.getAttributeNames())if(name.startsWith('data-'))control.removeAttribute(name);
    }
    Object.assign(clone.style,{position:'absolute',left:rect.left-clip.left+'px',top:rect.top-clip.top+'px',width:rect.width+'px',height:rect.height+'px',margin:'0',transform:'none',translate:'none',backgroundColor:'var(--paper)'});
    clone.style.setProperty('display',node.matches('.timeline-row')?'grid':node.matches('.page-heading')?'flex':'block','important');
    if(gridColumns)clone.style.gridTemplateColumns=gridColumns;
    cover.append(clone);document.body.append(cover);
    const a=play(clone,frames,duration,options),remove=()=>cover.remove();
    if(a)a.finished.catch(()=>{}).finally(remove);else remove();
  }
  function capture(root,context) {
    const same=root._motionContext===context;root._motionContext=context;
    const scroller=root.querySelector('.timeline-scroll');
    if(!same||mode()==='off'||!scroller)return null;
    const bounds=scroller.getBoundingClientRect(),positions=new Map(),head=scroller.querySelector('.timeline-head')?.getBoundingClientRect();
    const clip={left:Math.max(0,bounds.left),top:Math.max(0,bounds.top,head?.bottom||0),right:Math.min(innerWidth,bounds.right),bottom:Math.min(innerHeight,bounds.bottom)};
    for(const row of rows(root)) {
      const rect=row.getBoundingClientRect();
      if(rect.bottom<=clip.top||rect.top>=clip.bottom||!rect.height)continue;
      positions.set(rowKey(row),{row,rect,gridColumns:getComputedStyle(row).gridTemplateColumns,starred:starred(row),completed:row.classList.contains('completed')});
    }
    // Measure live positions first, then discard old transforms before measuring new targets.
    settle(root);
    return {positions,clip};
  }
  function layout(root,before) {
    const committedPlan=planId;planId=null;
    if(mode()==='off')return;
    const after=rows(root),current=new Set(after.map(rowKey));
    if(before){
      for(const [key,old] of [...before.positions].filter(([key])=>!current.has(key)).slice(0,12)){
        phantom(old.row,old.rect,before.clip,mode()==='reduced'?[{opacity:.75},{opacity:0}]:[{opacity:.8,transform:'none'},{opacity:0,transform:'translateY(-5px) scaleY(.83)'}],145,{},old.gridColumns);
      }
    }
    const bounds=root.getBoundingClientRect();let count=0;
    for(const row of after) {
      if(committedPlan&&row.dataset.rowPlan===committedPlan){
        play(row.querySelector('.personal-plan-bar'),mode()==='reduced'?[{opacity:.5},{opacity:1}]:[{opacity:.55,transform:'scaleY(1.32)'},{opacity:1,transform:'none'}],240,{easing:'cubic-bezier(.65,0,.25,1)'});
      }
      if(!before)continue;
      const rect=row.getBoundingClientRect();if(rect.bottom<bounds.top||rect.top>bounds.bottom||!rect.height||count>=24)continue;
      const old=before.positions.get(rowKey(row)),dy=old?old.rect.top-rect.top:0,opacity=Number(getComputedStyle(row).opacity),pin=old&&!old.starred&&starred(row);
      if(old&&Math.abs(dy)<1&&!pin&&old.completed===row.classList.contains('completed'))continue;
      count++;
      if(mode()==='standard'&&pin){
        row.classList.add('motion-pin');
        const a=play(row,[{transform:`translateY(${dy}px) scale(1.01)`,boxShadow:'0 6px 16px #0003'},{transform:'none',boxShadow:'none'}],240);
        if(a)a.finished.catch(()=>{}).finally(()=>row.classList.remove('motion-pin'));else row.classList.remove('motion-pin');
        play(row.querySelector('.event-star'),[{scale:'.85'},{scale:'1.08',offset:.56},{scale:'1'}],210);
      }
      else if(mode()==='standard'&&old&&Math.abs(dy)>=1)play(row,[{transform:`translateY(${dy}px)`},{transform:'none'}]);
      else play(row,mode()==='standard'?[{opacity:opacity*.55,transform:'translateY(4px)'},{opacity,transform:'none'}]:[{opacity:opacity*.65},{opacity}]);
    }
  }
  function focusLayout(change){
    const frame=document.querySelector('[data-frame=calendar]');if(mode()==='off'||!frame?.checkVisibility()){change();return;}
    const modules=[...document.querySelectorAll('.workspace-modules > .module-frame:not([data-frame=calendar]),.page-heading')];
    const snapshot=modules.filter(n=>n.checkVisibility()).map(n=>[n,n.getBoundingClientRect()]);
    const from=frame.getBoundingClientRect();
    frame.getAnimations().forEach(animation=>animation.cancel());
    change();const to=frame.getBoundingClientRect(),dy=from.top-to.top;
    const viewport={left:0,top:0,right:innerWidth,bottom:innerHeight};
    if(mode()==='standard'&&Math.abs(dy)>1)play(frame,[{transform:`translateY(${dy}px)`,clipPath:`inset(0 0 ${Math.max(0,to.height-from.height)}px 0)`},{transform:'none',clipPath:'inset(0 0 0 0)'}],275,{easing:'cubic-bezier(.65,0,.25,1)'});
    snapshot.filter(([n])=>!n.checkVisibility()).slice(0,5).forEach(([n,r],i)=>phantom(n,r,viewport,mode()==='reduced'?[{opacity:.75},{opacity:0}]:[{opacity:1,clipPath:'inset(0 0 0 0)'},{opacity:0,clipPath:'inset(0 0 100% 0)'}],175,{delay:mode()==='standard'?i*24:0}));
    modules.filter(n=>n.checkVisibility()&&!snapshot.some(([old])=>old===n)).slice(0,5).forEach((n,i)=>play(n,mode()==='reduced'?[{opacity:.65},{opacity:1}]:[{opacity:0,transform:'translateY(-6px)'},{opacity:1,transform:'none'}],180,{delay:mode()==='standard'?i*24:0,fill:'backwards'}));
  }
  function locate(row){
    stopEntrance();row.scrollIntoView({block:'nearest',inline:'nearest',behavior:mode()==='standard'?'smooth':'instant'});
    const target=row.querySelector('.event-name')||row;
    target.focus({preventScroll:true});
    for(const n of document.querySelectorAll('.motion-located'))n.classList.remove('motion-located');
    row.classList.add('motion-located');
    if(mode()==='standard')play(row.querySelector('.event-bar')||row,[{filter:'brightness(1)'},{filter:'brightness(1.23)',offset:.35},{filter:'brightness(1)'}],560,{delay:140});
    clearTimeout(locateTimer);
    locateTimer=setTimeout(()=>row.classList.remove('motion-located'),1450);
  }
  function feedback(node) {if(!node)return;const opacity=Number(getComputedStyle(node).opacity);play(node,[{opacity:opacity*.55},{opacity}]);}
  function focusKey(node) {
    if(!node?.matches?.('button,input,select,textarea,a'))return null;
    const attributes=['data-event-star','data-event','data-plan','id'];
    const key=attributes.find(name=>node.hasAttribute(name));
    return key?node.tagName.toLowerCase()+(node.classList[0]?'.'+CSS.escape(node.classList[0]):'')+`[${key}="${CSS.escape(node.getAttribute(key))}"]`:null;
  }
  function opened(dialog) {
    if(!dialogs.has(dialog)) {
      dialogs.set(dialog,{});
      dialog.addEventListener('close',()=>{
        const saved=dialogs.get(dialog);
        queueMicrotask(()=>{
          if(document.querySelector('dialog[open]'))return;
          if(document.activeElement!==document.body&&!dialog.contains(document.activeElement)&&document.activeElement!==saved.node)return;
          const target=saved.node?.isConnected?saved.node:saved.key?document.querySelector(saved.key):null;
          if(target?.checkVisibility()&&!target.disabled)target.focus({preventScroll:true});
        });
      });
    }
    if(!dialog.open)dialogs.set(dialog,{node:document.activeElement,key:focusKey(document.activeElement)});
  }
  function stages(statuses) {
    const running=statuses.filter(s=>s.running),done=!running.length&&statuses.length>0&&statuses.every(s=>s.result?.calendar&&!s.error);
    if(!running.length&&!done)return '';
    const names=['fetch','parse','images'],labels=['读取公告','整理日期','补充头图','完成'];
    // Multiple games may be in different stages: show the least advanced running stage.
    const current=running.length?Math.min(...running.map(s=>Math.max(0,names.indexOf(s.stage?.name)))):3;
    const waiting=running.some(s=>s.waiting);
    return '<ol class="sync-stage-strip" aria-label="同步阶段">'+labels.map((label,i)=>{
      const state=i<current||done?'done':i===current?(waiting?'waiting':'current'):'pending';
      return `<li data-stage="${names[i]||'done'}" data-state="${state}"${i===current?' aria-current="step"':''}><span aria-hidden="true">${state==='done'?'✓':state==='waiting'?'⏸':state==='current'?'●':'○'}</span>${label}</li>`;
    }).join('')+'</ol>';
  }
  return {configure,capture,layout,feedback,opened,stages,settle,enterTimeline,stopEntrance,focusLayout,locate,planSaved:id=>{planId=id;},get mode(){return mode();}};
})();
