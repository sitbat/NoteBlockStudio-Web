import {lowerBoundTick} from './dsp-protocol.js';
export function drawNativeGrid({ctx:g,ruler,song,state,prefs,width:w,height:h,rulerWidth,scrollX:sx,scrollY:sy,rows,drawNote,visuals,solo,dark,removalEffects=[],dropNotes=[],keyPositions=[],secondsAtTick=t=>t/song.tempo}){
  const cw=state.cell,ROW=32,bar=song.timeSignature*4,accent=prefs.accent||'#0078d4';
  g.clearRect(0,0,w,h);g.fillStyle=prefs.blackout&&state.player?'#000':dark?'#272727':'#f9f9f9';g.fillRect(0,0,w,h);
  const firstTick=Math.max(0,Math.floor(sx/cw)),lastTick=Math.ceil((sx+w)/cw);
  if(state.dropMode){
    const start=lowerBoundTick(dropNotes,state.tick-1),end=state.tick+h/ROW+2;
    for(let index=start;index<dropNotes.length;index++){const note=dropNotes[index];if(note.tick>end)break;const layer=song.layers[note.layer];if(layer?.muted||solo&&!layer?.solo)continue;const position=keyPositions[note.key];if(!position||position.x<-32||position.x>w+32)continue;drawNote(g,note,{x:position.x-16,y:h-(note.tick-state.tick)*ROW-32,width:32,height:32,alpha:prefs.fade ? .25+.005*note.velocity*(layer?.volume??100)/100:1,mode:state.editMode,prefs,dark,player:state.player});}
    g.fillStyle=accent;g.globalAlpha=.6;g.fillRect(0,h-2,w,2);g.globalAlpha=1;
  }else{
    const firstRow=Math.max(0,Math.floor(sy/ROW)),lastRow=Math.min(song.layers.length,Math.ceil((sy+h)/ROW));
    for(let row=firstRow;row<lastRow;row++){const y=row*ROW-sy;g.fillStyle=dark?(row===state.layer?'#26394b':'#272727'):(row===state.layer?'#eef5fb':'#f9f9f9');g.fillRect(0,y,w,ROW);g.strokeStyle=dark?'#383838':'#e4e4e4';g.beginPath();g.moveTo(0,y+ROW-.5);g.lineTo(w,y+ROW-.5);g.stroke();}
    for(let tick=firstTick;tick<=lastTick;tick++){if(cw<7&&tick%4)continue;const x=Math.round(tick*cw-sx)+.5;g.strokeStyle=dark?(tick%bar===0?'#777':tick%4===0?'#555':'#363636'):(tick%bar===0?'#b5b5b5':tick%4===0?'#c5c5c5':'#e2e2e2');g.lineWidth=tick%bar===0?2:1;g.beginPath();g.moveTo(x,0);g.lineTo(x,h);g.stroke();}g.lineWidth=1;
    for(let row=firstRow;row<lastRow;row++){const notes=rows.get(row)||[];for(let i=lowerBoundTick(notes,firstTick-1);i<notes.length;i++){const note=notes[i];if(note.tick>lastTick)break;const layer=song.layers[row],hit=layer?.locked?0:Math.max(0,1-visuals.noteAge(note)/1000),alpha=layer?.muted||(solo&&!layer?.solo) ? .2:Math.min(1,(prefs.fade ? .25+note.velocity*.005:1)+hit*.5);drawNote(g,note,{x:note.tick*cw-sx,y:row*ROW-sy,width:cw,height:ROW,alpha,mode:state.editMode,selected:state.selected.has(note.id),prefs,dark,player:state.player});}}
    if(!prefs.removeEffect)removalEffects.length=0;
    const now=performance.now();for(const effect of removalEffects){const age=(now-effect.started)/278;if(age>=1)continue;const expand=10*age,x=effect.tick*cw-sx,y=effect.layer*ROW-sy;g.globalAlpha=.5*(1-age);g.strokeStyle=accent;g.beginPath();g.roundRect(x-expand,y-expand,cw+expand*1.9,ROW+expand*2,expand);g.stroke();}g.globalAlpha=1;
    const gesture=state.gesture;if(gesture?.type==='select'){const x=Math.min(gesture.startX,gesture.x)-sx,y=Math.min(gesture.startY,gesture.y)-sy;g.fillStyle='#0078d418';g.strokeStyle=accent;g.fillRect(x,y,Math.abs(gesture.x-gesture.startX),Math.abs(gesture.y-gesture.startY));g.strokeRect(x+.5,y+.5,Math.abs(gesture.x-gesture.startX),Math.abs(gesture.y-gesture.startY));}
    const playX=state.tick*cw-sx;if(playX>=0&&playX<w){g.fillStyle=accent;g.fillRect(Math.floor(playX),0,2,h);}
    if(song.loopStart){const x=song.loopStart*cw-sx;g.strokeStyle='#0078d488';g.setLineDash([3,4]);g.beginPath();g.moveTo(x,0);g.lineTo(x,h);g.stroke();g.setLineDash([]);}
    const endX=song.length*cw-sx;if(endX<w){g.fillStyle='#00000009';g.fillRect(Math.max(0,endX),0,w-Math.max(0,endX),h);g.fillStyle='#a6a6a6';g.fillRect(endX,0,1,h);}
  }
  ruler.clearRect(0,0,rulerWidth,32);ruler.fillStyle=dark?'#2a2a2a':'#f3f3f3';ruler.fillRect(0,0,rulerWidth,32);ruler.font='9px "Segoe UI",sans-serif';ruler.textBaseline='middle';
  const labelStep=cw*4<38?4*Math.ceil(38/(cw*4)):4;
  for(let tick=Math.ceil(firstTick/labelStep)*labelStep;tick<=lastTick;tick+=labelStep){const x=tick*cw-sx;ruler.strokeStyle=dark?'#aaa':'#888';ruler.beginPath();ruler.moveTo(x+.5,25);ruler.lineTo(x+.5,32);ruler.stroke();ruler.fillStyle=dark?'#ddd':'#333';ruler.fillText(String(tick),x+3,24);}
  // The original seconds scale is independent of its four-tick labels.
  let step=song.tempo<.5?30:song.tempo<1?10:song.tempo<3.5?5:song.tempo>18?.25:song.tempo>11?.5:1;
  const firstSec=secondsAtTick(firstTick),lastSec=secondsAtTick(lastTick);while((lastSec-firstSec)/step>rulerWidth/28)step*=2;
  for(let sec=Math.ceil(firstSec/step)*step;sec<=lastSec;sec+=step){let low=firstTick,high=lastTick;for(let i=0;i<24;i++){const mid=(low+high)/2;if(secondsAtTick(mid)<sec)low=mid;else high=mid;}const x=(low+high)/2*cw-sx;ruler.fillStyle=dark?'#bbb':'#666';ruler.fillText(`${Number(sec.toFixed(2))}s`,x+3,8);ruler.strokeStyle=dark?'#777':'#aaa';ruler.beginPath();ruler.moveTo(x,13);ruler.lineTo(x,16);ruler.stroke();}
  if(state.section){const left=state.section.start*cw-sx,right=state.section.end*cw-sx;ruler.globalAlpha=.2;ruler.fillStyle='#003cff';ruler.fillRect(left,0,right-left,32);ruler.globalAlpha=1;for(const [x,direction]of [[left,1],[right,-1]]){ruler.fillStyle='#3b65d4';ruler.beginPath();ruler.moveTo(x,0);ruler.lineTo(x+direction*8,0);ruler.lineTo(x,9);ruler.fill();g.strokeStyle='#3b65d480';g.beginPath();g.moveTo(x,0);g.lineTo(x,h);g.stroke();}}
  const playX=state.tick*cw-sx;if(playX>=0&&playX<rulerWidth){ruler.fillStyle=accent;ruler.beginPath();ruler.moveTo(playX-6,0);ruler.lineTo(playX+6,0);ruler.lineTo(playX+6,5);ruler.lineTo(playX,11);ruler.lineTo(playX-6,5);ruler.fill();}
}
