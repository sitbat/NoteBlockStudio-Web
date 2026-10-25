import {isolationEnvironment} from './js/browser-environment.js';

const VERSION = '2', TIMEOUT_MS = 15000, preparations = new WeakMap();
const failure = (code, message) => ({ready: false, code, message});
const workerMatches = (worker, url) => { try { return new URL(worker?.scriptURL).href === url.href; } catch { return false; } };
function bounded(promise, timeoutMs) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SW_TIMEOUT')), timeoutMs); })]).finally(() => clearTimeout(timer));
}
function ownRegistration(registration, url) {
  return [registration?.active, registration?.waiting, registration?.installing].filter(Boolean).every(worker => workerMatches(worker, url));
}
function activatedWorker(registration, url, timeoutMs) {
  const worker = registration?.installing || registration?.waiting || registration?.active;
  if (!worker || !workerMatches(worker, url)) return Promise.reject(new Error('SW_CONFLICT'));
  if (worker.state === 'activated') return Promise.resolve(worker);
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); worker.removeEventListener('statechange', changed); };
    const changed = () => {
      if (worker.state === 'activated') { cleanup(); resolve(worker); }
      else if (worker.state === 'redundant') { cleanup(); reject(new Error('SW_REDUNDANT')); }
    };
    worker.addEventListener('statechange', changed);
    timer = setTimeout(() => { cleanup(); reject(new Error('SW_TIMEOUT')); }, timeoutMs);
    changed();
  });
}
function controlledBy(serviceWorker, worker, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); serviceWorker.removeEventListener('controllerchange', changed); };
    const changed = () => {
      if (serviceWorker.controller !== worker) return;
      cleanup(); resolve();
    };
    serviceWorker.addEventListener('controllerchange', changed);
    timer = setTimeout(() => { cleanup(); reject(new Error('SW_TIMEOUT')); }, timeoutMs);
    changed();
  });
}

async function prepare({scope = globalThis, moduleURL = import.meta.url, timeoutMs = TIMEOUT_MS, onStatus = () => {}} = {}) {
  const initial = isolationEnvironment(scope), base = new URL('./', moduleURL), workerURL = new URL('coi-serviceworker.js', base);
  const key = `nbs-static-isolation-${VERSION}:${base.pathname}`;
  const serviceWorker = scope.navigator?.serviceWorker;
  const clearMarker = () => { try { scope.sessionStorage?.removeItem(key); } catch {} };
  if (['FILE_PROTOCOL', 'INSECURE_CONTEXT', 'ISOLATION_POLICY_DENIED', 'SHARED_MEMORY_UNAVAILABLE'].includes(initial.code)) return initial;
  if (initial.ready && !serviceWorker?.getRegistration) { clearMarker(); return initial; }
  try { if (scope.top && scope.self && scope.top !== scope.self) return failure('EMBEDDED_PAGE', '此页面位于嵌入框架中，无法独立启用跨源隔离。请在独立标签页打开这个 HTTPS 网站。'); } catch { return failure('EMBEDDED_PAGE', '请在独立标签页打开这个 HTTPS 网站，以启用 Rust 多线程音频。'); }
  if (!serviceWorker?.register) return initial.ready ? initial : failure('SERVICE_WORKER_UNAVAILABLE', '浏览器未提供 Service Worker，无法在缺少隔离响应头的静态网站启用共享内存。请检查站点权限或使用支持 Service Worker 的浏览器。');
  if (base.origin !== scope.location?.origin || !scope.location?.pathname?.startsWith(base.pathname)) return failure('BOOTSTRAP_SCOPE_INVALID', '静态启动脚本必须与编辑器位于同一来源和目录。请保留完整项目目录结构。');
  if (serviceWorker.controller && !workerMatches(serviceWorker.controller, workerURL)) return initial.ready ? initial : failure('SERVICE_WORKER_CONFLICT', '此目录已由其他 Service Worker 控制；编辑器不会替换或注销它。请使用独立目录部署。');
  let storage;
  const reloadOnce = () => {
    try {
      storage = scope.sessionStorage;
      if (!storage) throw new Error('storage unavailable');
      if (storage.getItem(key) === VERSION) return failure('ISOLATION_RELOAD_FAILED', '启用跨源隔离后已自动重载一次，但浏览器仍未提供共享内存；已停止自动刷新。请普通刷新重试，并检查站点的隔离策略。');
      storage.setItem(key, VERSION);
      if (storage.getItem(key) !== VERSION) throw new Error('storage unavailable');
    } catch { return failure('SESSION_STORAGE_UNAVAILABLE', '浏览器禁止此站点使用会话存储，无法安全限制自动重载次数。请允许此站点存储后手动重试。'); }
    onStatus('静态启动脚本已就绪，正在普通重载一次…');
    scope.location.reload();
    return {ready: false, reloading: true, code: 'RELOADING', message: '正在重载以启用 Rust 多线程音频。'};
  };
  if (!initial.ready) {
    try {
      storage = scope.sessionStorage;
      if (!storage) throw new Error('storage unavailable');
      if (storage.getItem(key) === VERSION) return failure('ISOLATION_RELOAD_FAILED', '启用跨源隔离后已自动重载一次，但浏览器仍未提供共享内存；已停止自动刷新。请普通刷新重试，并检查站点的隔离策略。');
      storage.setItem(key, 'pending');
      if (storage.getItem(key) !== 'pending') throw new Error('storage unavailable');
      storage.removeItem(key);
    } catch { return failure('SESSION_STORAGE_UNAVAILABLE', '浏览器禁止此站点使用会话存储，无法安全限制自动重载次数。请允许此站点存储后手动重试。'); }
  }
  try {
    const existing = await bounded(serviceWorker.getRegistration?.(base.href), timeoutMs);
    if (!ownRegistration(existing, workerURL)) return initial.ready ? initial : failure('SERVICE_WORKER_CONFLICT', '此目录已有其他 Service Worker 注册；请使用独立目录部署编辑器。');
    // Native isolation headers need no new registration; maintain only our existing shim.
    if (initial.ready && !existing && !serviceWorker.controller) { clearMarker(); return initial; }
    onStatus(initial.ready ? '正在检查本站静态脚本更新…' : '正在为静态网站启用跨源隔离…');
    const registration = await bounded(serviceWorker.register(workerURL.href, {scope: base.href, updateViaCache: 'none'}), timeoutMs);
    if (!ownRegistration(registration, workerURL)) throw new Error('SW_CONFLICT');
    if (existing && registration.update) await bounded(registration.update(), timeoutMs);
    if (!ownRegistration(registration, workerURL)) throw new Error('SW_CONFLICT');
    const active = await activatedWorker(registration, workerURL, timeoutMs);
    // A hard-refreshed document may intentionally remain uncontrolled. An active
    // worker is sufficient for the next ordinary navigation; don't wait for a
    // controllerchange that a legacy active worker may never send.
    if (!initial.ready) return reloadOnce();
    if (serviceWorker.controller !== active) active.postMessage?.({type: 'NBS_STATIC_CLAIM'});
    await controlledBy(serviceWorker, active, timeoutMs);
    clearMarker(); return initial;
  } catch (error) {
    return failure(error.message === 'SW_CONFLICT' ? 'SERVICE_WORKER_CONFLICT' : error.message === 'SW_TIMEOUT' ? 'SERVICE_WORKER_TIMEOUT' : 'SERVICE_WORKER_FAILED', error.message === 'SW_CONFLICT' ? '本站启动脚本与已有 Service Worker 冲突，未替换其他注册。' : error.message === 'SW_TIMEOUT' ? '本站静态启动脚本未在限定时间内激活；未重复刷新。请普通刷新重试，并检查网络和脚本是否完整。' : 'Service Worker 启动或更新失败；未自动重复刷新。请确保 coi-serviceworker.js 与 index.html 同目录、以 JavaScript MIME 提供。');
  }
}

/** Coalesce callers in one document; storage only guards the one normal reload. */
export function prepareStaticIsolation(options = {}) {
  const scope = options.scope || globalThis;
  if (preparations.has(scope)) return preparations.get(scope);
  const pending = prepare(options).finally(() => preparations.delete(scope));
  preparations.set(scope, pending); return pending;
}

function bootMessage(document, status) {
  const boot = document?.getElementById('boot');
  if (!boot) return;
  boot.replaceChildren();
  const title = document.createElement('strong'), message = document.createElement('p');
  title.textContent = 'Note Block Studio'; message.textContent = status.message;
  boot.append(title, message);
  if (!status.ready && !status.reloading) {
    const code = document.createElement('p'); code.textContent = `诊断：${status.code}`; boot.append(code);
  }
}

export async function bootstrap({scope = globalThis, loadApp = () => import('./js/app.js'), moduleURL = import.meta.url, timeoutMs = TIMEOUT_MS} = {}) {
  const status = await prepareStaticIsolation({scope, moduleURL, timeoutMs, onStatus: message => bootMessage(scope.document, {reloading: true, message})});
  scope.__NBS_BOOTSTRAP__ = status;
  if (!status.ready) { bootMessage(scope.document, status); return status; }
  try { await loadApp(); return status; }
  catch { const failed = failure('APP_LOAD_FAILED', '编辑器脚本无法加载。请检查静态文件是否完整，以及 .js / .wasm 的 MIME 类型和网站内容安全策略。'); scope.__NBS_BOOTSTRAP__ = failed; bootMessage(scope.document, failed); return failed; }
}

if (typeof window !== 'undefined' && globalThis.document) void bootstrap();
