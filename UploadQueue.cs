using System.Security.Cryptography;
using System.Text;

namespace MarketBoardCollector;

// 上傳的排隊、重試與去重邏輯。全部是純邏輯（時間都由呼叫端傳入），不依賴 Dalamud，
// 所以可以在遊戲外用 tests/ 底下的小測試專案驗證。

/// <summary>一次上傳嘗試的結果分類。</summary>
public enum SendOutcome
{
    /// <summary>伺服器收了（2xx）。</summary>
    Success,
    /// <summary>被限流（429）：稍後再送同一筆，不算失敗。</summary>
    RateLimited,
    /// <summary>網路錯誤、逾時、伺服器 5xx：退避後重試，重試次數用完就放棄。</summary>
    Retryable,
    /// <summary>伺服器明確拒絕這筆（400／413／422／404…）：重送也不會成功，直接放棄。</summary>
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
    /// <summary>掃描開始的時間（UTC 毫秒）。伺服器不收超過 15 分鐘前的掃描，所以太舊的不用再送。</summary>
    public long CapturedAtMs { get; }
    public int ListingCount { get; }
    public int SalesCount { get; }
    /// <summary>內容指紋（見 ScanFingerprint）。</summary>
    public string ContentHash { get; }

    public int Attempts { get; internal set; }
    public DateTime NextAttemptUtc { get; internal set; } = DateTime.MinValue;
}

public enum EnqueueResult
{
    Queued,
    /// <summary>佇列裡已經有一模一樣的內容，不用再排。</summary>
    DuplicateOfQueued,
    /// <summary>已排入，但佇列滿了，最舊的一筆被丟掉（在 Dropped 裡）。</summary>
    QueuedDroppedOldest,
}

/// <param name="Job">現在該送的那一筆；沒有就是 null。</param>
/// <param name="Wait">沒有現在該送的，但之後還有：最多等多久再來看；佇列空了是 null。</param>
/// <param name="Expired">這次檢查時發現太舊而被移除的。</param>
public sealed record QueueStep(UploadJob? Job, TimeSpan? Wait, IReadOnlyList<UploadJob> Expired);

/// <param name="GaveUp">重試次數用完，這筆被放棄了。</param>
/// <param name="PausedFor">佇列暫停多久（限流或退避），沒有暫停是 null。</param>
public sealed record ReportResult(bool GaveUp, TimeSpan? PausedFor);

/// <summary>
/// 有上限的上傳佇列（先進先出）。
///   限流（429）與可重試的失敗不會丟資料：暫停一下再送同一筆，直到成功、被明確拒絕、重試用完或太舊。
///   同一個世界同一個物品只留最新的一筆（新的掃描取代排隊中的舊掃描）。
/// 不是執行緒安全的：呼叫端要自己加鎖。
/// </summary>
public sealed class UploadQueue
{
    public const int DefaultCapacity = 50;
    public const int MaxAttempts = 5;
    public static readonly TimeSpan DefaultMaxAge = TimeSpan.FromMinutes(14);
    private static readonly TimeSpan DefaultRateLimitPause = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan MinPause = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan MaxPause = TimeSpan.FromSeconds(60);
    // 第 1、2、3、4 次失敗後各等多久再試
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

        // 同一個世界同一個物品排隊中的舊掃描已經過時，用新的取代
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

    /// <summary>取出現在該送的那一筆（不會從佇列拿掉，送完要呼叫 Report）。同時移除太舊的。</summary>
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

    /// <summary>回報一筆送出的結果，決定它是留著重試還是拿掉。</summary>
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
                // 照伺服器說的等（限制在 1～60 秒）；沒說就等 5 秒。資料留著，不算一次失敗。
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
                pausedUntil = nowUtc + delay; // 網路或伺服器出問題時，全部先暫停，不要逐筆敲
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

/// <summary>
/// 記住每個世界每個物品「最近成功送出的內容」。同樣的內容在時間窗內不用再送：
/// 玩家反覆點同一個物品時，每次都送一樣的東西只是浪費流量。超過時間窗會再送一次，讓伺服器的「最後掃描時間」保持新鮮。
/// 執行緒安全。
/// </summary>
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

/// <summary>連續失敗之後，一段時間內不再嘗試（例如向伺服器要物品清單失敗時，不要每掃一個物品就再敲一次）。執行緒安全。</summary>
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

/// <summary>一次掃描內容的指紋：世界、物品、每筆掛單與成交的關鍵欄位（排序後，跟封包到達順序無關）。</summary>
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
