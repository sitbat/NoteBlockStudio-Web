param([switch]$Debug)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$taskEnv = Join-Path $projectRoot '../../work/toolchain/env.ps1'
if (Test-Path -LiteralPath $taskEnv) { . $taskEnv }
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'Rust cargo not found. Install stable Rust and the wasm32-unknown-unknown target, then rerun.' }
$previousRustFlags = $env:RUSTFLAGS
try {
    $env:RUSTFLAGS = (($previousRustFlags + ' -C target-feature=+simd128').Trim())
    $arguments = @('build', '--manifest-path', (Join-Path $projectRoot 'rust/Cargo.toml'), '--target', 'wasm32-unknown-unknown', '--offline')
    $profile = 'debug'
    if (-not $Debug) { $arguments += '--release'; $profile = 'release' }
    & cargo @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Rust WASM build failed.' }
    $destination = Join-Path $projectRoot 'wasm'
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot "rust/target/wasm32-unknown-unknown/$profile/nbs_dsp.wasm") -Destination (Join-Path $destination 'nbs_dsp.wasm')
    Get-Item -LiteralPath (Join-Path $destination 'nbs_dsp.wasm') | Select-Object FullName, Length
} finally { $env:RUSTFLAGS = $previousRustFlags }
