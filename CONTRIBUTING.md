# 开发与贡献

本项目以纯静态网站交付。Node.js 只用于构建、测试和本机开发预览；部署端只提供静态文件，不依赖应用 API、本机程序或服务器编码。

## 本地工作

需要 Node.js 18+，建议 24。已提供浏览器依赖和编译后的 WASM，不需要 `npm install`。

```sh
npm run build
npm start
npm test
```

按终端地址访问开发预览。生产只上传 `dist/` 内容，见 [部署说明](docs/DEPLOYMENT.md)。首次 HTTPS / localhost 访问可能由 Service Worker 自动重载一次，以建立实时音频的跨源隔离；不要以禁用 SharedArrayBuffer 或更换 DSP 来绕过环境问题。

## 修改边界

- UI 与项目操作放在浏览器模块中。大批量变换应先验证再原子提交，保留撤销语义、图层锁定和数量限制。
- 文件解析与 IndexedDB 写入由文件 Worker 负责。完整工程包携带 PCM，曲谱快照只保存曲谱；修改存储格式时保留明确的迁移路径。
- 实时播放和 WAV 导出使用同一 Rust 核心；逐轨混响状态保持独立。AudioWorklet 只消费短音频块，不做网络、文件解码或大块分配。
- 浏览器编码器、核心、Worker 与许可证随静态包分发，不在用户操作时从 CDN 下载代码，也不上传音频换取转码。
- URL 导入保留 CORS、大小与时间限制；Web MIDI 只在用户明确操作后申请权限。没有原生 Discord、文件关联、任意本机路径或 DLL 执行桥接。

## Rust 重建

只有修改 DSP 才需要 Rust/Cargo 与 `wasm32-unknown-unknown` 目标：

```sh
./scripts/build-wasm.sh
```

Windows 可用 `powershell -ExecutionPolicy Bypass -File scripts/build-wasm.ps1`。Cargo 项目无外部 crates，使用离线构建、SIMD128 和 release/LTO；标量构建用于独立对照。更新随包 WASM 时，同时验证 ABI、采样、混响独立性及相关音频测试。

## 验证与提交

运行适合改动的测试，再运行项目要求的完整检查。浏览器改动要检查真实点击、文件下载与重新导入、播放，以及首次 Service Worker 安装后的页面；不能只凭静态截图宣布音频成功。

编码器变更应验证实际文件内容，不能只检查扩展名；格式导出应使用独立解析器或重新导入核对。Minecraft 游戏内、物理 MIDI、跨设备实时性能需要分别记录，不能由单元测试替代。

PR 说明写清具体问题、修改后的行为和已完成的验证，保留材料许可证与来源。历史 [验证记录](docs/VERIFICATION.md) 和 `benchmarks/` 中的本地 Node / 原生 FFmpeg / 桥接记录应保留历史背景，不当作当前静态版验收结果。架构分工见 [ARCHITECTURE](docs/ARCHITECTURE.md)。
