import {MAX_LAYERS} from './model.js';
import {applyLayerOperation} from './layer-tools.js';

const ROW = 32;
const clamp = (value,min,max) => Math.min(max,Math.max(min,value));
const fields = {volume:[0,100],pan:[-100,100],reverb:[0,100]};
const actions = [['locked','锁定音轨'],['solo','独奏本轨'],['select','选择本轨所有音符'],['insert','在此插入空轨'],['delete','删除本轨'],['up','上移本轨'],['down','下移本轨']];

/** Clamp the DOM window rather than rendering a project-sized list. */
export function nativeLayerRange(length,start=0,end=length) {
  const count=Math.max(0,Math.trunc(Number(length)||0));
  const first=clamp(Math.trunc(Number(start)||0),0,count);
  return {start:first,end:clamp(Math.trunc(Number(end)||0),first,count)};
}

/** Stage allocations and validation before recording history or mutating the real song. */
export function applyNativeLayerEdit(song,{index,operation,value}={},beforeChange=()=>{}) {
  if(!song||!Array.isArray(song.layers)||!Array.isArray(song.notes)||!Number.isInteger(index)||index<0||index>=song.layers.length)throw new Error('当前音轨无效。');
  const layer=song.layers[index];
  if(operation==='name'||Object.hasOwn(fields,operation)||['muted','solo','locked'].includes(operation)) {
    let next;
    if(operation==='name')next=String(value??'').slice(0,200);
    else if(Object.hasOwn(fields,operation)){
      const number=Number(value);if(!Number.isFinite(number))throw new Error('音轨数值必须是有限数字。');
      next=clamp(Math.round(number),...fields[operation]);
    }else next=!!value;
    if((layer[operation]??(operation==='volume'?100:operation==='name'?'':operation==='pan'||operation==='reverb'?0:false))===next)return {changed:false,layer:index};
    beforeChange();layer[operation]=next;return {changed:true,layer:index};
  }
  let result,draft={...song};
  if(operation==='delete') {
    if(song.layers.length===1)throw new Error('必须保留至少一条音轨。');
    if(layer.locked)throw new Error('请先解锁需要删除的音轨。');
    for(const note of song.notes)if(!Number.isInteger(note.layer)||note.layer<0||note.layer>=song.layers.length)throw new Error('项目包含无效图层引用。');
    draft.layers=song.layers.filter((_,i)=>i!==index).map((item,id)=>({...item,id}));
    draft.notes=[];
    for(const note of song.notes)if(note.layer!==index)draft.notes.push(note.layer>index?{...note,layer:note.layer-1}:note);
    result={changed:true,layer:Math.min(index,draft.layers.length-1)};
  } else result=applyLayerOperation(draft,{index,operation});
  if(!result.changed)return result;
  beforeChange();song.layers=draft.layers;song.notes=draft.notes;return result;
}

/** A drag paints a single target state and visits each layer identity at most once.
 * Structural edits clone/reindex the staged rows, so tokens follow their ownership.
 */
export function createNativeLayerBrush(h,{operation,index}={}) {
  const song=h.getSong(),state=h.getState();
  if(!actions.some(([name])=>name===operation)||!song.layers[index])throw new Error('图层拖刷操作无效。');
  const tokens=song.layers.map(()=>({})),identities=new WeakMap(),visited=new Set();
  const bind=()=>song.layers.forEach((layer,i)=>identities.set(layer,tokens[i]));bind();
  const notesByLayer=new Map();if(operation==='select')for(const note of song.notes){if(!notesByLayer.has(note.layer))notesByLayer.set(note.layer,[]);notesByLayer.get(note.layer).push(note);}
  const initialNotes=notesByLayer.get(index)||[];
  const target=operation==='select'?!(initialNotes.length>0&&initialNotes.every(note=>state.selected.has(note.id))):!song.layers[index][operation];
  let checkpointed=false,changed=false;
  const checkpoint=()=>{if(!checkpointed){h.checkpoint();checkpointed=true;}};
  return {
    visit(index){
      if(h.getSong()!==song||!Number.isInteger(index)||index<0||index>=song.layers.length)return {changed:false,layer:state.layer};
      const layer=song.layers[index],token=identities.get(layer);if(!token||visited.has(token))return {changed:false,layer:state.layer};visited.add(token);
      if(operation==='select'){
        let selectionChanged=false;
        for(const note of notesByLayer.get(index)||[]){const selected=state.selected.has(note.id);if(selected!==target){selectionChanged=true;if(target)state.selected.add(note.id);else state.selected.delete(note.id);}}
        if(selectionChanged){state.layer=index;changed=true;}return {changed:selectionChanged,layer:index,selection:true};
      }
      if(operation==='insert'&&song.layers.length>=MAX_LAYERS||operation==='delete'&&(layer.locked||song.layers.length===1)||operation==='up'&&(index===0||layer.locked||song.layers[index-1]?.locked)||operation==='down'&&(index===song.layers.length-1||layer.locked||song.layers[index+1]?.locked))return {changed:false,layer:state.layer};
      const result=applyNativeLayerEdit(song,{index,operation,value:target},checkpoint);
      if(!result.changed)return result;
      if(operation==='insert'){const inserted={};tokens.splice(index,0,inserted);visited.add(inserted);}
      else if(operation==='delete')tokens.splice(index,1);
      else if(operation==='up'||operation==='down'){const other=index+(operation==='up'?-1:1);[tokens[index],tokens[other]]=[tokens[other],tokens[index]];}
      if(['insert','delete','up','down'].includes(operation))bind();state.layer=result.layer;changed=true;return result;
    },
    get changed(){return changed;},
    get savesProject(){return changed&&operation!=='select';}
  };
}

function rowMarkup(index) {
  return `<div class="native-layer-name-cell"><input class="native-layer-name" data-native-name maxlength="200" aria-label="音轨 ${index+1} 名称"><button class="native-layer-mix" data-layer-action="mix" title="静音与独立混响">⋯</button></div>`+
    ['volume','pan'].map(property=>`<button class="native-layer-meter native-layer-${property}" data-layer-action="${property}"><span class="native-meter-glyph" aria-hidden="true"></span><small></small></button>`).join('')+
    actions.map(([action,label])=>`<button class="native-layer-action nli-${action}" data-layer-action="${action}" aria-label="${label}" title="${label}"><span aria-hidden="true"></span></button>`).join('');
}

/** Dense original-style rows; the caller supplies the editor's one history/save pipeline. */
export function createNativeLayerUI(h) {
  const document=h.document||globalThis.document;
  const pane=document.getElementById('layerPane'),stack=document.getElementById('layerStack'),gridScroll=document.getElementById('gridScroll');
  if(!pane||!stack)throw new Error('找不到音轨面板。');
  const view=document.defaultView||globalThis,rows=new Map(),removers=[];
  let lastRender={start:0,end:0,scrollTop:0,counts:new Map()},popup=null,popupContext=null,drag=null,brush=null,nameSession=null,suppressClick=0,destroyed=false,touchPan=null;
  const touchContacts=new Set();
  const listen=(target,type,callback,options)=>{target.addEventListener(type,callback,options);removers.push(()=>target.removeEventListener(type,callback,options));};
  const report=error=>h.error?.(error);
  const safe=fn=>(...args)=>{try{return fn(...args);}catch(error){report(error);}};
  const editable=()=>{if(h.isBusy?.()||h.getState().busy||h.engine?._benchmarking)throw new Error('请先结束当前操作或退出播放器模式。');};
  const current=session=>session&&session.song===h.getSong()&&session.layer===session.song.layers[session.index];
  const rowOf=target=>target?.closest?.('.native-layer-row');
  const sessionFor=index=>({song:h.getSong(),index,layer:h.getSong().layers[index],changed:false,checkpointed:false});
  const checkpoint=session=>{if(!session.checkpointed){h.checkpoint();session.checkpointed=true;}};
  function paintRow(record,index,counts=lastRender.counts) {
    const {element}=record,layer=h.getSong().layers[index],state=h.getState();if(!layer)return;
    element.classList.toggle('selected',state.layer===index);element.classList.toggle('is-muted',!!layer.muted);
    element.setAttribute('aria-label',`音轨 ${index+1}，${layer.name||'未命名'}，${counts?.get?.(index)||0} 个音符`);
    const input=element.querySelector('[data-native-name]');
    if(document.activeElement!==input)input.value=layer.name||'';
    input.placeholder=`第 ${index+1} 层`;input.title=layer.name||input.placeholder;
    const mix=element.querySelector('[data-layer-action="mix"]');mix.textContent=layer.muted?'M':Math.round(layer.reverb||0)>0?String(Math.round(layer.reverb)):'⋯';
    mix.classList.toggle('active',!!layer.muted||Number(layer.reverb)>0);mix.title=`静音与独立混响 · 混响 ${Math.round(layer.reverb||0)}%${layer.muted?' · 已静音':''}`;mix.setAttribute('aria-label',`音轨 ${index+1} 静音与混响设置`);
    for(const property of ['volume','pan']){
      const value=Number(layer[property]??(property==='volume'?100:0)),button=element.querySelector(`[data-layer-action="${property}"]`);
      const text=property==='volume'?`${value}%`:value===0?'C':`${value<0?'L':'R'}${Math.abs(value)}`;
      button.querySelector('small').textContent=text;button.title=`${property==='volume'?'音量':'声像'} ${text}，上下拖动调整，Shift 精细调整；点击打开滑块`;
      button.setAttribute('aria-label',`音轨 ${index+1} ${button.title}`);
      const frame=property==='volume'?2+Math.min(3,Math.floor(value/30)):2+Math.floor((value+100)/50);
      const image=new URL(`../assets/original/${property==='volume'?'volume':'stereo'}-meter/${String(frame).padStart(2,'0')}-frame-${frame}.png`,import.meta.url);
      button.style.setProperty('--meter-fill',`url("${image.href}")`);
    }
    for(const [action]of actions){
      const button=element.querySelector(`[data-layer-action="${action}"]`);
      const active=action==='select'?false:!!layer[action];button.classList.toggle('active',active);
      if(['locked','solo'].includes(action))button.setAttribute('aria-pressed',String(active));
      button.disabled=action==='up'?(index===0||layer.locked||h.getSong().layers[index-1]?.locked):action==='down'?(index===h.getSong().layers.length-1||layer.locked||h.getSong().layers[index+1]?.locked):action==='delete'?(h.getSong().layers.length===1||layer.locked):action==='insert'?h.getSong().layers.length>=MAX_LAYERS:false;
    }
  }
  function render(options={}) {
    if(destroyed)return;lastRender={...lastRender,...options};
    const song=h.getSong(),range=nativeLayerRange(song.layers.length,lastRender.start,lastRender.end);
    stack.style.transform=`translateY(${-Math.max(0,Number(lastRender.scrollTop)||0)}px)`;stack.style.height=`${song.layers.length*ROW}px`;
    for(const [index,record]of rows){
      const focused=record.element.contains(document.activeElement);
      if(record.song!==song||record.layer!==song.layers[index]||((index<range.start||index>=range.end)&&!focused)){
        record.element.remove();rows.delete(index);
      }
    }
    for(let index=range.start;index<range.end;index++){
      let record=rows.get(index);
      if(!record){const element=document.createElement('div');element.className='layer-row native-layer-row';element.dataset.layer=String(index);element.style.top=`${index*ROW}px`;element.innerHTML=rowMarkup(index);record={element,song,layer:song.layers[index]};rows.set(index,record);stack.append(element);}
      paintRow(record,index);
    }
    if(popupContext&&!current(popupContext))closePopup();
  }
  function updateLive(session,property,value){
    editable();if(!current(session))return false;
    const result=applyNativeLayerEdit(session.song,{index:session.index,operation:property,value},()=>checkpoint(session));
    if(result.changed){session.changed=true;if(property!=='name')h.engine?.updateTrackParams(session.song);h.persist();const row=rows.get(session.index);if(row)paintRow(row,session.index);h.scheduleDraw();}
    return result.changed;
  }
  function finishLive(session){if(current(session)&&session.changed){session.changed=false;h.refresh({inspector:false,save:true});}}
  function closePopup(){if(popupContext)finishLive(popupContext);popup?.remove();popup=null;popupContext=null;}
  function openPopup(index,anchor,focusProperty='volume'){
    closePopup();editable();const session=sessionFor(index),layer=session.layer;h.getState().layer=index;popupContext=session;
    popup=document.createElement('div');popup.className='native-layer-popover';popup.setAttribute('role','dialog');popup.setAttribute('aria-label',`音轨 ${index+1} 混音设置`);
    popup.innerHTML=`<div class="native-layer-popover-heading"><strong>音轨 ${index+1}</strong><button data-popup-close aria-label="关闭音轨混音设置">×</button></div>`+
      Object.keys(fields).map(property=>`<label>${({volume:'音量',pan:'声像',reverb:'独立混响'})[property]}<output data-output="${property}"></output><input type="range" data-mix-field="${property}" min="${fields[property][0]}" max="${fields[property][1]}" step="1" value="${Number(layer[property]??(property==='volume'?100:0))}" aria-label="${({volume:'音轨音量',pan:'音轨声像',reverb:'本轨独立混响百分比'})[property]}"></label>`).join('')+
      `<label class="native-layer-mute-label"><input type="checkbox" data-mix-mute ${layer.muted?'checked':''}>静音本轨</label><div class="native-layer-popover-actions">${actions.map(([action,label])=>`<button data-popup-action="${action}" ${action==='delete'&&(layer.locked||session.song.layers.length===1)||action==='up'&&index===0||action==='down'&&index===session.song.layers.length-1?'disabled':''}>${label}</button>`).join('')}</div><button data-popup-settings>名称、锁定与更多设置…</button>`;
    document.body.append(popup);positionPopup(anchor);updateOutputs();
    popup.querySelector(`[data-mix-field="${focusProperty}"]`)?.focus({preventScroll:true});
    function updateOutputs(){for(const output of popup?.querySelectorAll('[data-output]')||[]){const value=Number(session.layer[output.dataset.output]??(output.dataset.output==='volume'?100:0));output.textContent=output.dataset.output==='pan'?(value===0?'中央':`${value<0?'左':'右'} ${Math.abs(value)}%`):`${value}%`;}}
    popup.addEventListener('input',safe(event=>{const property=event.target.dataset.mixField;if(property){updateLive(session,property,event.target.value);updateOutputs();}}));
    popup.addEventListener('change',safe(event=>{if(event.target.matches('[data-mix-mute]'))updateLive(session,'muted',event.target.checked);finishLive(session);session.checkpointed=false;}));
    popup.addEventListener('click',safe(event=>{const action=event.target.closest('[data-popup-action]')?.dataset.popupAction;if(action){commitAction(index,action);return;}if(event.target.closest('[data-popup-close]'))closePopup();else if(event.target.closest('[data-popup-settings]')){closePopup();h.showLayer(index);}}));
    popup.addEventListener('keydown',safe(event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closePopup();anchor?.focus?.({preventScroll:true});}else event.stopPropagation();}));
  }
  function positionPopup(anchor){if(!popup)return;const rect=anchor.getBoundingClientRect(),size=popup.getBoundingClientRect();popup.style.left=`${Math.max(4,Math.min(rect.left,view.innerWidth-size.width-4))}px`;popup.style.top=`${Math.max(4,Math.min(rect.bottom+3,view.innerHeight-size.height-4))}px`;}
  function commitAction(index,operation){
    editable();closePopup();const song=h.getSong(),state=h.getState();state.layer=index;
    if(operation==='select'){
      const notes=song.notes.filter(note=>note.layer===index),all=notes.length>0&&notes.every(note=>state.selected.has(note.id));
      for(const note of notes)if(all)state.selected.delete(note.id);else state.selected.add(note.id);
      h.refresh();return;
    }
    const result=applyNativeLayerEdit(song,{index,operation,value:!song.layers[index][operation]},()=>h.checkpoint());
    if(result.changed){state.layer=result.layer;h.refresh({save:true});}
  }
  listen(pane,'click',safe(event=>{
    if(performance.now()<suppressClick)return;const row=rowOf(event.target);if(!row)return;
    const index=Number(row.dataset.layer),action=event.target.closest('[data-layer-action]')?.dataset.layerAction;h.getState().layer=index;
    if(['mix','volume','pan'].includes(action))openPopup(index,event.target.closest('button'),action==='pan'?'pan':action==='mix'?'reverb':'volume');
    else if(action)commitAction(index,action);
    else {for(const [i,record]of rows)record.element.classList.toggle('selected',i===index);h.scheduleDraw();}
  }));
  listen(pane,'dblclick',safe(event=>{const row=rowOf(event.target);if(row&&!event.target.closest('input,button'))h.showLayer(Number(row.dataset.layer));}));
  listen(pane,'focusin',safe(event=>{if(!event.target.matches('[data-native-name]'))return;const index=Number(rowOf(event.target).dataset.layer);h.getState().layer=index;nameSession={...sessionFor(index),input:event.target,original:event.target.value};}));
  listen(pane,'input',safe(event=>{if(event.target.matches('[data-native-name]')&&nameSession?.input===event.target)updateLive(nameSession,'name',event.target.value);}));
  listen(pane,'focusout',safe(event=>{if(nameSession?.input!==event.target)return;const session=nameSession;nameSession=null;finishLive(session);}));
  listen(pane,'keydown',safe(event=>{
    if(event.target.matches('[data-native-name]')){event.stopPropagation();if(event.key==='Enter'){event.preventDefault();event.target.blur();}else if(event.key==='Escape'){event.preventDefault();if(nameSession){event.target.value=nameSession.original;updateLive(nameSession,'name',nameSession.original);}event.target.blur();}return;}
    if(event.target.closest('button')&&(event.code==='Space'||event.key==='Enter'))event.stopPropagation();
    const property=event.target.dataset.layerAction;
    if(['volume','pan'].includes(property)&&['ArrowUp','ArrowDown','Home','End'].includes(event.key)){
      event.preventDefault();event.stopPropagation();const index=Number(rowOf(event.target).dataset.layer),session=sessionFor(index),step=event.shiftKey?1:10;
      const value=event.key==='Home'?fields[property][0]:event.key==='End'?fields[property][1]:Number(session.layer[property]??(property==='volume'?100:0))+(event.key==='ArrowUp'?step:-step);
      updateLive(session,property,value);finishLive(session);
    }
  }));
  listen(pane,'pointerdown',safe(event=>{
    if(event.pointerType==='touch'){
      // Text selection stays native once the name field is already focused.
      const input=event.target.closest?.('input');if(input&&document.activeElement===input)return;
      event.preventDefault();touchContacts.add(event.pointerId);
      if(touchContacts.size===1)touchPan={pointerId:event.pointerId,x:event.clientX,y:event.clientY,scrollTop:gridScroll?.scrollTop||0,input,moved:false};
      else {touchPan=null;suppressClick=performance.now()+350;}
      // Capture only after a pan starts, so a tap keeps its button click target.
      return;
    }
    const button=event.target.closest('[data-layer-action]'),property=button?.dataset.layerAction;if(event.button!==0||!button||button.disabled)return;
    if(actions.some(([action])=>action===property)){
      editable();closePopup();event.preventDefault();const index=Number(rowOf(button).dataset.layer);
      brush={controller:createNativeLayerBrush(h,{operation:property,index}),pointerId:event.pointerId,operation:property,lastIndex:index};
      pane.setPointerCapture(event.pointerId);const result=brush.controller.visit(index);if(result.changed)h.refresh({save:brush.controller.savesProject});return;
    }
    if(!['volume','pan'].includes(property))return;
    editable();closePopup();event.preventDefault();const index=Number(rowOf(button).dataset.layer);h.getState().layer=index;
    drag={...sessionFor(index),pointerId:event.pointerId,property,startY:event.clientY,startX:event.clientX,startValue:Number(h.getSong().layers[index][property]??(property==='volume'?100:0)),moved:false};pane.setPointerCapture(event.pointerId);
  }));
  listen(pane,'pointermove',safe(event=>{
    if(touchContacts.has(event.pointerId)){
      event.preventDefault();if(!touchPan||touchPan.pointerId!==event.pointerId)return;
      if(!touchPan.moved&&Math.hypot(event.clientX-touchPan.x,event.clientY-touchPan.y)<=8)return;
      if(!touchPan.moved){touchPan.moved=true;pane.setPointerCapture(event.pointerId);}
      suppressClick=performance.now()+350;
      if(gridScroll)gridScroll.scrollTop=Math.max(0,touchPan.scrollTop+touchPan.y-event.clientY);
      return;
    }
    if(brush&&event.pointerId===brush.pointerId){
      const button=document.elementFromPoint(event.clientX,event.clientY)?.closest?.('[data-layer-action]'),row=rowOf(button);
      if(!row||!pane.contains(row)||button.dataset.layerAction!==brush.operation)return;
      const index=Number(row.dataset.layer);if(index===brush.lastIndex)return;
      // Crossing several rows between pointer events should still paint every row.
      const previous=brush.lastIndex,direction=index>previous?1:-1;brush.lastIndex=index;let changed=false;
      for(let current=previous+direction;direction>0?current<=index:current>=index;current+=direction)changed=brush.controller.visit(current).changed||changed;
      if(changed)h.refresh({save:brush.controller.savesProject});return;
    }
    if(!drag||event.pointerId!==drag.pointerId)return;const delta=drag.startY-event.clientY;if(Math.abs(delta)>2||Math.abs(event.clientX-drag.startX)>4)drag.moved=true;if(!drag.moved||Math.abs(delta)<1)return;let value=clamp(drag.startValue+delta,...fields[drag.property]);if(!event.shiftKey)value=Math.floor(value/10)*10;updateLive(drag,drag.property,value);
  }));
  const endDrag=safe(event=>{if(!drag||event.pointerId!==drag.pointerId)return;const session=drag;drag=null;suppressClick=performance.now()+350;finishLive(session);if(event.type==='pointerup'&&!session.moved&&current(session)){const anchor=rows.get(session.index)?.element.querySelector(`[data-layer-action="${session.property}"]`);if(anchor)openPopup(session.index,anchor,session.property);}});
  const endBrush=event=>{if(!brush||event.pointerId!==brush.pointerId)return;brush=null;suppressClick=performance.now()+350;};
  const endTouch=safe(event=>{
    // Moving implicit capture from a row child to the pane emits a child loss.
    if(event.type==='lostpointercapture'&&pane.hasPointerCapture?.(event.pointerId))return;
    if(!touchContacts.delete(event.pointerId))return;
    if(!touchPan)suppressClick=performance.now()+350;
    if(touchPan?.pointerId===event.pointerId){
      if(touchPan.moved||event.type!=='pointerup')suppressClick=performance.now()+350;
      else touchPan.input?.focus({preventScroll:true});
      touchPan=null;
    }
    if(!touchContacts.size)touchPan=null;
  });
  for(const type of ['pointerup','pointercancel','lostpointercapture']){listen(pane,type,endDrag);listen(pane,type,endBrush);listen(pane,type,endTouch);}
  listen(document,'pointerdown',safe(event=>{if(popup&&!popup.contains(event.target)&&!event.target.closest?.('.native-layer-row'))closePopup();}),true);
  listen(document,'keydown',safe(event=>{if(event.key==='Escape'&&popup){event.stopPropagation();closePopup();}}),true);
  listen(view,'blur',safe(()=>{if(drag){const session=drag;drag=null;finishLive(session);}if(brush){brush=null;suppressClick=performance.now()+350;}if(touchContacts.size)suppressClick=performance.now()+350;touchContacts.clear();touchPan=null;closePopup();}));
  return {render,destroy(){if(destroyed)return;closePopup();if(nameSession)finishLive(nameSession);if(drag)finishLive(drag);brush=null;touchContacts.clear();touchPan=null;destroyed=true;for(const remove of removers)remove();for(const {element}of rows.values())element.remove();rows.clear();}};
}
