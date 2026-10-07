[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8040,

    [switch]$NoBrowser
)

$ErrorActionPreference = 'Continue'

# Derive paths from $PSScriptRoot (no non-ASCII literals for encoding safety).
$projectRoot  = (Resolve-Path -LiteralPath (Join-Path -Path $PSScriptRoot -ChildPath '..')).Path
$serverScript = Join-Path -Path $PSScriptRoot -ChildPath 'library.py'
$venvPython   = Join-Path -Path $projectRoot -ChildPath '.venv\Scripts\python.exe'
$siteUrl      = "http://127.0.0.1:$Port"

function Test-LibraryReady {
    param([string]$Url)
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri ($Url + '/api/health') -TimeoutSec 2
        return $r.StatusCode -eq 200
    } catch { return $false }
}

if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host "python venv missing: $venvPython"
    Write-Host "Run: python -m venv .venv; .venv\Scripts\pip install pdfplumber pypdf"
    exit 1
}

# 若端口被旧进程占用，先全部释放，避免用到旧代码（8040 专用于私人文献库）
# 注意：可能残留多个实例叠在同一端口上，必须逐个杀干净
$occupied = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($occupied) {
    $oldPids = $occupied | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($oldPid in $oldPids) {
        try { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue } catch {}
    }
    Start-Sleep -Seconds 1
}

if (-not (Test-LibraryReady -Url $siteUrl)) {
    Write-Host 'Starting Private Library backend...'
    Start-Process -FilePath $venvPython -ArgumentList @($serverScript, '--host', '0.0.0.0', '--port', [string]$Port) -WindowStyle Hidden | Out-Null
    $ok = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        if (Test-LibraryReady -Url $siteUrl) { $ok = $true; break }
    }
    if (-not $ok) {
        Write-Host 'Backend start timeout.'
        exit 1
    }
}

Write-Host "Ready: $siteUrl"
if (-not $NoBrowser) {
    Start-Process explorer.exe -ArgumentList $siteUrl | Out-Null
    Write-Host 'Private Library opened. Closing in 3s...'
    Start-Sleep -Seconds 3
}
