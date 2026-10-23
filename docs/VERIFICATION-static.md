# v4 纯静态验证

2026-10-23，当前 Windows 主机、Edge 155。以下检查使用只提供文件、没有 COOP/COEP 响应头和应用 API 的本机静态站点；没有修改或发布用户的公网服务器。

## 自动回归与静态包

Node 24.19.0，提供独立 scalar WASM 后执行 `node scripts/run-tests.mjs --test-concurrency=2`：**187 项全部通过，0 跳过**。旧 Node 后端、桌面安装与本机更新器已移除，对应专用测试不再属于静态版；网站编辑、文件、MIDI、存储、Minecraft 与真实 Rust/WASM 测试继续运行。

新增检查覆盖 Service Worker 激活/控制/单次重载、权限及冲突诊断、同源响应流和子目录作用域、静态发布白名单/逐文件 SHA256、非法链接与坏 WASM、无后端的文件服务，以及浏览器编码队列、取消、失败恢复和内存边界。真实随包 FFmpeg WASM 还逐一编码五种格式，再反解码为指定采样率、双声道非零 PCM；该自动测试使用 Node 测试适配器，下面另做了实际浏览器 Worker 验收。

`scripts/smoke-static.mjs` 对静态站点逐文件检查清单、字节长度、SHA256 和 WASM MIME。服务器本身未发送隔离响应头；首次进入后，随包 Service Worker 自动接管并重载，编辑器成功启动。HTTP smoke 检查不能单独证明浏览器已隔离，实际播放验收补足了这一点。

## 万轨实时播放

48 kHz、14 Worker、256 帧、4 块预读，预热 3 秒后持续测试约 **60.254 秒**：

| 指标 | 实测 |
| --- | --- |
| 最低同时发声 / 独立混响轨道 | 10000 / 10000 |
| 启动与稳态欠载 / 丢声 | 0 / 0 |
| 非零输出 | RMS 0.032168，峰值 0.091845 |
| 播放中修改 | 第 10000 轨混响从 50% 调至 74%，1 次在线控制 |
| 最大控制排队 / 确认 | 18.667 / 9.560 ms |
| 配置预读 | 21.333 ms |

原始证据：[完整报告](../benchmarks/edge-v4-static-w14-f256-lead4-live-60s.json)。报告判定实时通过；预读、控制确认和浏览器估计声卡延迟是不同指标，不是端到端声学测量。结果只对应本次设备和负载。

## 浏览器编码与工程

在同一个无后端静态页面实际点击导出初始练习曲，FFmpeg 在浏览器的模块 Worker 中运行。随后使用离线 FFprobe 检查下载内容；FFprobe 仅用于验证，没有参与生成文件。

| 下载 | 真实编码 | 采样率 / 声道 |
| --- | --- | --- |
| MP3 | MP3 | 44100 / 2 |
| FLAC | FLAC | 44100 / 2 |
| AIFF | PCM s16be | 44100 / 1 |
| OGG | Vorbis | 44100 / 1 |
| 转换 WAV | PCM s16le | 44100 / 1 |
| 直接 WAV | PCM s16le | 48000 / 2 |

各文件时长约 12.850 秒。证据：[音频属性](../benchmarks/browser-v4-static-exports.json)。

载入内置 `The Ground's Colour Is Yellow` 示例，实际生成包含 1 个自定义音色、基准/低/高音域共 3 个 OGG 的 Minecraft 资源包。均为 48 kHz、单声道 Vorbis，时长约 0.747083 / 2.988333 / 0.186771 秒，变速比例约 1 / 4 / 0.25。证据：[资源包音频](../benchmarks/browser-v4-static-resourcepack.json)。

同一示例的 12919 个音符、45 图层与自定义 PCM 自动保存后刷新恢复；刷新前后实际下载的完整工程包，各条目内容逐字节相同，包含自定义 `samples/0.wav`。证据：[恢复校验](../benchmarks/browser-v4-static-project-reload.json)。

## 验证范围

当前没有应用服务器、编码 API、音频上传、原生 FFmpeg 或 Node 部署进程。开发预览与自动测试使用 Node，不进入发布的静态目录。静态网站仍需 HTTPS 或 localhost，以及允许 Service Worker、共享内存和音频的浏览器；本次不替代用户真实域名的最终上传验收。物理 MIDI、Minecraft 游戏内执行、其他设备和完整离线启动未在本轮实机覆盖。
