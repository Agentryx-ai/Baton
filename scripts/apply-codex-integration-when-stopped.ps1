param(
  [int]$TimeoutMinutes = 30,
  [string]$BatonBaseUrl = 'http://127.0.0.1:4400'
)

$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddMinutes($TimeoutMinutes)

while ([DateTime]::UtcNow -lt $deadline) {
  $running = @(
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object {
        ($_.ProcessName -eq 'ChatGPT' -and $_.Path -like '*OpenAI.Codex*') -or
        $_.ProcessName -eq 'codex'
      }
  )

  if ($running.Count -eq 0) {
    try {
      $capability = Invoke-RestMethod `
        -Method Get `
        -Uri "$BatonBaseUrl/baton/client-integration/capability"
      $result = Invoke-RestMethod `
        -Method Post `
        -Uri "$BatonBaseUrl/baton/client-integration/apply" `
        -Headers @{ 'X-Baton-Client-Capability' = [string]$capability.capability } `
        -ContentType 'application/json' `
        -Body '{"targets":["codex"]}'
      if (-not $result.applied) { throw 'Codex integration apply failed.' }
      exit 0
    } catch {
      Start-Sleep -Seconds 2
      continue
    }
  }

  Start-Sleep -Seconds 2
}

exit 1
