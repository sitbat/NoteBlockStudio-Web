const MACROS=[['tremolo','震音 / Tremolo…'],['stereo','立体声 / Stereo…'],['arpeggio','琶音 / Arpeggio…'],['portamento','滑音 / Portamento…'],['vibrato','颤音 / Vibrato'],['stagger','错开图层 / Stagger…'],['chorus','合唱 / Chorus'],['volume-lfo','音量 LFO'],['fade-in','淡入'],['fade-out','淡出'],['replace-key','替换音高'],['set-velocity','设置力度…'],['set-panning','设置声像…'],['set-pitch','设置微调音高…'],['reset-properties','重置全部属性']];
const MACRO_KEYS=['a','s','d','f','g','h','j','k','q','w','e','r','t','y','u'];
const MODE_NAMES={key:['升高一个八度','降低一个八度','升高半音','降低半音'],velocity:['增加 10 力度','减小 10 力度','增加 1 力度','减小 1 力度','设定力度…','重置力度'],pan:['向右移动 10','向左移动 10','向右移动 1','向左移动 1','设定声像…','重置声像'],pitch:['上调 10 音分','下调 10 音分','上调 1 音分','下调 1 音分','设定微调音高…','重置微调音高']};
const item=(action,label,shortcut='',icon='',extra={})=>({action,label,shortcut,icon,...extra});
const isZero=value=>value!==undefined&&Number(value)===0;

/** Pure source-derived menu model. Missing state fields preserve older integrations. */
export function buildNativeMenuModel(state={},instruments=[]) {
  const selected=state.selectedCount??state.selectionCount??state.selected?.size,notes=state.noteCount??state.notes?.length;
  const blocked=!!state.busy||!!state.playerMode,noSelection=isZero(selected),empty=isZero(notes);
  const write=(a,l,s='',i='',x={})=>item(a,l,s,i,{disabled:blocked,...x});
  const edit=(a,l,s='',i='',x={})=>write(a,l,s,i,{disabled:blocked||noSelection,...x});
  const mode=typeof state.editMode==='number'?['key','velocity','pan','pitch'][state.editMode]:state.editMode||'key',names=MODE_NAMES[mode]||MODE_NAMES.key;
  function instrumentItems(applyToSelection){
    const list=Array.isArray(instruments)?instruments:[];
    const page=offset=>{
      const rows=list.slice(offset,offset+25).map(ins=>{const id=Number(ins.id);return item(`instrument:${ins.id}`,ins.name||`音色 ${ins.id}`,!applyToSelection&&id<16?(id<9?`Ctrl+${id+1}`:`Ctrl+Shift+${id-8}`):'',id<16?`${String(id+10).padStart(2,'0')}-ins-${id+1}`:'26-custom-ins-base',{kind:'instrument',value:ins.id,applyToSelection,...(applyToSelection?{}:{checked:id===Number(state.instrument),radio:true}),disabled:blocked||(applyToSelection&&noSelection)});});
      if(list.length>offset+25)rows.push(item(`instruments-more:${offset+25}`,'更多…','','',{children:page(offset+25)}));return rows;
    };return page(0);
  }
  const choose=instrumentItems(false);if(choose.length)choose.push(null);choose.push(write('instruments','音色设置…','','42-instruments'),write('importMinecraftSounds','从 Minecraft 游戏文件获取音效…','','42-instruments'));
  return [
    {name:'file',trigger:'fileMenuBtn',label:'文件',items:[
      write('new','新文件','Ctrl+N','00-new'),item('open','打开歌曲…','Ctrl+O','01-open'),item('recent','最近歌曲…','','01-open'),null,
      write('save','保存歌曲','Ctrl+S','02-save'),write('saveAs','另存为…','','03-save-as'),write('saveProject','连带自定义音色保存完整工程包…','','42-instruments'),write('saveOptions','保存选项…'),item('backups','备份与恢复…'),null,
      write('importPattern','导入片段 NBP…'),edit('exportPattern','导出选区为片段 NBP…'),item('importMidiFile','从 MIDI 文件导入…'),item('transcribeAudio','从音频识别音符…','Ctrl+Alt+A'),item('recordHumming','录制哼唱…','Ctrl+Alt+H'),item('transcription','音频转音符面板…','Ctrl+Alt+T'),item('importSchematic','从 Schematic / NBT 文件导入…'),null,
      ...[['audioExport','导出音频…'],['minecraftSchematic','导出为 Schematic…'],['minecraftTrack','导出为直轨 Schematic…'],['minecraftBranch','导出为分支 Schematic…'],['minecraftDatapack','导出为数据包…']].map(([a,l])=>item(a,l,'','',{disabled:empty||!!state.busy})),null,
      item('export','更多导出（MIDI / JSON / WAV）…','','03-save-as'),item('minecraft','Minecraft 导入、导出与资源包…'),item('openURL','从链接打开…','','01-open')
    ]},
    {name:'edit',trigger:'editMenuBtn',label:'编辑',disabled:!!state.playerMode,items:[
      write('undo','撤销','Ctrl+Z','29-undo',{disabled:blocked||state.canUndo===false}),write('redo','重做','Ctrl+Y','31-redo',{disabled:blocked||state.canRedo===false}),null,
      edit('copy','复制','Ctrl+C','33-copy'),edit('cut','剪切','Ctrl+X','35-cut'),write('paste','粘贴','Ctrl+V','37-paste',{disabled:blocked||state.clipboard===false||state.clipboard===null}),edit('delete','删除','Delete','39-delete'),null,
      write('selectAll','全选','Ctrl+A','46-check',{disabled:blocked||empty}),edit('deselect','全不选','','48-check-inactive'),write('invertSelection','反向选择','Ctrl+I','',{disabled:blocked||empty}),
      write('selectInstrument','选择所有当前音色','','',{disabled:blocked||isZero(state.selectedInstrumentCount)||empty}),write('selectOtherInstruments','选择所有其他音色','','',{disabled:blocked||(state.selectedInstrumentCount!==undefined&&notes!==undefined&&state.selectedInstrumentCount===notes)||empty}),null,
      ...['increaseCoarse','decreaseCoarse','increaseFine','decreaseFine'].map((a,i)=>edit(a,names[i],['Ctrl+E','Ctrl+D','Ctrl+R','Ctrl+F'][i])),
      ...(names.length>4?[edit('setModeProperty',names[4],'Ctrl+T'),edit('resetModeProperty',names[5],'Ctrl+G')]:[]),edit('changeInstrument','更改音色…','','',{children:instrumentItems(true)}),null,
      edit('expandSelection','扩展选区 ×2'),edit('compressSelection','压缩选区 ÷2'),edit('macros','宏…','','41-properties',{children:MACROS.map(([id,label],index)=>edit(`macro:${id}`,label,`Ctrl+Shift+${MACRO_KEYS[index].toUpperCase()}`,'',{kind:'macro',value:id}))}),edit('foldOctave','将音符移入音符盒八度范围'),null,
      write('selectionTools','更多选择条件…','','46-check'),write('patterns','图案与分段代码…','Ctrl+Shift+P','33-copy'),write('chords','插入和弦…','','42-instruments'),write('layerTools','图层管理…','','41-properties')
    ]},
    {name:'settings',trigger:'viewMenuBtn',label:'设置',items:[
      write('chooseInstrument','音色','','42-instruments',{children:choose}),null,item('info','歌曲信息…','','40-information'),item('songProperties','歌曲属性…','','41-properties'),item('statistics','歌曲数据…','','40-information'),null,
      item('midi','MIDI 设备与录制…','','43-midi-input'),item('preferences','首选项…','Ctrl+P','41-properties'),null,item('properties','音符属性…','','54-editmode-key'),item('engineSettings','混音与独立混响…','','42-instruments'),item('performance','播放性能…','','55-editmode-vel'),item('tempoTap','敲击测速…','Ctrl+Shift+I'),item('system','浏览器运行信息…','','40-information')
    ]},
    {name:'help',trigger:'helpMenuBtn',label:'帮助',items:[
      item('tutorials','教程视频','','44-help',{children:[...['编写音符盒乐曲','打开 MIDI 文件','将乐曲导入 Minecraft','编辑 Minecraft 乐曲'].map((title,i)=>item(`tutorial:${i+1}`,`第 ${i+1} 集：${title}`,'','',{kind:'tutorial',value:i+1})),null,item('tutorials','观看所有教程')]}),item('help','操作指南…','F1','44-help'),null,
      item('website','原项目官方网站…','','45-internet'),item('sourceWebsite','GitHub 源码…','','45-internet'),item('reportBug','反馈问题…','','45-internet'),null,item('changelog','更新历史…'),item('about','关于…','','40-information')
    ]}
  ];
}

/** Cascading native-style menus; every effect is supplied by the editor. */
export function createNativeMenus(actions,options={}) {
  if(!actions||typeof actions!=='object')throw new TypeError('Menu actions must be an object.');
  const doc=options.document||globalThis.document,view=doc.defaultView||globalThis;
  const triggers=[['file','fileMenuBtn'],['edit','editMenuBtn'],['settings','viewMenuBtn'],['help','helpMenuBtn']].map(([name,id])=>({name,button:doc.getElementById(id)})).filter(m=>m.button);
  const removers=[],panels=[];let current=null,model=[],sequence=0,typeAhead='',typeAt=0;
  const coarse=view.matchMedia?.('(pointer: coarse)'),sheet=()=>view.innerWidth<=799||!!coarse?.matches;
  const listen=(node,type,fn,opts)=>{node.addEventListener(type,fn,opts);removers.push(()=>node.removeEventListener(type,fn,opts));};
  const handler=item=>item.kind==='instrument'?(options.onChooseInstrument||actions.chooseInstrument):item.kind==='macro'?(actions.macro||actions.macros):item.kind==='tutorial'?actions.tutorials:actions[item.action];
  const enabled=item=>!item.disabled&&(item.children?.length?item.children.some(child=>child&&enabled(child)):typeof handler(item)==='function');
  const snapshot=()=>buildNativeMenuModel(options.getState?.()||{},options.getInstruments?.()||[]);
  function syncPanels(){const compact=sheet();for(const [index,panel] of panels.entries()){panel.element.classList.toggle('native-menu-sheet',compact);panel.element.hidden=compact&&index!==panels.length-1;}}
  function truncate(depth){while(panels.length>depth){const panel=panels.pop();panel.parentButton?.setAttribute('aria-expanded','false');panel.element.remove();}syncPanels();}
  function close({restoreFocus=false}={}){const previous=current;truncate(0);current=null;typeAhead='';for(const menu of triggers){menu.button.setAttribute('aria-expanded','false');menu.button.classList.remove('native-menu-trigger-open');}if(restoreFocus)previous?.button.focus({preventScroll:true});}
  function position(panel){
    if(sheet()){for(const key of ['left','top','maxHeight'])panel.element.style[key]='';return;}
    const anchor=panel.parentButton||current?.button;if(!anchor)return;const rect=anchor.getBoundingClientRect(),box=panel.element.getBoundingClientRect();
    let left=panel.parentButton?rect.right-2:rect.left;if(left+box.width>view.innerWidth-3)left=panel.parentButton?rect.left-box.width+2:view.innerWidth-box.width-3;
    const top=Math.max(3,Math.min(panel.parentButton?rect.top-4:rect.bottom,view.innerHeight-Math.min(box.height,view.innerHeight-6)-3));
    panel.element.style.left=`${Math.max(3,left)}px`;panel.element.style.top=`${top}px`;panel.element.style.maxHeight=`${Math.max(60,view.innerHeight-top-3)}px`;
  }
  function back(panel){if(!panel.parent)return;truncate(panel.depth);panel.parentButton.focus({preventScroll:true});}
  function focusEntry(panel,index){if(!panel?.entries.length)return;truncate(panel.depth+1);panel.index=(index+panel.entries.length)%panel.entries.length;const entry=panel.entries[panel.index];entry.button.focus({preventScroll:true});entry.button.scrollIntoView?.({block:'nearest',inline:'nearest'});}
  function invoke(item){if(!enabled(item))return;const callback=handler(item);close({restoreFocus:true});if(item.kind==='instrument')return callback(item.value,{applyToSelection:item.applyToSelection});if(item.kind==='macro'||item.kind==='tutorial')return callback(item.value);return callback();}
  function openChild(panel,entry,{focus=false}={}){if(!entry.item.children?.length||!enabled(entry.item))return;truncate(panel.depth+1);const child=createPanel(entry.item.children,{parentButton:entry.button,parent:panel});entry.button.setAttribute('aria-expanded','true');if(focus)focusEntry(child,0);}
  function createPanel(items,{parentButton=null,parent=null}={}){
    const element=doc.createElement('div'),panel={element,parentButton,parent,depth:panels.length,entries:[],index:-1};
    element.className=`native-menu${parent?' native-submenu':''}`;element.id=`native-menu-${++sequence}`;element.setAttribute('role','menu');element.setAttribute('aria-labelledby',parentButton?.id||current.button.id);
    const heading=doc.createElement('div');heading.className='native-menu-sheet-heading';
    const backButton=doc.createElement('button');backButton.type='button';backButton.className='native-menu-sheet-back';backButton.textContent='‹ 返回';backButton.hidden=!parent;backButton.setAttribute('aria-label','返回上一级菜单');backButton.addEventListener('click',()=>back(panel));
    const title=doc.createElement('strong');title.textContent=parentButton?parentButton.querySelector('.native-menu-label')?.textContent||'菜单':model.find(menu=>menu.name===current.name)?.label||'菜单';
    const closeButton=doc.createElement('button');closeButton.type='button';closeButton.className='native-menu-sheet-close';closeButton.textContent='×';closeButton.setAttribute('aria-label','关闭菜单');closeButton.addEventListener('click',()=>close({restoreFocus:true}));heading.append(backButton,title,closeButton);element.append(heading);
    for(const item of items){
      if(!item){const separator=doc.createElement('div');separator.className='native-menu-separator';separator.setAttribute('role','separator');element.append(separator);continue;}
      const button=doc.createElement('button');button.type='button';button.id=`native-menu-entry-${++sequence}`;button.className='native-menu-item';button.tabIndex=-1;button.dataset.action=item.action;button.disabled=!enabled(item);
      button.setAttribute('role',item.radio?'menuitemradio':typeof item.checked==='boolean'?'menuitemcheckbox':'menuitem');if(typeof item.checked==='boolean')button.setAttribute('aria-checked',String(item.checked));
      if(item.children?.length){button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-expanded','false');}
      const glyph=doc.createElement('span');glyph.className='native-menu-glyph';glyph.setAttribute('aria-hidden','true');
      if(item.checked)glyph.textContent='✓';else if(item.icon){const image=doc.createElement('img');image.src=new URL(`../assets/original/toolbar-${doc.body.classList.contains('theme-dark')?'dark':'light'}/${item.icon}.png`,import.meta.url).href;image.alt='';glyph.append(image);}
      const label=doc.createElement('span');label.className='native-menu-label';label.textContent=item.label;
      const shortcut=doc.createElement('span');shortcut.className='native-menu-shortcut';shortcut.textContent=item.shortcut||'';shortcut.setAttribute('aria-hidden','true');
      const arrow=doc.createElement('span');arrow.className='native-menu-arrow';arrow.textContent=item.children?.length?'›':'';arrow.setAttribute('aria-hidden','true');button.append(glyph,label,shortcut,arrow);element.append(button);
      const entry={button,item};if(!button.disabled)panel.entries.push(entry);
      button.addEventListener('pointerenter',event=>{if(event.pointerType==='touch'||sheet())return;truncate(panel.depth+1);if(button.disabled)return;panel.index=panel.entries.indexOf(entry);button.focus({preventScroll:true});if(item.children?.length)openChild(panel,entry);});
      button.addEventListener('click',()=>{if(item.children?.length)openChild(panel,entry,{focus:true});else invoke(item);});
    }
    element.addEventListener('scroll',()=>{if(!sheet())truncate(panel.depth+1);},{passive:true});panels.push(panel);doc.body.append(element);syncPanels();position(panel);return panel;
  }
  function open(name,{focus=false,last=false}={}){const menu=typeof name==='string'?triggers.find(menu=>menu.name===name):name;if(!menu)return;const next=snapshot(),definition=next.find(item=>item.name===menu.name);if(!definition||definition.disabled)return;close();model=next;current=menu;const panel=createPanel(definition.items);menu.button.setAttribute('aria-expanded','true');menu.button.setAttribute('aria-controls',panel.element.id);menu.button.classList.add('native-menu-trigger-open');if(focus)focusEntry(panel,last?panel.entries.length-1:0);}
  function adjacent(direction){const index=triggers.indexOf(current);for(let step=1;step<=triggers.length;step++){const next=triggers[(index+direction*step+triggers.length*2)%triggers.length];if(!snapshot().find(menu=>menu.name===next.name)?.disabled){open(next,{focus:true});return;}}}
  function findAction(action,definitions=model){for(const menu of definitions)for(const item of menu.items||[]){if(!item)continue;if(item.action===action)return item;if(item.children){const found=findAction(action,[{items:item.children}]);if(found)return found;}}return null;}
  for(const menu of triggers){menu.button.setAttribute('aria-haspopup','menu');menu.button.setAttribute('aria-expanded','false');listen(menu.button,'click',()=>current===menu?close({restoreFocus:true}):open(menu));listen(menu.button,'pointerenter',event=>{if(event.pointerType!=='touch'&&!sheet()&&current&&current!==menu)open(menu);});}
  listen(doc,'pointerdown',event=>{if(current&&!panels.some(p=>p.element.contains(event.target))&&!triggers.some(m=>m.button.contains(event.target)))close();},true);
  listen(doc,'keydown',event=>{
    if(event.isComposing)return;
    if(!current){
      const trigger=triggers.find(m=>m.button===event.target),letter=event.key.toLowerCase();
      if(event.altKey&&!event.ctrlKey&&!event.metaKey&&['f','e','s','h'].includes(letter)){event.preventDefault();event.stopPropagation();open(triggers[['f','e','s','h'].indexOf(letter)],{focus:true});return;}
      if(trigger&&['ArrowDown','ArrowUp','Enter',' '].includes(event.key)){event.preventDefault();event.stopPropagation();open(trigger,{focus:true,last:event.key==='ArrowUp'});}
      else if(trigger&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();event.stopPropagation();const dir=event.key==='ArrowRight'?1:-1;triggers[(triggers.indexOf(trigger)+dir+triggers.length)%triggers.length].button.focus({preventScroll:true});}return;
    }
    event.stopPropagation();
    // Sheet navigation buttons keep their native keyboard click behavior.
    if((event.key==='Enter'||event.key===' ')&&(event.target.classList?.contains('native-menu-sheet-back')||event.target.classList?.contains('native-menu-sheet-close')))return;
    const panel=[...panels].reverse().find(p=>p.element.contains(doc.activeElement))||panels.at(-1),entry=panel?.entries[panel.index];
    if(event.key==='Escape'){event.preventDefault();if(panel?.parent)back(panel);else close({restoreFocus:true});}
    else if(event.key==='ArrowDown'){event.preventDefault();focusEntry(panel,panel.index+1);}
    else if(event.key==='ArrowUp'){event.preventDefault();focusEntry(panel,panel.index<0?panel.entries.length-1:panel.index-1);}
    else if(event.key==='Home'){event.preventDefault();focusEntry(panel,0);}
    else if(event.key==='End'){event.preventDefault();focusEntry(panel,panel.entries.length-1);}
    else if(event.key==='ArrowRight'){event.preventDefault();if(entry?.item.children?.length)openChild(panel,entry,{focus:true});else adjacent(1);}
    else if(event.key==='ArrowLeft'){event.preventDefault();if(panel.parent)back(panel);else adjacent(-1);}
    else if(event.key==='Enter'||event.key===' '){event.preventDefault();if(!entry)focusEntry(panel,0);else if(entry.item.children?.length)openChild(panel,entry,{focus:true});else invoke(entry.item);}
    else if(event.key==='Tab')close({restoreFocus:true});
    else if(event.key==='F1'){event.preventDefault();const help=findAction('help');if(help)invoke(help);}
    else if(event.ctrlKey||event.metaKey){
      const digit=/^Digit([0-9])$/.exec(event.code);
      if(digit){const number=Number(digit[1]);if(!event.shiftKey&&number===0){event.preventDefault();close({restoreFocus:true});actions.resetScale?.();return;}const id=event.shiftKey?(number>=1&&number<=7?number+8:-1):number-1;const settings=model.find(menu=>menu.name==='settings'),choose=findAction('chooseInstrument',[settings]);const findInstrument=items=>{for(const item of items||[]){if(!item)continue;if(item.kind==='instrument'&&Number(item.value)===id)return item;const child=findInstrument(item.children);if(child)return child;}return null;};const instrument=findInstrument(choose?.children);if(instrument){event.preventDefault();invoke(instrument);}return;}
      const key=event.key.toLowerCase(),macroIndex=event.shiftKey?MACRO_KEYS.indexOf(key):-1;
      const action=macroIndex>=0?`macro:${MACROS[macroIndex][0]}`:event.shiftKey&&key==='p'?'patterns':event.shiftKey&&key==='i'?'tempoTap':key==='z'?(event.shiftKey?'redo':'undo'):({n:'new',o:'open',s:'save',y:'redo',c:'copy',x:'cut',v:'paste',a:'selectAll',i:'invertSelection',e:'increaseCoarse',d:'decreaseCoarse',r:'increaseFine',f:'decreaseFine',t:'setModeProperty',g:'resetModeProperty',p:'preferences'})[key];
      if(action){event.preventDefault();const item=findAction(action);if(item)invoke(item);}
    }
    else if(event.key.length===1){const now=performance.now();typeAhead=now-typeAt>700?event.key:typeAhead+event.key;typeAt=now;const index=panel.entries.findIndex(({item})=>item.label.toLocaleLowerCase().startsWith(typeAhead.toLocaleLowerCase()));if(index>=0){event.preventDefault();focusEntry(panel,index);}}
  },true);
  const resize=()=>{syncPanels();const leaf=panels.at(-1);if(sheet()&&leaf&&!leaf.element.contains(doc.activeElement))focusEntry(leaf,Math.max(0,leaf.index));panels.forEach(position);};listen(view,'resize',resize);if(coarse?.addEventListener)listen(coarse,'change',resize);listen(view,'blur',()=>close());
  return {open:name=>open(name,{focus:true}),close,get isOpen(){return !!current;},refresh(){if(current)open(current,{focus:true});},destroy(){close();for(const remove of removers)remove();}};
}
