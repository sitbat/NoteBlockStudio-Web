# 服务器网站部署

仓库提供 Docker Compose + Caddy，以及已有 HTTPS 反向代理环境使用的 Node + systemd 模板。它们是通用部署配置；提供这些文件不代表已经替您购买域名、配置服务器或发布网站。以下命令面向 Linux 服务器，域名 `nbs.example.com` 必须替换为自己的域名。

## 网站版的数据与计算位置

编辑、采样播放、Rust / WebAssembly 多线程混音、每轨混响和 WAV 渲染仍在访问者的浏览器中完成。服务器配置的 2 CPU / 1536 MiB 是网站后端的资源上限，不会替访问者承担万轨播放计算。仓库中的万轨实测仅对应记录中的设备与浏览器，其他访问设备需要自行调整 Worker、缓冲及轨道数量。

曲谱、自定义采样、偏好与自动备份保存在访问者当前浏览器、当前网站来源的 IndexedDB / 本地存储中。网站没有云项目库、账号同步或跨设备恢复；清除站点数据、切换浏览器，或更换协议、域名、端口，都会影响可见的本地项目。重要作品应下载为包含音频的 `.nbpz` 完整工程包。

原采样率、立体声 WAV 可以在浏览器直接生成。MP3 / FLAC / AIFF / OGG、重采样或单声道导出，需要在用户点击导出后，将渲染好的 WAV 临时上传到网站服务器，由 FFmpeg 编码并返回下载；生成 OGG 的自定义音色资源包也会使用此服务。后端处理结束会清理临时文件，不提供作品长期保存服务。运营者仍应按自己的基础设施管理日志、备份与访问权限。

网站版的 URL 导入由浏览器直接读取目标地址，受目标站 CORS、HTTPS 混合内容和浏览器网络规则约束；读取失败时，先下载曲谱再用“打开文件”导入。网站后端不代理下载外部 URL，不提供本机文件启动入口或 Discord 活动连接。

## Docker Compose + 自动 HTTPS

需要已经安装 Docker Engine 与 Compose 插件的 Linux 服务器，以及可以管理 DNS 的域名。Compose 的基本操作见 [Docker 官方文档](https://docs.docker.com/compose/gettingstarted/)。

1. 将域名的 A 记录指向服务器公网 IPv4。若同时配置 AAAA，必须保证对应 IPv6 也能访问这台服务器。
2. 在服务器防火墙和云安全组开放入站 TCP 80、443；确保这两个端口没有被其他服务占用。此模板不要求对外开放 8765。
3. 获取仓库并创建环境文件：

   ```sh
   git clone https://github.com/sitbat/NoteBlockStudio-Web.git
   cd NoteBlockStudio-Web
   cp .env.example .env
   ```

4. 编辑 `.env`，至少设置以下一项，值只填写主机名，不加 `https://`、路径或结尾斜杠：

   ```dotenv
   DOMAIN=nbs.example.com
   ```

5. 检查配置、构建并启动：

   ```sh
   docker compose config --quiet
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=100 app caddy
   ```

域名解析和网络条件满足后，访问 `https://nbs.example.com/`。Caddy 会申请、续期证书并处理 HTTP 到 HTTPS 的跳转；证书签发还取决于域名验证与证书机构的可用性，详见 [Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)。

[`compose.yaml`](../compose.yaml) 只发布 Caddy 的 80 / 443 端口。应用只连接内部 `backend` 网络，Caddy 另连接 `edge` 网络；应用以非 root 用户运行，文件系统只读，转码临时文件使用有大小限制的 `/tmp`。应用容器默认限制为 2 CPU、1536 MiB 内存，并且全局只处理一个转码任务。浏览器编辑、播放可以并行使用，但匿名转码服务没有任务队列。

证书与 Caddy 状态保存在 `caddy_data`、`caddy_config` 命名卷中。更新或重启时保留这两个卷；不要随意运行 `docker compose down -v`，它会删除命名卷。普通停止可用 `docker compose stop`。

### 关闭服务器音频编码

若只需要浏览器编辑、播放和直接 WAV 下载，将 `.env` 改为：

```dotenv
HOSTED_ENABLE_TRANSCODE=0
```

然后运行 `docker compose up -d`。这会关闭服务器转码能力；额外编码格式、重采样、单声道转换，以及需要转成 OGG 的自定义资源包音频将不可用，原采样率立体声 WAV 仍由浏览器直接下载。

### 可选：仅供自己或小范围使用

默认网站允许匿名访问。后端的随机会话 Cookie 与 HMAC 请求令牌用于限制跨站转码请求，**不构成用户登录、用户配额或访问授权系统**。匿名接口有并发、速率、大小和超时限制；公开运营仍需要结合自己的访问控制与资源预算。

可以在 Caddy 前置 HTTP Basic Authentication。先交互生成密码哈希，避免把明文密码写入命令参数：

```sh
docker run --rm -it caddy:2-alpine caddy hash-password
```

在 `.env` 设置用户名与输出的哈希，哈希用单引号包住，避免 `$` 被 Compose 当作变量展开：

```dotenv
NBS_AUTH_USER=your-user
NBS_AUTH_HASH='$2a$14$替换为实际完整哈希'
```

取消 [`deploy/Caddyfile`](../deploy/Caddyfile) 中 `basic_auth` 整个区块的注释，再运行 `docker compose up -d --force-recreate caddy`。通过 HTTPS 访问时浏览器会要求凭据。密码必须使用哈希，具体规则见 [Caddy basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth)。不要提交包含凭据的 `.env`。

## 已有 HTTPS 反向代理：Node + systemd

已有 Nginx、证书和域名时，可以直接使用 [`deploy/nginx.conf.example`](../deploy/nginx.conf.example) 与 [`deploy/noteblockstudio-web.service`](../deploy/noteblockstudio-web.service)，不同时运行上面的 Caddy 端口映射。

安装系统级 Node.js 24 与 FFmpeg，确保服务可以执行 `/usr/bin/node` 和 PATH 中的 `ffmpeg`。若 Node 安装在其他系统路径，修改 service 的 `ExecStart`；用户家目录中的 nvm 安装通常不能直接用于该模板，因为服务使用 `DynamicUser` 和 `ProtectHome`。现成 WASM 已随仓库提供，无需安装 Rust、GameMaker 或执行 `npm install`。

将仓库放在 `/opt/noteblockstudio-web`，确保动态服务用户可读取代码与静态资源：

```sh
sudo git clone https://github.com/sitbat/NoteBlockStudio-Web.git /opt/noteblockstudio-web
cd /opt/noteblockstudio-web
sudo install -m 600 /dev/null /etc/noteblockstudio-web.env
sudoedit /etc/noteblockstudio-web.env
```

环境文件至少包含真实公开来源，不能包含子路径：

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

服务默认只监听 `127.0.0.1:8765`。将 Nginx 示例中的域名、证书路径改为自己的配置，并合并到该域名的 HTTPS `server` 中；若已有相同域名的配置，不要另建重复的 `server`。检查后重载：

```sh
sudo nginx -t
sudo systemctl reload nginx
```

反向代理必须保留浏览器的原始 `Host`，与 `PUBLIC_ORIGIN` 的主机名和端口精确一致；不要将它改成 `127.0.0.1:8765`。示例还会覆盖 `X-NBS-Client-IP` 为代理实际看到的客户端地址，配合 service 中显式开启的 `TRUST_PROXY_HEADERS=1` 用于速率限制。只在后端确实只能由可信代理访问，且代理覆盖该专用头时启用此开关。后端不使用 `X-Forwarded-For` 决定客户端地址，也不使用任何 forwarded 字段放宽公开来源校验。

如果自建反向代理或使用 CDN，仍需保持 HTTPS、正确 Host 和跨源隔离响应头；不要公开后端端口、去掉上传限制，或让用户绕过代理直接连接后端。

## 路径、响应头与浏览器要求

当前部署只支持域名根路径，例如 `https://nbs.example.com/`，不支持挂载在 `/music/` 之类的子路径。使用同一个来源提供页面、脚本、Worker、AudioWorklet、WASM、采样及 `/api/`，不要把其中一部分随意改到另一个 CDN 域名。后端只提供浏览器所需的静态白名单；仓库的 `.git`、源码、文档、运行时二进制及服务端脚本不会作为任意静态文件提供。

音频线程需要安全上下文、WebAssembly SIMD 和 SharedArrayBuffer。后端在响应中设置：

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
```

反向代理应保留这些头，避免添加互相冲突的重复值；也不要通过 `Permissions-Policy` 禁止 `cross-origin-isolated`。HTTPS、跨源隔离和浏览器支持需要同时满足，见 [MDN crossOriginIsolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)。建议使用现代桌面 Edge / Chrome，首次发声仍需要用户点击。

## 编码限制与配置

Compose 的 `.env` 暴露以下常用配置；修改后运行 `docker compose up -d`。使用 systemd 时则写入 `/etc/noteblockstudio-web.env` 并重启服务。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `HOSTED_ENABLE_TRANSCODE` | `1` | `0` 关闭服务器编码 |
| `HOSTED_MAX_INPUT_MIB` | `128` | 每次上传 WAV 的上限，单位 MiB，允许 1–512 |
| `HOSTED_MAX_OUTPUT_MIB` | `128` | 每次编码结果的上限，单位 MiB，允许 1–512 |
| `HOSTED_BODY_TIMEOUT_MS` | `20000` | 上传请求体超时，允许 1000–60000 ms |
| `HOSTED_TRANSCODE_RATE` | `30` | 每客户端在默认 60 秒窗口内允许的转码请求数 |

服务端还支持 `HOSTED_PROCESS_TIMEOUT_MS`（默认 120000，范围 1000–120000 ms）、`HOSTED_RATE_WINDOW_MS`、`HOSTED_CAPABILITY_RATE`、`HOSTED_RATE_CLIENTS` 和 `HOSTED_SESSION_TTL_SECONDS`。这些高级变量若用于 Compose，须同时加入 `compose.yaml` 的 `app.environment`；只写入 `.env` 不会自动传进容器。

上传与输出上限均针对编码数据，不等同于工程文件大小。原采样率立体声 WAV 的浏览器直接下载不经过上传限制。Nginx 示例的请求体上限为 `128m`，Caddy 示例为 `512MiB`，实际可接受大小还受后端上限约束；调高后端限制时需同时评估代理限制、容器临时盘和内存。默认 `/tmp` 为 384 MiB，不能在不调整资源的情况下假定同时支持 512 MiB 输入与输出。

## 验收、更新与排查

在公开 URL 上检查页面和健康接口：

```sh
curl -I https://nbs.example.com/
curl https://nbs.example.com/api/health
```

健康接口应返回包含 `"ok":true` 和 `"mode":"hosted"` 的 JSON；它只证明后端可达，不能证明 TLS 续期、真实浏览器音频或转码已验收。启用 Basic Auth 后需使用相应凭据访问这些地址。

仓库另附 [`scripts/smoke-hosted.mjs`](../scripts/smoke-hosted.mjs)，可从有 Node.js 24 的电脑或服务器运行。它检查实际 URL 的静态资源、WASM、隔离响应头、禁止公开的路径、会话校验和编码结果，并只使用自行生成的 0.1 秒测试音，不读取个人文件：

```sh
node scripts/smoke-hosted.mjs https://nbs.example.com --all-formats
```

`--all-formats` 要求编码服务可用，并在输出的 `encoded` 列表中列出 MP3、FLAC、AIFF、OGG、WAV；编码关闭或 FFmpeg 不可用时会报错。只验证网站与接口隔离时使用 `--no-transcode`。当前脚本不提供 Basic Auth 凭据参数；启用代理鉴权的网站应通过浏览器及带凭据的 `curl` 另行检查，不能把 401 当成应用部署故障。

正式使用前，在真实 HTTPS 地址中完成：打开曲谱、点击播放、检查性能窗口是否跨源隔离、刷新确认浏览器工程恢复、下载完整工程包、导出一份直接 WAV，以及在启用编码时导出一份 MP3 / OGG。仓库的测试记录不替代您的域名、反向代理、证书和客户端环境验收。

更新前让使用者保存作品，并备份 `.env`、自定义代理配置及 Caddy 命名卷。未修改受版本控制配置的 Docker checkout 可执行：

```sh
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=100 app caddy
```

若本地修改了 Caddyfile 等受版本控制文件，先检查并合并更新；不要用覆盖命令丢弃自己的配置。Node + systemd 部署在更新代码后执行 `sudo systemctl restart noteblockstudio-web`。页面返回 `no-cache`，更新后重新加载浏览器，并再次检查音频与导出。

| 现象 | 首先检查 |
| --- | --- |
| 证书申请失败或打不开站点 | DNS A / AAAA、80 / 443 的公网可达性、端口占用、Caddy 日志 |
| `Host is not the configured public origin` | `PUBLIC_ORIGIN` / `DOMAIN`、浏览器地址中的端口、代理是否保留 Host |
| 页面能开但线程音频不可用 | 实际 HTTPS、COOP / COEP 是否被代理覆盖、浏览器支持与站点权限 |
| 编码不可用 | `HOSTED_ENABLE_TRANSCODE`、系统 FFmpeg、服务日志；直接 WAV 可另行验证 |
| 编码返回 413 / 409 / 429 / 超时 | 输入/输出上限、全局已有编码任务、客户端速率限制、上传或处理时间限制 |
| URL 导入失败 | 曲谱来源的 CORS、混合内容限制；下载文件后本地导入 |
| 换域名后看不到旧工程 | 浏览器存储按来源隔离；从原来源导出工程包后在新来源导入 |
