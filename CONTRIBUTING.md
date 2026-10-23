# 参与开发

本仓库是支持本机运行与自建网站的 Note Block Studio Web 移植版。直接修改 JavaScript、HTML、CSS 和 Rust 源码即可，不需要前端构建工具或 npm 依赖安装。请保留原项目与素材的署名、许可证及第三方说明。

## 运行与测试

建议使用 Node.js 24；最低兼容版本为 Node.js 18。启动本地服务：

```sh
node server.mjs --open
```

请通过本地服务器检查界面和音频，让 COOP/COEP 响应头正常生效。浏览器音频需要一次用户操作。FFmpeg 仅用于额外音频编码格式；不修改该功能时，无需安装它。

测试网站模式可以在本机设置 `PUBLIC_ORIGIN=http://localhost:8790`、`PORT=8790` 后运行 `npm run start:hosted`；公开来源必须使用 HTTPS，外部接入由部署者处理。部署与验收命令见 [服务器部署](docs/DEPLOYMENT.md)。本机服务与网站服务分开维护；网站模式不应接入 Discord、本机路径或服务端 URL 代理。

运行完整 JavaScript 与随包 WASM 测试：

```sh
npm test -- --test-concurrency=2
```

`scripts/run-tests.mjs` 枚举 `tests/` 与 `rust/tests/` 下的真实 `.test.mjs` 文件，再将路径及参数传给 Node，Windows 与 Node.js 18 均不依赖 shell 展开通配符。支持直接传入 Node 测试参数，或只查看列表：

```sh
node scripts/run-tests.mjs --list
npm test -- --test-concurrency=2 --test-name-pattern="MIDI"
```

可选组件不可用时，对应测试会说明跳过原因：例如未安装 FFmpeg、Windows 未设置 POSIX shell，或系统不允许创建测试链接。不要为让测试通过而静默跳过逻辑错误。桌面集成、离线更新及回滚测试使用临时夹具；不要把自己的曲谱目录作为测试根目录。

## 修改 Rust DSP

使用随包的 `wasm/nbs_dsp.wasm` 无需 Rust。修改 `rust/src/` 后，先安装稳定版 Rust 的裸 WASM 目标，再使用构建脚本：

```sh
rustup target add wasm32-unknown-unknown
sh scripts/build-wasm.sh
```

Windows 可使用：

```powershell
rustup target add wasm32-unknown-unknown
powershell -ExecutionPolicy Bypass -File scripts/build-wasm.ps1
```

Rust crate 没有 registry 依赖；构建脚本使用离线 Cargo。首次安装 Rust 工具链和目标本身需要下载。也可直接运行 `cargo test --manifest-path rust/Cargo.toml --locked --offline` 检查原生核心。

更新 DSP 时同步提交源码与重新生成的 WASM。保持 `engine_*` 导出参数、平面立体声布局及 Worker 协议一致；添加行为时使用实际 WASM 的针对性测试验证。CI 会单独构建 SIMD 与 scalar 版本，比较公开导出及参数数量，再运行 ABI/音频池与 SIMD/scalar 一致性测试；不同 Rust 版本生成的二进制哈希无需完全相同。

## 提交前检查

说明修改解决的问题、用户可见行为，以及测试结果。格式处理应对截断、越界和无效输入给出明确错误；文件变更与恢复必须保留失败时的可恢复数据。用有意义的回归场景测试行为，避免只复述实现。

界面、MIDI 硬件和实时音频修改需要另做手动检查。请记录浏览器、系统、采样率和音频配置；物理设备未测试时说明这一点。CI 的 DSP 功能测试不能代替真实声卡或特定机器的万轨实时性能验证，相关流程见 `docs/VERIFICATION.md`、`docs/PERFORMANCE.md` 和 `docs/MIDI.md`。

工作流运行 Linux/Windows 的 Node.js 24、Linux 的 Node.js 18、Linux Rust/WASM 构建校验，以及应用 Docker 镜像测试。容器测试在镜像中安装 FFmpeg，用合成音频检查五种编码；它不会配置网络、部署网站、创建 GitHub Pages 或自动发布 Release。不要提交令牌、`.env`、用户曲谱、个人采样或本地更新备份。
