param([switch]$Package)
$ErrorActionPreference='Stop'
$taskNode=Join-Path $PSScriptRoot '..\work\toolchain\node-v24.21.0-win-x64'
$env:PATH="$taskNode;$env:PATH"
Push-Location $PSScriptRoot
try {
  & "$taskNode\node.exe" scripts/build.mjs
  if($LASTEXITCODE -ne 0){throw 'Desktop build failed'}
  if($Package){
    & "$taskNode\node.exe" scripts/package.mjs
    if($LASTEXITCODE -ne 0){throw 'Windows packaging failed'}
  }
} finally {Pop-Location}
