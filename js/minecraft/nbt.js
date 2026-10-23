/** Bounded Java Edition, big-endian Named Binary Tag codec. No native plugins. */
import {compress,decompress} from '../archive.js';
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
// Java DataInput/DataOutput UTF strings use modified UTF-8 (UTF-16 surrogate
// code units and a two-byte NUL), unlike the UTF-8 project metadata ByteArray.
function encodeString(value){const out=[];for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>0&&c<128)out.push(c);else if(c<2048)out.push(0xc0|(c>>6),0x80|(c&63));else out.push(0xe0|(c>>12),0x80|((c>>6)&63),0x80|(c&63));}return Uint8Array.from(out);}
function decodeString(a){let out='';for(let i=0;i<a.length;){const c=a[i++];if(c<128){out+=String.fromCharCode(c);continue;}if((c&0xe0)===0xc0){const b=a[i++];if(b===undefined||(b&0xc0)!==0x80)throw new Error('NBT 字符串编码无效。');out+=String.fromCharCode(((c&31)<<6)|(b&63));}else if((c&0xf0)===0xe0){const b=a[i++],d=a[i++];if(b===undefined||d===undefined||(b&0xc0)!==0x80||(d&0xc0)!==0x80)throw new Error('NBT 字符串编码无效。');out+=String.fromCharCode(((c&15)<<12)|((b&63)<<6)|(d&63));}else {return dec.decode(a);}}return out;}
export const tag=(type,value)=>({type,value});
export const byte=value=>tag(1,value),short=value=>tag(2,value),int=value=>tag(3,value),long=value=>tag(4,BigInt(value)),float=value=>tag(5,value),double=value=>tag(6,value),bytes=value=>tag(7,value),string=value=>tag(8,value),list=(type,value)=>tag(9,{type,value}),compound=value=>tag(10,value),ints=value=>tag(11,value);
export function encodeNBT(root,name=''){
  const out=[];const u8=v=>out.push(v&255),num=(v,n,set)=>{const a=new Uint8Array(n);new DataView(a.buffer)[set](0,v);out.push(...a);};
  const str=v=>{const a=encodeString(String(v));if(a.length>65535)throw new Error('NBT 字符串超过 65535 字节。');num(a.length,2,'setUint16');for(const b of a)u8(b);};
  function payload(t,v,depth){if(depth>64)throw new Error('NBT 嵌套过深。');switch(t){
    case 1:u8(v);break;case 2:num(v,2,'setInt16');break;case 3:num(v,4,'setInt32');break;case 4:num(BigInt(v),8,'setBigInt64');break;case 5:num(v,4,'setFloat32');break;case 6:num(v,8,'setFloat64');break;
    case 7:num(v.length,4,'setInt32');for(const b of v)u8(b);break;case 8:str(v);break;
    case 9:u8(v.type);num(v.value.length,4,'setInt32');for(const item of v.value)payload(v.type,item,depth+1);break;
    case 10:for(const [key,item] of Object.entries(v)){if(!item||item.type<1||item.type>12)throw new Error('NBT 标签类型无效。');u8(item.type);str(key);payload(item.type,item.value,depth+1);}u8(0);break;
    case 11:num(v.length,4,'setInt32');for(const n of v)num(n,4,'setInt32');break;case 12:num(v.length,4,'setInt32');for(const n of v)num(BigInt(n),8,'setBigInt64');break;default:throw new Error('不支持的 NBT 标签类型。');}}
  u8(root.type);str(name);payload(root.type,root.value,0);return Uint8Array.from(out);
}
export function decodeNBT(input,{maxBytes=128*1024*1024,maxItems=4000000}={}){
  const a=input instanceof Uint8Array?input:new Uint8Array(input);if(a.length>maxBytes)throw new Error('NBT 文件过大。');const view=new DataView(a.buffer,a.byteOffset,a.byteLength);let p=0,items=0;
  const need=n=>{if(n<0||p+n>a.length)throw new Error('NBT 文件截断。');},u8=()=>{need(1);return a[p++];},num=(n,get)=>{need(n);const v=view[get](p);p+=n;return v;},str=()=>{const n=num(2,'getUint16');need(n);const v=decodeString(a.subarray(p,p+n));p+=n;return v;};
  const count=()=>{const n=num(4,'getInt32');if(n<0||(items+=n)>maxItems)throw new Error('NBT 数组大小无效或超限。');return n;};
  function payload(t,depth){if(depth>64)throw new Error('NBT 嵌套过深。');if(++items>maxItems)throw new Error('NBT 标签过多。');switch(t){
    case 1:return num(1,'getInt8');case 2:return num(2,'getInt16');case 3:return num(4,'getInt32');case 4:return num(8,'getBigInt64');case 5:return num(4,'getFloat32');case 6:return num(8,'getFloat64');
    case 7:{const n=num(4,'getInt32');if(n<0||n>maxBytes)throw new Error('NBT 二进制数组大小无效或超限。');need(n);const v=a.slice(p,p+n);p+=n;return v;}case 8:return str();
    case 9:{const child=u8(),n=count();if(child>12||(!child&&n))throw new Error('NBT 列表类型无效。');return Array.from({length:n},()=>payload(child,depth+1));}
    case 10:{const v=Object.create(null);while(true){const child=u8();if(!child)return v;if(child>12)throw new Error('NBT 标签类型无效。');const name=str();if(Object.hasOwn(v,name))throw new Error('NBT 包含重复标签。');v[name]=payload(child,depth+1);} }
    case 11:return Array.from({length:count()},()=>num(4,'getInt32'));case 12:return Array.from({length:count()},()=>num(8,'getBigInt64'));default:throw new Error('NBT 标签类型无效。');}}
  const type=u8();if(type!==10)throw new Error('NBT 根标签必须是 Compound。');const name=str(),value=payload(type,0);if(p!==a.length)throw new Error('NBT 文件包含尾随数据。');return {name,value};
}
export const gzipNBT=async(root,name='')=>compress(encodeNBT(root,name),'gzip');
export async function readNBT(input,options={}){let a=input instanceof Uint8Array?input:new Uint8Array(input);if(a[0]===31&&a[1]===139)a=await decompress(a,'gzip',options.maxBytes||128*1024*1024);return decodeNBT(a,options);}
