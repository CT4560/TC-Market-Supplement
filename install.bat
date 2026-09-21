@echo off
rem FFXIV-TW-Market-Data-Supplement quick installer.
rem Adds the plugin repository to the Taiwan-server Dalamud settings. Plain text: open it in Notepad to read it.
setlocal
chcp 65001 >nul
set "SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:SELF,[Text.Encoding]::UTF8); $i=$t.IndexOf('#'+'PS_BEGIN'); Invoke-Expression $t.Substring($i)"
echo.
pause
exit /b
#PS_BEGIN
# 把插件儲存庫網址加進台灣服 Dalamud 的設定檔（第三方外掛程式倉庫）。只加網址，不下載也不安裝任何檔案。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$PluginName = 'FFXIV-TW-Market-Data-Supplement'
$RepoUrl = 'REPLACE_WITH_REPO_URL'

function Say($text, $color = 'White') { Write-Host $text -ForegroundColor $color }

function Find-DalamudConfig {
    if ($env:DALAMUD_CONFIG_PATH) { return $env:DALAMUD_CONFIG_PATH }
    $roots = Get-ChildItem -LiteralPath $env:APPDATA -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'FFXIVSimpleLauncher|XIVLauncherTC' }
    $found = foreach ($root in $roots) {
        Get-ChildItem -LiteralPath $root.FullName -Filter 'dalamudConfig.json' -Recurse -Depth 3 -File -ErrorAction SilentlyContinue
    }
    $found | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}

function Get-RepoEntries($parsed) {
    if ($null -eq $parsed.ThirdRepoList) { return @() }
    @($parsed.ThirdRepoList.'$values')
}

try {
    Say "== $PluginName 安裝 ==" Cyan
    Say ''

    if ($RepoUrl -like 'REPLACE_*') {
        throw '這個安裝檔還沒填入儲存庫網址（尚未發佈），請向提供者索取新版的 install.bat。'
    }
    if ($RepoUrl -notmatch '^https://[^"\\\s]+$') {
        throw "儲存庫網址格式不對：$RepoUrl"
    }

    $running = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -match '^(ffxiv|ffxiv_dx11|FFXIVSimpleLauncher|XIVLauncher.*)$' }
    if ($running) {
        $names = ($running | Select-Object -ExpandProperty ProcessName -Unique) -join '、'
        throw "偵測到遊戲或啟動器還在執行（$names）。請先完全關閉遊戲與啟動器再重新執行；不然 Dalamud 結束時會把設定蓋回去。"
    }

    $path = Find-DalamudConfig
    if (-not $path -or -not (Test-Path -LiteralPath $path)) {
        throw '找不到台灣服 Dalamud 的設定檔。請先用台灣服啟動器（XIVLauncher TC）啟動一次遊戲、進到角色選單後關閉，再重新執行。'
    }
    Say "設定檔：$path"

    $bytes = [IO.File]::ReadAllBytes($path)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $text = [Text.Encoding]::UTF8.GetString($bytes)
    if ($hasBom) { $text = $text.Substring(1) }
    $eol = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }

    try { $parsed = $text | ConvertFrom-Json } catch { throw '設定檔不是有效的 JSON，為了安全不做任何修改。' }

    $existing = @(Get-RepoEntries $parsed | Where-Object { $_.Url -eq $RepoUrl })
    $entry = '{ "$type": "Dalamud.Configuration.ThirdPartyRepoSettings, Dalamud", "Url": "' + $RepoUrl + '", "IsEnabled": true, "Name": null }'
    $newText = $null

    if ($existing.Count -gt 0) {
        if ($existing[0].IsEnabled) {
            Say '儲存庫已經加過了，不需要再做一次。' Green
            Say "下一步：啟動遊戲，輸入 /xlplugins，搜尋 $PluginName 安裝。"
            return
        }
        $rx = [regex]::new('("Url"\s*:\s*"' + [regex]::Escape($RepoUrl) + '"\s*,\s*"IsEnabled"\s*:\s*)false', 'IgnoreCase')
        $m = $rx.Match($text)
        if (-not $m.Success) { throw '儲存庫已在清單中但被停用，且無法自動啟用。請在 /xlsettings 的「試驗性功能」裡手動勾選。' }
        $newText = $text.Substring(0, $m.Index) + $m.Groups[1].Value + 'true' + $text.Substring($m.Index + $m.Length)
    }
    else {
        $rx = [regex]::new('("ThirdRepoList"\s*:\s*\{.*?"\$values"\s*:\s*\[)(\s*)(\]?)', 'Singleline')
        $m = $rx.Match($text)
        $wholeProperty = '"ThirdRepoList": { "$type": "System.Collections.Generic.List`1[[Dalamud.Configuration.ThirdPartyRepoSettings, Dalamud]], System.Private.CoreLib", "$values": [ ' + $entry + ' ] }'
        if ($m.Success) {
            $isEmpty = $m.Groups[3].Value -eq ']'
            $comma = if ($isEmpty) { '' } else { ',' }
            $newText = $text.Substring(0, $m.Index) + $m.Groups[1].Value + $eol + '        ' + $entry + $comma +
                $m.Groups[2].Value + $m.Groups[3].Value + $text.Substring($m.Index + $m.Length)
        }
        else {
            $nullRx = [regex]::new('"ThirdRepoList"\s*:\s*null')
            $n = $nullRx.Match($text)
            if ($n.Success) {
                $newText = $text.Substring(0, $n.Index) + $wholeProperty + $text.Substring($n.Index + $n.Length)
            }
            else {
                $open = $text.IndexOf('{')
                if ($open -lt 0) { throw '設定檔格式不認得，為了安全不做任何修改。' }
                $rest = $text.Substring($open + 1)
                $comma = if ($rest.TrimStart().StartsWith('}')) { '' } else { ',' }
                $newText = $text.Substring(0, $open + 1) + $eol + '  ' + $wholeProperty + $comma + $text.Substring($open + 1)
            }
        }
    }

    try {
        $check = $newText | ConvertFrom-Json
        $ok = @(Get-RepoEntries $check | Where-Object { $_.Url -eq $RepoUrl -and $_.IsEnabled })
        if ($ok.Count -ne 1) { throw 'verify' }
    }
    catch {
        throw '修改後的設定檔驗證失敗，為了安全沒有寫入任何東西。請改用 README 的手動步驟。'
    }

    $backup = "$path.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item -LiteralPath $path -Destination $backup
    if ($hasBom) { $outBytes = [byte[]](0xEF, 0xBB, 0xBF) + [Text.UTF8Encoding]::new($false).GetBytes($newText) }
    else { $outBytes = [Text.UTF8Encoding]::new($false).GetBytes($newText) }
    [IO.File]::WriteAllBytes($path, $outBytes)

    Say ''
    Say '完成！已把插件儲存庫加進 Dalamud。' Green
    Say "（原本的設定檔已備份：$backup）"
    Say ''
    Say '接下來：'
    Say '  1. 用台灣服啟動器啟動遊戲'
    Say "  2. 進遊戲後輸入 /xlplugins，搜尋 $PluginName，按安裝"
    Say '  3. 之後有新版會自動在 /xlplugins 出現更新'
}
catch {
    Say ''
    Say "安裝沒有完成：$($_.Exception.Message)" Red
    Say '設定檔沒有被改動。也可以照 README 的手動步驟安裝。'
}
