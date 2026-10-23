import {INSTRUMENTS} from './audio.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const WORK_STAT_FIELDS=Object.freeze([
  ['minutesSpent','所用分钟'],['leftClicks','左键次数'],['rightClicks','右键次数'],['blocksAdded','已放音符'],['blocksRemoved','已删音符']
].map(Object.freeze));
const workValue=value=>Number.isFinite(Number(value))?Math.max(0,Math.min(0xffffffff,Math.floor(Number(value)))):0;

/** NBS metadata uses the same five counters as the original native work-stat panel. */
export function nativeSongStatistics(song={}){
  const counts=new Map();for(const note of song.notes||[])counts.set(note.instrument,(counts.get(note.instrument)||0)+1);
  const definitions=[...INSTRUMENTS.map(({id,name})=>({id,name})),...(song.customInstruments||[]).map((instrument,index)=>({id:16+index,name:instrument.name||`自定义 ${index+1}`}))];
  const known=new Set(definitions.map(instrument=>instrument.id));for(const id of counts.keys())if(!known.has(id))definitions.push({id,name:`音色 ${id}`});
  const total=(song.notes||[]).length;
  return {total,layers:(song.layers||[]).length,work:Object.fromEntries(WORK_STAT_FIELDS.map(([key])=>[key,workValue(song.metadata?.[key])])),
    instruments:definitions.map(instrument=>({...instrument,count:counts.get(instrument.id)||0,percent:total?Math.floor((counts.get(instrument.id)||0)/total*100):0}))};
}

export function resetNativeWorkStatistics(song,beforeChange=()=>{}){
  const metadata={...(song.metadata||{})};for(const [key]of WORK_STAT_FIELDS)metadata[key]=0;
  beforeChange();song.metadata=metadata;
}

/** The native tapper averages instantaneous BPM, rounds BPM, and resets after a long gap. */
export class NativeTempoTapper{
  constructor(){this.reset();}
  reset(){this.lastTime=null;this.bpm=0;this.taps=0;}
  tap(milliseconds){
    const now=Number(milliseconds);if(!Number.isFinite(now))throw new Error('测速时间必须为有限数字。');
    if(this.lastTime===null||now<this.lastTime){this.lastTime=now;this.bpm=0;this.taps=1;return null;}
    const interval=now-this.lastTime;if(interval<=0)return this.bpm?Math.round(this.bpm):null;
    const instant=60000/interval,previous=this.bpm;
    this.bpm=previous?(instant+previous*this.taps)/(this.taps+1):instant;
    if(previous&&Math.round(instant)<=previous/2){this.bpm=0;this.taps=0;}
    this.lastTime=now;this.taps++;return this.bpm?Math.round(this.bpm):null;
  }
  tempo(double=false){return this.bpm?Math.max(.05,Math.min(655.35,Math.round(this.bpm)*(double?2:1)/15)):null;}
}

/** Readonly info, native work statistics and the T-key tempo tapper. */
export function createNativeDialogs(h){
  const doc=h.document||globalThis.document,$=id=>doc.getElementById(id);
  let cleanTempo=()=>{};
  const close=()=>{$('modal')?.close();};
  const fail=error=>h.error?h.error(error):h.toast?.(error?.message||String(error),true);
  const safe=fn=>(...args)=>{try{const result=fn(...args);if(result?.catch)result.catch(fail);return result;}catch(error){fail(error);}};
  const canEdit=()=>!(h.isBusy?.()||h.engine?._benchmarking||doc.body?.classList.contains('player-mode'));
  const requireEdit=()=>{if(!canEdit())throw new Error('请先退出播放器模式或结束当前操作。');};
  function showInfo(){
    cleanTempo();const song=h.getSong();
    h.modal('歌曲信息',`<section class="native-song-info"><h2>${escape(song.title||'无名歌曲')}</h2>${song.author?`<p><strong>作者：</strong>${escape(song.author)}</p>`:''}${song.originalAuthor?`<p><strong>原作者：</strong>${escape(song.originalAuthor)}</p>`:''}${song.description?`<div style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto">${escape(song.description)}</div>`:''}${song.metadata?.midiFile?`<p><small>导入自：${escape(song.metadata.midiFile)}</small></p>`:''}</section>`,`<button class="secondary-button" data-close>关闭</button><button class="primary-button" id="nativeInfoEdit" ${canEdit()?'':'disabled'}>修改歌曲属性…</button>`);
    $('nativeInfoEdit').onclick=safe(()=>{requireEdit();close();h.showProperties();});
  }
  function showStatistics(){
    cleanTempo();const song=h.getSong(),statistics=nativeSongStatistics(song);
    h.modal('歌曲数据',`<p>${statistics.total.toLocaleString()} 个音符 · ${statistics.layers.toLocaleString()} 条图层</p><div style="max-height:220px;overflow:auto"><table><thead><tr><th>音色</th><th>音符数</th><th>比例</th></tr></thead><tbody>${statistics.instruments.map(instrument=>`<tr><td>${escape(instrument.name)}</td><td>${instrument.count.toLocaleString()}</td><td>${instrument.percent}%</td></tr>`).join('')}</tbody></table></div><h3>工作数据</h3><table><tbody>${WORK_STAT_FIELDS.map(([key,label])=>`<tr><th>${label}</th><td>${statistics.work[key].toLocaleString()}</td></tr>`).join('')}</tbody></table>`,`<button class="secondary-button" id="nativeStatsReset" ${canEdit()?'':'disabled'}>重置工作数据…</button><button class="primary-button" data-close>关闭</button>`);
    $('nativeStatsReset').onclick=safe(()=>{
      requireEdit();
      h.modal('重置工作数据？','<p>将所用分钟、左键次数、右键次数、已放音符和已删音符五项计数归零。</p>',`<button class="secondary-button" id="nativeStatsCancel">取消</button><button class="primary-button" id="nativeStatsConfirm">确认重置</button>`);
      $('nativeStatsCancel').onclick=showStatistics;
      $('nativeStatsConfirm').onclick=safe(()=>{requireEdit();if(h.getSong()!==song)throw new Error('当前曲谱已改变，请重新打开歌曲数据。');resetNativeWorkStatistics(song,()=>h.checkpoint());h.refresh({save:true});showStatistics();h.toast?.('已重置工作数据');});
    });
  }
  function showTempoTap(){
    cleanTempo();const song=h.getSong(),tapper=new NativeTempoTapper();
    h.modal('速度测量器',`<p>按 <kbd>T</kbd> 或点击按钮打拍子；至少敲击两次。较长停顿后会重新测速。</p><button class="primary-button" id="nativeTempoTap">敲击（T / 空格）</button><p id="nativeTempoResult" role="status">等待敲击…</p><label class="inline-label"><input id="nativeTempoDouble" type="checkbox">双倍速度 ×2</label>`,`<button class="secondary-button" data-close>取消</button><button class="primary-button" id="nativeTempoApply" disabled>应用速度</button>`);
    const button=$('nativeTempoTap'),double=$('nativeTempoDouble'),result=$('nativeTempoResult'),apply=$('nativeTempoApply'),dialog=$('modal');
    let active=true;
    const render=()=>{const tempo=tapper.tempo(double.checked);apply.disabled=tempo===null||!canEdit();result.textContent=tempo===null?'至少再敲击一次。':`${(tempo*15).toFixed(1)} BPM · ${tempo.toFixed(2)} ticks/s${double.checked?'（双倍）':''}`;};
    const beat=()=>{
      if(h.preview)return h.preview();
      if(h.engine?.previewNotes)return h.engine.previewNotes([{tick:0,layer:0,instrument:4,key:45,velocity:100,pan:0,pitch:0}],[{volume:100,pan:0,reverb:0,muted:false,solo:false}]);
      return h.engine?.preview?.({instrument:4,key:45,velocity:100,pan:0,pitch:0},{volume:100,pan:0,reverb:0});
    };
    const tap=safe(()=>{if(!active||!button.isConnected){cleanTempo();return;}tapper.tap(performance.now());render();const sound=beat();if(sound?.catch)sound.catch(fail);});
    const keydown=event=>{
      if(!active||!button.isConnected){cleanTempo();return;}
      if(event.isComposing||event.ctrlKey||event.altKey||event.metaKey||event.repeat)return;
      if(event.key.toLowerCase()==='t'&&!event.target.closest('textarea,select,input:not([type=checkbox]),[contenteditable=true]')){event.preventDefault();event.stopPropagation();tap();}
    };
    doc.addEventListener('keydown',keydown,true);
    cleanTempo=()=>{if(!active)return;active=false;doc.removeEventListener('keydown',keydown,true);dialog?.removeEventListener('close',cleanTempo);};
    dialog?.addEventListener('close',cleanTempo,{once:true});
    button.onclick=tap;button.onkeydown=event=>{if(event.code==='Space'){event.preventDefault();event.stopPropagation();if(!event.repeat)tap();}};
    double.onchange=render;
    apply.onclick=safe(()=>{requireEdit();const tempo=tapper.tempo(double.checked);if(tempo===null)return;if(h.getSong()!==song)throw new Error('当前曲谱已改变，请重新测速。');h.checkpoint();song.tempo=tempo;cleanTempo();close();h.refresh({save:true});h.toast?.(`速度已设为 ${tempo.toFixed(2)} ticks/s`);});
    button.focus({preventScroll:true});
  }
  return {showInfo,showStatistics,showTempoTap,destroy(){cleanTempo();}};
}
