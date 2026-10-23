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

Web 版本没有复用归档中的原生 DLL 或 Python 模块。采样播放、变调、声音混合和独立混响使用本次编写的无第三方 crate 依赖的 Rust / WASM 核心；JavaScript 与浏览器 API 负责 UI、解码、线程传输、最终合并和文件。Node 服务器仅使用 Node.js 标准库。界面图形没有引入独立的外部图标包，原版精灵帧保存在 assets/original/。

本地完整包可另行附带官方 Linux x86_64 Node24.11.0，保留 [完整 Node 及第三方许可证](runtime/linux-x64/LICENSE) 与 [来源记录](runtime/linux-x64/PROVENANCE.md)。Git 源码不包含 Node 可执行文件。

Windows 本地完整包可附带 Gyan 分发的 FFmpeg9.0.2 essentials（FFmpeg 官方下载页链接的分发方），执行前已验证官方归档 SHA256。其 **GPLv3 许可证独立于本编辑器 MIT 许可证**；保留 [完整许可证](runtime/win32-x64/LICENSE)、[上游构建说明](runtime/win32-x64/README.txt) 和 [来源/源码版本及校验值](runtime/win32-x64/PROVENANCE.md)。Git 源码不包含 FFmpeg 可执行文件，Linux 使用系统或用户提供的 FFmpeg。
