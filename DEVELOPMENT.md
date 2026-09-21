# 開發說明

## 專案結構

- `Plugin.cs`：插件主體。收市場板封包、合併成一次掃描、上傳。
- `UploadQueue.cs`：上傳佇列、重試退避、內容去重。不依賴 Dalamud。
- `ConfigWindow.cs`、`CollectorStatus.cs`、`CollectorConfig.cs`：設定視窗、狀態統計、設定檔。
- `tests/UploadQueue.Tests`：`UploadQueue.cs` 的測試。
- `server/`：接收上傳與提供公開 API 的伺服器，見 [server/README.md](server/README.md)。

## 掃描與上傳

- 遊戲把掛單分成多個封包送來，最後沒有結束標記，所以一個物品安靜 2 秒就算一次掃描結束。
- 沒人在賣的物品只有成交紀錄的封包，插件把這種情況當成目前沒有掛單。
- 上傳前先向伺服器取物品清單（`GET /community/items`，約 30 分鐘更新一次），只回報清單內的物品。
- 掛單最多 100 筆、成交最多 50 筆，價格或數量不合法的項目在上傳前就略過，避免整包被伺服器拒絕。
- 上傳排在佇列裡。被限流（429）依 `Retry-After` 等待，網路錯誤與 5xx 依 5、15、45、135 秒退避，重試 5 次仍失敗、或超過 14 分鐘（伺服器不收更舊的掃描）就放棄。伺服器明確拒絕的不重送。
- 同一個世界同一個物品，內容和 10 分鐘內成功送出的相同時不重送。

## 建置

需要台灣服啟動器自帶的 Dalamud（API 13、.NET 9）和 .NET 10 SDK。`DALAMUD_HOME` 要指向台灣服 Dalamud 的 `Injector` 資料夾，不是國際版 XIVLauncher 的那份。

```powershell
$env:DALAMUD_HOME = 'C:\Users\<你>\AppData\Roaming\FFXIVSimpleLauncher\Dalamud\Injector\'
dotnet build -c Release
```

輸出在 `bin\Release\`。遊戲執行中不要建置到這裡，可能鎖檔或讓執行中的插件被換掉；要在遊戲開著時驗證編譯，加 `-o` 輸出到別的資料夾。

## 打包

```powershell
powershell -NoProfile -File .\pack.ps1
```

輸出 `dist\latest.zip`（含 DLL 與 manifest）。`repo.json` 是自訂儲存庫的範本，下載連結與 `RepoUrl` 還是佔位字串，發佈時填入，並確認 `AssemblyVersion` 與這次打包的版本一致。插件沒有簽章，目前也沒有發佈到任何地方。

## 測試

```powershell
cd tests\UploadQueue.Tests
dotnet run
```

伺服器的測試在 `server/`，見 [server/README.md](server/README.md)。

## 指向本機伺服器測試

啟動遊戲前設定環境變數 `MBCOLLECTOR_ENDPOINT`，插件就改用這個網址上傳，不出現在設定視窗：

```powershell
$env:MBCOLLECTOR_ENDPOINT = 'http://127.0.0.1:8787'
& '<啟動器路徑>\FFXIVSimpleLauncher.exe'
```

伺服器要設 `COMMUNITY_UPLOAD_ENABLED=on`。環境變數只對從這個視窗啟動的程式有效；平常用捷徑啟動就不會受影響。

## 已知限制

- 拿不到每筆掛單真正的上架時間（Dalamud 的 `LastReviewTime` 沒有被填值），所以插件不送這個欄位，伺服器用第一次看到這筆掛單的時間代替。
- 完全沒有掛單也沒有成交紀錄的物品，遊戲不會送任何封包，所以不會有回報。
- 插件只讀你目前所在的世界；要回報其他世界，要到那個世界的市場板查看。
