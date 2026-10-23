# Minecraft 文件与资源包

所有生成与解析均在本地执行。导出的是实际 NBT、红石方块、命令、数据包及声音资源文件；没有调用原项目的 EXE、DLL 或 Python 插件。

## 可用格式

| 格式 | 文件 | 内容 |
| --- | --- | --- |
| Alpha Schematic | `.schematic`，gzip NBT | 旧版 `Blocks` / `Data` 数组、音符盒方块实体、按钮、告示牌；支持 1.11 前后方块实体名称 |
| Java 结构 | `.nbt`，gzip NBT | 实际 `size`、`palette`、`blocks`、方块状态和实体；默认 `DataVersion=1519`（1.13） |
| 分支 | `.schematic` | 1–3 个指定图层、起止范围、左右或居中声像筛选、音量距离、电路开关 |
| 直轨 | `.nbt` | 九条相隔 12 格的空间声道，近似声像和力度；公共按钮及补偿延迟分配电路 |
| 数据包 | `.zip` | Java 1.20.5–1.20.6 或 1.21；每位玩家独立的播放、暂停、停止、重播和有限或无限循环 |

普通 Schematic/结构支持环形、简单、经典布局；每行中继器 5–100 个；10、5、2.5 tick/s；压缩空图层；包括锁定/静音层；乐器支撑方块、过道、电路及地面方块选择。环形和简单布局可带矿车轨道、矿车实体和矿车箱；环形可带循环控制；经典布局可选玻璃地板。经典尺寸比原生代码的估算多保留一行，避免末端转弯被截断。

`includeLocked:false` 会跳过编辑锁定层、静音层，以及存在独奏层时的非独奏层；`true` 则包括这些层。此规则同时用于结构、分支、直轨和数据包，仍保留指定图层及时间范围筛选。导出窗口的“包含锁定图层”可显式选择此行为，API 省略该字段时为 `false`。外部原生 NBS 没有有效 Web 扩展时，原生层状态 `1` 按原版恢复为锁定并静音，`2` 为独奏；有效 Web 扩展则保留网页独立的编辑锁和静音状态。

分支以 10 tick/s 运行；三个图层分别保留自己的力度距离。直轨以 10 tick/s 运行，用九个空间位置近似声音强弱和左右位置。其接线经过整理，功能对应原生导出选项，方块布局并非逐字节复制原项目的实验性直轨/分支输出。`direction` 对原始布局依次旋转 0、90、180、270 度：`north`、`east`、`south`、`west`。

普通音符盒仅使用 NBS key 33–57。结构或直轨开启 `commandBlocks` 后，使用真实 `playsound` 命令方块，可以导出 key 9–81 和微调音高。扩展音域需要额外资源包。普通音符盒不能直接播放外部采样；自定义音色会使用所选支撑方块对应的原版声音，并显示导出提示。命令方块必须在游戏/服务器中启用。

## 数据包与七种可视化

将导出 ZIP 放入世界的 `datapacks` 文件夹并运行 `/reload`，随后以玩家执行导出结果给出的播放命令。每曲提供 `play`、`pause`、`stop`、`restart`、`cleanup` 和 `uninstall`。数据包 ZIP 内的 `README.txt` 保存包含子目录的具体命令。

数据包的 `namespace`、`name` 和 `functionPath` 可区分同一命名空间内的多首乐曲。例如 `{namespace:'album', name:'first', functionPath:'music/disc'}` 生成 `/function album:music/disc/first/play`，其余函数、加载/时钟标签、计分板和可视化实体标记也使用该曲的范围；另一曲应使用不同的 `name` 或路径。不要只按旧示例手写 `namespace:play`。

`functionPath` 是可为空的小写相对子目录，最多 240 字符，可含 `/`、字母数字、`_`、`.` 和 `-`；拒绝绝对路径、反斜线、空路径段及 `.` / `..` 段。`name` 会转为 Minecraft 资源名；Unicode 或空格导致名称变化时附加区分后缀。提供空 `name` 时回退到曲名。为兼容旧调用，API 完全省略 `name` 和 `functionPath` 时仍生成 `namespace:play`。返回值的 `functionPath` 是最终路径，已经包含处理后的曲目 `name`，`commands.play/pause/stop` 可直接展示给用户。

目标 1.21 使用 `data/<namespace>/function/` 和 `pack_format:48`；目标 1.20 使用 `functions/` 和 `pack_format:41`，对应 1.20.5–1.20.6。没有宣称支持所有未来 Minecraft 版本。速度按原版 20 Hz 游戏时钟调度，最高 30 NBS tick/s；超过 20 tick/s 时会在一个游戏 tick 内执行跨过的多个音符时间点。有限循环次数表示首次播放后的重复次数。

可视化包含原项目七种实际实体动画：Arc、Fall、Rise、Bounce、Piano Roll、Fountain、Rittai Onkyou，分别生成不同位置和运动向量的 `falling_block`；立体音响还生成音符粒子。可设置发光、X/Y/Z 偏移、支撑方块。`cleanup` 清理仍存在的本曲可视化实体。它们使用真实游戏实体，建议在用于演奏的世界区域运行。

声音通道、声像、图层音量、力度、微调音高、半径广播和循环起点均写入实际命令。普通单人模式使用 `@s`，把图层音量与音符力度相乘，并按声像偏移位置。`radius:true` 则在演奏者位置向 `@a` 广播，使用统一的半径音量，不采用该单人声像/力度公式。

半径输入 `radiusValue` 的单位为格，合法范围为 `16…100000`，默认 `16`；按原版公式换算为 `playsound` 音量：`1 + (radiusValue - 16) × 0.06`。所以 16 格写入音量 `1`，100 格写入 `6.04`；不能把用户输入格数直接作为音量参数。这是导出命令的换算规则，本轮没有在游戏内测量实际可听边界。

`assets/minecraft/extranotes.zip` 和 `instrumenttextures.zip` 是用户归档内的原始资源包。下载时只调整目标版本的 `pack_format`：1.20 为 32，1.21 为 34。纹理资源包同时包含扩展八度声音。自定义音色资源包需要 OGG/Vorbis；随包 FFmpeg WASM 在浏览器转换后，资源包包含实际音频及 `sounds.json`，没有音频上传或服务器编码服务，不能把 WAV/MP3 改扩展名冒充 OGG。扩展自定义音符还需真实预调低/高八度音频；缺失时会明确提示。

界面在浏览器中把基准、低/高八度变体实际重采样为 48kHz 单声道 WAV，再在本设备编码为 OGG；变速同时改变音高和时长。原始单声道采样及每个变速结果最多 16 Mi 帧，过大时会提示缩短采样。各变体逐项编码、在浏览器打包，不再经过服务器请求限流。编码默认输入/输出各 128 MiB，队列最多 8 项、累计输入 256 MiB，加载超时 120 秒、单次编码超时 300 秒；实际速度和内存取决于客户端，详见 [浏览器运行时](RUNTIMES.md)。

## 从游戏文件导入采样

“导入 Minecraft 音效”可多选 OGG，或通过浏览器文件选择器授权一个音效 / `assets` 文件夹。应用只读取本次选择的文件；不会查找未授权的安装目录，也不下载缺少的游戏资源。

选择包含 `indexes/*.json` 和 `objects/<哈希前两位>/<完整哈希>` 的 assets 目录后，可选择资源版本索引。导入器按索引解析 `minecraft/sounds/*.ogg`，核对对象大小，并在解码前校验 SHA-1；缺失对象会明确报告，不会以空音频代替。索引 JSON 最多 16 MiB，索引项和所选文件各最多 100,000 个。

默认范围为“16 种音符盒采样（推荐）”，识别原版采样名和 Minecraft 别名。可切换“全部非音乐游戏音效”，列出所选版本下所有已授权的 OGG 游戏音效，排除 `music/` 和 `records/`。该模式把识别到的音符盒采样排在前面并默认勾选，其余音效可逐项勾选，也可全选或全部取消；普通音效文件夹同样支持此范围。直接多选 OGG 时，可以导入其它自定义声音。

此音色管理器采用兼容 NBS 的 **240 个自定义音色总上限**，对应完整乐器编号 `16…255`。可导入数量是 `240 - 当前自定义音色数`。发现的资源列表不会被截成 240 项；勾选数量超出剩余位置时会要求减少选择，导入按钮不可用，模块也会在解码前拒绝整批请求。每个编码文件最多 32 MiB，一批编码文件和解码 PCM 分别最多 256 MiB。

全部选中音效都成功读取、校验和解码后，才一次创建历史检查点并提交定义和采样；任意失败或工程被替换时不提交半批音色。可勾选把对应原生音符改用新采样，其他游戏音效不会自动替换曲谱音符。调整音色顺序、删除或替换采样前会停止主播放及监听音频池，随后按新采样库重新播放。

音色管理器还可编辑名称、文件引用、根音及钢琴按键标志，移动或删除音色，并从 NBS / NBPZ 追加定义；重排会同时更新曲谱和采样编号，删除会移除引用该音色的音符，可撤销。“导出音色 NBPZ”只保存音色定义和已加载采样，不包含曲谱音符，也不会沿文件引用读取任意本机路径。

## 导入与保真范围

可读 Alpha Schematic、Java 结构 NBT，以及 Note Block Studio 的数据包 ZIP。导出文件附带扩展乐谱数据，因此本移植版自己的文件能恢复音量、图层、微调及元数据。仅依赖通用 Minecraft 方块格式的软件可以忽略该扩展。

外部结构会从按钮或拉杆开始追踪首次红石脉冲，识别中继器方向和延迟、红石粉升降、火把反相、支撑方块音色及常见 `playsound` 命令方块。若找不到输入路径，按选择的方向和位置导入时间并提示。活塞、锁存器、复杂比较器及重复反馈并非完整游戏物理仿真，需在游戏内核对；未连接的音符会明确报告。导入速度用于把红石时间换算成 NBS tick。

外部数据包只解析原项目 `notes/<tick>.mcfunction` 中的静态 `playsound`；不执行任意函数或动态命令。导出的自带乐谱数据包可完整恢复项目。外部数据包的控制逻辑、循环及速度不能从任意命令可靠推断，导入时使用选定速度并显示提示。

红石输出沿用原生限制：长度/宽度小于 2000、高度小于 256；本地生成最多 200 万个非空气方块。数据包最多 20000 个独立时间点。ZIP 默认最多 65534 个条目、单条目 128 MiB、解压总量 256 MiB，校验 CRC32 并拒绝重复路径和路径穿越。

## 模块 API 与高级选项

`js/minecraft.js` 导出 `MINECRAFT_OPTIONS`（中文标签、默认值、候选值及范围），可直接用于界面或查看高级 JSON 的完整字段。关键接口：

```js
const result = await exportMinecraft(song, {
  format: 'structure', layout: 'simple', direction: 'north',
  tempo: 10, repeatersPerRow: 20, commandBlocks: false
});
// result: {bytes: Uint8Array, filename, mime, warnings: string[], summary}
const imported = await importMinecraft(result.bytes, {tempo: 10});
// imported: {song, warnings, summary}; preferEmbedded:false 强制从方块重建
```

数据包的高级字段包括 `namespace`、`name`、`functionPath`、`mcVersion`、`source`、`includeOutOfRange`、`customNamespace`、`radius`、`radiusValue`、`loopCount`、`visualizer`、`visualizerType`、`glow`、`x/y/z`。分支字段包括 `layers`（从 0 开始）、`rangeStart`、`rangeEnd`（包含端点）、`stereo`、`velocity`、`circuitry`。方块可写旧版数字 ID、`"minecraft:stone"` 或 `{id:35,data:11,name:"minecraft:blue_wool"}`；仅现代名称而没有旧版 ID 的方块不能写入 Alpha 数组。

`buildDatapack()` 同时返回 `files:Map`，可用于逐文件保存。`buildBundledResourcePack('extended'|'textures', options)` 读取本地随包素材。`buildCustomResourcePack(song, samples, options)` 接受按文件名或从 0 开始的自定义音色索引组织的 Map；数据为 OGG 字节/Blob 或 `{bytes, lower, upper}`。`lower`/`upper` 是分别预调 -24/+24 半音的实际 OGG。原始自定义音色的基准音高需在编码前归一化；完整乐器索引 16 起的 Map 可显式设置 `sampleIndexBase:16`。

`js/archive.js` 提供异步 `writeZip([{name,data}])` 与 `readZip(bytes) -> Map<string,Uint8Array>`。浏览器使用标准流 API，Node 18 缺少 raw-DEFLATE 流格式时使用有大小上限的标准库 zlib；写入为标准无压缩 ZIP，导入支持无压缩及 DEFLATE。

## 本次验证

文件测试覆盖独立 Node zlib 与 NBT 字节读取器检验、布局/方向、实体和调音命令、外部电路延迟追踪、七种动画、资源包音频和纹理、13 万音符外部数据包导入、ZIP 校验和解压边界及 Node 18 回退模拟。

本轮 `tests/minecraft.test.mjs` 新增所有导出类型的锁定/静音/独奏筛选、16/100 格半径换算、同命名空间的双曲目函数/计分板/实体标记隔离、非法子路径及 Unicode 名称区分回归。`tests/instrument-ui.test.mjs` 覆盖版本索引、只读取选中对象、哈希损坏拒绝、排除音乐/唱片、完整发现 301 项而不截断、剩余位置不足时零次解码拒绝、选中子集原子导入及失败不修改工程。`tests/instrument-tools.test.mjs` 覆盖定义/音符/采样重排、删除及实际 NBPZ PCM 往返；对话框测试另验证操作前停止主播放和监听。

这些是文件与逻辑测试；没有在真实 Minecraft 客户端/服务器中执行导出文件，不应把结构性验证写成游戏内验收。

参考依据是用户提供归档的 `scripts/schematic_export`、`branch_export`、`track_export`、`open_schematic`、`dat_generate`、`dat_reset`、`dat_pitch`、`dat_instrument` 和相应窗口/方块映射 GML。源文档仅用于理解格式与功能。
