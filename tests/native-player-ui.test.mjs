import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlayerSeekGesture,hasOpenPlayerOverlay} from '../js/native-player-ui.js';
function setup(){let song={length:64};const stops=[],seeks=[],previews=[];const gesture=createPlayerSeekGesture({getSong:()=>song,stopPlayback:reset=>stops.push(reset),seekTo:(tick,options)=>seeks.push({tick,options})},tick=>previews.push(tick));return {gesture,stops,seeks,previews,replace:()=>song={length:32}};}
test('an initially playing drag pauses once, previews locally and resumes once at its final position',()=>{const f=setup();f.gesture.begin({playing:true,tick:4});f.gesture.begin({playing:true,tick:5});for(const value of [10,20,30,40])f.gesture.set(value);assert.deepEqual(f.stops,[false]);assert.equal(f.seeks.length,0);assert.equal(f.gesture.dragging,true);f.gesture.finish();f.gesture.finish();assert.deepEqual(f.seeks,[{tick:40,options:{preview:false,resume:true}}]);assert.equal(f.gesture.dragging,false);});
test('paused seeking stays paused and clamps values to the current song bounds',()=>{const f=setup();f.gesture.begin({playing:false,tick:2});assert.equal(f.gesture.set(NaN),false);f.gesture.set(-3);f.gesture.set(900);assert.deepEqual(f.previews,[0,64]);f.gesture.finish();assert.deepEqual(f.seeks,[{tick:64,options:{preview:false,resume:false}}]);});
test('replacing the song or cancelling a range gesture never resumes a different project',()=>{const f=setup();f.gesture.begin({playing:true,tick:3});f.gesture.set(20);f.replace();assert.equal(f.gesture.finish(),false);assert.deepEqual(f.seeks,[]);f.gesture.begin({playing:true,tick:1});f.gesture.cancel();assert.equal(f.gesture.finish(),false);assert.deepEqual(f.seeks,[]);});

test('a permanent closed context popover does not block fading; open menus, dialogs and popovers do',()=>{
  // Small document fixture implements the selector forms used here independently of menu classes.
  const elements=[{tag:'div',attrs:{id:'contextPopup',class:'native-menu',popover:''},popoverOpen:false}];
  const matches=(element,selector)=>{
    if(selector===':popover-open')return element.popoverOpen;
    const match=/^([a-z]+)?(?:\[([a-z-]+)(?:="([^"]*)")?\])?$/.exec(selector);
    if(!match)return selector.startsWith('.')&&String(element.attrs.class||'').split(/\s+/).includes(selector.slice(1));
    return (!match[1]||element.tag===match[1])&&(!match[2]||Object.hasOwn(element.attrs,match[2])&&(match[3]===undefined||element.attrs[match[2]]===match[3]));
  };
  const document={querySelector:selectors=>elements.find(element=>selectors.split(',').some(selector=>matches(element,selector.trim())))||null};
  assert.equal(hasOpenPlayerOverlay(document),false,'the closed #contextPopup must allow the idle timeout');
  elements[0].popoverOpen=true;assert.equal(hasOpenPlayerOverlay(document),true,'an open section context popup holds the chrome');elements[0].popoverOpen=false;
  const menu={tag:'div',attrs:{role:'menu'}};elements.push(menu);assert.equal(hasOpenPlayerOverlay(document),true,'mounted native menu holds the chrome');elements.pop();
  const dialog={tag:'dialog',attrs:{open:''}};elements.push(dialog);assert.equal(hasOpenPlayerOverlay(document),true,'an open dialog holds the chrome');delete dialog.attrs.open;assert.equal(hasOpenPlayerOverlay(document),false,'closed dialogs do not block the timeout');
});
