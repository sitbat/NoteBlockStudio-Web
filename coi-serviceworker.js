// Network-only isolation shim. No CacheStorage, project persistence, or remote proxy.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if (event.data?.type !== 'NBS_STATIC_CLAIM' || !event.source?.url) return;
  const source = new URL(event.source.url), base = new URL(self.registration.scope);
  if (source.origin === base.origin && source.pathname.startsWith(base.pathname)) event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url), base = new URL(self.registration.scope);
  if (request.method !== 'GET' || url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.pathname.slice(base.pathname.length).startsWith('api/') || request.headers.has('range') || request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  event.respondWith((async () => {
    const relative = url.pathname.slice(base.pathname.length);
    const codeAsset = /\.(?:js|mjs|css|wasm)$/.test(relative) || relative === 'static-manifest.json' || relative.startsWith('assets/transcription/');
    const revalidate = codeAsset && ['default', 'force-cache'].includes(request.cache);
    const response = await fetch(request, request.mode === 'navigate' ? {cache: 'no-store'} : revalidate ? {cache: 'no-cache'} : undefined);
    if (response.redirected || response.type === 'opaque' || response.type === 'opaqueredirect' || response.status === 0 || response.status === 206 || response.status === 304 || response.status >= 300 && response.status < 400) return response;
    if (response.url) { const finalURL = new URL(response.url); if (finalURL.origin !== base.origin || !finalURL.pathname.startsWith(base.pathname)) return response; }
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    if (!headers.has('Cross-Origin-Resource-Policy')) headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
  })());
});
