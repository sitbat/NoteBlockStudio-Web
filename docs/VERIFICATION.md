# 本地验证记录 · Rust v3

日期：2026-10-23。记录针对本机回环服务，没有在线站点部署。以下区分文件/协议测试、Linux 服务测试和浏览器实际实时输出。

## 集中自动测试

Windows Node24.19.0，实际运行：

```powershell
$env:NBS_SCALAR_WASM = '任务本地编译的标量 nbs_dsp.wasm'
node --test --test-concurrency=2 --test-reporter=tap tests/*.test.mjs rust/tests/*.test.mjs
```

**180项：179通过、0失败、1项按平台跳过，耗时约4.11秒。** 本轮完整记录见 [windows-v3-tests.tap](../benchmarks/windows-v3-tests.tap)。标量路径已提供，实际 SIMD/标量比较也在其中执行。Windows 上跳过的 POSIX shell 测试在真实 Linux 上另行执行；不是音频或格式测试未通过。

覆盖实际 Rust/WASM ABI、每轨混响隔离、声音池、SIMD/标量、实时监听复音、采样替换/撤销、宏和原版 NBP 字节往返、分段代码、ZIP/完整工程、MIDI 映射与控制器、服务器安全边界、真实 FFmpeg 编码、离线更新/回滚与异常补偿。MIDI 的65535同时音符边界与65536拒绝采用真实大输入，图层分配为 O(N)。Minecraft 独立 NBT/zlib 读者检查真实方块/命令，含13万外部音符和所有七种可视化。

Rust 核心与 v2 相同：Rust/Cargo1.99.1、LLVM23.1.1、wasm32 release/SIMD128，39,275字节，SHA256 `6a6d3c084c111011d962696927c7d304cc83192ac82418eba4a4ba1a72e7cd79`。Windows 原生 cargo test 仍受本机缺 Windows SDK 链接库限制；随附 WASM 实际执行、标量对照及 POSIX 构建成功不能混同于 Windows 原生测试。

## v3 浏览器万轨实时复测

Windows x64、Ryzen9 9950X3D、32逻辑处理器，Edge155，48kHz。默认14 Worker、256帧、4块预读、声音池倍率4。预热3秒后测量约一分钟，10,000轨持续循环发声，全部轨道有独立非零混响。

| 原始报告 | 持续秒数 | 最低活跃 / 丢声 | 启动 / 稳态欠载 | 在线混响变更 |
| --- | --- | --- | --- | --- |
| [第一轮](../benchmarks/edge-v3-w14-f256-lead4-60s.json) | 60.179 | 10000 / 0 | 0 / 0 | 0 |
| [加入控制的一轮，失败](../benchmarks/edge-v3-w14-f256-lead4-live-failed.json) | 约60 | 10000 / 0 | 0 / 1 | 2 |
| **[隔离其他测试后的复测，通过](../benchmarks/edge-v3-w14-f256-lead4-live-60s.json)** | **60.259** | **10000 / 0** | **0 / 0** | **1** |

通过轮在播放中修改第10000轨混响；最大控制队列21.333ms、确认17.120ms，输出非零。配置预读21.333ms，浏览器估计基础延迟10ms、设备输出32ms；这些是不同指标，不声称21.333ms为完整声学延迟。一次失败记录原样保留，说明低预读仍会受系统调度/并行负载影响，不保证任意后台负载都零欠载。

本轮没有更改 Rust 渲染内核；旧吞吐和多个配置的通过/失败记录保留在 [v2验证](VERIFICATION-v2.md) 与 [性能说明](PERFORMANCE.md)。离线吞吐不能代替浏览器 AudioWorklet 实时消费。

## v3 实际界面与文件

- 在 Edge 实际全选128音符、宏设置力度50、撤销回100；插入原版12音符鼓组，重叠替换后132音符。通过手动与自动 IndexedDB 快照恢复为128音符；深色偏好保存并跨重载恢复。
- 用服务器 CLI 明确授予的 `.nbpz` 载入含48kHz、两声道、自制440/660Hz采样的工程。自动保存、页面刷新、取消重新导入后，再次导出完整工程。两份下载包内的float32 WAV与初始采样 **SHA256完全一致**，每轨混响43和自定义音符也保留。见 [browser-v3-files.json](../benchmarks/browser-v3-files.json)。
- 实际点击音频导出，从同一 Rust 核心生成并下载 MP3、FLAC、AIFF。FFprobe确认均为44100Hz，前两者2声道、AIFF1声道。报告见 [MP3](../benchmarks/browser-mp3-ffprobe.json)、[FLAC](../benchmarks/browser-flac-ffprobe.json)、[AIFF](../benchmarks/browser-aiff-ffprobe.json)。这轮界面使用本机已有 FFmpeg7.1；最终随包官方9.0.2的五格式服务另有真实测试。
- 实际导出自定义Minecraft音色包，包含基准、低/高八度三份真正OGG Vorbis与sounds.json；实际导出含Bounce可视化的数据包及两个原附资源包。ZIP条目和文件内容另行解析，未用游戏执行结果冒充。
- 实际MIDI启动文件导入，选择20ticks/s、4倍网格和原版GM预设，再导出NBS以核验80ticks/s和低音八度补偿。
- 最终随包FFmpeg9.0.2还从原示例曲的附带自定义采样实际生成工程包和三份扩展OGG；FFprobe确认48kHz、单声道、Vorbis，低/高八度时长按4倍/四分之一变化。播放器入口实际确认保留播放控件并关闭编辑菜单、录制及网格输入。

外部文件选择器自动化仍受当前Edge扩展文件URL权限限制。上述CLI文件授予、内置样例和实际下载路径已验证；不据此声称浏览器文件选择器自动化通过。没有修改浏览器扩展权限。

## 真实 Linux 与原生服务

经用户授权，把项目复制到既有ArchLinux临时目录，只在临时XDG中测试并随后清理。没有安装系统软件、更改默认关联或保留测试目录。使用官方SHA校验的便携Node24.11.0和VM既有FFmpeg9.0.2。

**14/14通过、0跳过**，含带空格路径启动、包内Node回退、隔离头/WASM MIME与哈希、用户桌面/MIME安装卸载、MP3/FLAC/AIFF/OGG/WAV的FFprobe属性、同源令牌与并发/超时恢复，以及本机Unixsocket Discord模拟握手/活动/清除。证据：[linux-v3.json](../benchmarks/linux-v3.json)、[linux-tests.tap](../benchmarks/linux-tests.tap)。

Windows随包FFmpeg9.0.2下载归档SHA与官方值一致，执行前验证；真实服务测试覆盖五格式和超时/并发控制。Discord默认关闭，实际客户端连接没有开启。

## 尚未实机覆盖

Linux图形浏览器/声卡和Linux万轨实时播放、物理MIDI设备、真实Discord客户端显示、Minecraft客户端/服务器内执行、原GameMaker听感与所有桌面格式的交互均未实机验收。没有原生DLL/Python任意插件ABI兼容承诺。数据与实现边界见 [迁移说明](MIGRATION.md) 和 [功能对照](FEATURE-PARITY.md)。
