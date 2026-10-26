/** Render display fields as text, independently of imported JSON extensions. */
const DEFAULT_COLOR='#b6e878';
const display=value=>typeof value==='string'?value:'';

function instrumentButton(document,instrument,selected){
  const button=document.createElement('button'),symbol=document.createElement('span'),name=document.createElement('span');
  const title=display(instrument.name),english=display(instrument.englishName);
  button.type='button';button.className=`instrument-card${selected===instrument.id?' active':''}`;
  button.dataset.instrument=String(instrument.id);
  button.style.setProperty('--inst-color',typeof instrument.color==='string'&&/^#[\da-f]{6}$/i.test(instrument.color)?instrument.color:DEFAULT_COLOR);
  button.title=`${title} · ${english}${instrument.id>=16?'（双击重新加载音色）':''}`;
  button.setAttribute('aria-label',title);button.setAttribute('aria-pressed',String(selected===instrument.id));
  symbol.className='inst-symbol';symbol.textContent=display(instrument.symbol);name.textContent=title;
  button.append(symbol,name);return button;
}

/** Imported strings stay text; attribute names are fixed and colors require hex syntax. */
export function renderInstrumentChoices({rack,popup,select},instruments,selected,visible){
  const document=rack.ownerDocument;
  const list=instruments.filter(instrument=>Number.isInteger(instrument?.id)&&instrument.id>=0&&instrument.id<=270);
  const count=Number.isFinite(visible)?Math.max(0,Math.floor(visible)):list.length;
  rack.replaceChildren(...list.map((instrument,index)=>{
    const button=instrumentButton(document,instrument,selected);button.hidden=index>=count;return button;
  }));
  popup.replaceChildren(...list.map(instrument=>instrumentButton(document,instrument,selected)));
  select.replaceChildren(...list.map(instrument=>{
    const option=document.createElement('option');option.value=String(instrument.id);
    option.textContent=`${display(instrument.name)} · ${display(instrument.englishName)}`;return option;
  }));
  select.value=String(selected);
}
