const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const lengthOf=song=>Math.max(1,Number(song?.length)||1);
const asset=name=>new URL(`../assets/original/toolbar-light/${name}.png`,import.meta.url).href;

/** Closed popover containers stay in the document and must not keep the chrome visible. */
export function hasOpenPlayerOverlay(doc) {
  return !!doc.querySelector('dialog[open],[role="menu"],:popover-open');
}

/** A range drag pauses once and resumes only at its final committed position. */
export function createPlayerSeekGesture(h,onPreview=()=>{}) {
  let gesture=null;
  return {
    begin({playing=false,tick=0,pointerId=null}={}){
      if(gesture)return;
      gesture={song:h.getSong(),resume:!!playing,tick:clamp(Number(tick)||0,0,lengthOf(h.getSong())),pointerId};
      try{h.stopPlayback(false);}catch(error){gesture=null;throw error;}
    },
    set(value){if(!gesture)return false;if(h.getSong()!==gesture.song){gesture=null;return false;}const number=Number(value);if(!Number.isFinite(number))return false;gesture.tick=clamp(number,0,lengthOf(gesture.song));onPreview(gesture.tick);return true;},
    ownsPointer(pointerId){return !!gesture&&(pointerId===undefined||gesture.pointerId===null||gesture.pointerId===pointerId);},
    finish({pointerId}={}){if(!gesture||(pointerId!==undefined&&gesture.pointerId!==null&&gesture.pointerId!==pointerId))return false;const completed=gesture;gesture=null;if(h.getSong()!==completed.song)return false;h.seekTo(completed.tick,{preview:false,resume:completed.resume});return true;},
    cancel(){gesture=null;},
    get dragging(){return !!gesture;}
  };
}

/** Source-supported player presentation. Rendering/audio remain in the main editor. */
export function createNativePlayerUI(h) {
  const doc=h.document||globalThis.document,view=doc.defaultView||globalThis,workspace=doc.querySelector('.workspace');
  if(!workspace)throw new Error('找不到播放器工作区。');
  const removers=[],card=doc.createElement('section');card.className='native-player-card';card.hidden=true;card.setAttribute('aria-label','歌曲播放器');
  card.innerHTML='<h1 data-player-title></h1><p class="native-player-author" data-player-author></p><p class="native-player-original" data-player-original></p><p class="native-player-description" data-player-description></p><p class="native-player-import" data-player-import></p><div class="native-player-times"><strong data-player-current>00:00</strong><small data-player-total></small></div><input class="native-player-position" type="range" min="0" max="1" step="0.01" value="0" aria-label="歌曲播放位置"><div class="native-player-transport"></div>';
  workspace.append(card);
  const $=selector=>card.querySelector(selector),range=$('.native-player-position'),currentTime=$('[data-player-current]'),totalTime=$('[data-player-total]');
  const transport=$('.native-player-transport'),buttons=new Map(),returnButton=doc.getElementById('playerViewBtn'),returnText=returnButton?.textContent||'♫';
  let state={player:false,dropMode:false,tick:0,playing:false,loop:false},lastSong=null,pointerDragging=false,keyboardDragging=false,holding=null,idleTimer=null,inChrome=false,destroyed=false,touchUsed=false;
  const coarse=view.matchMedia?.('(pointer: coarse)'),keepChrome=()=>touchUsed||!!coarse?.matches||view.innerWidth<=799;
  const listen=(node,type,fn,options)=>{node.addEventListener(type,fn,options);removers.push(()=>node.removeEventListener(type,fn,options));};
  const call=(fn,...args)=>{try{const result=fn?.(...args);if(result?.catch)result.catch(error=>h.error?h.error(error):console.error(error));return result;}catch(error){if(h.error)h.error(error);else console.error(error);}};
  const reduced=()=>!!h.isReducedMotion?.();
  const seconds=tick=>h.secondsAtTick?h.secondsAtTick(tick):tick/(Number(h.getSong().tempo)||10);
  const format=value=>h.formatTime?h.formatTime(value):`${Math.floor(value/60)}:${String(Math.floor(value%60)).padStart(2,'0')}`;
  function text(element,value){if(element.textContent!==value)element.textContent=value;}
  function position(tick){const value=clamp(Number(tick)||0,0,lengthOf(h.getSong()));if(range.value!==String(value))range.value=String(value);const time=format(seconds(value));text(currentTime,time);range.setAttribute('aria-valuetext',`${time} / ${format(seconds(lengthOf(h.getSong())))}`);}
  const seek=createPlayerSeekGesture(h,position);
  for(const [action,label,image]of [['back','倒带（按住）','07-back'],['stop','停止','06-stop'],['play','播放','04-play'],['forward','快进（按住）','08-forward'],['loop','循环播放','50-loop']]){
    const button=doc.createElement('button');button.type='button';button.dataset.playerAction=action;button.title=label;button.setAttribute('aria-label',label);button.innerHTML=`<img src="${asset(image)}" alt="">`;if(action==='loop')button.setAttribute('aria-pressed','false');transport.append(button);buttons.set(action,button);
  }
  function finishSeek(event){if(!seek.ownsPointer(event?.pointerId))return;seek.set(range.value);pointerDragging=false;keyboardDragging=false;call(()=>seek.finish(event));}
  listen(range,'pointerdown',event=>{if(event.button!==0||pointerDragging)return;if(keyboardDragging)finishSeek();pointerDragging=true;call(()=>seek.begin({...state,pointerId:event.pointerId}));range.setPointerCapture?.(event.pointerId);});
  listen(range,'input',()=>{if(!seek.dragging)call(()=>seek.begin(state));seek.set(range.value);});
  listen(range,'change',()=>{if(!pointerDragging&&!keyboardDragging)finishSeek();});
  listen(range,'keydown',event=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)){event.stopPropagation();keyboardDragging=true;call(()=>seek.begin(state));}});
  listen(range,'keyup',event=>{if(keyboardDragging){event.stopPropagation();finishSeek();}});
  for(const type of ['pointerup','pointercancel'])listen(doc,type,event=>{if(pointerDragging)finishSeek(event);},true);
  listen(range,'lostpointercapture',event=>{if(pointerDragging)finishSeek(event);});
  function releaseHold(event){if(!holding)return;if(event?.pointerId!==undefined&&holding.pointerId!==undefined&&event.pointerId!==holding.pointerId)return;if(event?.type==='keyup'&&holding.code&&event.code!==holding.code)return;holding=null;call(h.seekRelease);}
  for(const [action,direction]of [['back',-1],['forward',1]]){
    const button=buttons.get(action);
    listen(button,'pointerdown',event=>{if(event.button!==0||holding)return;event.preventDefault();holding={pointerId:event.pointerId};call(h.seekHold,direction,event);});
    listen(button,'keydown',event=>{if(!['Space','Enter'].includes(event.code))return;event.preventDefault();event.stopPropagation();if(!event.repeat){holding={code:event.code};call(h.seekHold,direction,event);}});
    listen(button,'lostpointercapture',releaseHold);
  }
  for(const type of ['pointerup','pointercancel','keyup'])listen(doc,type,releaseHold,true);
  listen(buttons.get('play'),'click',()=>call(h.togglePlayback));listen(buttons.get('stop'),'click',()=>call(h.stopPlayback));listen(buttons.get('loop'),'click',()=>call(h.toggleLoop));
  listen(transport,'keydown',event=>{if(event.code==='Space'||event.key==='Enter')event.stopPropagation();});
  function showChrome(){doc.body.classList.remove('native-player-idle');}
  function resetIdle(){
    clearTimeout(idleTimer);idleTimer=null;showChrome();if(!state.player||!state.dropMode||reduced()||keepChrome())return;
    idleTimer=setTimeout(()=>{idleTimer=null;if(!state.player||!state.dropMode||reduced()||keepChrome())return;if(inChrome||hasOpenPlayerOverlay(doc)){resetIdle();return;}doc.body.classList.add('native-player-idle');},1500);
  }
  listen(doc,'pointermove',event=>{if(event.pointerType==='touch')touchUsed=true;inChrome=event.clientX>=0&&event.clientX<530&&event.clientY>=0&&event.clientY<90;resetIdle();},{passive:true});
  listen(doc,'pointerdown',event=>{if(event.pointerType==='touch')touchUsed=true;resetIdle();},{passive:true});listen(doc,'keydown',resetIdle,true);
  listen(view,'blur',()=>{if(pointerDragging||keyboardDragging)finishSeek();releaseHold();});
  const motion=view.matchMedia?.('(prefers-reduced-motion: reduce)');if(motion?.addEventListener)listen(motion,'change',resetIdle);
  if(coarse?.addEventListener)listen(coarse,'change',resetIdle);listen(view,'resize',resetIdle);
  function update(next={}){
    if(destroyed)return;const merged={...state,...next},modeChanged=state.player!==!!merged.player||state.dropMode!==!!merged.dropMode;state=merged;
    const song=h.getSong();if(lastSong!==song){lastSong=song;seek.cancel();pointerDragging=false;keyboardDragging=false;releaseHold();}
    card.hidden=!state.player||!!state.dropMode;
    if(returnButton){const label=state.player?'返回编辑器':returnText;text(returnButton,label);returnButton.setAttribute('aria-label',state.player?'返回编辑器':'切换播放器模式');returnButton.title=state.player?'返回编辑器':'切换播放器模式';}
    const title=song.title||'未命名曲谱',author=song.author?`作者：${song.author}`:'',original=song.originalAuthor?`原作者：${song.originalAuthor}`:'',description=String(song.description||''),midi=song.metadata?.midiFile?`导入自：${String(song.metadata.midiFile).replace(/\\/g,'/').split('/').at(-1)}`:'';
    for(const [selector,value]of [['[data-player-title]',title],['[data-player-author]',author],['[data-player-original]',original],['[data-player-description]',description],['[data-player-import]',midi]]){const element=$(selector);text(element,value);element.hidden=!value;}
    const length=lengthOf(song);if(range.max!==String(length))range.max=String(length);text(totalTime,`/ ${format(seconds(length))}`);if(!seek.dragging)position(state.tick);
    const play=buttons.get('play'),playing=!!state.playing;if(play.dataset.playing!==String(playing)){play.dataset.playing=String(playing);play.querySelector('img').src=asset(playing?'05-pause':'04-play');play.setAttribute('aria-label',playing?'暂停':'播放');play.title=playing?'暂停':'播放';}
    const loop=buttons.get('loop');if(loop.getAttribute('aria-pressed')!==String(!!state.loop)){loop.setAttribute('aria-pressed',String(!!state.loop));loop.classList.toggle('active',!!state.loop);}
    if(modeChanged)resetIdle();else if(reduced()){clearTimeout(idleTimer);idleTimer=null;showChrome();}
  }
  return {update,destroy(){if(destroyed)return;destroyed=true;clearTimeout(idleTimer);seek.cancel();releaseHold();showChrome();card.remove();for(const remove of removers)remove();if(returnButton)text(returnButton,returnText);}};
}
