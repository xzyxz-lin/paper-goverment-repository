[CmdletBinding()]
param(
    [string]$LocalZeroTierAddress = '10.44.55.169',

    [string]$RemoteAddresses = '10.44.55.0/24',

    [int]$Port = 8040
)

# Private Library - open ZeroTier LAN access (run as Administrator)
# Usage: powershell -ExecutionPolicy Bypass -File enable_zerotier_access.ps1

$ErrorActionPreference = 'Stop'

$currentPrincipal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Please run as Administrator (right-click PowerShell -> Run as Administrator)'
}

$ruleName = "Private Library ZeroTier $Port"

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    Set-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Enabled True -Profile Any -ErrorAction Stop | Out-Null
    Set-NetFirewallAddressFilter -AssociatedNetFirewallRule $existing -LocalAddress $LocalZeroTierAddress -RemoteAddress $RemoteAddresses -ErrorAction Stop | Out-Null
    Write-Host 'UPDATED firewall rule' -ForegroundColor Green
}
else {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Enabled True `
        -Protocol TCP -LocalPort $Port -LocalAddress $LocalZeroTierAddress `
        -RemoteAddress $RemoteAddresses -Profile Any -ErrorAction Stop | Out-Null
    Write-Host 'CREATED firewall rule' -ForegroundColor Green
}

Write-Host ''
Write-Host "LAN URL: http://${LocalZeroTierAddress}:$Port" -ForegroundColor Cyan
Write-Host "Allowed sources: $RemoteAddresses" -ForegroundColor Yellow
Write-Host 'Note: backend should be started with --host 0.0.0.0 (start_web.ps1 default).' -ForegroundColor DarkGray
