param([ValidateSet('arm64-v8a','x86_64')][string]$Architecture='arm64-v8a',[switch]$Detailed)
$ErrorActionPreference='Stop'
$taskNative=Split-Path $PSScriptRoot -Parent
$taskProject=Split-Path $taskNative -Parent
$taskNode=Join-Path $taskProject 'work\toolchain\node-v24.21.0-win-x64'
$taskJdk=Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'
$taskSdk=Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$taskNinja=Join-Path $taskProject 'work\toolchain\ninja\ninja.exe'
foreach($taskRequired in @("$taskNode\node.exe","$taskJdk\bin\java.exe","$taskSdk\platform-tools\adb.exe",$taskNinja)) {
  if(-not(Test-Path -LiteralPath $taskRequired)){throw "Missing build prerequisite: $taskRequired"}
}
$env:JAVA_HOME=$taskJdk
$env:ANDROID_HOME=$taskSdk
$env:ANDROID_SDK_ROOT=$taskSdk
$env:GRADLE_USER_HOME=Join-Path $taskProject 'work\gradle'
$env:PATH="$taskNode;$taskJdk\bin;$taskSdk\platform-tools;$env:PATH"
[IO.File]::WriteAllText((Join-Path $taskNative 'android\local.properties'),"sdk.dir=$($taskSdk.Replace('\','/'))`n",[Text.UTF8Encoding]::new($false))
Push-Location (Join-Path $taskNative 'android')
try {
  $taskArguments=@('assembleRelease',"-PreactNativeArchitectures=$Architecture","-PninjaExecutable=$($taskNinja.Replace('\','/'))",'--console=plain','--max-workers=2','-Dorg.gradle.internal.http.socketTimeout=30000','-Dorg.gradle.internal.http.connectionTimeout=30000')
  if($Detailed){$taskArguments+='--info'}
  & .\gradlew.bat @taskArguments
  if($LASTEXITCODE -ne 0){throw 'Android build failed'}
  $taskVersion=(Get-Content -Raw -LiteralPath (Join-Path $taskNative 'package.json') | ConvertFrom-Json).version
  $taskReleaseDir=Join-Path $taskProject "releases\android\$taskVersion"
  New-Item -ItemType Directory -Path $taskReleaseDir -Force | Out-Null
  $taskApk=Join-Path $taskReleaseDir "live-voice-android-$taskVersion-$Architecture.apk"
  Copy-Item -LiteralPath (Join-Path $taskNative 'android\app\build\outputs\apk\release\app-release.apk') -Destination $taskApk
  Get-Item -LiteralPath $taskApk | Select-Object FullName,Length
} finally {Pop-Location}
