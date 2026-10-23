# Linux 本地使用

从 Git 克隆时需要 Node18+（建议24）可在 PATH 中执行，或用 NODE_BINARY 指定。Git 不包含 Node 可执行文件；便携运行时准备方式见 [运行时下载](RUNTIMES.md)。本地 Linux x86_64 完整包可包含官方便携 Node24.11.0，正常使用无需另装 Node。两种方式都不需要 Rust、Python 或 GameMaker；应用通过本机 HTTP 服务运行，图形界面由用户自己的浏览器提供。

## 启动与停止

解压后，在终端进入项目目录。使用保留可执行权限的 Linux tar.gz；如果权限丢失，可只为这些本地文件补上权限：

```sh
cd "/path/NoteBlockStudio-Web"
chmod u+x start.sh install-linux.sh uninstall-linux.sh scripts/build-wasm.sh runtime/linux-x64/bin/node
./start.sh
```

默认监听 `http://127.0.0.1:8765` 并尝试打开浏览器。保留终端，按 `Ctrl+C` 停止。无需以 root 运行。不要直接打开 `index.html`：随包服务器负责音频线程所需的 COOP/COEP 隔离头与 WASM MIME。

也可以从其他目录调用脚本；项目路径有空格时需加引号：

```sh
sh "/path/NoteBlockStudio-Web/start.sh" --port 8766 --no-open
```

随后手动访问 `http://127.0.0.1:8766`。`--no-open` 只关闭自动打开浏览器，不会关闭服务。Linux 自动打开顺序为 `BROWSER` 指定的可执行文件、`xdg-open`、`gio open`；均不可用时终端打印访问地址。`BROWSER` 只能是一个程序路径，不能包含参数或 `%s` 模板。

常用参数可直接传给 `start.sh`：

| 参数 | 行为 |
| --- | --- |
| `--port 8766` / `--port=8766` | 选择1–65535端口；优先于环境变量 `PORT`，默认8765 |
| `--open` / `--no-open` | 是否自动打开浏览器；同一命令中最后一个生效 |
| `--player` | 用 `?player=1` 打开播放器界面 |
| `--open-file "/path/song.nbs"` | 只授予读取指定文件；也接受一个位置参数或 `file://` URL |
| `--url 'https://example.com/song.nbs'` | 提供待打开链接；网页确认后才下载，也支持原 `nbs://` 链接形式 |
| `--help` | 打印服务器参数并退出 |

```sh
./start.sh --player --open-file "/home/me/Music/my song.nbpz"
NBS_NO_OPEN=1 PORT=8766 ./start.sh
NODE_BINARY="/opt/node/bin/node" ./start.sh --no-open
```

文件与 URL 二选一。启动文件支持 `.nbs`、`.nbp`、`.nbpz`、`.zip`、`.mid`、`.midi`、`.json`，上限128 MiB。改变浏览器或端口会改变浏览器自动保存所属的地址，应先导出重要工程。

运行时选择顺序为 `NODE_BINARY`、`NODE`、本包 Linux x86_64 Node、PATH 中的 `node` / `nodejs`。其他架构、musl或旧 glibc 环境请提供兼容的 Node18+；不会自动安装系统包。便携 Node 的许可和来源见 [runtime说明](../runtime/README.md)。

## 用户目录桌面入口

安装仅在执行以下命令时发生，支持包含空格的项目目录：

```sh
./install-linux.sh
./uninstall-linux.sh
```

默认使用 `XDG_DATA_HOME`；未设置时使用 `~/.local/share`。安装写入 `applications/noteblockstudio-web-local.desktop` 和 `mime/packages/noteblockstudio-web-local.xml`，声明 `.nbs` / `.nbp` / `.nbpz` 的 MIME 类型及 `nbs://` 处理能力。存在时会调用 `update-mime-database`、`update-desktop-database` 更新该用户目录的缓存；不会安装这些工具或修改系统目录。

桌面入口保留终端，并记录项目与 Node 的绝对路径。既有默认文件/URL关联保持不变，是否出现在“打开方式”中由桌面环境决定。此脚本没有修改默认关联的参数。移动项目后需在新位置重新安装入口。

可固定桌面入口端口，或使用单独的数据目录；卸载须指定同一个目录：

```sh
./install-linux.sh --port 8766
./install-linux.sh --data-home "/tmp/nbs-desktop-test" --port 8877
./uninstall-linux.sh --data-home "/tmp/nbs-desktop-test"
```

等价入口要求安装/卸载标志放在第一个参数：

```sh
./start.sh --install-desktop --port 8766
./start.sh --uninstall-desktop
```

卸载只删除带本应用管理标记的桌面文件和 MIME 定义，不删除工程、歌曲或浏览器数据；遇到同名的无关文件或符号链接会拒绝覆盖/删除。脚本不接受安装目录以外的系统安装选项，也不创建开机服务。

## FFmpeg、Discord与重建

编辑、播放、Rust WAV导出不依赖 FFmpeg。需要其他编码格式时，在启动服务器前选择本机 FFmpeg，例如：

```sh
NBS_FFMPEG="/usr/bin/ffmpeg" ./start.sh
```

能力状态可在“设置 → 本地服务与系统集成”查看。FFmpeg 路径选择、格式限制与许可证见 [runtime说明](../runtime/README.md)。Discord 默认关闭，需桌面客户端运行且由用户手动启用；终端环境不会自动连接 Discord。

修改 Rust 后才需要重新构建。已提供 Cargo 与 `wasm32-unknown-unknown` 目标时运行：

```sh
sh scripts/build-wasm.sh
sh scripts/build-wasm.sh --debug
CARGO="/opt/rust/bin/cargo" CARGO_TARGET_DIR="/tmp/nbs-rust-build" sh scripts/build-wasm.sh
```

脚本使用离线 Cargo、SIMD128，默认 release 构建并复制到 `wasm/nbs_dsp.wasm`。`--debug` 必须为第一个参数，其余参数继续传给 Cargo。脚本不会安装 Rust 或下载目标工具链。本次 POSIX 构建入口已用任务本地 Windows Rust 工具链真实重建 WASM；没有在 Linux 虚拟机安装 Rust或运行 Linux Cargo 编译。

## Linux 实测范围

2026-10-23在现有 ArchLinux x86_64 虚拟机内使用独立临时目录验证：Linux7.2.9、官方 Node24.11.0、系统 FFmpeg9.0.2。完整记录见 [linux-v3.json](../benchmarks/linux-v3.json) 和 [14项测试输出](../benchmarks/linux-tests.tap)。

- 无系统 Node及运行时覆盖变量时，入口选择包内 Node；项目路径包含空格，脚本能从其他工作目录启动。
- 本机服务正常，COOP/COEP/CORP 响应头正确，WASM使用 `application/wasm` 且二进制有效。
- MP3、FLAC、AIFF、OGG、WAV真实编码成功；FFprobe确认输出44.1kHz、双声道。并发拒绝、编码进程超时及失败后恢复通过。
- 同源/令牌、启动文件授权、链接重定向和大小限制验证通过；Discord使用真实 Unix socket 假服务验证握手、活动、Ping/Pong与清除，没有连接真实 Discord账号。
- 桌面入口和 MIME 文件仅在临时 XDG目录安装/卸载，未改默认关联；14项服务/入口测试全部通过。测试服务器与专用临时目录已清理。

这些结果覆盖 Linux 命令行、服务、编解码、IPC协议和桌面文件生成。没有实测 Linux图形桌面启动器、浏览器声音输出、声卡、硬件MIDI、真实Discord客户端，或 Linux浏览器万轨实时播放；Windows浏览器的性能记录不作为这些项目的验收结果。
