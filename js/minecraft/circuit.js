/** Redstone designs derived from the supplied GML exporters. Internal axes match GML. */
import {normalizeSong} from '../model.js';
import {SUPPORT_IDS,blockSpec,posKey,rotateModel} from './blocks.js';
export function prepareSong(raw,options={},kind='schematic'){
  const song=normalizeSong(raw),warnings=[],range=options.commandBlocks||kind==='datapack'&&options.includeOutOfRange?[9,81]:[33,57];
  const selected=options.layers?new Set(options.layers.map(Number)):null,solo=song.layers.some(l=>l.solo);
  const start=Math.max(0,Math.floor(options.rangeStart||0)),end=Math.min(song.length-1,Math.floor(options.rangeEnd??song.length-1));if(end<start)throw new Error('导出范围无效。');
  let excluded=0,custom=0,pitch=0;const notes=song.notes.filter(n=>{const layer=song.layers[n.layer];if(n.tick<start||n.tick>end||selected&&!selected.has(n.layer)||!options.includeLocked&&(layer.locked||layer.muted||solo&&!layer.solo))return false;
    const k=n.key+(kind==='datapack'||options.commandBlocks?n.pitch/100:0);if(k<range[0]||k>range[1]){excluded++;return false;}if(n.instrument>=16)custom++;if(n.pitch&&kind!=='datapack'&&!options.commandBlocks)pitch++;return true;}).map(n=>({...n,tick:n.tick-start}));
  if(excluded)warnings.push(`${excluded} 个音符超出 ${range[0]}–${range[1]} 音域，已跳过。`);
  if(custom&&kind!=='datapack'&&!options.commandBlocks)warnings.push(`${custom} 个自定义乐器音符使用所选支撑方块对应的原版音色；原版音符盒不能播放外部采样。`);
  if(pitch)warnings.push(`${pitch} 个音符的微调音高已舍入；原版音符盒只支持半音。`);
  if(!notes.length)throw new Error('所选范围内没有可导出的音符。');
  return{song:{...song,notes,length:end-start+1,loopStart:Math.max(0,song.loopStart-start)},warnings};
}
function builder(options){const map=new Map(),entities=[];const set=(a,b,c,id,data=0,extra={})=>{if(![a,b,c].every(Number.isInteger)||a<0||b<0||c<0)throw new Error('电路尺寸无效。');if(map.size>2000000)throw new Error('电路超过 200 万方块，请缩短导出范围。');const spec=typeof id==='object'?id:blockSpec({id,data});map.set(posKey(a,b,c),{...spec,...extra,pos:[a,c,b]});};
  const circuit=blockSpec(options.circuitBlock),walkway=blockSpec(options.walkwayBlock),ground=blockSpec(options.groundBlock);
  const solid=(a,b,c)=>set(a,b,c,circuit),wire=(a,b,c)=>set(a,b,c,55),rep=(a,b,c,delay,dir,powered=false)=>set(a,b,c,powered?94:93,Math.max(0,Math.min(3,delay))*4+dir);
  const note=(a,b,c,n)=>{const support=blockSpec(options.instrumentBlocks?.[n.instrument],SUPPORT_IDS[n.instrument]??3);set(a,b,c-1,support);set(a,b,c,options.commandBlocks?137:25,0,{note:n});};
  return{map,entities,set,solid,wire,rep,note,circuit,walkway,ground,finish(size,song,kind){let blocks=[...map.values()].map(b=>({...b,pos:[size[1]-1-b.pos[2],b.pos[1],b.pos[0]]}));const model={size:[size[1],size[2],size[0]],blocks,entities,song,kind};return rotateModel(model,options.direction);}};
}
/** Original alternating torch tower, with repeaters compensating two ticks per tier. */
function startTower(b,tiers,cy,end,height){const {solid,wire,set,rep}=b;solid(1,cy,height-2);solid(1,cy+1,height-2);set(1,cy,height-1,35,11);set(1,cy+1,height-1,35,11);set(2,cy,height-1,68,3,{sign:['Note Block Studio','Start','','']});set(2,cy+1,height-1,77,3);
  for(let a=-1;a<=1;a++){solid(0,cy+a,height-2);wire(0,cy+a,height-1);}set(0,cy-2,height-2,76,1);solid(0,cy-2,height-4);wire(0,cy-2,height-3);set(0,cy-3,height-4,75,1);
  let d=0;for(let tier=tiers-1;tier>=0;tier--){if(tier>0){set(0,cy-1-d,tier*3+1,76,2);solid(0,cy-1,tier*3-1+d);wire(0,cy-1,tier*3+d);set(0,cy-2,tier*3-1+d,75,1);}let remain=tier*2,p=0;for(let a=cy-2-d;a>=end;a--){solid(0,a,tier*3+1);wire(0,a,tier*3+2);p++;if(remain>0&&a<cy-3-d){rep(0,a,tier*3+2,Math.min(4,remain)-1,1);remain-=4;p=0;}if(p===16||a===end+1){rep(0,a,tier*3+2,0,1);p=0;}}for(let a=0;a<4;a++){wire(a,end,tier*3+2);solid(a,end,tier*3+1);}d=1-d;}
}
export function buildCircuit(raw,options={}){
  const kind=options.format||'schematic';if(kind==='branch')return buildBranch(raw,options);if(kind==='track')return buildTrack(raw,options);
  const {song,warnings}=prepareSong(raw,options,kind),b=builder(options),{set,solid,wire,rep,note}=b;
  const layout=typeof options.layout==='number'?options.layout:({circular:0,simple:1,classic:2})[options.layout??'simple'];if(![0,1,2].includes(layout))throw new Error('未知电路布局。');
  const tempo=Number(options.tempo??([10,5,2.5].includes(song.tempo)?song.tempo:10));if(![10,5,2.5].includes(tempo))throw new Error('红石电路速度只能是 10、5 或 2.5 tick/s。');if(tempo!==song.tempo)warnings.push(`红石电路使用 ${tempo} tick/s（项目为 ${song.tempo}）。`);
  const factor=10/tempo,perRow=Math.max(5,Math.min(100,Math.floor(options.repeatersPerRow??20))),byTick=new Map();for(const n of song.notes){if(!byTick.has(n.tick))byTick.set(n.tick,[]);byTick.get(n.tick).push(n);}
  const compress=options.compressLayers!==false,maxPoly=compress?[...byTick.values()].reduce((m,a)=>Math.max(m,a.length),0):song.notes.reduce((m,n)=>Math.max(m,n.layer+1),0),tiers=Math.ceil(maxPoly/4),height=4+3*tiers;
  if(height>=256)throw new Error('红石电路高度必须小于 256；请减少同时发声图层。');
  const segments=[];let delay=0;for(let tick=0;tick<song.length;tick++){delay+=factor;let ns=byTick.get(tick)||[];if(ns.length&&!compress){const slots=Array(Math.max(...ns.map(n=>n.layer))+1).fill(null);for(const n of ns)slots[n.layer]=n;ns=slots;}if(ns.length||delay===4){segments.push({tick,delay,notes:ns});delay=0;}}
  // Classic's first row reserves six control cells. The native estimate can
  // undershoot a final turn by one row; reserve that row rather than truncate it.
  let length=layout<2?2+Math.ceil(segments.length/perRow)*3:Math.max(6,Math.ceil((segments.length+2)/perRow)*3+4);if(layout===0)length+=3*Number(Math.ceil(segments.length/perRow)%2===0);
  const width=perRow*2+3+(layout===0?4:0),minecart=!!options.minecart&&layout<2,loop=!!options.loop&&layout===0;let cy=Math.round(width/2),x,y,dir,circ=1,lastTurn;
  if(length*width*height>16000000||length>=2000||width>=2000)throw new Error('电路体积过大，请缩短范围或调整每行中继器数。');
  for(let a=0;a<length;a++)for(let c=0;c<width;c++)set(a,c,0,b.ground);
  if(layout<2){
    for(let z=1;z<height-2;z++){for(let a=0;a<3;a++)set(1,cy+a,z,b.walkway);set(0,cy+2,z,65,2);}
    for(let a=-Number(minecart);a<3+Number(minecart&&layout===0);a++)for(let c=2;c<length;c++){set(c,cy+a,height-3,b.walkway);if(a===-1){if(c===length-1&&layout===1)set(c,cy+a,height-2,b.walkway);else if(c%12===2){set(c,cy+a,height-2,b.walkway);if(c>3)set(c,cy+a,height-1,66);}else if(c%12===3){set(c,cy-1,height-2,27,4);set(c,cy-2,height-2,75,5);set(c,cy-2,height-3,b.walkway);set(c,cy-2,height-4,76,5);}else set(c,cy+a,height-2,66,c%12===1?5:0);}}
    solid(1,cy,height-2);solid(1,cy+1,height-2);set(1,cy,height-1,35,11);set(1,cy+1,height-1,35,11);set(2,cy,height-1,68,3,{sign:[song.title,song.author,`${tempo} tick/s`,'Note Block Studio']});set(2,cy+1,height-1,77,3);
    if(minecart&&options.chest!==false)set(2,cy-1,height-1,54,4,{chest:true});
    if(loop){set(2,cy,height-2,68,3,{sign:['Loop','Lever','','']});set(2,cy+1,height-2,69,11);wire(1,cy+1,height-3);solid(0,cy+1,height-3);set(0,cy,height-3,75,1);}
    for(let a=-1;a<=1;a++){solid(0,cy+a,height-2);wire(0,cy+a,height-1);}set(0,cy-2,height-2,76,1);solid(0,cy-2,height-4);wire(0,cy-2,height-3);set(0,cy-3,height-4,75,1);
    let d=0;for(let tier=tiers-1;tier>=0;tier--){if(tier>0){set(0,cy-1-d,tier*3+1,76,2);solid(0,cy-1,tier*3-1+d);wire(0,cy-1,tier*3+d);set(0,cy-2,tier*3-1+d,75,1);}let c=tier*2,p=0;for(let a=cy-2-d;a>=0;a--){solid(0,a,tier*3+1);wire(0,a,tier*3+2);p++;if(c>0&&a<cy-3-d){rep(0,a,tier*3+2,Math.min(4,c)-1,1);c-=4;p=0;}if(p===16||a===1){rep(0,a,tier*3+2,0,1);p=0;}}for(let a=0;a<4;a++){wire(a,0,tier*3+2);solid(a,0,tier*3+1);}d=1-d;}
    x=3;y=0;dir=1;
  }else{
    for(let a=0;a<length;a++)for(let c=0;c<width-1;c++)set(a,c,height-3,options.glassFloor!==false&&a>0&&c>0&&a<length-1&&c<width-2?blockSpec(20):b.walkway);
    set(2,width-2,height-2,b.walkway);set(3,width-2,height-2,b.walkway);set(2,width-2,height-1,35,11);set(3,width-2,height-1,35,11);set(2,width-3,height-1,68,5,{sign:[song.title,song.author,`${tempo} tick/s`,'Note Block Studio']});set(3,width-3,height-1,77,1);wire(3,width-1,height-1);solid(3,width-1,height-2);wire(2,width-1,height-2);solid(2,width-1,height-3);set(1,width-1,height-3,76,4);
    let c=1;for(let a=tiers-1;a>=0;a--){let d=a*2;for(let p=width-2-c;p>width-8;p--){solid(1,p,a*3+1);if(d>0&&p<width-2-c){rep(1,p,a*3+2,Math.min(4,d)-1,1);d-=4;}else wire(1,p,a*3+2);}if(a>0)set(1,width-1-c,a*3+1,76,2);solid(1,width-1,a*3+3-c);wire(1,width-1,a*3+4-c);set(1,width-2,a*3+3-c,75,1);c=1-c;}
    for(let z=1;z<height-2;z++){set(0,width-2,z,b.walkway);set(0,width-1,z,65,4);}x=1;y=width-7;dir=-1;
  }
  for(let s=0;s<segments.length;s++){const segment=segments[s],ns=[...segment.notes];for(let tier=0;tier<tiers;tier++){const yy=y+dir,z=tier*3;rep(x,yy,z+2,segment.delay-1,dir===1?3:1);solid(x,yy,z+1);solid(x,yy+dir,z+2);if(tier>0){solid(x,yy,z);solid(x,yy+dir,z);}solid(x,yy+2*dir,z+1);if(ns.length)wire(x,yy+dir,z+1);for(const [dx,dy,dz] of [[-1,2,1],[1,2,1],[-1,1,2],[1,1,2]]){const n=ns.pop();if(n)note(x+dx,yy+dy*dir,z+dz,n);}}
    y+=2*dir;let turn=false;
    if(layout===0){if(circ===1){if(dir===1){if(x===length-2){if(y>=cy){circ=-1;y++;for(let tier=0;tier<tiers;tier++)for(let c=0;c<2;c++){solid(x,y+c,tier*3+1);wire(x,y+c,tier*3+2);}y++;}}else turn=y>=cy-2;}if(dir===-1)turn=y<=2;}else turn=dir===1?y>=width-3:y<=cy+5;}
    else turn=dir===1?y>=width-(layout===2?4:3):y<=2;
    if(s===segments.length-1)turn=false;
    if(turn){for(let tier=0;tier<tiers;tier++){wire(x,y,tier*3+1);wire(x,y+dir,tier*3+2);solid(x,y+dir,tier*3+1);for(let c=0;c<4;c++){wire(x+c*circ,y+2*dir,tier*3+2);solid(x+c*circ,y+2*dir,tier*3+1);}}y+=2*dir;dir=-dir;if(circ===-1&&dir===1)lastTurn={x,y:y-1,remaining:song.length-1-segment.tick-8};x+=3*circ;}
  }
  if(layout===0&&minecart){for(let a=2;a<length;a++){set(a,cy+3,height-3,b.walkway);set(a,cy+3,height-2,a===2?b.walkway:blockSpec(a%12===6?27:66));if(a%12===6)set(a,cy+2,height-2,76,5);}for(let a=-1;a<=3;a++)set(length-1,cy+a,height-2,66,a===-1?8:a===3?9:1);}
  if(loop&&lastTurn){let remaining=lastTurn.remaining,p=15,z=(tiers-1)*3;set(lastTurn.x,lastTurn.y,z+1,76,1);for(let a=lastTurn.x-1;a>3;a--){if(z>0)solid(a,lastTurn.y,z);if(remaining>0||p===0){rep(a,lastTurn.y,z+1,Math.max(1,Math.min(4,remaining))-1,0,true);remaining-=4;p=15;}else{wire(a,lastTurn.y,z+1);solid(a,lastTurn.y,z+2);p--;}}set(2,cy+1,height-4,76,5);solid(2,cy+1,height-5);set(2,cy+1,height-6,75,4);solid(3,cy+1,height-6);}
  if(minecart)b.entities.push({id:'minecraft:minecart',pos:[width-cy+.5,height-1,3.5]});
  const model=b.finish([length,width,height],{...song,tempo},kind);model.warnings=warnings;model.summary={notes:song.notes.length,blocks:model.blocks.length,dimensions:model.size,tempo,layout:['circular','simple','classic'][layout]};return model;
}
function buildBranch(raw,options){
  const {song,warnings}=prepareSong(raw,options,'branch'),b=builder(options),layers=options.layers||[...new Set(song.notes.map(n=>n.layer))].slice(0,3);if(layers.length<1||layers.length>3)throw new Error('分支电路必须选择 1–3 个图层。');
  const velocity=options.velocity!==false,width=velocity?35:21,len=song.length*2+6,height=layers.length*3+4,line=velocity?17:2,stereo=options.stereo||'all';if(len>=2000)throw new Error('分支范围过长，最多 996 tick。');
  if(!['all','left','right','center'].includes(stereo))throw new Error('分支声像筛选无效。');
  let count=0;const exported=[];for(let lane=0;lane<layers.length;lane++){const z=lane*3+1;for(let t=0;t<song.length;t++){if(options.circuitry!==false){b.solid(t*2+4,line,z);b.solid(t*2+5,line,z);b.rep(t*2+4,line,z+1,0,2);b.wire(t*2+5,line,z+1);}}
    for(const n of song.notes.filter(n=>n.layer===layers[lane])){if(stereo==='left'&&n.pan>=0||stereo==='right'&&n.pan<=0||stereo==='center'&&n.pan!==0)continue;let position=velocity?Math.max(2,Math.min(32,Math.round(32-n.velocity*.32)+1)):line+(lane===1?1:lane===2?-1:0);if(velocity&&position>=16&&position<=18)position=15;const x=n.tick*2+5;if(options.circuitry!==false&&velocity){const dir=Math.sign(position-line);for(let y=line;y!==position;y+=dir){b.solid(x,y,z);b.wire(x,y,z+1);}}
      b.note(x,position,z+1,n);exported.push(n);count++;}
  }
  if(options.circuitry!==false)startTower(b,layers.length,line+14,line,height);
  if(!count)throw new Error('所选图层、声像和范围内没有音符。');warnings.push('分支电路以 10 tick/s 运行；音量通过与中央通道的距离近似。');const model=b.finish([len,width,height],{...song,notes:exported,tempo:10},'branch');model.warnings=warnings;model.summary={notes:count,blocks:model.blocks.length,dimensions:model.size,tempo:10,layout:'branch'};return model;
}
function buildTrack(raw,options){
  const {song,warnings}=prepareSong(raw,options,'track'),b=builder(options),length=song.length*2+12,width=105,groups=new Map();if(length>=2000)throw new Error('直轨范围过长，最多 993 tick。');
  for(const n of song.notes){const layer=song.layers[n.layer],volume=layer.volume*n.velocity/10000,pan=(layer.pan+n.pan)/2;let lane=pan>20?Math.max(1,Math.min(4,Math.ceil(pan/25))):pan< -20?-Math.max(1,Math.min(4,Math.ceil(-pan/25))):volume>.8?0:(n.layer%2?1:-1)*Math.max(1,Math.min(4,Math.ceil((1-volume)*5)));if(volume<=0)continue;const k=`${n.tick}:${lane}`;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);}
  const tiers=Math.max(1,Math.ceil([...groups.values()].reduce((m,a)=>Math.max(m,a.length),0)/4)),height=tiers*3+4;if(height>=256)throw new Error('直轨高度必须小于 256。');
  // Nine spatial lanes at the native exporter's 12-block intervals. A common start
  // tower and 8-tick balanced distribution rail trigger every lane simultaneously.
  startTower(b,tiers,14,0,height);
  for(let tier=0;tier<tiers;tier++){const z=tier*3;for(let y=1;y<=100;y++){b.solid(3,y,z+1);if(y>=10&&(y-10)%12===0)b.rep(3,y,z+2,0,3);else b.wire(3,y,z+2);}
    for(let lane=-4;lane<=4;lane++){const y=52+lane*12,index=lane+4,compensate=8-index;
      for(let x=4;x<=8;x++){b.solid(x,y,z+1);b.wire(x,y,z+2);}if(compensate>0)b.rep(4,y,z+2,Math.min(4,compensate)-1,2);if(compensate>4)b.rep(6,y,z+2,compensate-5,2);
      for(let tick=0;tick<song.length;tick++){const x=8+tick*2;b.solid(x+1,y,z+1);b.rep(x+1,y,z+2,0,2);b.solid(x+2,y,z+2);b.solid(x+3,y,z+1);if(tier>0){b.solid(x+1,y,z);b.solid(x+2,y,z);}const ns=groups.get(`${tick}:${lane}`)||[];if(ns.length>tier*4)b.wire(x+2,y,z+1);for(let slot=0;slot<4;slot++){const n=ns[tier*4+slot];if(n)b.note(x+(slot<2?3:2),y+(slot%2?1:-1),z+(slot<2?1:2),n);}}
    }
  }
  warnings.push('直轨以九条间隔 12 格的空间声道近似声像与音量，以 10 tick/s 播放；公共按钮经补偿延迟同时启动各声道。数据包可保留精确声像与音量。');
  const model=b.finish([length,width,height],{...song,tempo:10},'track');model.warnings=warnings;model.summary={notes:song.notes.length,blocks:model.blocks.length,dimensions:model.size,tempo:10,layout:'track'};return model;
}
