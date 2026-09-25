$ErrorActionPreference='Stop'
$taskNode=Join-Path $PSScriptRoot '..\work\toolchain\node-v24.21.0-win-x64\node.exe'
if(-not(Test-Path -LiteralPath $taskNode)){$taskNode=(Get-Command node -ErrorAction Stop).Source}
& $taskNode (Join-Path $PSScriptRoot 'server.mjs')
