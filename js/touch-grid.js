/** Pointer-only touch routing. Pending taps never change the score before release. */
export function createTouchGridController({
  getMode=()=> 'pan',getViewport,transform,
  beginEdit=()=>{},moveEdit=()=>{},endEdit=()=>{},cancelEdit=()=>{},
  slop=8,minCell=1,maxCell=80
}={}) {
  if(typeof getViewport!=='function'||typeof transform!=='function')throw new TypeError('Touch grid requires viewport and transform callbacks.');
  const contacts=new Map();
  let phase='idle',origin=null,panOrigin=null,pinchOrigin=null;
  const position=event=>({x:event.clientX,y:event.clientY,event});
  const geometry=()=>{
    const [a,b]=contacts.values();
    return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,distance:Math.hypot(a.x-b.x,a.y-b.y)};
  };
  function startPinch(event) {
    if(phase==='edit')cancelEdit(event);
    const point=geometry(),view=getViewport();
    pinchOrigin={...point,...view,anchorX:(view.scrollLeft+point.x-view.left)/view.cell,anchorY:view.scrollTop+point.y-view.top};
    phase='pinch';origin=null;panOrigin=null;
  }
  function reset(event) {
    if(phase==='edit')cancelEdit(event||origin);
    contacts.clear();phase='idle';origin=null;panOrigin=null;pinchOrigin=null;
  }
  function down(event) {
    if(event.pointerType!=='touch')return false;
    if(contacts.has(event.pointerId))return true;
    contacts.set(event.pointerId,position(event));
    if(contacts.size===1){
      origin=event;
      if(getMode()==='edit')phase='pending';
      else {phase='pan';panOrigin={...getViewport(),x:event.clientX,y:event.clientY};}
    }else if(contacts.size===2)startPinch(event);
    // Additional contacts freeze the current transform until two remain.
    return true;
  }
  function move(event) {
    if(!contacts.has(event.pointerId))return false;
    contacts.set(event.pointerId,position(event));
    if(contacts.size>2)return true;
    if(phase==='pinch'&&contacts.size===2){
      const point=geometry(),base=pinchOrigin;
      const cell=Math.min(maxCell,Math.max(minCell,base.cell*point.distance/Math.max(1,base.distance)));
      transform({cell,scrollLeft:Math.max(0,base.anchorX*cell-point.x+base.left),scrollTop:Math.max(0,base.anchorY-point.y+base.top)});
    }else if(phase==='pan'){
      transform({cell:panOrigin.cell,scrollLeft:Math.max(0,panOrigin.scrollLeft+panOrigin.x-event.clientX),scrollTop:Math.max(0,panOrigin.scrollTop+panOrigin.y-event.clientY)});
    }else if(phase==='pending'){
      if(Math.hypot(event.clientX-origin.clientX,event.clientY-origin.clientY)>slop){phase='edit';beginEdit(origin);moveEdit(event);}
    }else if(phase==='edit')moveEdit(event);
    return true;
  }
  function finish(event,cancelled) {
    if(!contacts.has(event.pointerId))return false;
    const was=phase;
    contacts.delete(event.pointerId);
    if(was==='pending'&&!cancelled){beginEdit(origin);endEdit(event);}
    else if(was==='edit'){if(cancelled)cancelEdit(event);else endEdit(event);}
    if(!contacts.size){phase='idle';origin=null;panOrigin=null;pinchOrigin=null;}
    else if(contacts.size===2&&was==='pinch')startPinch(event);
    else {phase='blocked';origin=null;panOrigin=null;pinchOrigin=null;}
    return true;
  }
  return {down,move,up:event=>finish(event,false),cancel:event=>finish(event,true),reset};
}
