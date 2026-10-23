import {noteName} from './model.js';
export function createNativeNoteRenderer(onload=()=>{}){
  const load=path=>{const image=new Image();image.onload=onload;image.src=`assets/original/${path}`;return image;};
  const names=['harp','double-bass','bass-drum','snare-drum','click','guitar','flute','bell','chime','xylophone','iron-xylophone','cow-bell','didgeridoo','bit','banjo','pling',...Array.from({length:18},(_,i)=>`custom-${i+1}`)];
  const colors=names.map((name,i)=>load(`note-blocks/${String(i).padStart(2,'0')}-${name}.png`)),shapes=names.map((_,i)=>load(`note-shapes/${String(i).padStart(2,'0')}.png`)),colorShapes=names.map((_,i)=>load(`note-shapes-color/${String(i).padStart(2,'0')}.png`));
  const glyphs=names.slice(0,16).map((name,i)=>load(`instrument-glyphs/${String(i).padStart(2,'0')}-${name}.png`));glyphs.push(load('instrument-glyphs/16-custom-base.png'));
  const plain=load('note-plain/01.png'),selection=load('selection-overlay/00-frame-0.png');
  const valid=image=>image?.complete&&image.naturalWidth;
  return (ctx,n,{x,y,width=32,height=32,alpha=1,mode='key',selected=false,prefs,dark=false,player=false})=>{
    const frame=n.instrument<16?n.instrument:16+(n.instrument-16)%18,tile=prefs.shapes?(prefs.colors?colorShapes:shapes)[frame]:prefs.colors?colors[frame]:plain;
    ctx.globalAlpha=alpha;ctx.imageSmoothingEnabled=false;
    if(valid(tile))ctx.drawImage(tile,x,y,width,height);else{ctx.fillStyle=dark?'#a4b3bd':'#c6d4e1';ctx.fillRect(x+1,y+1,width-2,height-2);}
    if(prefs.icons&&width>=18){const glyph=glyphs[Math.min(16,n.instrument)];if(valid(glyph))ctx.drawImage(glyph,x+width/2,y+height/2,width/2,height/2);}
    if(!player&&n.pitch){ctx.globalAlpha=Math.min(.5,Math.abs(n.pitch)/100*alpha*.25);ctx.fillStyle=n.pitch<0?'red':'blue';ctx.fillRect(x,y,width-1,height-1);}
    ctx.globalAlpha=1;
    if(!player&&prefs.incompatible&&(n.instrument>=16||n.key<33||n.key>57)){ctx.strokeStyle='#e00000';ctx.lineWidth=1;ctx.strokeRect(x+1.5,y+1.5,width-3,height-3);}
    if(selected){if(valid(selection)){ctx.globalAlpha=.8;ctx.drawImage(selection,x,y,width,height);ctx.globalAlpha=1;}ctx.strokeStyle=prefs.accent||'#0078d4';ctx.lineWidth=2;ctx.strokeRect(x+1,y+1,width-2,height-2);ctx.lineWidth=1;}
    if(width>=22){let name=noteName(n.key);if(prefs.flat)name=name.replace('C♯','D♭').replace('D♯','E♭').replace('F♯','G♭').replace('G♯','A♭').replace('A♯','B♭');if(!prefs.octaves)name=name.replace(/-?\d+$/,'');ctx.textAlign='center';ctx.textBaseline='top';ctx.font='8px "Segoe UI",sans-serif';ctx.fillStyle=prefs.theme==='classic-dark'?'#fff':'#ffff00';ctx.fillText(name,x+width/2,y+4,width-2);
      if(prefs.numbers){const text=mode==='velocity'?`${Math.round(n.velocity)}`:mode==='pan'?`${n.pan<0?'L':n.pan>0?'R':''}${Math.abs(Math.round(n.pan))}`:mode==='pitch'?`${n.pitch>0?'+':''}${n.pitch}`:n.key<33?'<':n.key>57?'>':String(n.key-33);ctx.font='11px "Segoe UI",sans-serif';ctx.fillStyle='#fff';ctx.fillText(text,x+width/2-(prefs.icons?8:0),y+height/2,width-3);}
    }
  };
}
