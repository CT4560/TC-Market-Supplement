using MarketBoardCollector;

// 上傳佇列的測試（不用測試框架）：cd tests/UploadQueue.Tests && dotnet run

var failures = 0;
var total = 0;

void Test(string name, Action body)
{
    total++;
    try
    {
        body();
        Console.WriteLine($"ok   - {name}");
    }
    catch (Exception ex)
    {
        failures++;
        Console.WriteLine($"FAIL - {name}: {ex.Message}");
    }
}

void Expect(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}

void ExpectEqual<T>(T expected, T actual, string what)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception($"{what}: 預期 {expected}，實際 {actual}");
}

var t0 = new DateTime(2026, 9, 21, 12, 0, 0, DateTimeKind.Utc);
long Ms(DateTime time) => new DateTimeOffset(time).ToUnixTimeMilliseconds();
UploadJob Job(uint item, string hash = "h", uint world = 4033, DateTime? capturedAt = null) =>
    new(item, world, "{}", Ms(capturedAt ?? t0), 3, 2, hash);

// ---------- 佇列：基本流程 ----------

Test("空佇列：沒有工作也沒有等待", () =>
{
    var step = new UploadQueue().Next(t0);
    Expect(step.Job is null && step.Wait is null && step.Expired.Count == 0, "應該全是空的");
});

Test("成功：送出後從佇列拿掉，依先進先出", () =>
{
    var queue = new UploadQueue();
    var a = Job(1);
    var b = Job(2);
    queue.Enqueue(a);
    queue.Enqueue(b);
    ExpectEqual(a, queue.Next(t0).Job, "第一筆");
    queue.Report(a, SendOutcome.Success, null, t0);
    ExpectEqual(b, queue.Next(t0).Job, "第二筆");
    queue.Report(b, SendOutcome.Success, null, t0);
    ExpectEqual(0, queue.Count, "佇列");
});

Test("同一個世界同一個物品：完全一樣的內容不重複排；內容不同時新的取代舊的", () =>
{
    var queue = new UploadQueue();
    ExpectEqual(EnqueueResult.Queued, queue.Enqueue(Job(1, "a")).Result, "第一次");
    ExpectEqual(EnqueueResult.DuplicateOfQueued, queue.Enqueue(Job(1, "a")).Result, "同內容");
    ExpectEqual(1, queue.Count, "數量");

    var newer = Job(1, "b");
    ExpectEqual(EnqueueResult.Queued, queue.Enqueue(newer).Result, "不同內容");
    ExpectEqual(1, queue.Count, "舊的被取代");
    ExpectEqual(newer, queue.Next(t0).Job, "留下新的");

    queue.Enqueue(Job(1, "a", world: 4035));
    ExpectEqual(2, queue.Count, "不同世界互不影響");
});

Test("佇列滿了：丟掉最舊的並回報", () =>
{
    var queue = new UploadQueue(capacity: 3);
    for (uint item = 1; item <= 3; item++) queue.Enqueue(Job(item));
    var (result, dropped) = queue.Enqueue(Job(4));
    ExpectEqual(EnqueueResult.QueuedDroppedOldest, result, "結果");
    ExpectEqual(1u, dropped!.ItemId, "被丟掉的是最舊的");
    ExpectEqual(3, queue.Count, "數量維持上限");
});

// ---------- 佇列：限流、重試、放棄 ----------

Test("被限流（429）：資料留著，照伺服器說的時間暫停（限制 1～60 秒），不算一次失敗", () =>
{
    var queue = new UploadQueue();
    var job = Job(1);
    queue.Enqueue(job);

    var report = queue.Report(job, SendOutcome.RateLimited, TimeSpan.FromSeconds(3), t0);
    Expect(!report.GaveUp, "不該放棄");
    ExpectEqual(TimeSpan.FromSeconds(3), report.PausedFor, "暫停時間");
    ExpectEqual(0, job.Attempts, "限流不算失敗次數");
    ExpectEqual(1, queue.Count, "資料還在");

    var during = queue.Next(t0 + TimeSpan.FromSeconds(1));
    Expect(during.Job is null && during.Wait == TimeSpan.FromSeconds(2), "暫停中要等剩下的時間");
    ExpectEqual(job, queue.Next(t0 + TimeSpan.FromSeconds(3)).Job, "時間到了再送同一筆");

    ExpectEqual(TimeSpan.FromSeconds(60), queue.Report(job, SendOutcome.RateLimited, TimeSpan.FromHours(1), t0).PausedFor, "上限 60 秒");
    ExpectEqual(TimeSpan.FromSeconds(1), queue.Report(job, SendOutcome.RateLimited, TimeSpan.Zero, t0).PausedFor, "下限 1 秒");
    ExpectEqual(TimeSpan.FromSeconds(5), queue.Report(job, SendOutcome.RateLimited, null, t0).PausedFor, "沒給就 5 秒");
});

Test("可重試的失敗：退避 5→15→45→135 秒，第 5 次失敗就放棄", () =>
{
    var queue = new UploadQueue();
    var job = Job(1);
    queue.Enqueue(job);
    var now = t0;
    var delays = new List<TimeSpan?>();
    for (var i = 0; i < 4; i++)
    {
        var report = queue.Report(job, SendOutcome.Retryable, null, now);
        Expect(!report.GaveUp, $"第 {i + 1} 次失敗還不該放棄");
        delays.Add(report.PausedFor);
        now += report.PausedFor!.Value;
        ExpectEqual(job, queue.Next(now).Job, "退避結束後再送同一筆");
    }
    Expect(delays.SequenceEqual(new TimeSpan?[] { TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(45), TimeSpan.FromSeconds(135) }), "退避間隔");

    var last = queue.Report(job, SendOutcome.Retryable, null, now);
    Expect(last.GaveUp, "第 5 次失敗要放棄");
    ExpectEqual(0, queue.Count, "放棄後拿掉");
});

Test("失敗時整個佇列先暫停，不會逐筆敲伺服器", () =>
{
    var queue = new UploadQueue();
    var a = Job(1);
    var b = Job(2);
    queue.Enqueue(a);
    queue.Enqueue(b);
    queue.Report(a, SendOutcome.Retryable, null, t0);
    var step = queue.Next(t0 + TimeSpan.FromSeconds(1));
    Expect(step.Job is null && step.Wait == TimeSpan.FromSeconds(4), "b 也要等");
});

Test("被伺服器明確拒絕：直接拿掉，不重試", () =>
{
    var queue = new UploadQueue();
    var job = Job(1);
    queue.Enqueue(job);
    var report = queue.Report(job, SendOutcome.Permanent, null, t0);
    Expect(!report.GaveUp && report.PausedFor is null, "沒有暫停");
    ExpectEqual(0, queue.Count, "已拿掉");
});

Test("太舊的掃描不再送（伺服器只收 15 分鐘內的），回報被移除的", () =>
{
    var queue = new UploadQueue();
    var old = Job(1, capturedAt: t0);
    var fresh = Job(2, capturedAt: t0 + TimeSpan.FromMinutes(10));
    queue.Enqueue(old);
    queue.Enqueue(fresh);

    var step = queue.Next(t0 + TimeSpan.FromMinutes(15));
    ExpectEqual(1, step.Expired.Count, "過期的數量");
    ExpectEqual(1u, step.Expired[0].ItemId, "過期的是舊的那筆");
    ExpectEqual(fresh, step.Job, "新的還可以送");
    ExpectEqual(1, queue.Count, "佇列剩一筆");
});

Test("Clear 會清空並解除暫停", () =>
{
    var queue = new UploadQueue();
    var job = Job(1);
    queue.Enqueue(job);
    queue.Report(job, SendOutcome.RateLimited, TimeSpan.FromSeconds(30), t0);
    queue.Clear();
    ExpectEqual(0, queue.Count, "數量");
    var fresh = Job(2);
    queue.Enqueue(fresh);
    ExpectEqual(fresh, queue.Next(t0).Job, "不再被舊的暫停擋住");
});

// ---------- 內容去重 ----------

Test("指紋：跟到達順序無關、內容或世界不同就不同", () =>
{
    var a = ScanFingerprint.Compute(4033, 5729, new[] { "1:100:2:雇員", "2:200:1:雇員" }, new[] { "10:5:1:買家" });
    var reordered = ScanFingerprint.Compute(4033, 5729, new[] { "2:200:1:雇員", "1:100:2:雇員" }, new[] { "10:5:1:買家" });
    ExpectEqual(a, reordered, "順序不同但內容相同");
    Expect(a != ScanFingerprint.Compute(4033, 5729, new[] { "1:100:2:雇員" }, new[] { "10:5:1:買家" }), "少一筆掛單");
    Expect(a != ScanFingerprint.Compute(4035, 5729, new[] { "1:100:2:雇員", "2:200:1:雇員" }, new[] { "10:5:1:買家" }), "不同世界");
    Expect(a != ScanFingerprint.Compute(4033, 5730, new[] { "1:100:2:雇員", "2:200:1:雇員" }, new[] { "10:5:1:買家" }), "不同物品");
    Expect(a != ScanFingerprint.Compute(4033, 5729, new[] { "1:100:2:雇員", "2:200:1:雇員" }, new[] { "10:5:1:買家", "11:6:1:買家" }), "多一筆成交");
});

Test("最近送過一樣的內容就略過；內容變了、超過時間窗、換世界或物品都要送", () =>
{
    var tracker = new SentTracker(TimeSpan.FromMinutes(10));
    Expect(!tracker.WasSentRecently(4033, 1, "h", t0), "沒送過");
    tracker.Record(4033, 1, "h", t0);
    Expect(tracker.WasSentRecently(4033, 1, "h", t0 + TimeSpan.FromMinutes(9)), "9 分鐘內同內容要略過");
    Expect(!tracker.WasSentRecently(4033, 1, "h", t0 + TimeSpan.FromMinutes(10)), "滿 10 分鐘要再送一次（刷新最後掃描時間）");
    Expect(!tracker.WasSentRecently(4033, 1, "other", t0 + TimeSpan.FromMinutes(1)), "內容變了要送");
    Expect(!tracker.WasSentRecently(4035, 1, "h", t0 + TimeSpan.FromMinutes(1)), "不同世界");
    Expect(!tracker.WasSentRecently(4033, 2, "h", t0 + TimeSpan.FromMinutes(1)), "不同物品");
});

Test("記錄太多時會清掉過期的（不無限成長）", () =>
{
    var tracker = new SentTracker(TimeSpan.FromMinutes(10));
    for (uint item = 1; item <= 600; item++) tracker.Record(4033, item, "h", t0);
    tracker.Record(4033, 9999, "h", t0 + TimeSpan.FromMinutes(11));
    Expect(!tracker.WasSentRecently(4033, 1, "h", t0), "過期的已被清掉");
    Expect(tracker.WasSentRecently(4033, 9999, "h", t0 + TimeSpan.FromMinutes(11)), "新的還在");
});

// ---------- 物品清單退避 ----------

Test("失敗後 60 秒內不再嘗試，成功後立刻解除", () =>
{
    var gate = new RetryGate(TimeSpan.FromSeconds(60));
    Expect(gate.CanAttempt(t0), "一開始可以試");
    gate.Failed(t0);
    Expect(!gate.CanAttempt(t0 + TimeSpan.FromSeconds(59)), "59 秒內不試");
    Expect(gate.CanAttempt(t0 + TimeSpan.FromSeconds(60)), "60 秒後可以試");
    gate.Failed(t0);
    gate.Succeeded();
    Expect(gate.CanAttempt(t0), "成功後解除");
});

Console.WriteLine(failures == 0 ? $"全部通過（{total} 項）" : $"{failures}／{total} 項失敗");
return failures == 0 ? 0 : 1;
