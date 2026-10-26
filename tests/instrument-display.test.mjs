import test from 'node:test';
import assert from 'node:assert/strict';
import {renderInstrumentChoices} from '../js/instrument-display.js';
import {normalizeSong} from '../js/model.js';
import {INSTRUMENTS} from '../js/audio.js';

// A DOM sink adapter: any attempt to interpret a string as markup fails.
// It deliberately does not emulate HTML parsing or script execution.
function fixture(){
  const document={createElement(tag){
    const element={ownerDocument:document,tagName:tag.toUpperCase(),children:[],dataset:{},attributes:new Map(),textContent:'',hidden:false,
      style:{properties:new Map(),setProperty(name,value){this.properties.set(name,value);}},
      setAttribute(name,value){this.attributes.set(name,String(value));},
      append(...children){this.children.push(...children);},replaceChildren(...children){this.children=[...children];}};
    Object.defineProperty(element,'innerHTML',{set(){throw new Error('Imported display strings must never be interpreted as HTML');}});
    return element;
  }};
  return {rack:document.createElement('div'),popup:document.createElement('div'),select:document.createElement('select')};
}

test('instrument controls render imported names, paths and symbols as text and ignore CSS/attribute payloads',()=>{
  const controls=fixture(),markup='<img src=x onerror="globalThis.untrusted=true">',path='" autofocus onfocus="globalThis.untrusted=true',symbol='<svg onload="globalThis.untrusted=true">';
  const song=normalizeSong({customInstruments:[{name:markup,file:path,key:45,symbol,color:'red;background-image:url(https://invalid.example/leak)',onmouseover:'untrusted',extension:{preserved:true}}]});
  const imported=song.customInstruments[0];
  renderInstrumentChoices(controls,[{id:16,name:imported.name,englishName:imported.file,symbol:imported.symbol,color:imported.color}],16,1);
  for(const button of [controls.rack.children[0],controls.popup.children[0]]){
    assert.equal(button.children[0].textContent,symbol);assert.equal(button.children[1].textContent,markup);
    assert.equal(button.style.properties.get('--inst-color'),'#b6e878');assert.equal(button.title,`${markup} · ${path}（双击重新加载音色）`);
    assert.deepEqual([...button.attributes.keys()],['aria-label','aria-pressed']);assert.equal(button.attributes.get('aria-pressed'),'true');
  }
  assert.equal(controls.select.children[0].textContent,`${markup} · ${path}`);assert.equal(controls.select.value,'16');
  assert.deepEqual(song.customInstruments[0].extension,{preserved:true},'display hardening must not discard project extensions');
});

test('rack visibility, complete popup, selection, symbols and original colors remain intact',()=>{
  const controls=fixture();renderInstrumentChoices(controls,INSTRUMENTS,3,5);
  assert.equal(controls.rack.children.length,16);assert.equal(controls.popup.children.length,16);assert.equal(controls.select.children.length,16);
  for(let i=0;i<16;i++){
    assert.equal(controls.rack.children[i].hidden,i>=5);assert.equal(controls.popup.children[i].hidden,false);
    assert.equal(controls.rack.children[i].dataset.instrument,String(i));assert.equal(controls.rack.children[i].style.properties.get('--inst-color'),INSTRUMENTS[i].color);
    assert.equal(controls.rack.children[i].children[0].textContent,INSTRUMENTS[i].symbol);
  }
  assert.equal(controls.rack.children[3].className,'instrument-card active');assert.equal(controls.select.value,'3');
  assert.notEqual(controls.rack.children[0],controls.popup.children[0],'popup owns independent nodes');
});

test('invalid display IDs and non-string style fields cannot become markup or CSS',()=>{
  const controls=fixture();renderInstrumentChoices(controls,[{id:'0" onclick="bad',color:'#fff'},{id:271},{id:270,name:'unknown',symbol:{html:'bad'},color:{toString:null}}],270,1);
  assert.equal(controls.rack.children.length,1);assert.equal(controls.rack.children[0].dataset.instrument,'270');
  assert.equal(controls.rack.children[0].style.properties.get('--inst-color'),'#b6e878');assert.equal(controls.rack.children[0].children[0].textContent,'');
});
