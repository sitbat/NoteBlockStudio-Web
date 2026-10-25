/** Mono microphone capture only. The output is always silent; PCM stays in this browser. */
class TranscriptionCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings=options?.processorOptions||{};
    this.chunkFrames=Math.max(128,Math.min(16384,Math.trunc(settings.chunkFrames)||4096));
    this.maxFrames=Math.max(128,Math.trunc(settings.maxFrames)||sampleRate*600);
    this.pcm=new Float32Array(this.chunkFrames);this.used=0;this.frames=0;this.peak=0;this.stopped=false;
    this.port.onmessage=({data})=>{if(data?.type==='stop')this.stop(data.flush!==false);};
  }
  flush() {
    if(!this.used)return;
    const pcm=this.pcm.slice(0,this.used),peak=this.peak;
    this.used=0;this.peak=0;
    this.port.postMessage({type:'audio',pcm,sampleRate,peak},[pcm.buffer]);
  }
  stop(flush=true) {
    if(this.stopped)return;this.stopped=true;
    if(flush)this.flush();else this.used=0;
    this.port.postMessage({type:'stopped',frames:this.frames});
  }
  process(inputs,outputs) {
    for(const output of outputs)for(const channel of output)channel.fill(0);
    if(this.stopped)return true;
    const channels=inputs[0];if(!channels?.length)return true;
    const frames=channels[0]?.length||0;
    for(let frame=0;frame<frames;frame++) {
      if(this.frames>=this.maxFrames){this.port.postMessage({type:'limit',frames:this.frames});this.stop();break;}
      let value=0;
      for(const channel of channels){const sample=channel[frame];if(Number.isFinite(sample))value+=sample/channels.length;}
      value=Math.min(1,Math.max(-1,value));this.pcm[this.used++]=value;this.frames++;
      this.peak=Math.max(this.peak,Math.abs(value));
      if(this.used===this.chunkFrames)this.flush();
    }
    return true;
  }
}
registerProcessor('nbs-transcription-capture',TranscriptionCaptureProcessor);
