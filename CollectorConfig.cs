namespace MarketBoardCollector;

/// <summary>
/// 設定檔（放在外掛設定資料夾的 config.json）。所有玩家都上傳到同一個官方社群伺服器，網址寫死在程式裡，
/// 所以這裡只有開關。上傳預設開啟（跟 Universalis 內建上傳器一樣，裝了就會回報）；只會送出市場板上的物品資料。
/// 發佈給背景工作使用的實例視為「唯讀」：要改設定就建立新實例再整個換掉（見 Plugin.SaveConfig），不要就地修改。
/// </summary>
public sealed class CollectorConfig
{
    /// <summary>是否把掃描到的物品資料回報給社群伺服器。預設開啟；關閉就只寫本機檔案。</summary>
    public bool UploadEnabled { get; set; } = true;

    /// <summary>是否同時把每次掃描寫進本機 capture.jsonl（除錯用）。預設關閉，一般玩家不需要。</summary>
    public bool CaptureToFile { get; set; }

    /// <summary>第一次使用的說明（聊天視窗那一則）是否已經顯示過。</summary>
    public bool NoticeShown { get; set; }
}
