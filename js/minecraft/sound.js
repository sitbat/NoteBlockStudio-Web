import {INSTRUMENTS} from './blocks.js';
export const resourceId=(value,fallback='song')=>String(value||fallback).toLowerCase().replace(/[^a-z0-9_.-]/g,'_').replace(/^\.+$/,'_').slice(0,80)||fallback;
export const decimal=value=>String(Number(Number(value).toFixed(6)));
export function soundEvent(song,n,{namespace='minecraft',includeOutOfRange=true}={}){
  const key=n.key+(n.pitch||0)/100;let event=n.instrument<16?`minecraft:block.note_block.${INSTRUMENTS[n.instrument]}`:`${resourceId(namespace)}:${resourceId(song.customInstruments[n.instrument-16]?.name,`custom_${n.instrument-16}`)}`;
  let base=33;if(includeOutOfRange&&key<33){event+='_-1';base=9;}else if(includeOutOfRange&&key>57){event+='_1';base=57;}
  return{event,pitch:.5*2**((key-base)/12),extended:key<33||key>57,custom:n.instrument>=16};
}
export function playSoundCommand(song,n,options={}){
  const {event,pitch}=soundEvent(song,n,options),layer=song.layers[n.layer],volume=layer.volume*n.velocity/10000,source=options.source||'record';
  if(!['master','music','record','weather','block','hostile','neutral','player','ambient','voice'].includes(source))throw new Error('Minecraft 声音通道无效。');
  if(options.radius)return `execute at @s run playsound ${event} ${source} @a ~ ~ ~ ${decimal(Math.max(1,Math.min(10000,Number(options.radiusValue)||16)))} ${decimal(pitch)}`;
  const stereo=-(layer.pan+n.pan)/100;return `playsound ${event} ${source} @s ^${decimal(stereo)} ^ ^ ${decimal(volume)} ${decimal(pitch)} 1`;
}
