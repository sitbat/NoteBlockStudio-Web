/** Explicit diagnostics for the required Rust/SIMD shared-memory backend. No alternate audio backend. */
export function isolationEnvironment(scope = globalThis) {
  if (scope.location?.protocol === 'file:') return {ready: false, code: 'FILE_PROTOCOL', message: '浏览器不能从 file:// 文件启用 Rust 多线程音频。请将完整静态目录放到 HTTPS 网站，或通过 localhost 打开。'};
  if (!scope.isSecureContext) return {ready: false, code: 'INSECURE_CONTEXT', message: 'Rust 多线程音频需要安全上下文。请使用 HTTPS；仅本机 localhost / 127.0.0.1 可使用 HTTP，远程 HTTP 地址不支持。'};
  if (!scope.crossOriginIsolated) {
    let denied = false;
    try { denied = scope.document?.permissionsPolicy?.allowsFeature('cross-origin-isolated') === false; } catch { /* Older browsers may not expose this policy. */ }
    return {ready: false, code: denied ? 'ISOLATION_POLICY_DENIED' : 'NOT_CROSS_ORIGIN_ISOLATED', message: denied ? '网站的 Permissions-Policy 禁止跨源隔离。请允许 cross-origin-isolated，并在独立标签页打开。' : '当前页面尚未获得跨源隔离。HTTPS 静态网站首次打开需允许 Service Worker 并自动重载一次；请在独立标签页打开，检查浏览器站点权限、Service Worker 与网站的隔离策略。'};
  }
  if (typeof scope.SharedArrayBuffer !== 'function') return {ready: false, code: 'SHARED_MEMORY_UNAVAILABLE', message: '页面已隔离，但浏览器仍禁用 SharedArrayBuffer。请检查浏览器安全策略，或使用支持共享内存的新版 Chrome / Edge。'};
  return {ready: true, code: 'READY', message: '跨源隔离与共享内存已就绪。'};
}

export function assertRealtimeEnvironment(context, scope = globalThis) {
  const status = isolationEnvironment(scope);
  const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  if (!status.ready) fail(status.code, status.message);
  if (typeof scope.WebAssembly?.compile !== 'function') fail('WEBASSEMBLY_UNAVAILABLE', '当前浏览器禁用或缺少 WebAssembly，无法加载 Rust SIMD 音频核心。');
  if (typeof scope.Worker !== 'function') fail('WORKERS_UNAVAILABLE', '当前浏览器禁用或缺少专用 Worker，无法运行 Rust 多核音频。请检查站点的 worker-src 安全策略。');
  if (!context?.audioWorklet || typeof scope.AudioWorkletNode !== 'function') fail('AUDIO_WORKLET_UNAVAILABLE', '当前浏览器缺少或禁用 AudioWorklet，无法启动 Rust 实时音频。请使用支持 AudioWorklet 的新版 Chrome / Edge。');
}
