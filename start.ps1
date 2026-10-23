$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$taskNodeCommand = Get-Command node -ErrorAction SilentlyContinue
$taskNodeRuntime = if ($taskNodeCommand) { $taskNodeCommand.Source } else { $null }
if (-not $taskNodeRuntime) {
    $taskRuntimeCandidates = @(
        (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    )
    $taskNodeRuntime = $taskRuntimeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $taskNodeRuntime) {
    Write-Host 'Node.js 18 or newer was not found. Install Node.js and run start.bat again; the included server supplies the required audio isolation headers.' -ForegroundColor Red
    exit 1
}

Write-Host 'Starting Note Block Studio Web on http://127.0.0.1:8765 ...'
Write-Host 'Keep this window open. Press Ctrl+C to stop the local server.'
& $taskNodeRuntime (Join-Path $PSScriptRoot 'server.mjs') --open @args
exit $LASTEXITCODE
