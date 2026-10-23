# 来源与作者说明

本地 Web 版本根据提供归档中的 Open Note Block Studio 项目实现，应用界面素材与音色取自同一归档；可选运行时另有下文列出的下载来源。原项目的 MIT 许可证已原样保存在本目录的 `LICENSE` 文件中：Copyright (c) 2024 OpenNBS。

## 原项目作者

以下署名来自归档内 `datafiles/Data/credits.txt`：

- Lead developer: Bentroen
- Project managers: Bentroen, encode42
- Developers: Bentroen, chenxi050402
- Former developers: Hielke, ShinkoNet
- Originally created by: David Andrei
- Additional designs: LeakyJAZZ
- Special thanks: the entire note block community

## 随包素材

`assets/` 下的内置音色、图标和示例曲取自用户提供的同一归档，保留原项目来源。

音频素材共 20 个采样：`assets/sounds/` 下的 16 个原生乐器，以及 `assets/sounds/Custom/` 下的 4 个原项目自定义采样：`block.portal.trigger.ogg`、`block.sand.break.ogg`、`entity.experience_orb.pickup.ogg`、`entity.firework.blast_far.ogg`。

`assets/minecraft/extranotes.zip` 与 `assets/minecraft/instrumenttextures.zip` 原样复制自同一归档的 `datafiles/Data/`，分别提供扩展八度音频及包含扩展音频的乐器纹理资源包。下载为指定 Minecraft 版本生成的副本时，仅更新包描述的格式版本；音频与纹理仍保留原来源及其各自权利人，不作重新授权。

四首示例曲的原始署名仍保留在 NBS 文件的元数据中：

| 文件 | NBS 作者 | 原曲作者（文件中的记录） |
| --- | --- | --- |
| Megalovania - Super Smash Bros. Ultimate.nbs | ShinkoNetCavy | Toby Fox |
| Nyan Cat.nbs | chenxi050402 | 未填写 |
| The Ground's Colour Is Yellow.nbs | ShinkoNet | U2 Akiyama |
| Turkish March.nbs | chenxi050402 | Mozart |

`The Ground's Colour Is Yellow.nbs` 的说明还记载：基于 40Nix 的 2A03 版本。原曲与素材的相关权利仍归其各自权利人；此移植没有对其重新授权。

初始练习曲「晨光练习」为本次 Web 移植编写的原创 128 音符示例，保存在 JavaScript 项目数据中。「10,000 轨编辑示例」是本次生成的测试曲谱，不是归档原作。

## 原生版依赖与 Web 版运行时

原项目使用 Microsoft Fluent UI System Icons。相关图标 Copyright (c) 2020 Microsoft Corporation，采用 MIT 许可证；完整许可见 [licenses/fluentui-system-icons-LICENSE.txt](licenses/fluentui-system-icons-LICENSE.txt)，[上游来源](https://github.com/microsoft/fluentui-system-icons)。

原项目署名列出了 Boost.Filesystem、FFmpeg、LAME、NumPy、GMPython、nbswave、audio-DLL、midi-input-DLL、window-DLL、file-DLL、Realtime Blur、7-Zip、Pydub、zlib、Fluent Icons、NekoPresence、Dialog Module、ExecuteShell、File Dropper、pynbs 和 pybind11。

Web 版本没有复用归档中的原生 DLL 或 Python 模块。采样播放、变调、声音混合和独立混响使用本次编写的无第三方 crate 依赖的 Rust / WASM 核心；JavaScript 与浏览器 API 负责 UI、解码、线程传输、最终合并和文件。纯静态网站没有应用服务器。界面图形没有引入独立的外部图标包，原版精灵帧保存在 assets/original/。

## 浏览器音频编码

v4 在浏览器 Worker 中使用随包 FFmpeg/WASM，不使用服务器 Node 或本机 FFmpeg 可执行文件。JavaScript 包装器 `@ffmpeg/ffmpeg` 为 0.12.15、MIT；`@ffmpeg/core` 为 0.12.10，采用其上游所声明的 GPL-2.0-or-later。FFmpeg 核心及其编译组件的许可独立于编辑器 MIT 许可。完整许可证、源码来源和固定校验记录随 `vendor/ffmpeg/` 一起提供，不从第三方 CDN 运行脚本。

此前 v1–v3 本地安装包的运行时说明属于历史版本；v4 静态包不分发这些 Node/FFmpeg 原生可执行文件。
