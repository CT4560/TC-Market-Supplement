# 本機打包：建置 Release 並產生 dist\latest.zip，不上傳也不發佈。
# 用法：powershell -NoProfile -File .\pack.ps1
# 用台灣服啟動器的 Dalamud（DALAMUD_HOME）建置，輸出在 dist\build，不動 bin\Release。

param(
    [string]$DalamudHome = "$env:APPDATA\FFXIVSimpleLauncher\Dalamud\Injector\",
    [string]$DotnetRoot = "$env:USERPROFILE\.dotnet10"
)

$ErrorActionPreference = 'Stop'
$projectDir = $PSScriptRoot
$projectName = 'MarketBoardCollector'
$distDir = Join-Path $projectDir 'dist'
$buildDir = Join-Path $distDir 'build'

if (-not (Test-Path (Join-Path $DalamudHome 'Dalamud.dll'))) {
    throw "找不到 Dalamud：$DalamudHome（請用 -DalamudHome 指定台灣服 Dalamud 的 Injector 資料夾）"
}

if (Test-Path (Join-Path $DotnetRoot 'dotnet.exe')) {
    $env:DOTNET_ROOT = $DotnetRoot
    $env:PATH = "$DotnetRoot;$env:PATH"
}
$env:DALAMUD_HOME = $DalamudHome

if (Test-Path $distDir) { Remove-Item -Recurse -Force $distDir }
New-Item -ItemType Directory -Force $distDir | Out-Null

Push-Location $projectDir
try {
    dotnet build -c Release -o $buildDir
    if ($LASTEXITCODE -ne 0) { throw "dotnet build 失敗（結束碼 $LASTEXITCODE）" }
}
finally {
    Pop-Location
}

$builtZip = Join-Path $buildDir "$projectName\latest.zip"
if (-not (Test-Path $builtZip)) {
    throw "找不到 DalamudPackager 產出的 latest.zip：$builtZip"
}

$zipPath = Join-Path $distDir 'latest.zip'
Copy-Item $builtZip $zipPath

# 檢查 zip 內容：至少要有 DLL 與 manifest json
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $names = $zip.Entries | ForEach-Object { $_.FullName }
    foreach ($required in @("$projectName.dll", "$projectName.json")) {
        if ($names -notcontains $required) { throw "latest.zip 缺少 $required" }
    }
    $manifestEntry = $zip.Entries | Where-Object { $_.FullName -eq "$projectName.json" }
    $reader = New-Object IO.StreamReader($manifestEntry.Open())
    try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
}
finally {
    $zip.Dispose()
}

$item = Get-Item $zipPath
$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash
Write-Host ''
Write-Host "產出：$($item.FullName)"
Write-Host "大小：$($item.Length) bytes"
Write-Host "SHA256：$hash"
Write-Host "內容：$($names -join ', ')"
Write-Host "插件版本 (AssemblyVersion)：$($manifest.AssemblyVersion)，DalamudApiLevel：$($manifest.DalamudApiLevel)"

# repo.json 範本裡的版本要和這次打包的一致，否則 Dalamud 不會判定有更新
$repoPath = Join-Path $projectDir 'repo.json'
if (Test-Path $repoPath) {
    $repo = Get-Content $repoPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $entry = @($repo)[0]
    if ($entry.AssemblyVersion -ne $manifest.AssemblyVersion) {
        Write-Warning "repo.json 的 AssemblyVersion ($($entry.AssemblyVersion)) 與這次打包的版本 ($($manifest.AssemblyVersion)) 不同，發佈前請更新。"
    }
    if ($entry.DalamudApiLevel -ne $manifest.DalamudApiLevel) {
        Write-Warning "repo.json 的 DalamudApiLevel ($($entry.DalamudApiLevel)) 與 manifest ($($manifest.DalamudApiLevel)) 不同。"
    }
}

Write-Host ''
Write-Host '這只是本機產物，尚未發佈到任何地方。'
