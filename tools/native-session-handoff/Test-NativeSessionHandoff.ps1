#requires -Version 5.1
[CmdletBinding()]
param([switch]$LiveAnalysis, [switch]$KeepTestData)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'NativeSessionHandoff.psd1') -Force

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('baton-handoff-test-' + [guid]::NewGuid().ToString('N'))
$codexRoot = Join-Path $testRoot 'codex'
$claudeRoot = Join-Path $testRoot 'claude'
$claudeDesktopRoot = Join-Path $testRoot 'ClaudeDesktop\claude-code-sessions'
$codexSessionRoot = Join-Path $codexRoot 'sessions\2026\07\18'
$claudeProjectRoot = Join-Path $claudeRoot 'projects\C--work-demo'
$claudeDesktopWorkspace = Join-Path $claudeDesktopRoot 'profile-fixture\workspace-fixture'
[void][IO.Directory]::CreateDirectory($codexSessionRoot)
[void][IO.Directory]::CreateDirectory($claudeProjectRoot)
[void][IO.Directory]::CreateDirectory($claudeDesktopWorkspace)

try {
    $codexId = '11111111-1111-4111-8111-111111111111'
    $claudeId = '22222222-2222-4222-8222-222222222222'
    $codexPath = Join-Path $codexSessionRoot "rollout-2026-07-18T00-00-00-$codexId.jsonl"
    $claudePath = Join-Path $claudeProjectRoot "$claudeId.jsonl"
    $codexLines = @(
        '{"timestamp":"2026-07-18T00:00:00Z","type":"session_meta","payload":{"id":"11111111-1111-4111-8111-111111111111","cwd":"C:\\work\\demo"}}',
        '{"timestamp":"2026-07-18T00:00:01Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Build the demo"}]}}',
        '{"timestamp":"2026-07-18T00:00:02Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Finish the demo safely"}]}}'
    )
    $claudeLines = @(
        '{"sessionId":"22222222-2222-4222-8222-222222222222","cwd":"C:\\work\\demo","timestamp":"2026-07-18T01:00:00Z","type":"user","message":{"content":[{"type":"text","text":"Continue the demo from Codex"}]}}'
    )
    [IO.File]::WriteAllLines($codexPath, $codexLines, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllLines($claudePath, $claudeLines, [Text.UTF8Encoding]::new($false))
    $desktopMetadataPath = Join-Path $claudeDesktopWorkspace 'local_fixture.json'
    $desktopMetadata = [ordered]@{
        sessionId = 'local_33333333-3333-4333-8333-333333333333'
        cliSessionId = $claudeId
        cwd = 'C:\work\demo'
        createdAt = '2026-07-18T01:00:00Z'
        lastActivityAt = '2026-07-18T01:02:00Z'
        isArchived = $false
        title = 'Desktop demo task'
        titleSource = 'auto'
    }
    [IO.File]::WriteAllText($desktopMetadataPath, ($desktopMetadata | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    $archivedMetadata = [ordered]@{
        sessionId = 'local_44444444-4444-4444-8444-444444444444'
        cliSessionId = $claudeId
        cwd = 'C:\work\demo'
        createdAt = '2026-07-18T01:00:00Z'
        lastActivityAt = '2026-07-18T01:02:00Z'
        isArchived = $true
        title = 'Archived duplicate'
    }
    [IO.File]::WriteAllText((Join-Path $claudeDesktopWorkspace 'local_archived.json'), ($archivedMetadata | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    $beforeCodex = (Get-FileHash -LiteralPath $codexPath -Algorithm SHA256).Hash
    $beforeClaude = (Get-FileHash -LiteralPath $claudePath -Algorithm SHA256).Hash

    $codexThreads = @([pscustomobject]@{
        id = $codexId
        path = $codexPath
        cwd = 'C:\work\demo'
        name = 'Codex Desktop demo task'
        preview = 'Build the demo'
        source = 'cli'
        modelProvider = 'openai'
        createdAt = [DateTimeOffset]::Parse('2026-07-18T00:00:00Z').ToUnixTimeSeconds()
        updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    })
    $inventory = New-HandoffInventory -CodexHome $codexRoot -ClaudeHome $claudeRoot `
        -ClaudeDesktopRoot $claudeDesktopRoot -CodexDesktopThreads $codexThreads
    if (@($inventory.codex_sessions).Count -ne 1) { throw 'Expected one Codex session.' }
    if (@($inventory.claude_sessions).Count -ne 1) { throw 'Expected one Claude session.' }
    if ($inventory.codex_sessions[0].session_id -ne $codexId) { throw 'Codex session ID mismatch.' }
    if ($inventory.claude_sessions[0].session_id -ne $claudeId) { throw 'Claude session ID mismatch.' }
    if ($inventory.claude_sessions[0].desktop_session_id -ne $desktopMetadata.sessionId) { throw 'Claude Desktop identity mismatch.' }
    if ($inventory.source_scope -ne 'desktop-visible') { throw 'Desktop-visible must be the default source scope.' }
    if ($inventory.codex_sessions[0].first_user_preview -ne 'Build the demo') {
        throw "Codex preview mismatch: '$($inventory.codex_sessions[0].first_user_preview)'"
    }
    if ($inventory.claude_sessions[0].first_user_preview -ne 'Continue the demo from Codex') {
        throw "Claude preview mismatch: '$($inventory.claude_sessions[0].first_user_preview)'"
    }
    if ($inventory.codex_sessions[0].last_user_preview -ne 'Finish the demo safely') {
        throw 'Codex session dossier did not preserve the latest user preview.'
    }
    $filteredInventory = New-HandoffInventory -CodexHome $codexRoot -ClaudeHome $claudeRoot `
        -ClaudeDesktopRoot $claudeDesktopRoot -CodexDesktopThreads $codexThreads -ProjectPath 'C:\work\demo'
    if (@($filteredInventory.codex_sessions).Count -ne 1 -or @($filteredInventory.claude_sessions).Count -ne 1) {
        throw 'Project path filter omitted the matching fixture sessions.'
    }
    $emptyInventory = New-HandoffInventory -CodexHome $codexRoot -ClaudeHome $claudeRoot `
        -ClaudeDesktopRoot $claudeDesktopRoot -CodexDesktopThreads $codexThreads -ProjectPath 'C:\work\other'
    if (@($emptyInventory.codex_sessions).Count -ne 0 -or @($emptyInventory.claude_sessions).Count -ne 0) {
        throw 'Project path filter included sessions from another project.'
    }
    $groups = @(New-AnalysisGroups -Inventory $inventory)
    if ($groups.Count -ne 1) { throw 'Expected one project group.' }
    if (@($groups[0].codex_sessions).Count -ne 1 -or @($groups[0].claude_sessions).Count -ne 1) {
        throw 'Project grouping mismatch.'
    }
    $localAll = New-HandoffInventory -CodexHome $codexRoot -ClaudeHome $claudeRoot -SourceScope local-all
    if (@($localAll.codex_sessions).Count -ne 1 -or @($localAll.claude_sessions).Count -ne 1) {
        throw 'Local-all compatibility scope did not inventory both CLI transcript stores.'
    }
    if (Get-Command git -ErrorAction SilentlyContinue) {
        $repoRoot = Join-Path $testRoot 'repo'
        $repoChild = Join-Path $repoRoot 'nested\child'
        [void][IO.Directory]::CreateDirectory($repoChild)
        & git -C $repoRoot init --quiet
        if ($LASTEXITCODE -ne 0) { throw 'Could not initialize project-identity fixture repository.' }
        $rootIdentity = Resolve-HandoffProjectIdentity $repoRoot
        $childIdentity = Resolve-HandoffProjectIdentity $repoChild
        if ($rootIdentity.key -ne $childIdentity.key -or $childIdentity.strategy -ne 'git_worktree_root') {
            throw 'Git project identity did not group a nested cwd under its worktree root.'
        }
    }
    if ($LiveAnalysis) {
        $analysisDirectory = Join-Path $testRoot 'analysis'
        $manifest = Invoke-HandoffAnalysis -Inventory $inventory -OutputDirectory $analysisDirectory `
            -Model 'gpt-5.6-sol' -Effort 'high' -Direction all -Concurrency 1
        if (@($manifest.logical_works).Count -lt 1) { throw 'Live analysis returned no logical work.' }
        if (-not $manifest.route.catalog_verified) { throw 'Live analysis route catalog was not verified.' }
    }
    if ((Get-FileHash -LiteralPath $codexPath -Algorithm SHA256).Hash -ne $beforeCodex) { throw 'Codex source changed.' }
    if ((Get-FileHash -LiteralPath $claudePath -Algorithm SHA256).Hash -ne $beforeClaude) { throw 'Claude source changed.' }

    Get-Content -LiteralPath (Join-Path $PSScriptRoot 'schemas\handoff-plan.schema.json') -Encoding utf8 -Raw | ConvertFrom-Json | Out-Null
    Get-Content -LiteralPath (Join-Path $PSScriptRoot 'schemas\ingest-ack.schema.json') -Encoding utf8 -Raw | ConvertFrom-Json | Out-Null
    Write-Host 'NativeSessionHandoff self-test passed.'
}
finally {
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($KeepTestData) {
        Write-Host "Test data retained: $resolvedTestRoot"
    }
    elseif ($resolvedTestRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTestRoot)) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
