# 浏览器 WASM 依赖与来源

v4 的运行时全部在浏览器中。部署目录不包含原生 Node / FFmpeg 可执行文件，服务器不启动应用程序，也不接收音频上传。Node.js 18+ 仅供构建、测试和开发预览使用，建议 24；构建无需 `npm install`。

## Rust 音频核心

[`wasm/nbs_dsp.wasm`](../wasm/nbs_dsp.wasm) 对应 [`rust/src/lib.rs`](../rust/src/lib.rs)，负责采样、声音池、混音和每轨独立 FDN 混响。由多个浏览器 Worker 执行，AudioWorklet 消费共享短音频队列。访问者不需要安装 Rust、Python 或 GameMaker。

重建才需要 Rust/Cargo 与 `wasm32-unknown-unknown`；入口为 `scripts/build-wasm.sh` / `scripts/build-wasm.ps1`。DSP 源码无外部 crates，采用离线 Cargo、SIMD128 和 release/LTO。核心代码适用项目 [MIT 许可证](../LICENSE)。

## FFmpeg WebAssembly

随包目录 [`vendor/ffmpeg/`](../vendor/ffmpeg/) 包含：

| 组件 | 版本与文件 | 许可 |
| --- | --- | --- |
| `@ffmpeg/ffmpeg` 浏览器包装层 | 0.12.15，`esm/` 中的模块与 Worker；元数据见 [ffmpeg-package.json](../vendor/ffmpeg/ffmpeg-package.json) | [MIT](../vendor/ffmpeg/LICENSE-MIT) |
| `@ffmpeg/core` 单线程核心 | 0.12.10，`core/ffmpeg-core.js`、`core/ffmpeg-core.wasm`；元数据见 [core-package.json](../vendor/ffmpeg/core-package.json) | 包元数据标为 GPL-2.0-or-later，保留 [GPLv2](../vendor/ffmpeg/COPYING.GPLv2) / [GPLv3](../vendor/ffmpeg/COPYING.GPLv3) 文本 |

来源为 [ffmpeg.wasm 上游项目](https://github.com/ffmpegwasm/ffmpeg.wasm) 对应 npm 发布包。使用随包的确定版本，不在访问者首次导出时向 npm/CDN 下载执行代码；静态构建完整复制本地 `vendor/`，保留包元数据、许可与来源记录。

核心 WASM 为 32,232,419 字节，约 30.7 MiB；核心自身版本为 FFmpeg 5.1.4 / Emscripten 3.1.40，与 npm 包发布号不同。首次额外格式导出需要加载和初始化，浏览器内存占用高于压缩文件大小。当前 FFmpeg 核心为单线程；实时 Rust DSP 的多 Worker 与单线程编码器是不同路径，不能把前者的万轨性能当作编码速度。

`js/browser-codecs.js` 在浏览器 Worker 和虚拟文件系统中完成 MP3、FLAC、AIFF、OGG 及采样率/通道转换。直接 WAV 使用 Rust 渲染，无需调用 FFmpeg。自定义 Minecraft 资源包的采样先做有界 PCM 变速重采样，再生成 OGG。输入规模、输出内存和具体采样率/格式组合受实现与编码器限制；失败应明确报告，不能只改扩展名。

当前网站默认限制如下：

| 项目 | 限制 |
| --- | --- |
| 单次输入 / 编码输出 | 各 128 MiB |
| 在途任务与输入队列 | 最多 8 个任务，累计输入最多 256 MiB，串行执行 |
| 加载 / 编码超时 | 加载 120 秒，编码 300 秒；失败或取消释放 Worker，后续任务重新初始化 |
| PCM 时长 | 单次最多一小时，仍须满足文件与内存上限 |
| MP3 | 8–48 kHz 的标准采样率，32–320 kbps，单/双声道 |
| OGG Vorbis | 最高 192 kHz，单/双声道 |
| FLAC / AIFF / WAV | 8–384 kHz，单/双声道，受具体编码器组合支持约束 |

不支持的格式/采样率组合会明确报错，不静默更改采样率。队列上限包括正在执行的任务，虚拟文件清理结束后才交接下一项。上述限制针对额外编码，不是 Rust 直接 WAV 的同一项预算；实际浏览器占用还包括 PCM、WASM 堆、输出副本与工程数据。

包装层的 MIT 不会把 FFmpeg 核心或其链接依赖重新授权为 MIT。再分发静态包时保留相应许可、来源与对应源码/构建信息，详见 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)。旧 Gyan Windows FFmpeg 和便携 Linux Node 的许可证、校验与下载命令不适用于这些浏览器组件。

## 浏览器要求与隔离

实时播放需要 WebAssembly SIMD、Worker、SharedArrayBuffer 与 AudioWorklet。HTTPS / localhost 下由随包 Service Worker 为站点建立跨源隔离，首次可能自动重载一次。`file://`、普通远程 HTTP、禁止 Service Worker 或禁止跨源隔离的环境不能提供等价音频能力，不会自动改成另一套 DSP。

Service Worker 透传网络，不缓存项目、音频或编码器，也不建立完整离线资源库。所有浏览器依赖须实际可从静态站点读取，不能假定首次断网启动可用。

## 更新依赖

更新浏览器依赖时同时审查上游版本、包内容、WASM 有效性、Wrapper/Worker/Core 的配套关系、许可证与来源记录。运行实际浏览器编码并验证文件内容，不能用原生 FFmpeg 的成功记录替代 WASM 版本测试。重新构建 `dist/` 后按 [UPDATING](../UPDATING.md) 整体发布。
