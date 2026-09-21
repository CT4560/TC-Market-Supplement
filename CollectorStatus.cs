namespace MarketBoardCollector;

/// <summary>給設定視窗顯示用的狀態快照。</summary>
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

/// <summary>本次遊戲階段的上傳統計，背景工作寫、UI 讀。</summary>
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

    /// <summary>重試中：只更新訊息，不計成功或失敗。</summary>
    public void RecordPending(string message)
    {
        lock (gate)
        {
            uploadMessage = Shorten(message);
            uploadMessageOk = false;
            uploadAt = DateTime.UtcNow;
        }
    }

    /// <summary>內容沒變而略過：單獨計數，不算錯誤。</summary>
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

    /// <summary>壓成單行並限制長度。</summary>
    public static string Shorten(string text)
    {
        var singleLine = text.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return singleLine.Length <= MaxMessageLength ? singleLine : singleLine[..MaxMessageLength] + "...";
    }
}
