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
      Invoke-RestMethod `
        -Method Post `
        -Uri "$BatonBaseUrl/baton/client-integration/apply" `
        -ContentType 'application/json' `
        -Body '{"targets":["codex"]}' |
        Out-Null
      exit 0
    } catch {
      Start-Sleep -Seconds 2
      continue
    }
  }

  Start-Sleep -Seconds 2
}

exit 1
