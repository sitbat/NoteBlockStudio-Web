# 从 Git 源码恢复可选运行时

Git 仓库保留运行时许可证、说明和校验信息，不提交超过100 MiB的 FFmpeg / Node 可执行文件。本地完整包及已下载的二进制不受影响。`scripts/setup-runtime.mjs` 可恢复固定版本，不需要 npm 依赖，不安装系统软件，也不修改 PATH、注册表或系统关联。

脚本本身需要已有 Node.js18+。从 Git 克隆后，Linux 用户也需要先提供一个 Node 才能运行这个 JavaScript 脚本；恢复的便携 Node 用于之后通过 `start.sh` 启动应用。若已经使用合适的系统 Node 和 FFmpeg，可以直接使用它们，无须重复下载。

## 命令

在项目根目录运行：

```sh
node scripts/setup-runtime.mjs --help
node scripts/setup-runtime.mjs --list
node scripts/setup-runtime.mjs
```

`--help` 和 `--list` 不联网。无参数时，Windows x64 选择 FFmpeg9.0.2，Linux x64 选择便携 Node24.11.0。其他平台需自行提供兼容运行时，或显式选择下列已知目标供其他机器使用：

```sh
node scripts/setup-runtime.mjs --runtime ffmpeg-win32-x64
node scripts/setup-runtime.mjs --runtime node-linux-x64
node scripts/setup-runtime.mjs --all
```

也可重复 `--runtime`。`--all` 与 `--runtime` 不能同时使用。下载结束后运行正常启动入口即可；脚本不会执行下载得到的 FFmpeg 或 Node。Windows 的便携 FFmpeg 在本地服务启动时自动发现，Linux 的便携 Node 由 `start.sh` 选择。

| 目标 | 固定来源与版本 | 安装文件 |
| --- | --- | --- |
| `ffmpeg-win32-x64` | Gyan 的 FFmpeg9.0.2 essentials Windows x64 构建，FFmpeg官网列出的发行方 | `runtime/win32-x64/ffmpeg.exe`、`LICENSE`、`README.txt` |
| `node-linux-x64` | Node.js官方24.11.0 Linux x64 | `runtime/linux-x64/bin/node`、`LICENSE`、`README.md` |

Linux ARM64、macOS、musl或不兼容的旧 glibc系统不使用这里的 Linux x64二进制；请提供适配的系统 Node18+。脚本不下载 Linux FFmpeg，使用系统 FFmpeg或显式 `NBS_FFMPEG`，详见 [runtime说明](../runtime/README.md)。

## 校验、下载与已有文件

每个目标同时固定下载 URL、归档字节数、归档 SHA256和最终可执行文件 SHA256。下载仅使用 HTTPS，限制重定向；整包校验通过后才交给系统解压器，仅提取指定文件。最终二进制再次校验通过，才写入对应的项目目录。校验失败会报错并清理本次临时目录，不会启动未校验程序。

默认最多16路 HTTP Range下载；服务器忽略 Range时使用该次完整响应。可调为单连接或增加每个归档的下载时间上限：

```sh
node scripts/setup-runtime.mjs --runtime ffmpeg-win32-x64 --connections 1 --timeout 1200
```

`--connections` 为1–16，默认16；`--timeout` 为10–3600秒，默认600秒。超时或失败后可重试。临时目录在项目 `runtime/.setup-*` 下，每次安装结束后清理；不保留未完成的网络下载，也不自动改代理。

如果已经有完整归档，可离线恢复；仍会核对同一组固定校验值：

```sh
node scripts/setup-runtime.mjs --runtime ffmpeg-win32-x64 --archive "/path/ffmpeg-9.0.2-essentials_build.zip"
node scripts/setup-runtime.mjs --runtime node-linux-x64 --archive "/path/node-v24.11.0-linux-x64.tar.xz"
```

`--archive` 只能对应一个目标，不接受自定义 URL、版本或校验值。已有完整运行时且二进制 SHA匹配时，脚本直接复用，不再下载或提取。遇到不同的已有可执行文件，默认拒绝覆盖；需要替换时明确运行：

```sh
node scripts/setup-runtime.mjs --runtime ffmpeg-win32-x64 --force
```

`--force` 仍要通过全部固定校验。实际发生替换时，原文件保存在 `runtime/.runtime-backups/<目标-时间-随机值>/`，按原目录结构保留；发生安装错误时会尝试恢复原文件。备份不会自动删除。安装不会删除现有完整包，也不会将下载器变成自动升级服务。

## 解压工具与许可证

ZIP使用纯 Node标准库读取目录及解压，只接受指定的普通文件，检查大小和 CRC，不依赖 Windows工具或 GNU tar的 ZIP能力。`.tar.xz` 使用现有系统 `tar`，所有参数通过数组传递，关闭 shell。缺少支持该格式的 tar会报错，不会自动安装。POSIX系统安装可执行文件时设置用户可执行权限。

Windows FFmpeg构建使用 GPLv3，保留[完整许可](../runtime/win32-x64/LICENSE)、[上游构建说明](../runtime/win32-x64/README.txt)及[来源和校验值](../runtime/win32-x64/PROVENANCE.md)。Linux Node保留[完整许可及第三方说明](../runtime/linux-x64/LICENSE)、[上游README](../runtime/linux-x64/README.md)和[来源校验值](../runtime/linux-x64/PROVENANCE.md)。这些许可与项目代码的 MIT许可证分别保留。

## 这次验证

测试仅使用受控本地 HTTP、小归档和已有官方归档，没有重新下载大型文件，也没有执行下载得到的程序。10项窄测试覆盖参数/帮助、SHA及大小失败、分段下载、Range回退、超时、校验前禁止提取、已有文件复用、强制替换备份、目录链接拒绝、纯 Node ZIP提取及真实 tar指定成员提取。

另在 `work/` 的独立临时项目内，用已验证的官方 FFmpeg9.0.2 ZIP实际运行了 `--archive`：提取后二进制 SHA与固定值一致，第二次运行报告 `already-present`，原应用的本地二进制校验值保持不变。脚本下载的是固定版本；若将来更新版本，需要同时审查来源、归档校验值、二进制校验值和许可证记录。
