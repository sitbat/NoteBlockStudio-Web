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
task_bootroot=$(CDPATH= cd -P "$task_parent/.." && pwd)
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
task_root=$("$task_node" -e 'const fs=require("fs"),p=require("path");process.stdout.write(p.dirname(p.dirname(fs.realpathSync(process.argv[1]))))' "$0")

task_cargo=${CARGO:-cargo}
command -v "$task_cargo" >/dev/null 2>&1 || { printf '%s\n' 'Cargo is required only to rebuild WASM; the included binary runs without Rust.' >&2; exit 1; }
task_profile=release
case "${1-}" in --debug) task_profile=debug; shift ;; esac
task_target=${CARGO_TARGET_DIR:-$task_root/rust/target}
task_target=$("$task_node" -e 'process.stdout.write(require("path").resolve(process.argv[1]))' "$task_target")
RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C target-feature=+simd128"
export RUSTFLAGS
if [ "$task_profile" = release ]; then
    "$task_cargo" build --manifest-path "$task_root/rust/Cargo.toml" --target wasm32-unknown-unknown --target-dir "$task_target" --release --offline "$@"
else
    "$task_cargo" build --manifest-path "$task_root/rust/Cargo.toml" --target wasm32-unknown-unknown --target-dir "$task_target" --offline "$@"
fi
"$task_node" -e 'const fs=require("fs"),p=require("path");fs.mkdirSync(p.dirname(process.argv[2]),{recursive:true});fs.copyFileSync(process.argv[1],process.argv[2])' "$task_target/wasm32-unknown-unknown/$task_profile/nbs_dsp.wasm" "$task_root/wasm/nbs_dsp.wasm"
printf '%s\n' "Built $task_root/wasm/nbs_dsp.wasm"
