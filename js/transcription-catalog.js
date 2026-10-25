/** Small metadata only: importing this file never contacts a model host. */
const catalog=Object.freeze({
  small:Object.freeze({variant:'small',label:'MuScriptor small',url:'https://www.modelscope.cn/models/MuScriptor/muscriptor-small/resolve/master/model.safetensors',bytes:411888600,sha256:'bbd482c786b895cf7d8f44185073d951adae2ebb8a66f82ca84cd1f84569549c',revision:'dac5b012f7b9fdc5d4fd6eda846cf0c541571671',packageURL:new URL('../assets/transcription/small/model.json',import.meta.url).href,available:true}),
  medium:Object.freeze({variant:'medium',label:'MuScriptor medium',url:'https://www.modelscope.cn/models/MuScriptor/muscriptor-medium/resolve/master/model.safetensors',bytes:1228144472,sha256:'ac80adbdf85d87231735fd948af7013441c0afced316c4e9067fd5d8a7fb97ec',revision:'a29bf177425f8bc584bee29dbf84a498aeb8420f',packageURL:new URL('../assets/transcription/medium/model.json',import.meta.url).href,available:true})
});
export function getTranscriptionDownloadInfo(variant){return Object.hasOwn(catalog,variant)?catalog[variant]:Object.freeze({variant,label:'MuScriptor large',available:false,bytes:0,url:null,packageURL:null,unavailableReason:'此档模型请使用兼容的本地浏览器模型包。'});}
