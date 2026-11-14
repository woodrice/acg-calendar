'use strict';
/* Session-only task navigation. Dialog origins and drafts never enter provider or backup data. */
window.PlaytimeJourney = (() => {
  const $=s=>document.querySelector(s), stack=[], hooks=new WeakMap(), silent=new WeakMap();
  let current=null, root=null, pending=null, notify=()=>{}, historyBack=false, fromHistory=false;
  const newId=()=>[...crypto.getRandomValues(new Uint8Array(16))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const session=newId(),depth=()=>stack.length+(current?1:0);
  const browserHistory=new URLSearchParams(location.search).get('shell')!=='android';
  const stamp=()=>({...history.state,playtimeTask:{session,depth:depth()}});
  function pushed(){if(browserHistory&&!fromHistory&&!historyBack)history.pushState(stamp(),'');}
  function stepped(count=1){if(browserHistory&&!fromHistory&&!historyBack){historyBack=true;history.go(-count);}}
  const selector=node=>{
    if(!node?.matches?.('button,input,select,textarea,a,summary,[tabindex]'))return null;
    if(node.id)return '#'+CSS.escape(node.id);
    const a=[...node.attributes].filter(a=>a.name.startsWith('data-'));
    return a.length?node.tagName.toLowerCase()+a.map(a=>`[${a.name}="${CSS.escape(a.value)}"]`).join(''):null;
  };
  function scrollKey(node){
    const parts=[];
    for(let n=node;n?.nodeType===1;n=n.parentElement){
      if(n.id){parts.unshift('#'+CSS.escape(n.id));break;}
      parts.unshift(n.tagName.toLowerCase()+':nth-child('+([...n.parentElement?.children||[]].indexOf(n)+1)+')');
    }
    return parts.join(' > ');
  }
  function snapshot(scope=document){
    const node=document.activeElement;
    return {scope,node,key:selector(node),scroll:[...(scope===document?[]:[scope]),...scope.querySelectorAll('*')].filter(n=>n.scrollTop||n.scrollLeft||/(auto|scroll)/.test(getComputedStyle(n).overflow)).map(n=>[n,scrollKey(n),n.scrollTop,n.scrollLeft]),x:scrollX,y:scrollY};
  }
  function restore(saved){
    if(!saved)return;
    for(const [node,key,top,left]of saved.scroll){const target=node.isConnected?node:saved.scope.querySelector(key);if(target){target.scrollTop=top;target.scrollLeft=left;}}
    window.scrollTo(saved.x,saved.y);
    const target=saved.node?.isConnected?saved.node:saved.key?saved.scope.querySelector(saved.key):null;
    if(target?.checkVisibility()&&!target.disabled&&!target.closest('[inert]'))target.focus({preventScroll:true});
    else{const fallback=current?.querySelector('h2')||$('#toast:not([hidden]) .toast-action')||$('#calendar');if(fallback){if(!fallback.matches('button,input,select,textarea,a'))fallback.tabIndex=-1;fallback.focus({preventScroll:true});}}
  }
  function hide(dialog){if(!dialog?.open)return;silent.set(dialog,(silent.get(dialog)||0)+1);dialog.close();}
  function open(dialog){
    if(current===dialog&&dialog.open)return;
    if(stack.some(x=>x.dialog===dialog)){
      const before=depth();fromHistory=true;try{while(current!==dialog)close();}finally{fromHistory=false;}stepped(before-depth());return;
    }
    // Existing direct native dialogs are also valid origins (e.g. the reminders inbox).
    const origin=current?.open?current:$('dialog[open]');
    if(origin&&origin!==dialog){stack.push({dialog:origin,saved:snapshot(origin)});hide(origin);}
    else if(!origin&&!stack.length)root=snapshot();
    current=dialog;window.PlaytimeMotion.opened(dialog);
    if(!dialog.open)dialog.showModal();
    const back=stack.length?hooks.get(stack.at(-1).dialog)?.label:null;
    for(const b of dialog.querySelectorAll('[data-close]')){b.title=back?'返回'+back:'关闭';b.setAttribute('aria-label',b.title);}
    pushed();
  }
  function returned(){
    const parent=stack.pop();
    if(parent){current=parent.dialog;parent.dialog.showModal();hooks.get(parent.dialog)?.refresh?.();restore(parent.saved);}
    else{current=null;restore(root);root=null;}
  }
  function close(dialog=current){
    if(!dialog)return;
    if(dialog===current){hide(dialog);hooks.get(dialog)?.closed?.();current=null;returned();stepped();}
    else dialog.close();
  }
  function clear(){
    const count=depth();
    pending=null;$('#discard-draft-dialog')?.close();
    for(const d of document.querySelectorAll('dialog[open]'))hide(d);
    for(const d of [...stack.map(x=>x.dialog),current])if(d)hooks.get(d)?.closed?.();
    stack.length=0;current=null;root=null;
    if(count)stepped(count);
  }
  function leave(action,dialog=current){
    if(!dialog)return;
    const guard=hooks.get(dialog);
    if(guard?.busy?.()){notify('正在保存，请稍候');return;}
    if(guard?.dirty?.()){
      pending={dialog,action};const prompt=$('#discard-draft-dialog');prompt.showModal();$('#keep-draft').focus();return;
    }
    action();
  }
  function requestClose(dialog=current){leave(()=>close(dialog),dialog);}
  const tasks=()=>[...stack.map(x=>x.dialog),current].filter(Boolean);
  function leaveAll(action){
    if(tasks().some(d=>hooks.get(d)?.busy?.())){notify('正在保存，请稍候');return;}
    const dirty=tasks().find(d=>hooks.get(d)?.dirty?.());
    if(dirty)leave(()=>{for(const d of tasks())hooks.get(d)?.discard?.();action();},dirty);
    else action();
  }
  function init({toast}){
    notify=toast;
    document.body.insertAdjacentHTML('beforeend','<dialog id="discard-draft-dialog" class="feature-dialog draft-confirm" aria-labelledby="discard-draft-title" aria-describedby="discard-draft-description"><div class="dialog-header"><h2 id="discard-draft-title">放弃未保存的改动？</h2></div><div class="dialog-body"><p id="discard-draft-description">改动尚未保存，返回后会丢弃本次输入。</p><div class="draft-confirm-actions"><button id="keep-draft" type="button" class="button button-primary">继续编辑</button><button id="discard-draft" type="button" class="button">放弃并返回</button></div></div></dialog>');
    document.addEventListener('close',e=>{
      const d=e.target,count=silent.get(d)||0;
      if(count){silent.set(d,count-1);e.stopImmediatePropagation();return;}
      if(d===current){hooks.get(d)?.closed?.();current=null;returned();stepped();}
    },true);
    document.addEventListener('cancel',e=>{
      if(e.target.id==='discard-draft-dialog'){pending=null;return;}
      if(e.target===current){e.preventDefault();requestClose(e.target);}
    },true);
    document.addEventListener('click',e=>{
      if(e.target.closest('#keep-draft')){const d=pending?.dialog;pending=null;$('#discard-draft-dialog').close();[...d?.querySelectorAll('input,textarea,select')||[]].find(n=>n.checkVisibility()&&!n.disabled)?.focus({preventScroll:true});return;}
      if(e.target.closest('#discard-draft')){const task=pending;pending=null;$('#discard-draft-dialog').close();if(task){hooks.get(task.dialog)?.discard?.();task.action();}return;}
      const b=e.target.closest('[data-close]');
      if(b&&b.closest('dialog')===current){e.preventDefault();e.stopImmediatePropagation();requestClose(current);return;}
      if(e.target===current){const r=current.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom){e.preventDefault();e.stopImmediatePropagation();requestClose(current);}}
    },true);
    window.addEventListener('popstate',()=>{
      if(!browserHistory)return;
      const task=history.state?.playtimeTask,target=task?.session===session?task.depth:0;
      if(historyBack){historyBack=false;if(depth()!==target)pushed();return;}
      if(target>=depth()){history.replaceState(stamp(),'');return;} // Forward never resurrects a saved/discarded form.
      const leaving=[...stack.map(x=>x.dialog),current].slice(target),guarded=leaving.find(d=>hooks.get(d)?.dirty?.()||hooks.get(d)?.busy?.());
      if(guarded){pushed();leave(()=>{for(const d of leaving)hooks.get(d)?.discard?.();fromHistory=true;try{while(depth()>target)close();}finally{fromHistory=false;}stepped();},guarded);return;}
      fromHistory=true;try{while(depth()>target)close();}finally{fromHistory=false;}
    });
    window.addEventListener('beforeunload',e=>{if([...stack.map(x=>x.dialog),current].some(d=>d&&(hooks.get(d)?.dirty?.()||hooks.get(d)?.busy?.()))){e.preventDefault();e.returnValue='';}});
  }
  return {init,open,close,clear,requestClose,leave,leaveAll,newId,register:(d,h)=>hooks.set(typeof d==='string'?$(d):d,h),snapshot,restore,get hasDraft(){return tasks().some(d=>hooks.get(d)?.dirty?.()||hooks.get(d)?.busy?.());},get parent(){return stack.at(-1)?.dialog||null;}};
})();
