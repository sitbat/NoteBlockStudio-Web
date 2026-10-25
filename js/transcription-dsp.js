// Numerical preprocessing and MT3 decoding follow MuScriptor's MIT implementation.
// See licenses/muscriptor-LICENSE.txt and THIRD_PARTY_NOTICES.md.
const f32=Math.fround;
export const TRANSCRIPTION_RATE=16000,CHUNK_SAMPLES=80000;
export const MT3=Object.freeze({pad:0,eos:1,unk:2,shift:3,pitch:1004,velocity:1132,tie:1134,program:1135,drum:1265,size:1393});
const fail=message=>{throw new Error(message);};

/** Julius-style polyphase sinc resampler; retained input is only the FIR tail. */
export class TranscriptionResampler {
  constructor(sourceRate,targetRate=TRANSCRIPTION_RATE){
    if(!Number.isInteger(sourceRate)||sourceRate<8000||sourceRate>384000||targetRate!==TRANSCRIPTION_RATE)throw new RangeError('转录采样率无效。');
    const gcd=(a,b)=>b?gcd(b,a%b):a,g=gcd(sourceRate,targetRate);
    this.sourceRate=sourceRate;this.targetRate=targetRate;this.old=sourceRate/g;this.next=targetRate/g;
    this.buffer=new Float32Array();this.offset=0;this.received=0;this.produced=0;this.first=0;this.last=0;this.closed=false;
    if(sourceRate===targetRate)return;
    const cutoff=Math.min(this.old,this.next)*.945,width=Math.ceil(24*this.old/cutoff);this.width=width;this.filters=[];
    for(let phase=0;phase<this.next;phase++){
      const all=[];let sum=0;
      for(let index=-width;index<width+this.old;index++){
        const t=Math.max(-24,Math.min(24,(-phase/this.next+index/this.old)*cutoff))*Math.PI;
        const value=f32((t===0?1:Math.sin(t)/t)*Math.cos(t/48)**2);all.push(value);sum+=value;
      }
      let start=0,end=all.length;while(start<end&&Math.abs(all[start])<1e-12)start++;while(end>start&&Math.abs(all[end-1])<1e-12)end--;
      this.filters.push({start:start-width,end:end-width,weights:Float32Array.from(all.slice(start,end),n=>n/sum)});
    }
  }
  push(pcm,{final=false}={}){
    if(this.closed)throw new Error('重采样输入已结束。');
    if(!(pcm instanceof Float32Array)||pcm.some(n=>!Number.isFinite(n)))throw new TypeError('音频必须是有限的 Float32 PCM。');
    if(pcm.length){if(!this.received)this.first=pcm[0];this.last=pcm.at(-1);}
    if(this.sourceRate===this.targetRate){this.received+=pcm.length;this.produced+=pcm.length;this.closed=final;return pcm.slice();}
    const joined=new Float32Array(this.buffer.length+pcm.length);joined.set(this.buffer);joined.set(pcm,this.buffer.length);this.buffer=joined;this.received+=pcm.length;
    const maximum=Math.floor(this.received*this.next/this.old),result=[];
    while(this.produced<maximum){
      const center=Math.floor(this.produced/this.next)*this.old,filter=this.filters[this.produced%this.next];
      if(!final&&center+filter.end>this.received)break;
      let value=0;for(let j=0;j<filter.weights.length;j++){const index=center+filter.start+j,sample=index<0?this.first:index>=this.received?this.last:this.buffer[index-this.offset];value+=sample*filter.weights[j];}
      result.push(value);this.produced++;
    }
    const retain=Math.max(0,Math.floor(this.produced/this.next)*this.old-this.width);
    if(retain>this.offset){this.buffer=this.buffer.slice(Math.min(this.buffer.length,retain-this.offset));this.offset=retain;}
    this.closed=final;return Float32Array.from(result);
  }
}

export class MuscriptorLogMel {
  constructor({window,melFilter}={}){
    this.size=2048;this.bins=1025;this.mels=512;this.hop=160;
    this.window=window||Float32Array.from({length:2048},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/2048));
    if(this.window.length!==2048)throw new Error('模型 Hann 窗长度无效。');
    this.filters=[];
    if(melFilter&&melFilter.length!==1025*512)throw new Error('模型 Mel 滤波器大小无效。');
    const maxMel=f32(2595*Math.log10(1+8000/700)),points=Float32Array.from({length:514},(_,i)=>700*(10**(f32(maxMel*i/513)/2595)-1));
    for(let bin=0;bin<1025;bin++)for(let mel=0;mel<512;mel++){
      const hz=f32(8000*bin/1024),weight=melFilter?melFilter[bin*512+mel]:f32(Math.max(0,Math.min((hz-points[mel])/(points[mel+1]-points[mel]),(points[mel+2]-hz)/(points[mel+2]-points[mel+1]))));
      if(weight>0)this.filters.push([bin,mel,weight]);
    }
    this.reverse=Uint16Array.from({length:2048},(_,i)=>{let out=0;for(let j=0;j<11;j++){out=(out<<1)|(i&1);i>>=1;}return out;});
    this.cos=Float64Array.from({length:1024},(_,i)=>Math.cos(-2*Math.PI*i/2048));this.sin=Float64Array.from({length:1024},(_,i)=>Math.sin(-2*Math.PI*i/2048));
    this.real=new Float64Array(2048);this.imag=new Float64Array(2048);this.magnitude=new Float64Array(1025);this.sums=new Float64Array(512);
  }
  compute(pcm){
    if(!(pcm instanceof Float32Array)||pcm.length!==CHUNK_SAMPLES)throw new RangeError('模型需要 5 秒、16 kHz 的音频块。');
    const output=new Float32Array(501*512),{real,imag,reverse,size}=this;
    for(let frame=0;frame<501;frame++){
      for(let i=0;i<size;i++){let at=frame*160+i-1024;if(at<0)at=-at;if(at>=pcm.length)at=2*pcm.length-2-at;real[reverse[i]]=f32(pcm[at]*this.window[i]);imag[reverse[i]]=0;}
      for(let len=2;len<=size;len*=2){const half=len/2,stride=size/len;for(let start=0;start<size;start+=len)for(let j=0;j<half;j++){
        const a=start+j,b=a+half,tw=j*stride,wr=this.cos[tw],wi=this.sin[tw],r=real[b]*wr-imag[b]*wi,im=real[b]*wi+imag[b]*wr;
        real[b]=real[a]-r;imag[b]=imag[a]-im;real[a]+=r;imag[a]+=im;
      }}
      for(let bin=0;bin<this.bins;bin++)this.magnitude[bin]=Math.hypot(real[bin],imag[bin]);this.sums.fill(0);
      for(const [bin,mel,weight]of this.filters)this.sums[mel]+=this.magnitude[bin]*weight;
      for(let mel=0;mel<512;mel++)output[frame*512+mel]=Math.log(this.sums[mel]+1e-6);
    }
    return output;
  }
}

/** Exact MT3 event ranges and cross-chunk tie rules, with bounded note state. */
export class MuscriptorTokenDecoder {
  constructor({maxNotes=1000000}={}){this.maxNotes=maxNotes;this.notes=[];this.open=new Map();this.nextId=0;this.warnings=0;this.started=false;}
  _close(key,time){const note=this.open.get(key);if(note){note.endSeconds=Math.max(note.startSeconds+.01,time);this.open.delete(key);}}
  _closeAll(time){for(const key of this.open.keys())this._close(key,time);}
  begin(startSeconds,endSeconds){
    if(this.started&&this.prologue)this._closeAll(this.start);
    this.start=startSeconds;this.end=endSeconds;this.time=startSeconds;this.program=null;this.velocity=null;this.prologue=true;this.skip=false;this.ties=new Set();this.started=true;
  }
  promptTokens(bos,{force=false}={}){
    const tokens=[bos];if(!force)return tokens;let previous=null;
    for(const note of [...this.open.values()].sort((a,b)=>a.program-b.program||a.midiKey-b.midiKey)){if(previous!==note.program){tokens.push(MT3.program+note.program);previous=note.program;}tokens.push(MT3.pitch+note.midiKey);}
    tokens.push(MT3.tie);return tokens;
  }
  push(token){
    if(!Number.isInteger(token)||token<0||token>=MT3.size)return;
    const kind=token<3?'special':token<MT3.pitch?'shift':token<MT3.velocity?'pitch':token<MT3.tie?'velocity':token===MT3.tie?'tie':token<MT3.drum?'program':'drum';
    const value=token-({shift:MT3.shift,pitch:MT3.pitch,velocity:MT3.velocity,program:MT3.program,drum:MT3.drum}[kind]||0);
    if(this.prologue){
      if(kind==='tie'){this.prologue=false;this.velocity=null;for(const key of this.open.keys())if(!this.ties.has(key))this._close(key,this.start);}
      else if(kind==='shift'){this.prologue=false;this.skip=true;this.warnings++;this._closeAll(this.start);}
      else if(kind==='program')this.program=value;
      else if(kind==='pitch'&&this.program!==null)this.ties.add(`${this.program}:${value}`);
      return;
    }
    if(this.skip)return;
    if(kind==='shift'){if(value>0)this.time=Math.round(this.start*100+value)/100;return;}
    if(kind==='program'){this.program=value;return;}if(kind==='velocity'){this.velocity=value;return;}
    if(this.time>=this.end)return;
    if(kind==='drum'){this._add({program:0,midiKey:value,isDrum:true,startSeconds:this.time,endSeconds:this.time+.01});return;}
    if(kind==='pitch'&&this.program!==null&&this.velocity!==null){if(this.program>127){this.warnings++;return;}const key=`${this.program}:${value}`;this._close(key,this.time);if(this.velocity>0){const note=this._add({program:this.program,midiKey:value,isDrum:false,startSeconds:this.time});this.open.set(key,note);}}
  }
  _add(note){if(this.notes.length>=this.maxNotes)fail('转录音符达到工程上限，已停止识别。');note.id=`transcribed-${this.nextId++}`;this.notes.push(note);return note;}
  finish(endSeconds){if(this.prologue)this._closeAll(this.start);else for(const [key,note]of this.open)this._close(key,Math.min(endSeconds,note.startSeconds+.01));}
  snapshot(){return this.notes.map(note=>({...note}));}
}
