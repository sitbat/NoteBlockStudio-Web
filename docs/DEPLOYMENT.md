# 应用部署

仓库提供 Docker Compose 与 Node + systemd 两种应用启动方式。公网域名、HTTPS 和反向代理由部署者自行处理，项目不提供相应配置。本次仅提供部署方式，没有实际公开发布网站。

## 数据与计算位置

编辑、采样播放、Rust / WebAssembly 多线程混音、每轨混响和 WAV 渲染均在访问者的浏览器中完成。应用容器的 2 CPU / 1536 MiB 限制只针对服务器后端；仓库中的万轨实测对应记录中的客户端设备与浏览器，不保证其他设备具有相同性能。

曲谱、自定义采样、偏好与自动备份保存在当前浏览器、当前网站来源的 IndexedDB / 本地存储中，没有云项目库或跨设备同步。清除站点数据、切换浏览器，或更换协议、域名、端口，都会影响可见的本地工程。重要作品应下载为包含音频的 `.nbpz` 完整工程包。

原采样率立体声 WAV 直接在浏览器生成。MP3 / FLAC / AIFF / OGG、重采样或单声道导出，会在用户点击导出后，将渲染好的 WAV 临时上传到应用后端，由 FFmpeg 编码并返回；自定义音色资源包的 OGG 转换也使用此服务。处理结束后清理临时文件，后端不提供作品长期保存服务。

URL 导入由浏览器直接读取目标地址，受目标站 CORS、混合内容和浏览器网络规则约束；失败时可先下载曲谱，再通过“打开文件”导入。网站应用不提供外部 URL 下载代理、本机文件启动或 Discord 活动连接。

## Docker Compose

需要 Git、Docker Engine 与 Compose 插件。应用镜像使用 Node.js 24 和系统 FFmpeg；启动时无需安装 Rust、GameMaker 或执行 `npm install`。

```sh
git clone https://github.com/sitbat/NoteBlockStudio-Web.git
cd NoteBlockStudio-Web
cp .env.example .env
```

编辑 `.env`，将 `PUBLIC_ORIGIN` 设为使用者最终访问的完整来源，只含协议、主机名和可选端口，不包含路径、查询参数或结尾斜杠。`APP_PORT` 是本机应用监听端口：

```dotenv
PUBLIC_ORIGIN=https://nbs.example.com
APP_PORT=8765
```

检查配置并启动：

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
```

[`compose.yaml`](../compose.yaml) 只启动应用容器，将容器内 8765 映射到主机的 `127.0.0.1:${APP_PORT:-8765}`。应用使用非 root 用户、只读文件系统和 384 MiB 的 `/tmp` 临时盘，默认限制为 2 CPU / 1536 MiB 内存。后端全局同时只处理一个转码任务。

只在本机测试时，可将 `.env` 改为 `PUBLIC_ORIGIN=http://127.0.0.1:8765`、`APP_PORT=8765`，再访问该地址；HTTP 来源仅允许回环地址。使用实际网站地址时，`PUBLIC_ORIGIN` 必须与浏览器所见来源一致。

停止应用使用 `docker compose stop`。应用容器不保存访问者的曲谱；停止或重建容器不替代浏览器工程备份。

## Node 与 systemd

安装系统级 Node.js 24 和 FFmpeg，将仓库放在 `/opt/noteblockstudio-web`。应用无需额外 npm 依赖：

```sh
sudo git clone https://github.com/sitbat/NoteBlockStudio-Web.git /opt/noteblockstudio-web
cd /opt/noteblockstudio-web
```

先在前台运行可直接检查启动输出，按 Ctrl+C 停止：

```sh
PUBLIC_ORIGIN=https://nbs.example.com node hosted-server.mjs
```

默认监听 `127.0.0.1:8765`；可通过 `HOST`、`PORT` 或 `--host`、`--port` 指定应用监听地址。`node hosted-server.mjs --help` 显示参数说明。

常驻运行使用 [`deploy/noteblockstudio-web.service`](../deploy/noteblockstudio-web.service)。模板使用 `/usr/bin/node`；若 Node 位于其他系统路径，修改 `ExecStart`。模板启用 `DynamicUser`、`PrivateTmp`、`ProtectHome` 与资源限制，因此代码和静态资源须可被动态服务用户读取，用户家目录中的 nvm 通常不适合直接用于该服务。

创建环境文件：

```sh
sudo install -m 600 /dev/null /etc/noteblockstudio-web.env
sudoedit /etc/noteblockstudio-web.env
```

填入：

```dotenv
PUBLIC_ORIGIN=https://nbs.example.com
HOSTED_ENABLE_TRANSCODE=1
```

安装并启动服务：

```sh
sudo cp deploy/noteblockstudio-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now noteblockstudio-web
sudo systemctl status noteblockstudio-web
sudo journalctl -u noteblockstudio-web -n 100 --no-pager
```

修改 `/etc/noteblockstudio-web.env` 后执行 `sudo systemctl restart noteblockstudio-web`。

## 应用接入要求

应用只支持来源根路径，例如 `https://nbs.example.com/`，不支持 `/music/` 等子路径。页面、脚本、Worker、AudioWorklet、WASM、采样及 `/api/` 应使用同一个来源。传给应用的原始 `Host` 必须与 `PUBLIC_ORIGIN` 的主机名和端口匹配。

浏览器音频线程需要安全上下文、WebAssembly SIMD、SharedArrayBuffer 和跨源隔离。应用提供以下响应头，接入环境应保留它们，避免剥离或加入冲突值：

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
```

也不要通过 `Permissions-Policy` 禁止 `cross-origin-isolated`。建议使用现代桌面 Edge / Chrome；首次发声需要用户点击。

应用只提供浏览器资源白名单，不公开 `.git`、文档、运行时二进制或服务端脚本。随机会话 Cookie 与 HMAC 请求令牌用于跨站请求校验，不是登录、账号或访问授权系统。

## 编码设置与限制

以下常用变量可直接写入 Docker 的 `.env`；修改后运行 `docker compose up -d`。systemd 则写入 `/etc/noteblockstudio-web.env` 后重启服务。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `HOSTED_ENABLE_TRANSCODE` | `1` | `0` 关闭服务器编码 |
| `HOSTED_MAX_INPUT_MIB` | `128` | 每次上传 WAV 上限，单位 MiB，允许 1–512 |
| `HOSTED_MAX_OUTPUT_MIB` | `128` | 每次编码结果上限，单位 MiB，允许 1–512 |
| `HOSTED_BODY_TIMEOUT_MS` | `20000` | 上传请求体超时，允许 1000–60000 ms |
| `HOSTED_TRANSCODE_RATE` | `30` | 每连接来源地址在默认 60 秒窗口内允许的转码请求数 |

`HOSTED_ENABLE_TRANSCODE=0` 时，原采样率立体声 WAV 仍可直接在浏览器下载；额外编码格式、重采样、单声道转换及需要 OGG 转换的自定义资源包不可用。

应用还支持 `HOSTED_PROCESS_TIMEOUT_MS`（默认 120000，允许 1000–120000 ms）、`HOSTED_RATE_WINDOW_MS`、`HOSTED_CAPABILITY_RATE`、`HOSTED_RATE_CLIENTS` 和 `HOSTED_SESSION_TTL_SECONDS`。用于 Compose 时，须同时把需要的高级变量加入 `app.environment`，仅写入 `.env` 不会自动传入容器。

输入与输出上限针对编码数据，不等同于工程文件大小。默认 `/tmp` 为 384 MiB，调大文件上限时须同时评估临时盘与内存，不能假定默认资源可同时容纳 512 MiB 输入和输出。经相同连接来源地址进入应用的访问者共享相应速率预算。资源包批处理会按限流提示等待并重试当前变体，达到等待上限后提示失败。

## 应用验收

[`scripts/smoke-hosted.mjs`](../scripts/smoke-hosted.mjs) 使用自行生成的 0.1 秒测试音，检查实际应用地址的资源、WASM、隔离响应头、非公开路径、会话及编码结果，不读取个人文件。用 Node.js 24 运行：

```sh
node scripts/smoke-hosted.mjs https://nbs.example.com --all-formats
```

`--all-formats` 要求编码服务可用，输出的 `encoded` 列表应包含 MP3、FLAC、AIFF、OGG、WAV。关闭编码时改用 `--no-transcode`。本机回环测试则使用与 `PUBLIC_ORIGIN` 完全一致的地址，例如 `http://127.0.0.1:8765`。

健康接口 `/api/health` 返回包含 `"ok":true` 和 `"mode":"hosted"` 的 JSON，只表示应用可达。还应在目标浏览器中打开曲谱、点击播放、检查跨源隔离、刷新确认本浏览器工程恢复、下载完整工程包、导出直接 WAV，并在启用编码时导出一份 MP3 / OGG。仓库的自动测试不替代实际接入环境和客户端验收。

## 更新与排查

更新前保存工程并备份 `.env` 等应用设置：

```sh
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=100 app
```

本地修改过受版本控制文件时，应先检查并合并。Node + systemd 更新代码后执行 `sudo systemctl restart noteblockstudio-web`。更新后重新加载页面，再检查播放和导出。

| 现象 | 应用检查项 |
| --- | --- |
| `Host is not the configured public origin` | `PUBLIC_ORIGIN` 是否与最终来源一致、应用收到的 Host 是否匹配 |
| 页面能开但线程音频不可用 | 安全上下文、隔离响应头、浏览器支持与站点权限 |
| 编码不可用 | `HOSTED_ENABLE_TRANSCODE`、系统 FFmpeg、应用日志 |
| 编码返回 413 / 409 / 429 / 超时 | 文件上限、已有转码任务、速率预算、上传或处理时间限制 |
| URL 导入失败 | 目标地址的 CORS 和混合内容限制；可下载后本地导入 |
| 更换来源后看不到旧工程 | 从原来源导出完整工程包，再在新来源导入 |
