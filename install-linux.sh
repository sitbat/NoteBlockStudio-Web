#!/bin/sh
set -eu

# Resolve directory and file links before choosing the bundled Linux runtime.
task_script=$0
if command -v readlink >/dev/null 2>&1; then
    while [ -L "$task_script" ]; do
        task_parent=${task_script%/*}
        [ "$task_parent" != "$task_script" ] || task_parent=.
        task_link=$(readlink "$task_script")
        case "$task_link" in /*) task_script=$task_link ;; *) task_script=$task_parent/$task_link ;; esac
    done
fi
task_parent=${task_script%/*}
[ "$task_parent" != "$task_script" ] || task_parent=.
task_bootroot=$(CDPATH= cd -P "$task_parent" && pwd)
task_node=${NODE_BINARY:-${NODE:-}}
if [ -z "$task_node" ]; then
    case "$(uname -s 2>/dev/null || printf unknown)/$(uname -m 2>/dev/null || printf unknown)" in
        Linux/x86_64|Linux/amd64) [ ! -x "$task_bootroot/runtime/linux-x64/bin/node" ] || task_node=$task_bootroot/runtime/linux-x64/bin/node ;;
    esac
fi
if [ -z "$task_node" ]; then task_node=$(command -v node || command -v nodejs || true); fi
[ -n "$task_node" ] && command -v "$task_node" >/dev/null 2>&1 || {
    printf '%s\n' 'Node.js 18 or newer is required. Set NODE_BINARY to its executable path.' >&2
    exit 1
}
task_root=$("$task_node" -e 'const fs=require("fs"),p=require("path");process.stdout.write(p.dirname(fs.realpathSync(process.argv[1])))' "$0")
exec "$task_node" "$task_root/scripts/linux-desktop.mjs" install "$@"
