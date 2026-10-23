/** Capabilities are explicit for hosted servers; old desktop servers retain their local defaults. */
export function serviceCapabilities(value) {
  const valid = !!value && typeof value === 'object' && !Array.isArray(value);
  const info = valid ? value : {};
  const mode = info.mode === 'hosted' ? 'hosted' : info.mode === 'local' || valid && info.mode === undefined ? 'local' : 'unknown';
  const local = mode === 'local', features = info.features || {};
  const enabled = (name, fallback) => typeof features[name] === 'boolean' ? features[name] : fallback;
  return {...info, mode, features: {
    transcode: mode !== 'unknown' && enabled('transcode', local),
    presence: local && enabled('presence', !!info.discord),
    launchFile: local && enabled('launchFile', true),
    fetchSong: local && enabled('fetchSong', true),
  }};
}

export function audioServiceDescription(value) {
  const info = serviceCapabilities(value);
  return info.mode === 'hosted'
    ? 'Rust 混响与 WAV 渲染在浏览器中完成。原采样率立体声 WAV 直接下载；其他格式、重采样或单声道会在点击导出后，将渲染出的 WAV 发送到网站服务器编码，再下载结果。'
    : info.mode === 'local'
      ? '使用同一 Rust 混响核心在浏览器渲染；其他格式、重采样和单声道由您电脑上的本地 FFmpeg 完成。'
      : 'Rust 混响与原采样率立体声 WAV 在浏览器中生成；当前无法确认额外编码服务是否可用。';
}

/** Retry an expired hosted session once; Origin denials and desktop token errors remain final. */
export async function requestService(path, body, {binary = false, getCapabilities, refreshCapabilities, fetchImpl = globalThis.fetch} = {}) {
  const feature = ({'/api/transcode': 'transcode', '/api/presence': 'presence', '/api/fetch-song': 'fetchSong'})[path.split('?')[0]];
  if (!feature) throw new Error('未知的服务功能。');
  let info = await getCapabilities();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!info.features[feature]) throw new Error('当前服务不提供这项功能。');
    const response = await fetchImpl(path, {method: 'POST', credentials: 'same-origin', headers: {'X-NBS-Token': info.token, 'Content-Type': binary ? 'audio/wav' : 'application/json'}, body: binary ? body : JSON.stringify(body)});
    if (response.ok) return response;
    let error;
    try { error = await response.json(); } catch { /* Preserve the HTTP error for non-JSON responses. */ }
    if (attempt === 0 && info.mode === 'hosted' && response.status === 403 && error?.code === 'SESSION_REQUIRED' && refreshCapabilities) {
      info = await refreshCapabilities(info);
      continue;
    }
    const failure = new Error(error?.error || error?.message || `${info.mode === 'hosted' ? '网站' : '本地'}服务返回 ${response.status}`);
    const retryAfter = response.headers.get('retry-after');
    failure.status = response.status;
    failure.code = error?.code;
    failure.retryAfterMs = retryAfter === null ? null : /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
    throw failure;
  }
}

/** Resource-pack batches alone wait for shared-server capacity; ordinary exports remain one attempt. */
export async function retryResourceEncoding(operation, {onWait = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxRetries = 4, maxWaitMs = 180000} = {}) {
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 8 || !Number.isFinite(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > 300000) throw new Error('资源包编码重试限制无效。');
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const limited = error.status === 429, busy = error.status === 409 && error.code === 'TRANSCODE_BUSY';
      if (!limited && !busy) throw error;
      const hinted = error.retryAfterMs, delay = Math.max(1000, Number.isFinite(hinted) && hinted >= 0 ? hinted : 2000 * 2 ** attempt);
      if (attempt >= maxRetries || waited + delay > maxWaitMs) {
        const failure = new Error(limited ? '服务器编码请求较多，自动等待已达上限；请稍后重新导出资源包。' : '服务器正在为其他访客编码，自动等待已达上限；请稍后重新导出资源包。');
        failure.cause = error;
        throw failure;
      }
      waited += delay;
      for (let remaining = delay; remaining > 0; remaining -= 1000) {
        onWait({remainingSeconds: Math.ceil(remaining / 1000), retry: attempt + 1, status: error.status});
        await sleep(Math.min(1000, remaining));
      }
    }
  }
}

/** Accept the native nbs:// wrapper, but never file:, data:, credentials or executable schemes. */
export function songURL(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('请输入有效的 HTTP(S) 曲谱链接。');
  let input = value.trim();
  if (/^nbs:\/\//i.test(input)) input = input.slice(6).replace(/^(https?)\/\//i, '$1://');
  let url;
  try { url = new URL(input); } catch { throw new Error('请输入有效的 HTTP(S) 曲谱链接。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('曲谱链接只允许不含用户名和密码的 HTTP(S) 地址。');
  return url;
}

const LOCAL_IMPORT = '可先在浏览器下载该曲谱，再通过“打开文件”导入。';
function filenameFor(response, url) {
  const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  const disposition = response.headers.get('content-disposition') || '';
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const simple = /filename\s*=\s*"([^"]*)"/i.exec(disposition)?.[1] ?? /filename\s*=\s*([^;]+)/i.exec(disposition)?.[1];
  let candidate = response.headers.get('x-nbs-filename') || encoded || simple || url.pathname.split('/').at(-1) || 'song';
  try { candidate = decodeURIComponent(candidate.trim()); } catch { /* Keep literal malformed escapes in the display filename. */ }
  candidate = candidate.split(/[\\/]/).at(-1).replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/, '').slice(0, 240) || 'song';
  if (!/\.(nbs|midi?|json|nbp|nbpz|zip)$/i.test(candidate)) candidate += /midi/.test(type) ? '.mid' : /json/.test(type) ? '.json' : '.nbs';
  return {filename: candidate, mime: type || 'application/octet-stream'};
}

/** Called only by the user's URL-import action. No server proxy, cookies, or no-cors opaque response. */
export async function fetchSongInBrowser(input, {fetchImpl = globalThis.fetch, maxBytes = 128 * 1024 * 1024, timeoutMs = 45000} = {}) {
  const requested = songURL(input);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024 || !Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('曲谱下载限制无效。');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader, response;
  try {
    try { response = await fetchImpl(requested.href, {method: 'GET', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', signal: controller.signal}); }
    catch (error) { if (controller.signal.aborted || error.name === 'AbortError') throw new Error(`浏览器读取曲谱超时。${LOCAL_IMPORT}`); throw new Error(`浏览器无法读取此链接：可能是来源未允许 CORS、HTTPS 混合内容或网络不可用。${LOCAL_IMPORT}`); }
    if (!response.ok) throw new Error(`链接返回 HTTP ${response.status}。${LOCAL_IMPORT}`);
    if (response.type === 'opaque') throw new Error(`链接未提供可读取的跨域响应（CORS）。${LOCAL_IMPORT}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel(); throw new Error(`链接曲谱超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 下载限制。${LOCAL_IMPORT}`); }
    const finalURL = response.url ? songURL(response.url) : requested;
    const chunks = []; let length = 0;
    if (response.body) {
      reader = response.body.getReader();
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) { await reader.cancel(); throw new Error(`链接曲谱超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 下载限制。${LOCAL_IMPORT}`); }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return {bytes, ...filenameFor(response, finalURL), url: finalURL.href};
  } catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError') throw new Error(`浏览器读取曲谱超时。${LOCAL_IMPORT}`);
    if (!error.message?.includes(LOCAL_IMPORT)) throw new Error(`浏览器读取曲谱失败：${error.message}。${LOCAL_IMPORT}`);
    throw error;
  } finally { clearTimeout(timer); reader?.releaseLock(); }
}
