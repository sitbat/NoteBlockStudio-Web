# MuScriptor 纯客户端转录与模型资源

普通用户在网页内确认下载、等待准备完成后即可使用，不需要安装 Python、PyTorch、Node 或任何本机推理服务。网站服务器只提供静态页面、ONNX 小图、前处理系数和浏览器运行时；音频处理和模型计算均在客户端完成。

## 静态服务器模块兼容

ONNX Runtime Web 1.30.0 的两个 ES 模块在本项目中分别使用 `vendor/onnxruntime/ort.all.min.js` 与 `ort-wasm-simd-threaded.jsep.js` 文件名，适配已有 `.js` JavaScript MIME 映射。某些静态服务器把 `.mjs` 当作 `application/octet-stream`，浏览器会拒绝把它加载为模块；此修复不要求修改服务器或反代配置。

`ort.env.wasm.wasmPaths` 使用官方支持的 `{mjs: URL, wasm: URL}` 格式，明确指向上述 helper `.js` 和原 `.wasm`，不依赖根据文件名猜测路径。上游 pthread helper 使用 `new Worker(new URL(import.meta.url), {type: 'module'})`，因此线程也从同一 helper `.js` 启动；运行时自身的两个默认文件名引用已同步改名。`env.wasm.proxy` 保持关闭。只有文件名与加载路径改变，WASM 二进制、模型数学和默认推理模式保持原样；打包差异与文件校验和记录在 `vendor/onnxruntime/VERSION.json`。

## 首次使用与资源来源

首次点转录功能时，界面先说明模型体积和来源，由用户确认后才下载，并显示下载及准备进度。small 与 medium 的原始 `model.safetensors` 分别直接从用户指定的 ModelScope 地址获取，网站服务器不转存、不代理这些完整权重。后续使用浏览器本地缓存；清除站点数据或更换浏览器后可能需要重新准备。

v4.4.2 起，权重按 **40 MiB（41,943,040 字节）**分段，最后一段按剩余长度请求。面板及下载确认框可选 **1–4 路并发**，默认 2，选择保存在当前浏览器。开始下载后固定本次并发数；调整设置用于下一次下载。片段按原始顺序合并，进度累计所有连接实际收到的字节，同一次下载中的连接中断只重试缺少的部分。全部下载结束后仍校验总长度及 SHA-256，再进行转换和安装。取消或刷新会丢弃尚未安装的内存片段，当前不支持跨刷新续传。实际速度由模型来源、网络及设备共同决定。

| 档位 | 原始权重来源 | 原始文件字节数 | 预期 SHA-256 |
| --- | --- | ---: | --- |
| small | [ModelScope small](https://www.modelscope.cn/models/MuScriptor/muscriptor-small/resolve/master/model.safetensors) | 411,888,600 | `bbd482c786b895cf7d8f44185073d951adae2ebb8a66f82ca84cd1f84569549c` |
| medium | [ModelScope medium](https://www.modelscope.cn/models/MuScriptor/muscriptor-medium/resolve/master/model.safetensors) | 1,228,144,472 | `ac80adbdf85d87231735fd948af7013441c0afced316c4e9067fd5d8a7fb97ec` |

表中大小和预期校验和来自 2026-10-25 检查到的 ModelScope 文件元数据；浏览器下载后仍需核对实际字节和 SHA-256。普通 safetensors 不是 ONNX 包，不能直接交给 ONNX Runtime。本项目使用下面的源张量映射，在 Worker 中构造所需的 ONNX external data，不要求用户用 Python 转换，也不重新上传整模型。

首次运行还需约 **29 MB** 的 ONNX Runtime Web 核心与 JavaScript（当前随包合计约 29.18 MB），以及 small 约 2.34 MB / medium 约 2.49 MB 的静态图模板和系数。客户端派生权重为 406,683,648 / 1,221,902,336 字节；下载、校验、派生和缓存会占用额外内存与本地存储。存储不足、网络失败或设备分配失败必须明确报错，不能用“继续”绕过实际硬件限制。

官方源码使用 MIT；模型权重使用 CC BY-NC 4.0，并有模型页条件。使用者仍需具备相应使用权限。直接使用公开 ModelScope 文件不等于取消模型原有许可，也不需要网页把 Hugging Face 登录设为 ModelScope 下载的前置条件。

- [官方源码与许可说明](https://github.com/muscriptor/muscriptor)
- [官方 small 模型页](https://huggingface.co/MuScriptor/muscriptor-small)
- [官方 medium 模型页](https://huggingface.co/MuScriptor/muscriptor-medium)

## 前处理系数 v2 与旧缓存迁移

v1 模板曾把新建 PyTorch 模块的 Hann 窗和 Mel 滤波器当作模型系数。真实 checkpoint 保存的两个 buffer 已含精度舍入，与重新计算并不逐字节相同；即使 learned weights 映射正确，也会改变输入 Mel 和 logits。v2 使用真实 small / medium 文件中提取并核对的相同 buffer，不能简单把旧系数做一次 Float16 round 来替代。

| v2 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `window-v2.f32` | 8,192 | `0c84bb4f4654fb07efc1d59ed47f697c95a2d242fe19025791d5211265abed8b` |
| `mel-filter-v2.f32` | 2,099,200 | `a18c6e6e401ede017e9a95400b3742d87073f60df52c92822c18bcb1e86f4fdb` |

`js/transcription-preprocessing-patches.js` 只匹配两份已知原始权重 SHA、variant、model id、原图/映射和旧系数指纹。迁移仅取得这两个小文件，保存到版本化缓存 key，再原子切换 manifest 的前处理角色，保留原 `weights.bin` 和旧缓存 blob；不会重新下载 400 MB / 1.2 GB 权重，也不会覆盖自定义模型。`load()`、自检和独立 QA probe 均回传 `preprocessingRevision` 与实际文件路径、SHA，便于确认正在用 v2。

同一已知音符 PCM 的因果检查中，旧网页 Mel 输入官方原生模型得到首 logits 最大值约 15.01158；使用 checkpoint 系数后恢复约 15.49598，与原生参考约 15.49597 一致。真实浏览器 v2 首 logits 相对原生参考最大误差约 `8.49e-5`。这是前处理数值接入证据；转录准确率、幻觉和并发性能仍需分别检查。v1 链路上的性能和质量记录不能代替修复后的验收。

## 静态图模板如何使用原始权重

`assets/transcription/small/` 和 `assets/transcription/medium/` 新安装清单各包含 8 个小文件：`model.json`、`source-map.json`、两个 ONNX 图、v2 Hann 窗、v2 Mel 滤波器及两份许可说明。目录另保留两份 v1 系数以兼容旧清单，新安装不会下载它们。这里没有 `weights.bin`、完整 `.safetensors`、随机模型权重或 `validation/` 测试目录。

图模板不是把随机权重包装成可识别音乐的模型。开发期使用随机参数帮助导出结构和发现变换，然后将**全部学习参数**从图中移除，以 external data 引用替代；实际使用时必须填入经校验的下载模型数据。随机参数本身不会进入最终运行图。small 的 120 个、medium 的 200 个所需源张量，均已逐个对照真实 ModelScope header 的名称、别名、F32 类型和维度。

图模板使用 `nbs-muscriptor-source-onnx` 格式，版本 1：

- `runtimeTemplate` 保存原有 `nbs-muscriptor-onnx` v1 图接口、结构、前处理参数与静态文件校验和；`externalData` 仍为 `weights.bin`。
- `files` 只列需要从网站取得的小文件；`derivedAssets` 单独声明客户端产生的 `weights.bin` 和长度。
- `mapping` 指向 `source-map.json`。源文件下载地址、实际长度和预期 SHA-256 由下载目录提供。
- `graphValidationUsedRandomWeights: true` 表示图结构做过随机参数数值检查，不表示真实权重或识别结果已验收。

`source-map.json` 使用 `nbs-muscriptor-weight-map` v1，声明 `target`、`source.tensors` 与连续的 `segments`。每段包含：

```json
{
  "offset": 0,
  "bytes": 3072,
  "sourceKey": "condition_provider.conditioners.self_wav.output_proj.bias",
  "sourceDtype": "F32",
  "targetDtype": "F32",
  "sourceShape": [768],
  "shape": [768],
  "op": "copy"
}
```

仅使用三种操作：

- `copy`：复制整个源张量的 little-endian F32 字节。
- `transpose2d`：整个二维源矩阵转置；目标维度与源维度相反。
- `slice`：按**原源张量扁平元素序号**读取 `slice.start` 起的 `slice.count` 个元素；不与转置合并。用于两个空条件的 embedding 第 1 行。

每段的类型、维度、元素数、字节范围都必须一致，目标范围按顺序无空隙覆盖完整派生文件。`emb.weight` / `linear.weight` 通过明确别名兼容官方文件中的 `emb.0.weight` / `linears.0.weight`，不能接受多义匹配。共享 external data 省去两个图重复下载，不表示两个推理会话共享显存分配。

## 图接口与前处理

- `prefill.onnx` 输入 `log_mel: float32[1,501,512]`、`tokens: int64[1,prompt_length]`。首 token 是 BOS，值等于模型 `card`；后续可携带上一块持续音的 tie 提示。
- `step.onnx` 输入 `token: int64[1,1]`、`position: int64[1]`，以及每层 `past_key_i`、`past_value_i: float32[1,heads,past_length,64]`。
- 两图均输出 `logits: float32[1,card]` 和每层 `present_key_i`、`present_value_i`。每步缓存长度增加 1。
- small / medium 的 `card` 分别为 1393 / 1395；输出 ID >= 1393 为保留项，需要屏蔽。输入 BOS 不受该输出规则影响。
- 音频条件前缀为 501 帧音频、dataset 空条件、instrument 空条件，然后才是 BOS / 提示 token。最后一帧音频条件在投影后归零，条件前缀总长 503。

前处理保持 16 kHz 单声道、每块 80,000 样本、短尾右补零、2048 点周期 Hann 窗、hop=160、reflect 中心补边、幅度谱（非功率谱）、HTK 512 Mel、无 Slaney 归一化及 `log(mel+1e-6)`。本地小文件 `window-v2.f32` 和 `mel-filter-v2.f32` 保存真实模型 checkpoint 内的 little-endian Float32 buffer，包括保存模型时已经产生的精度舍入；不能用新建 PyTorch 模块重新算出的系数替代。

图含动态 KV 缓存、`Erf`、`LayerNormalization`、`Range` 等算子。提供 WebNN / WebGPU API 不代表整个模型都由该加速器执行；具体浏览器可用性和回退必须实测并如实展示。

## 解码预算、缓存和性能读数

`maxTokens=2000` 沿用官方 `LMModel.generate()` 的**总生成预算**：不含 BOS，包含上一块强制携带的 tie 提示。若提示长为 `P`（含 BOS），当前块最多再生成 `2000-(P-1)` 个 token；提示自身已耗尽预算时明确报错，不能悄悄丢掉持续音状态。超过预算仍未生成 EOS 的块标记为失败，不当作完整识别结果。

WebGPU 的每层 KV 输出声明 `gpu-buffer`，解码时留在设备上；CPU 只需读取单步 logits，而不是把整个 KV 下载到 JavaScript。当前 step 图用 `Concat` 扩展缓存，每个 token 仍会写出一份新的完整 KV。运行时收到结果后先释放旧缓存，再进入用户暂停等待，避免暂停期间持续保留两代缓存；取消或卸载会等待正在执行的内核退出后释放会话。单个 runtime 不允许同时启动两个推理或自检操作。

FP32 下，KV 逻辑字节数为 `2*layers*heads*headDim*positions*4`。BOS 首次 prefill 的 504 个位置，small 约 41.3 MiB、medium 约 94.5 MiB；约 2,503 个位置时分别约 205.3 / 469.3 MiB。更新时旧缓存与新输出会短暂同时存在。两个 ONNX 会话、权重分配、执行工作区和运行时池还需额外内存；这里的数字不是浏览器进程或显存峰值。medium FP32 尤其需要实测 WASM 地址空间、临时复制与设备分配，不能因为文件小于 2 GB 就保证可以加载。

每块 `result.metrics`（同时保存为 `engine.lastMetrics`）记录 `melMs`、`prefillMs`、`decodeMs`、`logitReadMs`、`tokens`、`steps`、`firstNoteMs`、`pausedMs`、`wallMs`、`processingMs` 和实际 `cacheLocations`。`peakLogicalKVBytes` 只计算相邻两代缓存张量；`concatOutputBytesEstimate` 只估算 step 写出的 KV 字节，均不是设备性能计数器。`milliseconds` 仅在调用方通过 `isPaused()` 明确标记用户暂停时扣除暂停等待；未暂停时的异步调度延迟仍计入处理时间，`wallMilliseconds` 仍保留实际经过时间；麦克风积压和首次可用结果等待还需独立观察，不能由较低 RTF 推导低延迟。

长块内的增量输出与低延迟流式识别有区别：当前模型每 5 秒音频建立一次条件前缀，然后逐 token 解码。准确率、跨块持续音、录音输入追赶能力，以及与一万轨音频播放并行时的欠载和参数响应必须分别测量。

### 可选 GPU token 批回读实验

`load({backend: 'webgpu', gpuTokenBatchSize: 8})` 可启用候选批回读路径；默认值仍为 1，必须用真实浏览器 A/B 结果决定是否采用。共享 `assets/transcription/common/decoder-argmax.onnx` 只有 780 字节，不改变 small / medium 的权重映射或浏览器缓存。它截取合法词表 0–1392，屏蔽 NaN / 正负无穷，采用与 CPU 相同的首个最大值规则；输出 int64 GPU token 直接传给下一步，累计 `[token, hasFiniteLegalLogit]`，每批最多 8 个 token 才读回 CPU。

这条路径减少 CPU/GPU 同步次数；它仍需逐步调度 ONNX 会话，不代表在 GPU 上一次性完成整个自回归循环。为发现 EOS，最多会多计算 7 个不采用的 token，预算末尾也必须提前回读，不能越过总生成上限。有效音符状态只按首个 EOS 前的 token 更新；跨块会丢弃该块 KV，因此多算部分不会带入下一块。批回读可能增加首音等待，吞吐、积压和延迟需一起比较。

`load()` 的 `optimization` 返回请求、实际批大小和失败原因。辅助图不可用时回退原 CPU 贪心解码；运行中辅助解码或设备 token 输入失败也记录 `decodingStrategy` / `fallbackReason` 后重试 CPU 路径。数值异常仍明确报错，不以回退掩盖无效输出。性能日志额外记录 `argmaxMs`、`tokenReadMs`、`tokenReadBatches`、`discardedTokens`。

开发者可独立生成该图，无需完整模型、PyTorch 或权重：

```powershell
work/muscriptor-env/Scripts/python.exe outputs/NoteBlockStudio-Web/scripts/export-muscriptor.py --decoder-argmax --output work/decoder-argmax
```

实际 tiny ONNX/WASM 测试已覆盖有限值/保留词/并列最大值、17-token 原贪心与批路径逐个相同、辅图故障回退；独立生命周期测试覆盖 EOS 后丢弃和 GPU token 输入重试。WASM 中这些结果只证明计算及调度逻辑，不能代替 WebGPU 设备驻留、显存与速度验收。

### 固定 8 步图候选

另一个独立候选是 `load({backend: 'webgpu', gpuUnrollSteps: 8})`，默认仍为 1。它优先于上述独立辅助会话实验：prefill 先按原贪心取第一个 token，之后一次 `step8.onnx` 调用在图内执行 8 次模型步骤、合法词表 ArgMax 和有限值检查，只读回一组 token，再传递最终 GPU KV。剩余预算不足 8 时使用原 step 单步图，因此不会越过 2000-token 总预算。首次 EOS 之后最多 7 个未采用的猜测被丢弃。

候选保存在 `assets/transcription/gpu/{small,medium}/`，small 图约 758 KB、medium 约 1.26 MB。每个 learned initializer 在该图中仍只声明一次，其 external data 文件名、offset、长度、类型、维度逐项保持原值；它不是把权重复制 8 份。`step8.json` 绑定原 step 图 SHA-256、新图 SHA-256 和大小，加载时必须与浏览器缓存一致，不适用于布局不同的自定义包或非 FP32 包。新图直接由静态站取得，沿用已有 `weights.bin`，不会重新下载完整权重。

运行时目前同时保留 prefill、step1 和 step8 三个会话，各会话可能各自分配权重，须额外检查 medium 的 WASM 地址空间、显存与临时复制峰值；同一图共享 initializer 不能证明跨会话共享内存。图加载或执行不可用时回退单步路径并在 `optimization` / `fallbackReason` 中明确记录。`graphRuns` 计实际调用次数，图内 ArgMax 时间计入 `decodeMs`。

开发者可仅从既有小图重建，不读取完整权重：

```powershell
work/muscriptor-env/Scripts/python.exe outputs/NoteBlockStudio-Web/scripts/export-muscriptor.py --unroll-step outputs/NoteBlockStudio-Web/assets/transcription/small/step.onnx --output work/step8-small
```

实际 tiny ONNX Runtime Web WASM 已对照 8 次独立模型调用：8 个 token 逐个一致，最后 logits 与全部 KV 最大绝对误差均为 0。完整 runtime 测试覆盖 19-token 严格预算（prefill + 两次 step8 + 两次单步尾，共 5 次 graph run）和故障后无 token 丢失的回退。这些仅证明微型计算和控制流程，真实模型 GPU 性能与并发播放仍需浏览器 A/B。

## 开发者重新生成模板

以下 Python 环境仅供开发者生成静态图和做数值检查，网站部署与普通用户使用均不需要它。没有安装完整 MuScriptor 服务端或节拍检测模型。

```powershell
python -m venv work/muscriptor-env
work/muscriptor-env/Scripts/python.exe -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.9.0
work/muscriptor-env/Scripts/python.exe -m pip install onnx==1.23.2 onnxruntime==1.31.0 safetensors==0.8.0 einops==0.8.2 numpy==2.5.4 huggingface_hub==1.33.0 mido==1.3.3 packaging==26.3
git clone https://github.com/muscriptor/muscriptor.git work/muscriptor-upstream
```

本次使用 Windows Python 3.13 和官方源码修订 `8a1ef88672cc23c26619adaff37ec48d82c0b906`。其他环境须使用可用依赖并重新检查。

```powershell
work/muscriptor-env/Scripts/python.exe outputs/NoteBlockStudio-Web/scripts/export-muscriptor.py --upstream work/muscriptor-upstream --variant small --dummy-full-size --source-template --output work/source-template-small
work/muscriptor-env/Scripts/python.exe outputs/NoteBlockStudio-Web/scripts/export-muscriptor.py --upstream work/muscriptor-upstream --variant medium --dummy-full-size --source-template --output work/source-template-medium
```

`--output` 必须是新目录或空目录。模板导出仅支持 FP32。完整尺寸模板默认读取仓库内已验证 SHA 的 v2 checkpoint 系数；若该资源缺失则报错，不能回退为 重新计算的系数。也可使用 `--preprocessing-weights PATH/TO/model.safetensors`，仅 lazy 读取该文件中 2 个固定 buffer，不读取全部 learned weights。微型 `--dummy` 测试可使用新建系数，并明确标为 testOnly。导出时先随机化所有学习参数（尤其 LayerNorm 的 gamma/beta），避免 ONNX 对默认全 1/0 参数按值去重而误把不同层映射到同一源张量；然后查明每个参数的复制、转置或切片，输出外部引用，并在完成前删除临时随机权重和验证数据。最终目录可只按 `files` 清单和 `model.json` 复制到静态资源目录。不要复制工作目录的完整中间产物。

微型 source-map 开发验证：

```powershell
work/muscriptor-env/Scripts/python.exe outputs/NoteBlockStudio-Web/scripts/export-muscriptor.py --upstream work/muscriptor-upstream --dummy --source-template --source-fixture work/source-map-test/source.safetensors --output work/source-map-test/template
```

此命令在模板目录**外**生成微型随机 safetensors（使用官方 legacy 键名）、参考与重建 external data、数值对照。测试包明确 `testOnly: true`，不能作为音乐识别模型。

## 可选的本地 ONNX 包导出

对已经持有许可权重的开发者，原完整包导出路径仍可用：

```powershell
work/muscriptor-env/Scripts/python.exe outputs/NoteBlockStudio-Web/scripts/export-muscriptor.py --upstream work/muscriptor-upstream --variant small --precision fp32 --weights PATH/TO/model.safetensors --output work/local-small-onnx
```

`--precision fp16` 使用半精度 Transformer，但保留 FP32 音频条件器、位置编码和外部接口；候选后端为支持半精度的 WebGPU。`--precision int8` 使用逐通道动态 INT8 常量 MatMul 权重量化，针对 CPU / WASM；不能据此宣称 WebNN / WebGPU 兼容。源模板首次下载流程当前使用 FP32，不会偷偷执行未验证的浏览器量化转换。

## 已验证与未验证范围

验证阶段仅在本地进行；发布状态以 Git 提交和部署记录为准。文中 `benchmarks/local-*` 原始详细日志与 `work/` 参考产物只在本地留存，未随仓库发布；代码格式的相对路径用于本地复查，本文保留汇总数值与限制。

- 微型 raw safetensors → recipe → external data 已在独立 Python 重建和项目 JavaScript adapter 中检查，输出字节逐一相同；开发 fixture 的派生 SHA-256 为 `9c596637f42e45c200c2f6874e590ae23bf6168e11e5e74eb65ae7aeb00ec25f`。
- small / medium **真实尺寸结构**均用随机参数完成官方 PyTorch、导出图与 ONNX Runtime CPU 对照，覆盖 BOS、4-token 提示和连续 3 步 KV 缓存，最大绝对误差分别约 `2.15e-6` / `2.75e-6`。
- 两个模板的全部学习张量、所有外部 initializer 的引用、目标连续覆盖、文件长度和 SHA-256 均已检查；静态目录没有完整权重或验证目录。
- 微型图在项目随包 ONNX Runtime Web 的 WASM 后端实际执行，参考 Mel 的前缀 logits 相对原生参考最大误差约 `8.35e-7`；使用网页 FFT/Mel 后约 `8.57e-6`，贪心 token 相同。连续缓存步骤也与重新计算整个前缀相符。
- 纯音近静音频带的 FFT 浮点细节可能在对数 Mel 域被放大；这不等于相同幅度的 logits 变化。前述数字只说明测试样本与结构的数值接入，不是识别质量保证。
- 当前 Windows Edge 中，真实 small 权重已完成 ModelScope 直连下载、SHA-256 校验、浏览器内适配、缓存和 WebGPU 加载；前缀与一个 KV 解码步骤自检通过，首次约 1,494.7 ms。刷新后再次进入功能可从 IndexedDB 直接复用。该数字不是持续转录速度或音频控制延迟。详见 [下载验证记录](TRANSCRIPTION-DOWNLOAD-QA.md)。

下列真实模型复核与结构数值检查是不同层次的证据。通用音乐或麦克风准确率、实体手机性能、其他浏览器后端，以及与一万轨独立混响同时播放的最终性能结论，必须按相应原始记录分别验收；不能以下载、自检、非空输出或无限等待代替。

## 真实模型质量边界（2026-10-25，本地复核）

五个合成夹具只用于回归：原版 `harp.ogg` 生成的单旋律、和弦、加噪旋律，解析谐波跨块持续音，以及静音。匹配采用一对一、同 MIDI 音高且起始误差不超过 50 ms；音符结束时刻与 program 分开评分。原版 harp 的 program 0 是标注惯例，没有验证该采样对应的真实 GM 乐器身份。这些夹具不是人声哼唱或一般音乐测试集。

**下表是发现 checkpoint 系数遗漏前的历史构建结果。** 后续首步数值复核已定位 Hann / Mel 缓冲区差异，见下节；修正系数后的最新五组结果已另行保存，不能把本表直接沿用为修正后模型的准确率。

修正后 revision 2 的 small / medium 五组合成夹具现已自然完成，最新数据见 [正式验证报告](TRANSCRIPTION-VERIFICATION.md#修正系数后的五组-gt)。small 仍严重退化；medium 的单旋律 / 和弦 / 加噪起始 F1 为 1 / 0.8 / 1，但加入时值后三项 F1 全为 0，跨块谐波自然完成却漏检全部音符。两者静音均无误报。以下旧表仅保留定位过程，不是最新结果表。

| 模型 / 夹具 | 预测音符 | 音高与起始 F1 | 结果边界 |
| --- | ---: | ---: | --- |
| small / harp-mono | 1,661，其中 1,647 个鼓 | 0.00120 | 严重重复和幻觉，音符集中于 0.51–0.83 秒 |
| small / harp-chords | 0 | 0 | 九个标注音符全部漏检 |
| small / harp-noise | 0 | 0 | 四个标注音符全部漏检 |
| small / harmonic-crosschunk | 3，均为鼓 | 0 | 未正确还原跨块持续音 |
| small / silence | 0 | 1 | 只表明此静音样本没有误报 |
| medium / harp-mono | 4 | 1 | 此样本音高、起始匹配，不代表时值正确 |
| medium / harp-chords | 6 | 0.8 | 九个标注音符中仍漏检三个 |
| medium / harp-noise | 4 | 1 | 此加噪样本音高、起始匹配，不代表一般抗噪能力 |
| medium / harmonic-crosschunk | 未完成 | 不计通过 | 到 2,000-token 总预算仍未生成 EOS，`GENERATION_LIMIT` |
| medium / silence | 0 | 1 | 此 5.2 秒静音样本完成，0 个误报；不代表其他输入质量 |

medium 前三个样本的“音高、起始、结束时刻”联合 F1 **均为 0**，因此不能把上表的起始 F1 写成完整音符准确率。和弦存在漏检，跨块谐波输入未完成；静音样本已完成且为 0 音符、0 个误报，目前仍不能宣称通用音乐或哼唱识别准确。原始浏览器结果保存在 `benchmarks/local-ai-small-gt-v1.json`、`benchmarks/local-ai-small-gt-mono-bad-v1.json`、`benchmarks/local-ai-medium-gt-v1.json` 与 `benchmarks/local-ai-medium-silence-v1.json`；开发过程中的文件可能继续补充，引用时需保留具体样本和配置。medium 的这些 QA 样本结果不等于其普通编辑器完整产品流程已通过。

small 的异常还用**同一份未量化 Float32 PCM**做了官方 PyTorch 对照：16 kHz、128,000 样本、8 秒，输入 SHA-256 为 `9fef5cccf01b91b7c950b921f9b1ebef6991b0c8fa1cfec964589c2c52c5acc1`。经官方 `load_model` 严格加载同一 SHA 的真实 small 权重，使用 CPU FP32、greedy、CFG 1、batch 1、prelude forcing，得到 1,547 个原始事件音符，其中 1,435 个鼓；只看 8 秒音频范围内仍有 1,515 个音符、1,435 个鼓。两块均自然生成 EOS，没有预算警告。这说明严重退化在该模型的官方执行中也存在，不能仅归因于 WebGPU 或遗漏音量归一化。

原生与浏览器的数量仍不一致，**尚未证明真实权重逐 token 数值一致**。官方原始事件包含零长重触发，以及最后补零块超出原始 8 秒的时间；这些原始计数不能直接当作网页约束后的有效音符数。没有通过改变音量归一化、强制只允许钢琴或修剪鼓音符去凑四个标注音符。官方 `normalize_audio=False`、均值单声道、Julius 16 kHz、5 秒补零、末 Mel 帧 mask 和空类别 embedding 索引已核对；随后同 PCM 首步数值对照发现的实际缺陷是下面的 checkpoint 系数遗漏。

官方参考脚本、完整 token/事件及首步 logits 位于工作区的 `work/muscriptor-pytorch-reference/harp-mono-exact-v1/report.json` 与同目录 `first-logits.f32`，相对于本仓库为 `../../work/muscriptor-pytorch-reference/`。该工作目录和下载的完整权重不进入网站发布包，也不作为普通用户运行依赖。参考计算约 39.10 秒仅用于本地数值和行为诊断，不是浏览器实时性能验收。

### Checkpoint 前处理系数缺陷复核

原模板从数学公式重新生成了 Hann 窗和 Mel 滤波器，却没有使用真实 checkpoint 保存的两个 F32 buffer。两者数值并不相同：Hann 最大差 `2.44081e-4`，Mel 滤波器最大差 `3.11017e-4`，在近静音频带经过 log 后放大，令同一音频块的 Log-Mel 最大差达到 `3.667014`、RMSE `0.148106`。不能把首 logits 的明显差异归为普通 WebGPU FP32 舍入。

small 与 medium 的真实两个 buffer 已逐字节核对相同；medium 仅从官方地址 Range 读取对应 2,107,392 字节，没有下载完整模型。精确布局与 SHA-256 为：

| Buffer | F32 形状 / 排列 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| Hann | `[2048]` | 8,192 | `0c84bb4f4654fb07efc1d59ed47f697c95a2d242fe19025791d5211265abed8b` |
| Mel | `[1025,512]`，frequency-major，`filter[frequency*512+mel]` | 2,099,200 | `a18c6e6e401ede017e9a95400b3742d87073f60df52c92822c18bcb1e86f4fdb` |

把旧数学系数简单执行 `float16 → float32` 并不逐元素复现 checkpoint：当前 PyTorch 公式的 Hann 仍差 2 点，Mel 仍差 337 点；改用 Python `math.log10` 端点可减少部分差异，但仍不精确。系数资源和缓存升级需要绑定上面的精确 SHA，不能只凭数学名称或精度标签认定等价。

三次官方原生首 prefill 进一步隔离了原因：输入始终仅 BOS `[1393]`，条件前缀 503，`first_step=True`，没有强制 tie。原生 checkpoint 系数复现先前原生 logits，逐元素误差为 0。将旧浏览器完整 Log-Mel 输入同一个官方模型后，最大 logit 变为 `15.0115776`，与旧浏览器 `15.0115757` 相符，向量最大差 `7.13e-5`。改用精确 checkpoint 系数和同一 JavaScript FFT 后，最大 logit 恢复 `15.4959764`，对官方原生 `15.4959736` 的向量最大差降至 `3.05e-5`、RMSE `1.24e-5`。这定位了旧首步向量约 `0.59426` 最大差的来源；长序列 greedy、跨块状态与质量仍须在浏览器升级缓存后重新验收。

汇总证据见 `benchmarks/local-ai-preprocessing-parity-v1.json`，原始数学和首步输出位于工作区 `work/muscriptor-pytorch-reference/preprocessing-parity-v1/`。此核查只执行少数首 prefill，不是完整模型性能或最终识别质量通过的证据。

达到 `GENERATION_LIMIT`、后端运行错误或取消时，状态不为 `completed`，即便已经出现部分预览也不能确认写入曲谱。界面明确标为未完成预览；不能把半截 token 流作为成功转录。成功且自然 EOS 只表示计算完成，仍可能像 small 的上述结果一样质量很差，用户需要检查临时预览后再落谱。

落谱时会按 NBS 的整数 tick 网格和目标音色整理完全重复或量化重合的目标，避免把同一位置的模型重复事件扩成大量新增音轨。转录面板持续显示“原始识别数 → 实际落谱数”、重复和重合统计、映射忽略或音域跳过说明；撤销后保留上次整理记录，重做按插入音符 ID 恢复已写入状态。这一步只整理目标曲谱，原始 token、识别音符和 GT 评分保持原样。

### 已完成性能测量与未验收范围

已完成的 revision 2 单步 WebGPU / 一万轨 72 秒并发结果见 [正式验证报告](TRANSCRIPTION-VERIFICATION.md)：音频播放通过，small / medium 的严格 AI 实时条件均因输入结束积压超限而未通过。历史 CPU 回退不能作为修正系数后最终结果。

按用户要求，本轮保留稳定单步默认路径，停止继续堆叠内联候选与重复长测；下面未测项维持未验收，不表示仍在后台推进或已达到目标。

WASM 的请求线程数与实际线程利用证据分开；已预加载文件的批量计算时间不能作为实时录音首批延迟。下面的 RTF / 积压取输入结束时，排空后最终值另见正式报告。

| 模型 / 实际后端 | 输入与原始记录 | 1× 输入合格 | 首批结果墙钟 | RTF / 积压 | 一万轨并发欠载 / 丢声 | 最终结论 |
| --- | --- | --- | --- | --- | --- | --- |
| small / WebGPU 单步 | `local-ai-small-concurrent-v2.json` id 3，72 s | 通过 | 5.491130 s | 0.424635 / 7 s | 0 / 0 | AI 实时未通过 |
| medium / WebGPU 单步 | `local-ai-medium-concurrent-v2.json` id 4，72 s | 通过 | 5.618325 s | 0.974701 / 7 s | 0 / 0 | AI 实时未通过 |
| small / WASM | 仅有旧系数历史 quick；修正版未验收 | 历史未通过 | 不沿用 | 不沿用 | 未做修正版并发 | 未验收，本轮停止追加 |
| medium / WASM | 仅有旧系数历史 quick；修正版未验收 | 历史未通过 | 不沿用 | 不沿用 | 未做修正版并发 | 未验收，本轮停止追加 |

持续录音在首块计算前需先积累约 5 秒音频，之后还要加模型计算与调度时间；主动提前停止的短尾才补零处理。界面将文件批量计算至首批结果与录音收集、计算的实际等待分开标注。普通编辑器产品流程复核见 [本地 UI 验证记录](TRANSCRIPTION-UI-QA.md)，其中 small 已有端到端结果，medium 完整流程待测。
