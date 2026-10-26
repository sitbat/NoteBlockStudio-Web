import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const entry=await readFile(new URL('../index.html',import.meta.url),'utf8');
const policies=[...entry.matchAll(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"[^>]*>/gi)];
assert.equal(policies.length,1,'The static entry must deliver one enforced page policy.');
const policy=new Map();
for(const segment of policies[0][1].split(';')){
  const [name,...sources]=segment.trim().split(/\s+/);if(!name)continue;
  assert(!policy.has(name),`Duplicate directive ${name} would hide later restrictions.`);
  policy.set(name,sources);
}
const sources=name=>new Set(policy.get(name)||[]);
const requireSources=(name,values)=>{for(const value of values)assert(sources(name).has(value),`${name} must permit ${value}`);};

test('static CSP is enforced before any stylesheet, script or other active resource',()=>{
  const firstResource=entry.search(/<(?:script|link|style|iframe|object|embed)\b/i);
  assert(firstResource>policies[0].index,'Resources before a meta CSP are not covered by that policy.');
  assert(entry.indexOf('<meta charset=')<policies[0].index);
});

test('page policy rejects inline script, handlers, JS eval and third-party script sources',()=>{
  assert.deepEqual(sources('script-src'),new Set(["'self'","'wasm-unsafe-eval'"]));
  assert.deepEqual(sources('script-src-attr'),new Set(["'none'"]));
  assert(!policies[0][1].includes("'unsafe-eval'"),'WASM compilation must not enable JavaScript eval/Function.');
  for(const [name,values]of policy)if(name.startsWith('script-src'))for(const value of values){
    assert(!['https:','http:','data:','blob:','*',"'unsafe-inline'"].includes(value),`${name} must not accept arbitrary code sources.`);
  }
});

test('the entry does not depend on inline executable scripts or event attributes',()=>{
  for(const script of entry.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    assert(/\bsrc="[^"\s]+"/.test(script[1]),'Executable scripts must use a same-origin file.');
    assert.equal(script[2].trim(),'');
  }
  assert(!/\son[a-z]+\s*=/i.test(entry),'Inline event attributes are disallowed by the page policy.');
});

test('unneeded active content, base overrides and form submissions are denied',()=>{
  for(const name of ['default-src','base-uri','object-src','frame-src','form-action'])assert.deepEqual(sources(name),new Set(["'none'"]),name);
  for(const unsupported of ['frame-ancestors','sandbox','report-uri'])assert(!policy.has(unsupported),`${unsupported} cannot be enforced by a meta policy.`);
});

test('the page retains WASM, local/blob workers, inline layout styles and local media',()=>{
  requireSources('script-src',["'self'","'wasm-unsafe-eval'"]);
  assert.deepEqual(sources('worker-src'),new Set(["'self'",'blob:']));
  requireSources('style-src',["'self'","'unsafe-inline'"]);
  requireSources('img-src',["'self'",'data:','blob:']);
  requireSources('font-src',["'self'",'data:']);
  requireSources('media-src',["'self'",'blob:','data:']);
  requireSources('manifest-src',["'self'"]);
});

test('user-selected URL imports and model/CDN fetches retain HTTP(S) and blob connectivity',()=>{
  requireSources('connect-src',["'self'",'https:','http:','blob:']);
  assert(!sources('connect-src').has('*'),'Explicit schemes keep the network boundary reviewable.');
});
