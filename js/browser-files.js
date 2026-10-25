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

export const TRANSCRIPTION_AUDIO_EXTENSIONS='.wav,.flac,.mp3,.ogg,.oga,.m4a,.aac,.aiff,.aif,.opus,.webm,.weba,.mp4';
const AUDIO_EXTENSION=/\.(wav|flac|mp3|ogg|oga|m4a|aac|aiff|aif|opus|webm|weba|mp4)$/i;
const PROJECT_EXTENSION=/\.(nbs|midi?|json|nbp|nbpz|zip)$/i;
const AUDIO_MIME_EXTENSIONS=Object.freeze({'audio/wav':'.wav','audio/x-wav':'.wav','audio/wave':'.wav','audio/vnd.wave':'.wav','audio/flac':'.flac','audio/x-flac':'.flac','audio/mpeg':'.mp3','audio/mp3':'.mp3','audio/ogg':'.ogg','application/ogg':'.ogg','audio/opus':'.opus','audio/mp4':'.m4a','audio/x-m4a':'.m4a','audio/aac':'.aac','audio/x-aac':'.aac','audio/aiff':'.aiff','audio/x-aiff':'.aiff','audio/webm':'.webm','video/webm':'.webm','video/mp4':'.mp4'});
/** MIDI and project files retain their own import flow, even with a misleading generic audio MIME. */
export function isTranscriptionAudioFile(file){
  const name=String(file?.name||''),type=String(file?.type||'').split(';')[0].trim().toLowerCase();
  if(PROJECT_EXTENSION.test(name)||/^(audio\/(?:x-)?midi|application\/(?:x-)?midi)$/.test(type))return false;
  return AUDIO_EXTENSION.test(name)||Object.hasOwn(AUDIO_MIME_EXTENSIONS,type)||type.startsWith('audio/');
}
export const BROWSER_OPEN_ACCEPT=`.nbs,.mid,.midi,.json,.nbp,.nbpz,.zip,${TRANSCRIPTION_AUDIO_EXTENSIONS},audio/*`;
const LOCAL_IMPORT = '可先在浏览器下载该文件，再通过“打开文件”导入。';
function filenameFor(response, url) {
  const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  const disposition = response.headers.get('content-disposition') || '';
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const simple = /filename\s*=\s*"([^"]*)"/i.exec(disposition)?.[1] ?? /filename\s*=\s*([^;]+)/i.exec(disposition)?.[1];
  let candidate = response.headers.get('x-nbs-filename') || encoded || simple || url.pathname.split('/').at(-1) || 'song';
  try { candidate = decodeURIComponent(candidate.trim()); } catch { /* Keep literal malformed escapes in the display filename. */ }
  candidate = candidate.split(/[\\/]/).at(-1).replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/, '').slice(0, 240) || 'song';
  if (!PROJECT_EXTENSION.test(candidate)&&!AUDIO_EXTENSION.test(candidate)) candidate += /midi/.test(type) ? '.mid' : /json/.test(type) ? '.json' : AUDIO_MIME_EXTENSIONS[type]||'.nbs';
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
