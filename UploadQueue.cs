using System.Security.Cryptography;
using System.Text;

namespace MarketBoardCollector;

// 上傳佇列、去重與退避。不依賴 Dalamud，測試在 tests/UploadQueue.Tests。

/// <summary>一次上傳的結果分類。</summary>
public enum SendOutcome
{
    /// <summary>2xx。</summary>
    Success,
    /// <summary>429，稍後再送。</summary>
    RateLimited,
    /// <summary>網路錯誤、逾時、5xx，退避後重試。</summary>
    Retryable,
    /// <summary>被明確拒絕，不重送。</summary>
    Permanent,
}

/// <summary>等著送出的一次掃描結果。</summary>
public sealed class UploadJob
{
    public UploadJob(uint itemId, uint worldId, string body, long capturedAtMs, int listingCount, int salesCount, string contentHash)
    {
        ItemId = itemId;
        WorldId = worldId;
        Body = body;
        CapturedAtMs = capturedAtMs;
        ListingCount = listingCount;
        SalesCount = salesCount;
        ContentHash = contentHash;
    }

    public uint ItemId { get; }
    public uint WorldId { get; }
    public string Body { get; }
    /// <summary>掃描開始時間（UTC 毫秒），伺服器不收超過 15 分鐘的。</summary>
    public long CapturedAtMs { get; }
    public int ListingCount { get; }
    public int SalesCount { get; }
    public string ContentHash { get; }

    public int Attempts { get; internal set; }
    public DateTime NextAttemptUtc { get; internal set; } = DateTime.MinValue;
}

public enum EnqueueResult
{
    Queued,
    DuplicateOfQueued,
    QueuedDroppedOldest,
}

public sealed record QueueStep(UploadJob? Job, TimeSpan? Wait, IReadOnlyList<UploadJob> Expired);

public sealed record ReportResult(bool GaveUp, TimeSpan? PausedFor);

/// <summary>有上限的先進先出佇列。限流與暫時失敗的資料會留著重送，同一世界同一物品只留最新一筆。非執行緒安全，呼叫端要加鎖。</summary>
public sealed class UploadQueue
{
    public const int DefaultCapacity = 50;
    public const int MaxAttempts = 5;
    public static readonly TimeSpan DefaultMaxAge = TimeSpan.FromMinutes(14);
    private static readonly TimeSpan DefaultRateLimitPause = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan MinPause = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan MaxPause = TimeSpan.FromSeconds(60);
    // 第 1～4 次失敗後的等待時間
    private static readonly TimeSpan[] RetryDelays = { TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(45), TimeSpan.FromSeconds(135) };

    private readonly List<UploadJob> jobs = new();
    private readonly int capacity;
    private readonly TimeSpan maxAge;
    private DateTime pausedUntil = DateTime.MinValue;

    public UploadQueue(int capacity = DefaultCapacity, TimeSpan? maxAge = null)
    {
        this.capacity = capacity;
        this.maxAge = maxAge ?? DefaultMaxAge;
    }

    public int Count => jobs.Count;

    public (EnqueueResult Result, UploadJob? Dropped) Enqueue(UploadJob job)
    {
        if (jobs.Any(j => j.WorldId == job.WorldId && j.ItemId == job.ItemId && j.ContentHash == job.ContentHash))
        {
            return (EnqueueResult.DuplicateOfQueued, null);
        }

        jobs.RemoveAll(j => j.WorldId == job.WorldId && j.ItemId == job.ItemId);
        jobs.Add(job);

        if (jobs.Count > capacity)
        {
            var dropped = jobs[0];
            jobs.RemoveAt(0);
            return (EnqueueResult.QueuedDroppedOldest, dropped);
        }
        return (EnqueueResult.Queued, null);
    }

    /// <summary>取出現在該送的一筆（送完要呼叫 Report），並移除太舊的。</summary>
    public QueueStep Next(DateTime nowUtc)
    {
        var expired = jobs.Where(j => nowUtc - DateTimeOffset.FromUnixTimeMilliseconds(j.CapturedAtMs).UtcDateTime > maxAge).ToList();
        foreach (var job in expired) jobs.Remove(job);

        if (jobs.Count == 0) return new QueueStep(null, null, expired);
        if (nowUtc < pausedUntil) return new QueueStep(null, pausedUntil - nowUtc, expired);

        var due = jobs.FirstOrDefault(j => j.NextAttemptUtc <= nowUtc);
        if (due is not null) return new QueueStep(due, null, expired);

        return new QueueStep(null, jobs.Min(j => j.NextAttemptUtc) - nowUtc, expired);
    }

    public ReportResult Report(UploadJob job, SendOutcome outcome, TimeSpan? retryAfter, DateTime nowUtc)
    {
        switch (outcome)
        {
            case SendOutcome.Success:
            case SendOutcome.Permanent:
                jobs.Remove(job);
                return new ReportResult(false, null);

            case SendOutcome.RateLimited:
            {
                // 照伺服器指定的時間等（1～60 秒），沒指定就 5 秒
                var wait = Clamp(retryAfter ?? DefaultRateLimitPause, MinPause, MaxPause);
                pausedUntil = nowUtc + wait;
                job.NextAttemptUtc = pausedUntil;
                return new ReportResult(false, wait);
            }

            default:
            {
                job.Attempts++;
                if (job.Attempts >= MaxAttempts)
                {
                    jobs.Remove(job);
                    return new ReportResult(true, null);
                }

                var delay = RetryDelays[Math.Min(job.Attempts - 1, RetryDelays.Length - 1)];
                pausedUntil = nowUtc + delay; // 網路或伺服器有問題時整個佇列先停
                job.NextAttemptUtc = pausedUntil;
                return new ReportResult(false, delay);
            }
        }
    }

    public void Clear()
    {
        jobs.Clear();
        pausedUntil = DateTime.MinValue;
    }

    private static TimeSpan Clamp(TimeSpan value, TimeSpan min, TimeSpan max) => value < min ? min : value > max ? max : value;
}

/// <summary>記住各世界各物品最近成功送出的內容，同樣內容在時間窗內不重送。執行緒安全。</summary>
public sealed class SentTracker
{
    public static readonly TimeSpan DefaultWindow = TimeSpan.FromMinutes(10);

    private readonly object gate = new();
    private readonly Dictionary<(uint World, uint Item), (string Hash, DateTime At)> last = new();
    private readonly TimeSpan window;

    public SentTracker(TimeSpan? window = null)
    {
        this.window = window ?? DefaultWindow;
    }

    public bool WasSentRecently(uint worldId, uint itemId, string hash, DateTime nowUtc)
    {
        lock (gate)
        {
            return last.TryGetValue((worldId, itemId), out var entry) && entry.Hash == hash && nowUtc - entry.At < window;
        }
    }

    public void Record(uint worldId, uint itemId, string hash, DateTime nowUtc)
    {
        lock (gate)
        {
            last[(worldId, itemId)] = (hash, nowUtc);
            if (last.Count <= 500) return;
            foreach (var key in last.Where(pair => nowUtc - pair.Value.At >= window).Select(pair => pair.Key).ToList()) last.Remove(key);
        }
    }
}

/// <summary>失敗後一段時間內不再嘗試。執行緒安全。</summary>
public sealed class RetryGate
{
    private readonly object gate = new();
    private readonly TimeSpan delay;
    private DateTime until = DateTime.MinValue;

    public RetryGate(TimeSpan? delay = null)
    {
        this.delay = delay ?? TimeSpan.FromSeconds(60);
    }

    public bool CanAttempt(DateTime nowUtc)
    {
        lock (gate) return nowUtc >= until;
    }

    public void Failed(DateTime nowUtc)
    {
        lock (gate) until = nowUtc + delay;
    }

    public void Succeeded()
    {
        lock (gate) until = DateTime.MinValue;
    }
}

/// <summary>掃描內容的指紋，跟封包順序無關。</summary>
public static class ScanFingerprint
{
    public static string Compute(uint worldId, uint itemId, IEnumerable<string> listingKeys, IEnumerable<string> saleKeys)
    {
        var text = new StringBuilder();
        text.Append(worldId).Append('|').Append(itemId).Append("|L");
        foreach (var key in listingKeys.OrderBy(k => k, StringComparer.Ordinal)) text.Append('|').Append(key);
        text.Append("|S");
        foreach (var key in saleKeys.OrderBy(k => k, StringComparer.Ordinal)) text.Append('|').Append(key);

        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text.ToString())));
    }
}
