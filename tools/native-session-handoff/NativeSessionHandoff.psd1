@{
    RootModule = 'NativeSessionHandoff.psm1'
    ModuleVersion = '0.2.0'
    GUID = '4f67942f-49ee-414f-a2ba-0e09417ed3d8'
    Author = 'Agentryx-ai'
    CompanyName = 'Agentryx-ai'
    Copyright = '(c) Agentryx-ai'
    Description = 'One-shot read-only discovery and approval-gated handoff for Codex interactive tasks and Claude Desktop local Code/Cowork tasks.'
    PowerShellVersion = '5.1'
    FunctionsToExport = @(
        'Get-DefaultCodexHome', 'Get-DefaultClaudeHome', 'Get-DefaultClaudeDesktopRoot',
        'Get-CodexSessionInventory', 'Get-ClaudeSessionInventory', 'Get-CodexDesktopThreadList',
        'Get-CodexDesktopSessionInventory', 'Get-ClaudeDesktopSessionInventory',
        'Resolve-HandoffProjectIdentity', 'New-HandoffInventory', 'New-AnalysisGroups',
        'Write-JsonFile', 'Test-CodexAnalysisRoute', 'Invoke-HandoffAnalysis',
        'Test-ClaudeAnalysisRoute', 'Invoke-CodexHandoffApply', 'Invoke-ClaudeHandoffApply', 'Invoke-HandoffApplyWizard'
    )
    CmdletsToExport = @()
    VariablesToExport = @()
    AliasesToExport = @()
}
