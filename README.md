# TC-Market Supplement

FFXIV 繁中服的 Dalamud 插件。你在市場板查看物品時，它會把繁中服上 Universalis 沒有價格資料的物品（主要是舊染劑與色素）的掛單和成交紀錄，匿名回報給社群伺服器，讓大家有地方查得到這些價格。

你不需要另外做任何事，平常怎麼用市場板就怎麼用。

## 會回報什麼

只回報市場板上本來就公開顯示的資料：

- 世界、物品編號、掃描時間
- 掛單的單價、數量、雇員名稱
- 成交紀錄的單價、數量、買家名稱、成交時間

不會回報你自己的角色名稱、角色編號、背包、位置或其他遊戲資料。插件只讀取市場板傳來的封包，不會操作遊戲，也不會自動翻市場板。

上傳是匿名的，不需要帳號或金鑰。上傳預設開啟，第一次登入遊戲時聊天視窗會說明一次。

## 安裝

需要台灣服啟動器（XIVLauncher TC）自帶的 Dalamud。

### 快速安裝（建議）

1. [下載 `install.bat`](https://github.com/CT4560/TC-Market-Supplement/releases/latest/download/install.bat)。
2. 完全關閉遊戲與啟動器，雙擊 `install.bat`。Windows 跳出警告的話，選「其他資訊」→「仍要執行」。
3. 進遊戲輸入 `/xlplugins`，搜尋 TC-Market Supplement 並安裝。

`install.bat` 是純文字檔，只會把儲存庫網址加進 Dalamud 設定（先備份原檔），不會下載或安裝任何東西。

### 自己加入儲存庫

1. 遊戲內輸入 `/xlsettings`，打開「試驗性功能」分頁。
2. 在「第三方外掛程式倉庫」貼上 `https://raw.githubusercontent.com/CT4560/TC-Market-Supplement/main/repo.json`，按儲存。
3. 輸入 `/xlplugins`，搜尋 TC-Market Supplement 並安裝。

### 手動安裝

1. 從 [Releases](https://github.com/CT4560/TC-Market-Supplement/releases/latest) 下載 `latest.zip`，解壓縮到一個固定的資料夾。
2. 遊戲內輸入 `/xlsettings`，「試驗性功能」分頁的「開發版外掛程式位置」加入 `MarketBoardCollector.dll` 的完整路徑，按儲存。
3. 輸入 `/xlplugins`，在「開發版外掛程式」裡啟用。

## 使用

- 輸入 `/mbcollector` 開關設定視窗，可以看目前狀態。
- 設定裡的「啟用上傳」取消勾選，就不會再回報任何資料。
- 「寫入本機檔案」是除錯用，平常不用開。

上傳失敗（網路不通、伺服器忙碌）時會自動重送。同一個物品的內容沒有變，10 分鐘內不會重複上傳。

## 資料的用途

回報的資料由公開的 API 提供給任何人使用，格式與 Universalis 相同，說明在 [server/README.md](server/README.md)；伺服器網域後面加 `/docs/` 有可以直接試用的開發者文件網站。開發插件的相關說明在 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 授權

MIT，見 [LICENSE](LICENSE)。
