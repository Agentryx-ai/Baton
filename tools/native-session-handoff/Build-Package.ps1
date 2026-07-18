#requires -Version 5.1
[CmdletBinding()]
param([string]$Destination)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $Destination) {
    $Destination = Join-Path $PSScriptRoot 'output\baton-native-session-handoff-0.2.0.zip'
}
$resolvedDestination = [IO.Path]::GetFullPath($Destination)
$destinationDirectory = Split-Path -Parent $resolvedDestination
[void][IO.Directory]::CreateDirectory($destinationDirectory)
$stagingRoot = Join-Path ([IO.Path]::GetTempPath()) ('baton-handoff-package-' + [guid]::NewGuid().ToString('N'))
$packageDirectory = Join-Path $stagingRoot 'baton-native-session-handoff'
[void][IO.Directory]::CreateDirectory($packageDirectory)

try {
    foreach ($item in Get-ChildItem -LiteralPath $PSScriptRoot -Force) {
        if ($item.Name -eq 'output') { continue }
        Copy-Item -LiteralPath $item.FullName -Destination $packageDirectory -Recurse -Force
    }
    if (Test-Path -LiteralPath $resolvedDestination) { Remove-Item -LiteralPath $resolvedDestination -Force }
    Compress-Archive -LiteralPath $packageDirectory -DestinationPath $resolvedDestination -CompressionLevel Optimal
    $digest = (Get-FileHash -LiteralPath $resolvedDestination -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$resolvedDestination.sha256", "$digest  $([IO.Path]::GetFileName($resolvedDestination))`n", [Text.UTF8Encoding]::new($false))
    Write-Host $resolvedDestination
    Write-Host "SHA256 $digest"
}
finally {
    $resolvedStaging = [IO.Path]::GetFullPath($stagingRoot)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedStaging.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStaging)) {
        Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
    }
}
