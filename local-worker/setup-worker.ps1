# Pinned front door for local-worker/setup_worker.py (Windows PowerShell).
#
# This wrapper never installs or upgrades uv. It requires uv 0.12.12 exactly,
# then asks uv to provide the project-pinned CPython 3.12.14 for the
# orchestrator. No pairing code is accepted through this script's arguments;
# use --packet-stdin, --code-stdin, or --code-fd.
$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$worker = Join-Path $here "setup_worker.py"
if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) {
    [Console]::Error.WriteLine("setup-worker: setup_worker.py is missing beside this wrapper")
    exit 3
}

$uvBin = $env:AIPSTER_UV
if (-not $uvBin) {
    $uvCommand = Get-Command uv -ErrorAction SilentlyContinue
    if ($uvCommand) { $uvBin = $uvCommand.Source }
}
if (-not $uvBin) {
    [Console]::Error.WriteLine("setup-worker: uv 0.12.12 is required exactly; install it and rerun (no global upgrade is attempted).")
    exit 3
}

try {
    $versionLine = (& $uvBin --version 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "uv --version failed" }
    $parts = ($versionLine -split '\s+')
    if ($parts.Length -lt 2) { throw "unreadable version" }
    $version = $parts[1]
} catch {
    [Console]::Error.WriteLine("setup-worker: could not read the uv version; uv 0.12.12 is required exactly.")
    exit 3
}
if ($version -ne "0.12.12") {
    [Console]::Error.WriteLine("setup-worker: uv 0.12.12 is required exactly; found $version. No substitution or global upgrade is attempted.")
    exit 3
}

$env:UV_NO_CONFIG = "1"
$env:PYTHONNOUSERSITE = "1"
$env:PYTHONDONTWRITEBYTECODE = "1"
& $uvBin run --no-project --python 3.12.14 python $worker @args
exit $LASTEXITCODE
