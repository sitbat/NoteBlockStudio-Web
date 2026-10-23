# Browser FFmpeg dependency

These are unmodified ESM distribution files from the official npm packages:

| Component | Package | License | Files |
| --- | --- | --- | --- |
| Browser Worker wrapper | `@ffmpeg/ffmpeg@0.12.15` | MIT | `esm/`, `LICENSE-MIT` |
| Single-thread FFmpeg WebAssembly | `@ffmpeg/core@0.12.10` | GPL-2.0-or-later | `core/`, `COPYING.GPLv2`, `COPYING.GPLv3` |

The core identifies itself as FFmpeg 5.1.4, built with Emscripten 3.1.40, SIMD enabled and pthreads disabled. This is a separate dependency from the application's Rust DSP. It uses an ordinary module Worker and does not itself require SharedArrayBuffer. The core's GPL license is separate from the application's MIT license; retain its license and source notices when redistributing it.

`core/ffmpeg-core.wasm` is 32,232,419 bytes; `core/ffmpeg-core.js` is 111,804 bytes. They are loaded on the first encoding request. The wrapper files add about 32 KiB. Browser memory use also includes decoded input, the WASM heap and encoded output; download size is not a memory estimate.

The application always supplies explicit same-origin `classWorkerURL`, `coreURL` and `wasmURL` from `js/browser-codecs.js`. The upstream wrapper's unused CDN fallback constant remains unmodified. Encoding does not call that fallback, upload audio, use an API server or run a native executable. Paths are resolved relative to the JavaScript module, including deployment below a URL subdirectory.

`provenance.json` records fixed official package URLs, registry SHA-512 integrity, verified archive SHA-256 and hashes of every supplied distribution/license file. Archives were checked against registry integrity before extraction. The `.d.ts` files are upstream declarations, not runtime package dependencies.

Official source and build information:

- [ffmpeg.wasm source and build scripts](https://github.com/ffmpegwasm/ffmpeg.wasm)
- [Upstream architecture and component versions](https://ffmpegwasm.netlify.app/docs/overview/)
- [FFmpeg 5.1.4 source](https://ffmpeg.org/releases/ffmpeg-5.1.4.tar.xz)
- [FFmpeg license documentation](https://ffmpeg.org/legal.html)
- [Wrapper npm package](https://www.npmjs.com/package/@ffmpeg/ffmpeg/v/0.12.15) and [core npm package](https://www.npmjs.com/package/@ffmpeg/core/v/0.12.10)

The full upstream core includes libraries beyond the five audio codecs used here; its source/build scripts list those libraries and their licenses. GPLv2 is the published core's license baseline; GPLv3 is supplied as the later-license option. This directory contains no Gyan/native FFmpeg program.

Run `node --test tests/browser-codecs*.test.mjs` from the project root for queue, cancellation, bounded-input tests and actual vendored WASM encoding/decoding of MP3, FLAC, AIFF, OGG Vorbis and WAV. Node is a test tool only. Production uses the upstream browser Worker. The application defaults to 128 MiB each for input/output, 256 MiB of queued input, eight pending/active tasks, 120 seconds for loading and 300 seconds per encoding; tasks are serial. MP3 accepts standard sample rates through 48 kHz, Vorbis through 192 kHz, and FLAC/AIFF/WAV through 384 kHz.
