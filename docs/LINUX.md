# Linux 上使用静态网站

v4 与其他平台使用同一套浏览器站点，不需要 Linux Node 服务、系统 FFmpeg、desktop/MIME 安装或 `nbs://` 协议注册。通过 HTTPS 地址打开网站，使用现代桌面 Chrome / Edge；首次可能由 Service Worker 自动重载一次，随后点击播放。

选择或拖入 NBS / MIDI / JSON / NBP / NBPZ 文件即可编辑，音频编码也在浏览器完成。播放器可使用站点的 `?player=1` 地址。Web MIDI 需要兼容浏览器、驱动与用户授权；尚未完成物理设备验收。

## 构建与本机预览

仅开发/构建机需要 Node.js 18+，建议 24，依赖已随仓库提供：

```sh
git clone https://github.com/sitbat/NoteBlockStudio-Web.git
cd NoteBlockStudio-Web
npm run build
npm start
```

`npm start` 是开发静态预览，默认地址 `http://127.0.0.1:8792/`，按 Ctrl+C 停止；它不提供应用 API，也不要求服务器部署 Node。生产只上传 `dist/` 全部内容，见 [DEPLOYMENT](DEPLOYMENT.md)。

只有修改 DSP 才需要 Rust/Cargo 和 `wasm32-unknown-unknown`：

```sh
sh scripts/build-wasm.sh
```

该构建使用离线 Cargo、SIMD128 并更新 `wasm/nbs_dsp.wasm`。随包 WASM 可直接使用，无需访问者安装 Rust。

## 工程迁移

浏览器存储以协议、主机名和端口组成的来源为边界，更换地址前先下载 `.nbpz` 完整工程包，再在新地址导入。旧本机地址中的自动保存不会自动出现在新网站。曲谱快照不含历史音频。

旧版 `start.sh`、desktop/MIME 与协议安装器不属于当前静态网站入口；不需要用它们启动或部署 v4。

## 历史验证背景

[linux-v3.json](../benchmarks/linux-v3.json) 与 [linux-tests.tap](../benchmarks/linux-tests.tap) 记录早期 ArchLinux 环境中的 Node 启动器、原生 FFmpeg、模拟 IPC、临时 XDG 安装/卸载等测试。保留这些文件用于追溯历史，不把它们作为当前依赖或纯静态浏览器验收结果。

这些历史记录没有验证 Linux 图形浏览器声音、物理 MIDI、真实 Discord 或 Linux 浏览器万轨实时性能；Windows 的性能记录也不能替代 Linux 客户端验收。当前静态测试以 [VERIFICATION](VERIFICATION.md) 中明确标注的环境和版本为准。
