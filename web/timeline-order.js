'use strict';
/* A drag is only a visual preview; the host owns validated workspace order. */
window.PlaytimeOrder=(()=>{
  let H,root,pending=null,drag=null,saving=false,blockedClick=null;
  const M=window.PlaytimeMotion;
  const handleSelector='.event-bar,.point-marker,[data-order-handle]';
  function enabled(){return H?.enabled()&&!saving&&!document.querySelector('dialog[open]');}
  function blocks(row){
    const group=row.dataset.orderGroup,by=new Map();
    for(const item of root.querySelectorAll('[data-order-root]')){
      if(item.dataset.orderGroup!==group)continue;
      const id=item.dataset.orderRoot;
      if(!by.has(id))by.set(id,{id,rows:[]});
      by.get(id).rows.push(item);
    }
    return [...by.values()];
  }
  function clearPending(){if(pending){clearTimeout(pending.timer);pending=null;}}
  function down(e){
    const handle=e.target.closest(handleSelector),row=handle?.closest('[data-row-event]');
    if(!row||row.dataset.rowEvent!==row.dataset.orderRoot||!enabled()||drag||e.button!==0||!e.isPrimary)return;
    if(e.pointerType==='touch'&&!handle.hasAttribute('data-order-handle'))return;
    clearPending();M.stopEntrance();
    pending={handle,row,pointer:e.pointerId,x:e.clientX,y:e.clientY,key:H.key(),timer:setTimeout(lift,340)};
  }
  function lift(){
    const p=pending;clearPending();
    if(!p?.handle.isConnected||!enabled()||p.key!==H.key())return;
    const groups=blocks(p.row);if(groups.length<2)return;
    const scroller=p.row.closest('.timeline-scroll');if(!scroller)return;
    M.settle(root);
    const scrollTop=scroller.scrollTop,winTop=scrollY;
    for(const group of groups){
      const first=group.rows[0].getBoundingClientRect(),last=group.rows.at(-1).getBoundingClientRect();
      group.top=first.top;group.height=last.bottom-first.top;
    }
    const block=groups.find(g=>g.id===p.row.dataset.rowEvent);if(!block)return;
    try{p.handle.setPointerCapture(p.pointer);}catch{return;}
    drag={...p,groups,block,scroller,scrollTop,winTop,lastY:p.y,index:groups.indexOf(block),frame:0};
    root.classList.add('ordering-timeline');block.rows.forEach(n=>n.classList.add('order-lifted'));
    H.announce('已拿起活动。上下拖动，松手放置，Esc 取消。');
    drag.frame=requestAnimationFrame(tick);
  }
  function position(d){
    const scrolled=d.scroller.scrollTop-d.scrollTop+scrollY-d.winTop;
    const start=d.groups[0].top,end=d.groups.at(-1).top+d.groups.at(-1).height;
    const y=Math.max(start,Math.min(end-d.block.height,d.block.top+d.lastY-d.y+scrolled));
    const peers=d.groups.filter(g=>g!==d.block),center=d.block.top+d.lastY-d.y+scrolled+d.block.height/2;
    const index=peers.filter(g=>center>g.top+g.height/2).length;
    const ordered=[...peers.slice(0,index),d.block,...peers.slice(index)];
    let top=start;
    for(const group of ordered){
      const offset=(group===d.block?y:top)-group.top;
      for(const row of group.rows)row.style.translate=`0 ${offset}px`;
      top+=group.height;
    }
    if(index!==d.index||!d.marker){
      d.marker?.classList.remove('order-insert-before','order-insert-after');
      d.marker=index<peers.length?peers[index].rows[0]:peers.at(-1).rows.at(-1);
      d.marker.classList.add(index<peers.length?'order-insert-before':'order-insert-after');
    }
    d.index=index;
  }
  function tick(){
    if(!drag)return;
    const d=drag,box=d.scroller.getBoundingClientRect(),head=d.scroller.querySelector('.timeline-head');
    const top=Math.max(0,box.top,head?.getBoundingClientRect().bottom||0),bottom=Math.min(innerHeight,box.bottom);
    if(d.moved&&bottom-top>60){
      const pace=d.lastY<top+34?-8:d.lastY>bottom-34?8:0;
      if(pace){const prev=d.scroller.scrollTop;d.scroller.scrollTop+=pace;
        if(prev===d.scroller.scrollTop&&d.scroller.scrollHeight<=d.scroller.clientHeight)window.scrollBy(0,pace);
        position(d);
      }
    }
    d.frame=requestAnimationFrame(tick);
  }
  function move(e){
    if(pending?.pointer===e.pointerId&&Math.hypot(e.clientX-pending.x,e.clientY-pending.y)>8)clearPending();
    if(drag?.pointer!==e.pointerId)return;
    e.preventDefault();drag.lastY=e.clientY;
    if(Math.abs(e.clientY-drag.y)>=5)drag.moved=true;
    if(drag.moved)position(drag);
  }
  function cleanup(d){
    d.marker?.classList.remove('order-insert-before','order-insert-after');
    for(const group of d.groups)for(const row of group.rows){row.style.translate='';row.classList.remove('order-lifted');}
    root.classList.remove('ordering-timeline');
  }
  async function finish(commit,render=true){
    clearPending();if(!drag)return;
    const d=drag;drag=null;cancelAnimationFrame(d.frame);
    if(d.handle.hasPointerCapture(d.pointer))d.handle.releasePointerCapture(d.pointer);
    blockedClick={handle:d.handle,until:performance.now()+320};
    const before=d.groups.map(g=>g.id),from=before.indexOf(d.block.id);
    if(!commit||!d.moved||from===d.index||d.key!==H.key()){
      cleanup(d);H.announce(commit?'顺序未改变':'已取消拖动');if(render)H.render();return;
    }
    const after=before.slice();after.splice(from,1);after.splice(d.index,0,d.block.id);
    saving=true;
    try{await H.save(before,after);}
    finally{cleanup(d);saving=false;H.render();}
  }
  async function step(handle,direction){
    const row=handle.closest('[data-row-event]');if(!row||row.dataset.rowEvent!==row.dataset.orderRoot||!enabled()||drag)return;
    const order=blocks(row).map(b=>b.id),from=order.indexOf(row.dataset.rowEvent),to=from+direction;
    if(to<0||to>=order.length){H.announce('已到本组边界');return;}
    const next=order.slice();next.splice(to,0,next.splice(from,1)[0]);
    saving=true;try{await H.save(order,next);}finally{saving=false;}
  }
  function init(host){
    H=host;root=document.querySelector('#calendar');
    root.addEventListener('pointerdown',down);
    root.addEventListener('focusin',M.stopEntrance);
    document.addEventListener('pointermove',move,{passive:false});
    document.addEventListener('pointerup',e=>{if(drag?.pointer===e.pointerId){e.preventDefault();finish(true);}else if(pending?.pointer===e.pointerId)clearPending();},true);
    for(const name of ['pointercancel','lostpointercapture'])document.addEventListener(name,e=>{if(drag?.pointer===e.pointerId)finish(false);else if(pending?.pointer===e.pointerId)clearPending();},true);
    root.addEventListener('contextmenu',e=>{if(drag||pending)e.preventDefault();});
    document.addEventListener('click',e=>{
      const handle=e.target.closest(handleSelector);
      if(handle&&blockedClick?.handle===handle&&performance.now()<blockedClick.until){blockedClick=null;e.preventDefault();e.stopImmediatePropagation();}
    },true);
    document.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&(drag||pending)){e.preventDefault();e.stopImmediatePropagation();finish(false);return;}
      const handle=e.target.closest?.(handleSelector);
      if(handle?.hasAttribute('aria-keyshortcuts')&&root.contains(handle)&&e.altKey&&['ArrowUp','ArrowDown'].includes(e.key)&&enabled()){e.preventDefault();step(handle,e.key==='ArrowUp'?-1:1);}
    },true);
    window.addEventListener('blur',()=>finish(false));window.addEventListener('resize',()=>finish(false));
  }
  return {init,cancel:()=>finish(false,false),get holding(){return !!drag;},matches:()=>!drag||drag.key===H.key()};
})();
