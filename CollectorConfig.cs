namespace MarketBoardCollector;

/// <summary>config.json 的內容。上傳位址寫死在程式裡，所以只有開關。</summary>
public sealed class CollectorConfig
{
    /// <summary>是否回報給社群伺服器，預設開啟。</summary>
    public bool UploadEnabled { get; set; } = true;

    /// <summary>是否另外寫本機 capture.jsonl（除錯用），預設關閉。</summary>
    public bool CaptureToFile { get; set; }

    /// <summary>聊天視窗的第一次說明是否已顯示。</summary>
    public bool NoticeShown { get; set; }
}
