#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Inventory', 'Plan', 'Wizard', 'Apply')]
    [string]$Action = 'Wizard',

    [ValidateSet('all', 'codex-to-claude', 'claude-to-codex')]
    [string]$Direction = 'all',

    [string]$CodexHome,
    [string]$ClaudeHome,
    [string]$ProjectPath,
    [string]$OutputRoot,
    [string]$ManifestPath,
    [ValidateRange(0, 36500)][int]$SinceDays = 365,
    [ValidateRange(0, 64)][int]$Concurrency = 4,
    [string]$CodexModel = 'gpt-5.6-sol',
    [string]$CodexEffort = 'high',
    [string]$ClaudeModel = 'claude-fable-5',
    [string]$ClaudeEffort = 'high',
    [switch]$RequireEffectiveAttestation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'NativeSessionHandoff.psm1') -Force

if (-not $CodexHome) { $CodexHome = Get-DefaultCodexHome }
if (-not $ClaudeHome) { $ClaudeHome = Get-DefaultClaudeHome }
if (-not $OutputRoot) { $OutputRoot = Join-Path $PSScriptRoot 'output' }

function New-RunDirectory {
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $path = Join-Path ([IO.Path]::GetFullPath($OutputRoot)) "run-$stamp"
    [void][IO.Directory]::CreateDirectory($path)
    return $path
}

function Write-ManifestDigest {
    param([Parameter(Mandatory)][string]$Path)
    $digest = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$Path.sha256", "$digest  $([IO.Path]::GetFileName($Path))`n", [Text.UTF8Encoding]::new($false))
    return $digest
}

if ($Action -eq 'Apply') {
    if (-not $ManifestPath) { throw '-ManifestPath is required for Action Apply.' }
    $resolvedManifest = [IO.Path]::GetFullPath($ManifestPath)
    if (-not (Test-Path -LiteralPath $resolvedManifest -PathType Leaf)) { throw "Manifest not found: $resolvedManifest" }
    $digestPath = "$resolvedManifest.sha256"
    if (-not (Test-Path -LiteralPath $digestPath -PathType Leaf)) { throw "Manifest digest not found: $digestPath" }
    $expectedDigest = ((Get-Content -LiteralPath $digestPath -Encoding ascii -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $actualDigest = (Get-FileHash -LiteralPath $resolvedManifest -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expectedDigest -ne $actualDigest) { throw 'Manifest SHA256 mismatch. Generate a new plan or update it through an explicit reviewed workflow.' }
    $manifest = Get-Content -LiteralPath $resolvedManifest -Encoding utf8 -Raw | ConvertFrom-Json
    $applyDirectory = New-RunDirectory
    $receipts = Invoke-HandoffApplyWizard -Manifest $manifest -OutputDirectory $applyDirectory `
        -CodexModel $CodexModel -CodexEffort $CodexEffort -ClaudeModel $ClaudeModel -ClaudeEffort $ClaudeEffort
    $receiptPath = Join-Path $applyDirectory 'apply-receipts.json'
    Write-JsonFile -Value @($receipts) -Path $receiptPath
    Write-Host "Receipts: $receiptPath"
    exit 0
}

$runDirectory = New-RunDirectory
$inventory = New-HandoffInventory -CodexHome $CodexHome -ClaudeHome $ClaudeHome -SinceDays $SinceDays `
    -ProjectPath $ProjectPath
$inventoryPath = Join-Path $runDirectory 'inventory.json'
Write-JsonFile -Value $inventory -Path $inventoryPath
Write-Host "Codex sessions: $(@($inventory.codex_sessions).Count)"
Write-Host "Claude sessions: $(@($inventory.claude_sessions).Count)"
Write-Host "Inventory: $inventoryPath"

if ($Action -eq 'Inventory') { exit 0 }

$analysisDirectory = Join-Path $runDirectory 'analysis'
$manifest = Invoke-HandoffAnalysis -Inventory $inventory -OutputDirectory $analysisDirectory `
    -Model $CodexModel -Effort $CodexEffort -Direction $Direction -Concurrency $Concurrency `
    -RequireEffectiveAttestation:$RequireEffectiveAttestation
$manifestPath = Join-Path $runDirectory 'handoff-manifest.json'
Write-JsonFile -Value $manifest -Path $manifestPath
$manifestDigest = Write-ManifestDigest -Path $manifestPath
Write-Host "Logical works: $(@($manifest.logical_works).Count)"
Write-Host "Manifest: $manifestPath"
Write-Host "Manifest SHA256: $manifestDigest"

if ($Action -eq 'Wizard') {
    $receiptDirectory = Join-Path $runDirectory 'apply'
    $receipts = Invoke-HandoffApplyWizard -Manifest $manifest -OutputDirectory $receiptDirectory `
        -CodexModel $CodexModel -CodexEffort $CodexEffort -ClaudeModel $ClaudeModel -ClaudeEffort $ClaudeEffort
    $receiptPath = Join-Path $runDirectory 'apply-receipts.json'
    Write-JsonFile -Value @($receipts) -Path $receiptPath
    Write-Host "Receipts: $receiptPath"
}
