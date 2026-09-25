param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
$taskUrl='http://127.0.0.1:8792/'
$taskResponse=$null
try {$taskResponse=Invoke-WebRequest -UseBasicParsing -Uri $taskUrl -TimeoutSec 2} catch {}
if($taskResponse -and $taskResponse.Headers['X-Live-Voice-Tool'] -ne 'pc-config-v2') {
  throw 'Port 8792 is being used by another application.'
}
if(-not $taskResponse) {
  $taskNode=Join-Path $PSScriptRoot '..\work\toolchain\node-v24.21.0-win-x64\node.exe'
  if(-not(Test-Path -LiteralPath $taskNode)){$taskNode=(Get-Command node -ErrorAction Stop).Source}
  $taskLogDir=Join-Path $PSScriptRoot '..\work\pc-config'
  New-Item -ItemType Directory -Path $taskLogDir -Force | Out-Null
  $taskServer=Join-Path $PSScriptRoot 'server.mjs'
  $taskProcess=Start-Process -FilePath $taskNode -ArgumentList @("`"$taskServer`"") -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskLogDir 'server.log') -RedirectStandardError (Join-Path $taskLogDir 'server-error.log')
  for($taskAttempt=0;$taskAttempt -lt 20;$taskAttempt++) {
    try {$taskResponse=Invoke-WebRequest -UseBasicParsing -Uri $taskUrl -TimeoutSec 1; break} catch {Start-Sleep -Milliseconds 150}
    if($taskProcess.HasExited){throw 'Local configuration page could not start.'}
  }
  if(-not $taskResponse -or $taskResponse.Headers['X-Live-Voice-Tool'] -ne 'pc-config-v2') {throw 'Local configuration page could not start.'}
}
if(-not $NoBrowser){Start-Process $taskUrl}
