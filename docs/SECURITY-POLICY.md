# 静态网页内容安全策略

`index.html` 在字符编码声明后、任何脚本与样式加载前提供强制执行的 CSP meta。它随静态文件交付，不依赖 Node、反向代理或服务器响应头配置。

## 页面保护与必要来源

- 默认拒绝未列出的资源；禁止 `<base>` 改写、对象插件、内嵌页面和表单提交。
- JavaScript 只从本站加载，禁止内联脚本、事件处理属性、`javascript:` 执行和 JavaScript `eval` / `Function`。仅用 `'wasm-unsafe-eval'` 放行 WebAssembly 编译，不使用更宽的 `'unsafe-eval'`。
- Worker 创建允许本站及 Blob URL。当前生产入口的 DSP、文件处理、转录、FFmpeg 和 ORT pthread Worker 均使用本站固定文件；ONNX Runtime 的 proxy Worker 保持关闭。**页面的 `script-src` 没有放行 Blob 或任意 HTTP(S) 脚本**。FFmpeg 核心模块在本站 Worker 内加载。
- 内联 CSS 用于主题、音轨颜色、尺寸和动画，故 `style-src` 保留 `'unsafe-inline'`；这不会放行内联 JavaScript。图像允许本站、`data:` SVG 和本地 Blob，字体允许本站和 `data:`；音频允许本站、Blob 和 `data:`。
- `connect-src` 允许本站、HTTP(S) 与 Blob。用户可主动指定任意曲谱或兼容模型包 URL，ModelScope 权重还可能重定向到 CDN，不能固定为单个域名。这里仅放行读取连接，不允许这些远端地址成为脚本来源；CORS、混合内容、文件大小及校验和检查继续独立生效。允许 HTTP 也保留了 localhost 预览与已有 HTTP 曲谱入口，CSP 不会绕过 HTTPS 页面的混合内容限制。
- Blob 文件下载、`decodeAudioData`、麦克风与 Web MIDI 的用户授权流程保持现有浏览器规则。本策略不增加麦克风或其他设备权限。

## 覆盖边界

CSP 是防御纵深，不能替代字段验证、HTML 文本转义及 `textContent`。保留外部 URL 导入意味着它也不是一个只允许访问本站的网络隔离策略。

根据 CSP 标准，meta 不支持 `frame-ancestors`、`sandbox`、`report-uri`，也不支持 Report-Only；因此文件中不放置这些看似存在、实际不能由 meta 执行的设置。本版本不声称通过 meta 阻止第三方网站将编辑器放入 iframe，也不更改部署者的服务器配置。若宿主额外提供 CSP 响应头，它会与此 meta 同时生效，两者都必须允许某项行为才可执行。

独立 HTTP(S) Worker 的内部执行策略由它自己的响应头控制，**不会自动继承页面的 meta CSP**；Blob Worker 则继承创建者的策略。这里限制了页面可创建的 Worker 来源，没有给所有 Worker 伪称一份全局“禁止 eval”的策略。

当前受信任的固定 ONNX Runtime 1.30.0 `ort-wasm-simd-threaded.jsep.js` 含 Emscripten embind 的 `new Function` 方法调用封装生成。直接向其独立 Worker 强行套用同一份无 JavaScript eval 的响应头，可能破坏第三方推理运行时。本次不放宽页面的策略、不替换或重编译该运行时，也不替部署者增加 Worker CSP 响应头。未来若要同时限制 Worker 内的动态 JavaScript，需要先验证无动态执行的运行时构建。

`tests/security-policy.test.mjs` 检查策略交付位置、代码来源限制和现有功能所需的允许项；这些声明测试不能替代真实浏览器中的音频、编码与推理运行验证。

参考：[W3C CSP 3：meta 交付](https://www.w3.org/TR/CSP3/#meta-element)、[W3C CSP 3：script-src / WebAssembly 与 JavaScript 执行限制](https://www.w3.org/TR/CSP3/#directive-script-src)、[MDN：CSP 与 Worker](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy#csp_in_workers)。
