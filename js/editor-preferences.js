export const DEFAULT_PREFERENCES=Object.freeze({
  theme:'light',colors:true,shapes:false,icons:false,numbers:true,octaves:false,incompatible:true,
  showLayers:true,showPiano:true,keyNames:true,keyNumbers:false,keyBindings:true,noteChart:false,outOfRange:true,
  keyboardInput:true,selectLastKey:true,keysmax:30,follow:true,followMode:'page',sectionStart:true,sectionEnd:false,mono:false,
  returnMarker:true,fade:true,flat:false,bpm:false,scale:100,wheelMode:'scroll',wheelProperties:true,
  removeEffect:true,rainbow:false,blackout:false,autoBackup:true,backupMinutes:5,accent:'#0078d4',transcriptionDownloadConcurrency:2,
});
export function normalizePreferences(value={}){
  const result={...DEFAULT_PREFERENCES};
  for(const [key,fallback]of Object.entries(DEFAULT_PREFERENCES))if(typeof fallback==='boolean'&&typeof value?.[key]==='boolean')result[key]=value[key];
  if(['light','dark','system','classic','aqua','classic-dark'].includes(value?.theme))result.theme=value.theme;
  if(['page','tick','frame'].includes(value?.followMode))result.followMode=value.followMode;
  if(['scroll','instrument','key'].includes(value?.wheelMode))result.wheelMode=value.wheelMode;
  for(const [key,min,max]of [['keysmax',7,52],['scale',75,150],['backupMinutes',1,60]])if(Number.isFinite(Number(value?.[key])))result[key]=Math.max(min,Math.min(max,Math.round(Number(value[key]))));
  if(/^#[\da-f]{6}$/i.test(value?.accent||''))result.accent=value.accent;
  if(Number.isInteger(value?.transcriptionDownloadConcurrency)&&value.transcriptionDownloadConcurrency>=1&&value.transcriptionDownloadConcurrency<=4)result.transcriptionDownloadConcurrency=value.transcriptionDownloadConcurrency;
  return result;
}
export const PIANO_BINDINGS=Object.freeze(Object.fromEntries([...'1Q2W3ER5T6YU8I9O0PZSXDCVG'].map((key,index)=>[key.toLowerCase(),54+index])));
export function loadPianoBindings(storage){try{const saved=JSON.parse(storage.getItem('nbs-piano-bindings')||'null');if(!saved||typeof saved!=='object')return {...PIANO_BINDINGS};const result={};for(const [key,midi]of Object.entries(saved))if(key.length===1&&Number.isInteger(midi)&&midi>=21&&midi<=108)result[key.toLowerCase()]=midi;return result;}catch{return {...PIANO_BINDINGS};}}
