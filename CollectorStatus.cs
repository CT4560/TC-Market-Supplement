namespace MarketBoardCollector;

/// <summary>某一時間點的狀態快照，給設定視窗顯示用（不含金鑰）。</summary>
public sealed record StatusSnapshot(
    bool UploadEnabled,
    string Endpoint,
    int ItemCount,
    DateTime? ItemListAtUtc,
    long UploadOk,
    long UploadFailed,
    bool UploadMessageOk,
    string UploadMessage,
    DateTime? UploadMessageAtUtc,
    string ListMessage,
    DateTime? ListMessageAtUtc,
    bool Refreshing,
    long UploadSkipped,
    int Queued);

/// <summary>
/// 本次遊戲階段的上傳統計。背景 Task 寫入、UI 執行緒讀取，所以計數用 Interlocked、訊息用鎖保護。
/// 訊息只放簡短的結果說明，絕不放金鑰。
/// </summary>
public sealed class CollectorStatus
{
    private const int MaxMessageLength = 160;

    private readonly object gate = new();
    private long uploadOk;
    private long uploadFailed;
    private long uploadSkipped;
    private string uploadMessage = "";
    private bool uploadMessageOk;
    private DateTime? uploadAt;
    private string listMessage = "";
    private DateTime? listAt;

    public void RecordUpload(bool ok, string message)
    {
        if (ok) Interlocked.Increment(ref uploadOk);
        else Interlocked.Increment(ref uploadFailed);

        lock (gate)
        {
            uploadMessage = Shorten(message);
            uploadMessageOk = ok;
            uploadAt = DateTime.UtcNow;
        }
    }

    /// <summary>還在重試、尚未成功也尚未放棄：只更新訊息，不算成功或失敗。</summary>
    public void RecordPending(string message)
    {
        lock (gate)
        {
            uploadMessage = Shorten(message);
            uploadMessageOk = false;
            uploadAt = DateTime.UtcNow;
        }
    }

    /// <summary>內容跟最近送過的一樣而略過：不是錯誤，單獨計數。</summary>
    public void RecordSkipped(string message)
    {
        Interlocked.Increment(ref uploadSkipped);
        lock (gate)
        {
            uploadMessage = Shorten(message);
            uploadMessageOk = true;
            uploadAt = DateTime.UtcNow;
        }
    }

    public void RecordItemList(string message)
    {
        lock (gate)
        {
            listMessage = Shorten(message);
            listAt = DateTime.UtcNow;
        }
    }

    public (long Ok, long Failed, long Skipped, bool UploadMessageOk, string UploadMessage, DateTime? UploadAt, string ListMessage, DateTime? ListAt) Read()
    {
        lock (gate)
        {
            return (Interlocked.Read(ref uploadOk), Interlocked.Read(ref uploadFailed), Interlocked.Read(ref uploadSkipped), uploadMessageOk, uploadMessage, uploadAt, listMessage, listAt);
        }
    }

    /// <summary>壓成單行並限制長度（伺服器回的錯誤訊息可能很長）。</summary>
    public static string Shorten(string text)
    {
        var singleLine = text.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return singleLine.Length <= MaxMessageLength ? singleLine : singleLine[..MaxMessageLength] + "...";
    }
}
