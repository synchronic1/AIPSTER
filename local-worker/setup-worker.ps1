# Front door for local-worker/setup_worker.py (Windows PowerShell).
#
# Uses a suitable uv 0.12.12 from PATH when one exists. Otherwise it provisions
# the same pinned uv build into a user-private cache through uv_bootstrap.py,
# verifying the official archive SHA-256 before extraction. It never upgrades,
# replaces, or writes to a global uv. The private directory is added to PATH
# and AIPSTER_UV for the child process only.
#
# No pairing code is accepted through this script's arguments; use
# --packet-stdin, --code-stdin, or --code-fd.
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

$uvVersion = ""
if ($uvBin -and (Test-Path -LiteralPath $uvBin -PathType Leaf)) {
    try {
        $versionLine = (& $uvBin --version 2>$null)
        if ($LASTEXITCODE -eq 0) {
            $parts = ($versionLine -split '\s+')
            if ($parts.Length -ge 2) { $uvVersion = $parts[1] }
        }
    } catch {
        $uvVersion = ""
    }
}

if ($uvVersion -ne "0.12.12") {
    $bootstrap = Join-Path $here "uv_bootstrap.py"
    if (Test-Path -LiteralPath $bootstrap -PathType Leaf) {
        $pythonBin = $env:AIPSTER_PYTHON
        $pythonArgs = @()
        if (-not $pythonBin) {
            $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
            if ($pythonCommand) {
                $pythonBin = $pythonCommand.Source
            } else {
                $pyCommand = Get-Command py -ErrorAction SilentlyContinue
                if ($pyCommand) {
                    $pythonBin = $pyCommand.Source
                    $pythonArgs = @("-3")
                }
            }
        }
        if (-not $pythonBin) {
            [Console]::Error.WriteLine("setup-worker: uv 0.12.12 is absent and Python 3.9+ is unavailable for the private bootstrap.")
            [Console]::Error.WriteLine("setup-worker: install Python 3.9+ (or a qualified packaged installer); no global uv was changed.")
            exit 3
        }
        & $pythonBin @pythonArgs -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" 2>$null
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine("setup-worker: Python 3.9+ is required for the private uv bootstrap; no global uv was changed.")
            exit 3
        }
        if ($uvVersion) {
            [Console]::Error.WriteLine("setup-worker: found uv $uvVersion, not the pinned 0.12.12; using a private pinned uv without changing it.")
        }
        $bootstrapOutput = @(& $pythonBin @pythonArgs $bootstrap --print-path)
        $bootstrapStatus = $LASTEXITCODE
        if ($bootstrapStatus -ne 0) {
            [Console]::Error.WriteLine("setup-worker: private pinned uv bootstrap failed; no global uv was changed.")
            exit $bootstrapStatus
        }
        $uvBin = ($bootstrapOutput -join "").Trim()
        if (-not $uvBin -or -not (Test-Path -LiteralPath $uvBin -PathType Leaf)) {
            [Console]::Error.WriteLine("setup-worker: private pinned uv bootstrap returned no executable; no global uv was changed.")
            exit 3
        }
        $uvDir = Split-Path -Parent $uvBin
        [Console]::Error.WriteLine("setup-worker: using private pinned uv at $uvBin for this command only.")
        $env:PATH = "$uvDir;$env:PATH"
        $env:AIPSTER_UV = $uvBin
        $env:UV_NO_CONFIG = "1"
        $env:PYTHONNOUSERSITE = "1"
        $env:PYTHONDONTWRITEBYTECODE = "1"
        & $uvBin run --no-project --python 3.12.14 python $worker @args
        exit $LASTEXITCODE
    }
    [Console]::Error.WriteLine("setup-worker: uv 0.12.12 is required exactly; install it and rerun (no global upgrade is attempted).")
    exit 3
}

$env:UV_NO_CONFIG = "1"
$env:PYTHONNOUSERSITE = "1"
$env:PYTHONDONTWRITEBYTECODE = "1"
& $uvBin run --no-project --python 3.12.14 python $worker @args
exit $LASTEXITCODE
