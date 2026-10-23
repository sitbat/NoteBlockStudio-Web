# 本地运行时与可选服务

Git 源码只保留许可证和来源记录，不提交 Node / FFmpeg 可执行文件。源码启动先提供 Node18+；可选依赖下载见 [RUNTIMES](../docs/RUNTIMES.md)。以下“附带”均指此前生成的本地完整包，以实际文件为准。

编辑、Rust/WASM 播放和浏览器内 WAV 导出使用随包的 `wasm/nbs_dsp.wasm`，不需要安装 Rust、Python 或 GameMaker，也不需要 `npm install`。Node.js 用于本机 HTTP 服务；FFmpeg 用于可选的格式转换。服务只监听 `127.0.0.1`，不会发布到互联网。

| 平台 | Node.js 与入口 | FFmpeg 可发现位置 |
| --- | --- | --- |
| Windows | Node18+；`start.bat` / `start.ps1` 寻找 PATH、本机 Codex 运行时及常见 Node 安装目录 | `runtime/win32-x64/ffmpeg.exe`，其他架构使用对应目录 |
| Linux x86_64 | 已附官方便携 Node24.11.0；`start.sh` 优先使用 `runtime/linux-x64/bin/node` | `runtime/linux-x64/ffmpeg` 或系统 FFmpeg |
| Linux ARM64 | 自行提供兼容的 Node18+；通过 `NODE_BINARY` 指定或放入 PATH | `runtime/linux-arm64/ffmpeg` 或系统 FFmpeg |
| macOS | 自行提供 Node18+；`sh start.sh` 或 `node server.mjs --open`；此平台未实测 | `runtime/darwin-arm64/ffmpeg` / `runtime/darwin-x64/ffmpeg` 或系统 FFmpeg |

FFmpeg 是否随附以对应目录中的实际文件为准。Linux x86_64 便携 Node 不适用于 ARM、musl/Alpine 或所有旧 glibc 系统；这些环境需要兼容运行时。Windows / macOS 的 Node 不随本目录附带。浏览器还需支持 WebAssembly SIMD、SharedArrayBuffer、AudioWorklet 与 Worker，并保留本地服务器提供的跨源隔离响应头。

Windows x86_64 当前附带 Gyan 发行的 FFmpeg9.0.2，归档已核对发行方 SHA256。该构建为 GPLv3，保留完整[许可证](win32-x64/LICENSE)、[发行说明与构建配置](win32-x64/README.txt)和[来源记录](win32-x64/PROVENANCE.md)。

## 显式选择 FFmpeg

启动时按以下顺序探测，选用第一个能正常执行 `-version` 的 FFmpeg：

1. 环境变量 `NBS_FFMPEG` 指向的可执行文件。
2. `runtime/<process.platform>-<process.arch>/ffmpeg`，Windows 文件名为 `ffmpeg.exe`。
3. PATH 中的 `ffmpeg`。

`NBS_FFMPEG` 是一个程序路径，不能填写命令参数或 shell 命令。路径有空格时按所在 shell 的规则加引号。示例只改变当前启动进程的环境：

```sh
NBS_FFMPEG="/opt/ffmpeg/bin/ffmpeg" sh "/path/NoteBlockStudio-Web/start.sh"
```

```powershell
$env:NBS_FFMPEG = 'D:\Tools\FFmpeg\bin\ffmpeg.exe'
& '.\start.ps1'
```

设置路径后需要重启本地服务器，页面刷新不会重新探测。可在“设置 → 本地服务与系统集成”查看能力状态。无 FFmpeg 时仍可编辑、播放和导出浏览器内 WAV；其他格式会明确提示不可用，不会自动下载或安装依赖。

“文件 → 音频导出设置”先用 Rust 生成 WAV，再由本机 FFmpeg 编码为 MP3、FLAC、AIFF、OGG 或 WAV。对应 FFmpeg 构建需提供 `libmp3lame`、`flac`、`pcm_s16be`、`libvorbis` 和 `pcm_s16le`。采样率/通道组合也受具体编码器限制。编码单次最多接收512 MiB WAV、输出512 MiB，只允许一个任务，子进程最多运行120秒；临时文件在完成、失败或取消后清理。歌曲不会上传给编解码服务商。

## 本地集成边界

所有修改接口需要完全相同的 Origin 和服务器每次启动生成的随机令牌，服务器先验证本机 Host。通过 `--open-file` 只授予那一个启动文件，接口不接受任意路径查询；支持 NBS、NBP、NBPZ/ZIP、MIDI 和 JSON，启动文件上限128 MiB。

链接导入只在用户操作后请求 HTTP(S)，拒绝 URL 内的用户名/密码，最多5次重定向、20秒、128 MiB。Discord Presence 默认关闭，手动启用后通过本机 Discord 桌面客户端的 IPC 发送活动信息；关闭时清除活动。它不依赖原归档的 NekoPresence DLL。原归档中的 EXE、DLL 和 Python 模块不会由这些服务加载。

## 来源、许可证与重建

Linux Node 来自[官方24.11.0发布页](https://nodejs.org/en/blog/release/v24.11.0)，下载归档执行前已核对官方 SHA256。保留了完整的[Node及其第三方许可证](linux-x64/LICENSE)、[上游说明](linux-x64/README.md)和[来源与校验值](linux-x64/PROVENANCE.md)。该便携程序不修改系统 PATH、包管理器或全局 Node 设置。

本项目代码及 Rust 核心使用项目 [MIT 许可证](../LICENSE)，素材来源见[第三方说明](../THIRD_PARTY_NOTICES.md)。FFmpeg 的许可取决于构建选项，可能适用 LGPL 或 GPL；请同时保留所用发行包的许可证、构建及来源说明，不把它当作本项目 MIT 代码重新授权。参见 [FFmpeg 官方许可说明](https://ffmpeg.org/legal.html)。使用系统 FFmpeg 时，其二进制和许可证由该系统的软件包提供。

只有重新编译 Rust 核心才需要 Cargo/Rust 和 `wasm32-unknown-unknown` 目标。Linux 命令、运行时覆盖及桌面入口见 [Linux 使用说明](../docs/LINUX.md)。应用运行时不需要 `work/toolchain`；任务本地 Rust 工具链不随本目录分发。
