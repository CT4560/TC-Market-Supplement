using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Text.Json;
using Dalamud.Game.Command;
using Dalamud.Game.Network.Structures;
using Dalamud.Interface.Windowing;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;

namespace MarketBoardCollector;

/// <summary>
/// 被動記錄玩家在市場板點開的物品，只把伺服器接受的物品（舊染劑等）的掛單與成交紀錄回報出去。
/// 掛單分成多個封包送來、沒有結束標記，所以物品安靜 2 秒就算一次掃描結束；沒人在賣時只有成交紀錄，視為目前沒有掛單。
/// 不會操作遊戲。
/// </summary>
public sealed class Plugin : IDalamudPlugin
{
    private const string CommandName = "/mbcollector";

    // 上傳位址寫死，玩家不能改。
    private const string DefaultEndpoint = "https://api-ffxiv-bot.epicurean-expedition.com";
    private const string EndpointOverrideVariable = "MBCOLLECTOR_ENDPOINT";

    private static readonly TimeSpan QuietPeriod = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan ItemListRefresh = TimeSpan.FromMinutes(30);
    private const long MaxCaptureFileBytes = 5 * 1024 * 1024;

    // 上限與伺服器一致，超過的話整包會被拒絕。
    private const int MaxListingsPerUpload = 100;
    private const int MaxSalesPerUpload = 50;

    private readonly IDalamudPluginInterface pluginInterface;
    private readonly ICommandManager commandManager;
    private readonly IMarketBoard marketBoard;
    private readonly IPlayerState playerState;
    private readonly IDataManager dataManager;
    private readonly IPluginLog log;
    private readonly IChatGui chatGui;
    private readonly IFramework framework;
    private readonly IClientState clientState;
    private readonly string dir;
    private readonly string capturePath;
    private readonly string configPath;
    private readonly object writeLock = new();
    private readonly object configLock = new();
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(15) };
    private readonly CancellationTokenSource stop = new();
    private readonly ConcurrentDictionary<uint, Scan> scans = new();
    private readonly Timer flushTimer;
    private readonly CollectorStatus status = new();
    // 上傳佇列（UploadQueue.cs），只在 queueLock 內存取。
    private readonly UploadQueue queue = new();
    private readonly object queueLock = new();
    private readonly SentTracker sent = new();
    private readonly RetryGate itemListGate = new();
    private int pumping;
    private readonly WindowSystem windowSystem = new("MarketBoardCollector");
    private readonly ConfigWindow configWindow;

    // 設定與物品清單都是整個換掉、不就地修改，讀取端先取快照。
    private volatile CollectorConfig config = new();
    // 環境變數 MBCOLLECTOR_ENDPOINT 可以覆寫上傳位址，只給開發測試用。
    private readonly string endpoint = ResolveEndpoint();
    private volatile ItemList itemList = ItemList.Empty;
    private int refreshing;

    private sealed record ItemList(HashSet<uint> Ids, DateTime FetchedAtUtc)
    {
        public static readonly ItemList Empty = new(new HashSet<uint>(), DateTime.MinValue);
    }

    private sealed class Scan
    {
        public uint WorldId;
        public long StartedAtMs;
        public DateTime LastEventAt;
        public bool GotOfferings;
        public bool GotHistory;
        public bool ListingsTrimmed;
        public readonly List<object> Listings = new();
        public readonly List<object> Sales = new();
        // 同一次掃描裡同編號的掛單只留一次。
        public readonly HashSet<string> ListingIds = new();
        public readonly List<string> ListingKeys = new();
        public readonly List<string> SaleKeys = new();
    }

    public Plugin(
        IDalamudPluginInterface pluginInterface,
        ICommandManager commandManager,
        IMarketBoard marketBoard,
        IPlayerState playerState,
        IDataManager dataManager,
        IChatGui chatGui,
        IFramework framework,
        IClientState clientState,
        IPluginLog log)
    {
        this.pluginInterface = pluginInterface;
        this.commandManager = commandManager;
        this.marketBoard = marketBoard;
        this.playerState = playerState;
        this.dataManager = dataManager;
        this.log = log;
        this.chatGui = chatGui;
        this.framework = framework;
        this.clientState = clientState;

        dir = pluginInterface.GetPluginConfigDirectory();
        Directory.CreateDirectory(dir);
        capturePath = Path.Combine(dir, "capture.jsonl");
        configPath = Path.Combine(dir, "config.json");
        LoadConfig();

        configWindow = new ConfigWindow(this);
        windowSystem.AddWindow(configWindow);
        pluginInterface.UiBuilder.Draw += windowSystem.Draw;
        pluginInterface.UiBuilder.OpenConfigUi += OpenSettings;
        pluginInterface.UiBuilder.OpenMainUi += OpenSettings;
        commandManager.AddHandler(CommandName, new CommandInfo(OnCommand) { HelpMessage = "開啟或關閉 FFXIV-TW-Market-Data-Supplement 的設定視窗" });

        marketBoard.OfferingsReceived += OnOfferings;
        marketBoard.HistoryReceived += OnHistory;
        flushTimer = new Timer(_ => FlushQuietScans(), null, TimeSpan.FromMilliseconds(500), TimeSpan.FromMilliseconds(500));

        // 第一次登入後在聊天視窗說明一次。
        if (!config.NoticeShown) framework.Update += OnFrameworkUpdate;

        log.Information(
            "[MarketBoardCollector] started. upload={Upload}, capture file={Path}",
            IsUploadEnabled(config) ? endpoint : "off (disabled in settings)",
            capturePath);
    }

    public void Dispose()
    {
        marketBoard.OfferingsReceived -= OnOfferings;
        marketBoard.HistoryReceived -= OnHistory;
        commandManager.RemoveHandler(CommandName);
        pluginInterface.UiBuilder.OpenMainUi -= OpenSettings;
        pluginInterface.UiBuilder.OpenConfigUi -= OpenSettings;
        pluginInterface.UiBuilder.Draw -= windowSystem.Draw;
        windowSystem.RemoveAllWindows();
        framework.Update -= OnFrameworkUpdate;
        flushTimer.Dispose();
        stop.Cancel();
        http.Dispose();
    }

    private static string ResolveEndpoint()
    {
        var overridden = Environment.GetEnvironmentVariable(EndpointOverrideVariable)?.Trim().TrimEnd('/');
        return string.IsNullOrEmpty(overridden) ? DefaultEndpoint : overridden;
    }

    private static bool IsUploadEnabled(CollectorConfig c) => c.UploadEnabled;

    // ---------- 設定視窗 ----------

    private void OpenSettings() => configWindow.IsOpen = true;

    private void OnCommand(string command, string args) => configWindow.Toggle();

    public CollectorConfig CurrentConfig => config;

    private int QueuedCount()
    {
        lock (queueLock) return queue.Count;
    }

    public StatusSnapshot GetStatus()
    {
        var cfg = config;
        var list = itemList;
        var s = status.Read();
        return new StatusSnapshot(
            IsUploadEnabled(cfg),
            endpoint,
            list.Ids.Count,
            list.FetchedAtUtc == DateTime.MinValue ? null : list.FetchedAtUtc,
            s.Ok,
            s.Failed,
            s.UploadMessageOk,
            s.UploadMessage,
            s.UploadAt,
            s.ListMessage,
            s.ListAt,
            Volatile.Read(ref refreshing) == 1,
            s.Skipped,
            QueuedCount());
    }

    /// <summary>儲存設定並立即生效。成功回傳 null，失敗回傳錯誤說明。</summary>
    public string? SaveConfig(bool uploadEnabled, bool captureToFile)
    {
        CollectorConfig next;
        lock (configLock)
        {
            next = new CollectorConfig { UploadEnabled = uploadEnabled, CaptureToFile = captureToFile, NoticeShown = config.NoticeShown };
            var error = PersistConfig(next, out var previous);
            if (error is not null) return error;

            // 從關閉切回開啟時，下次上傳重新取物品清單。
            if (!previous.UploadEnabled && next.UploadEnabled)
            {
                itemList = ItemList.Empty;
            }
        }

        // 關掉上傳就不送還在排隊的資料。
        if (!next.UploadEnabled)
        {
            lock (queueLock) queue.Clear();
        }

        log.Information("[MarketBoardCollector] settings saved. upload={Upload}, capture={Capture}", IsUploadEnabled(next) ? "on" : "off", next.CaptureToFile);
        return null;
    }

    /// <summary>寫入 config.json 並換上新的設定，要在 configLock 內呼叫。</summary>
    private string? PersistConfig(CollectorConfig next, out CollectorConfig previous)
    {
        previous = config;
        try
        {
            // 先寫暫存檔再換掉，避免寫一半壞檔。
            var tempPath = configPath + ".tmp";
            File.WriteAllText(tempPath, JsonSerializer.Serialize(next, new JsonSerializerOptions { WriteIndented = true }));
            File.Move(tempPath, configPath, overwrite: true);
        }
        catch (Exception ex)
        {
            log.Error(ex, "[MarketBoardCollector] could not write config.json");
            return "無法寫入 config.json：" + CollectorStatus.Shorten(ex.Message);
        }

        config = next;
        return null;
    }

    // ---------- 第一次使用的說明 ----------

    private void OnFrameworkUpdate(IFramework updatedFramework)
    {
        if (!clientState.IsLoggedIn) return;

        framework.Update -= OnFrameworkUpdate;
        chatGui.Print("[FFXIV-TW-Market-Data-Supplement] 這個插件預設會把你在市場板打開的舊染劑等物品資料（掛單與成交紀錄，含雇員名稱與買家名稱）匿名回報給社群伺服器，不含你自己的角色資訊。不想回報：輸入 /mbcollector，取消「啟用上傳」。");

        lock (configLock)
        {
            var current = config;
            PersistConfig(new CollectorConfig { UploadEnabled = current.UploadEnabled, CaptureToFile = current.CaptureToFile, NoticeShown = true }, out _);
        }
    }

    /// <summary>重新向伺服器取得物品清單（測試連線按鈕用）。</summary>
    public bool RefreshItemListNow()
    {
        var cfg = config;
        if (!IsUploadEnabled(cfg)) return false;
        if (Interlocked.Exchange(ref refreshing, 1) == 1) return false;

        _ = Task.Run(async () =>
        {
            try
            {
                await EnsureItemListAsync(cfg, force: true);
            }
            catch (Exception ex)
            {
                log.Warning("[MarketBoardCollector] manual item list refresh failed: {Message}", ex.Message);
            }
            finally
            {
                Volatile.Write(ref refreshing, 0);
            }
        });
        return true;
    }

    private void LoadConfig()
    {
        try
        {
            if (!File.Exists(configPath))
            {
                File.WriteAllText(configPath, JsonSerializer.Serialize(new CollectorConfig(), new JsonSerializerOptions { WriteIndented = true }));
                return;
            }

            var loaded = JsonSerializer.Deserialize<CollectorConfig>(File.ReadAllText(configPath), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new CollectorConfig();
            config = loaded;
        }
        catch (Exception ex)
        {
            log.Error(ex, "[MarketBoardCollector] could not read config.json, using defaults");
            config = new CollectorConfig();
        }
    }

    // ---------- 哪些物品要收（向伺服器問，不寫死）----------

    private static string DescribeHttpStatus(int code) => code switch
    {
        404 => "HTTP 404，伺服器未啟用社群回報",
        429 => "HTTP 429，上傳太頻繁",
        _ => $"HTTP {code}",
    };

    /// <summary>取得可上傳的物品清單，拿不到回傳 null。</summary>
    private async Task<HashSet<uint>?> EnsureItemListAsync(CollectorConfig cfg, bool force = false)
    {
        if (!IsUploadEnabled(cfg)) return null;

        var cached = itemList;
        if (!force && DateTime.UtcNow - cached.FetchedAtUtc < ItemListRefresh && cached.Ids.Count > 0) return cached.Ids;
        var fallback = cached.Ids.Count > 0 ? cached.Ids : null;
        // 剛失敗過，先不再試
        if (!force && !itemListGate.CanAttempt(DateTime.UtcNow)) return fallback;

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{endpoint}/community/items");
            using var response = await http.SendAsync(request, stop.Token);
            if (!response.IsSuccessStatusCode)
            {
                log.Warning("[MarketBoardCollector] item list request failed: {Status}", (int)response.StatusCode);
                status.RecordItemList($"取得物品清單失敗：{DescribeHttpStatus((int)response.StatusCode)}（60 秒後再試）");
                itemListGate.Failed(DateTime.UtcNow);
                return fallback;
            }

            var json = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: stop.Token);
            var ids = json.GetProperty("itemIds").EnumerateArray().Select(e => e.GetUInt32()).ToHashSet();

            if (config.UploadEnabled)
            {
                itemList = new ItemList(ids, DateTime.UtcNow);
            }

            itemListGate.Succeeded();
            log.Information("[MarketBoardCollector] server accepts reports for {Count} items", ids.Count);
            status.RecordItemList($"已取得可上傳物品清單：{ids.Count} 個");
            return ids;
        }
        catch (Exception ex)
        {
            log.Warning("[MarketBoardCollector] could not fetch the item list: {Message}", ex.Message);
            status.RecordItemList($"取得物品清單失敗：{ex.Message}（60 秒後再試）");
            itemListGate.Failed(DateTime.UtcNow);
            return fallback;
        }
    }

    // ---------- 封包事件 ----------

    private uint CurrentWorldId()
    {
        try
        {
            return playerState.CurrentWorld.RowId;
        }
        catch
        {
            return 0;
        }
    }

    private Scan ScanFor(uint itemId)
    {
        var scan = scans.GetOrAdd(itemId, _ => new Scan { WorldId = CurrentWorldId(), StartedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
        scan.LastEventAt = DateTime.UtcNow;
        return scan;
    }

    private void OnOfferings(IMarketBoardCurrentOfferings offerings)
    {
        try
        {
            var listings = offerings.ItemListings;
            if (listings.Count == 0) return;

            var itemId = listings[0].ItemId;
            var scan = ScanFor(itemId);
            lock (scan)
            {
                scan.GotOfferings = true;
                foreach (var l in listings)
                {
                    // 略過不合法的值，避免整包被伺服器拒絕
                    if (l.PricePerUnit <= 0 || l.ItemQuantity <= 0) continue;

                    var listingId = l.ListingId.ToString();
                    if (!scan.ListingIds.Add(listingId)) continue;

                    scan.ListingKeys.Add($"{listingId}:{l.PricePerUnit}:{l.ItemQuantity}:{l.RetainerName}");
                    scan.Listings.Add(new
                    {
                        pricePerUnit = l.PricePerUnit,
                        quantity = l.ItemQuantity,
                        hq = l.IsHq,
                        retainerName = l.RetainerName,
                        // 64 位元編號用字串傳
                        listingId,
                    });
                }

                if (scan.Listings.Count > MaxListingsPerUpload)
                {
                    scan.Listings.RemoveRange(MaxListingsPerUpload, scan.Listings.Count - MaxListingsPerUpload);
                    if (!scan.ListingsTrimmed)
                    {
                        scan.ListingsTrimmed = true;
                        log.Warning("[MarketBoardCollector] item#{Item}: listings exceeded {Max}, extra ones dropped before upload", itemId, MaxListingsPerUpload);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            log.Error(ex, "[MarketBoardCollector] failed to handle offerings");
        }
    }

    private void OnHistory(IMarketBoardHistory history)
    {
        try
        {
            var scan = ScanFor(history.ItemId);
            lock (scan)
            {
                scan.GotHistory = true;
                scan.Sales.Clear();
                scan.SaleKeys.Clear();
                foreach (var s in history.HistoryListings)
                {
                    if (s.SalePrice <= 0 || s.Quantity <= 0) continue;

                    var purchasedAtMs = new DateTimeOffset(DateTime.SpecifyKind(s.PurchaseTime, DateTimeKind.Utc)).ToUnixTimeMilliseconds();
                    scan.SaleKeys.Add($"{purchasedAtMs}:{s.SalePrice}:{s.Quantity}:{s.BuyerName}");
                    scan.Sales.Add(new
                    {
                        pricePerUnit = s.SalePrice,
                        quantity = s.Quantity,
                        hq = s.IsHq,
                        buyerName = s.BuyerName ?? "",
                        timestamp = purchasedAtMs,
                    });
                }

                if (scan.Sales.Count > MaxSalesPerUpload)
                {
                    scan.Sales.RemoveRange(MaxSalesPerUpload, scan.Sales.Count - MaxSalesPerUpload);
                }
            }
        }
        catch (Exception ex)
        {
            log.Error(ex, "[MarketBoardCollector] failed to handle history");
        }
    }

    // ---------- 掃描結束 → 整理、寫檔、上傳 ----------

    private void FlushQuietScans()
    {
        foreach (var (itemId, scan) in scans)
        {
            if (DateTime.UtcNow - scan.LastEventAt < QuietPeriod) continue;
            if (!scans.TryRemove(itemId, out _)) continue;
            _ = Task.Run(() => FinishScanAsync(itemId, scan));
        }
    }

    private async Task FinishScanAsync(uint itemId, Scan scan)
    {
        try
        {
            var cfg = config;

            object[] listings;
            object[] sales;
            string[] listingKeys;
            string[] saleKeys;
            bool gotOfferings;
            lock (scan)
            {
                listings = scan.Listings.ToArray();
                sales = scan.Sales.ToArray();
                listingKeys = scan.ListingKeys.ToArray();
                saleKeys = scan.SaleKeys.ToArray();
                gotOfferings = scan.GotOfferings;
            }

            var payload = new
            {
                worldId = scan.WorldId,
                itemId,
                capturedAt = scan.StartedAtMs,
                listings,
                sales,
            };

            if (cfg.CaptureToFile)
            {
                WriteCapture(new { kind = "scan", at = scan.StartedAtMs, world = scan.WorldId, itemId, item = ItemInfo(itemId), offeringsPackets = gotOfferings, listingCount = listings.Length, salesCount = sales.Length });
            }

            if (!IsUploadEnabled(cfg)) return;
            if (scan.WorldId == 0)
            {
                log.Warning("[MarketBoardCollector] skipped item#{Item}: current world unknown yet", itemId);
                return;
            }
            var accepted = await EnsureItemListAsync(cfg);
            if (accepted is null) return;
            if (!accepted.Contains(itemId)) return; // 伺服器不收的物品不回報

            // 內容跟最近送出的一樣就不重送，超過 10 分鐘會再送一次
            var hash = ScanFingerprint.Compute(scan.WorldId, itemId, listingKeys, saleKeys);
            if (sent.WasSentRecently(scan.WorldId, itemId, hash, DateTime.UtcNow))
            {
                status.RecordSkipped($"item#{itemId}：內容跟 10 分鐘內送過的一樣，略過");
                return;
            }

            EnqueueUpload(new UploadJob(itemId, scan.WorldId, JsonSerializer.Serialize(payload), scan.StartedAtMs, listings.Length, sales.Length, hash));
        }
        catch (Exception ex)
        {
            log.Error(ex, "[MarketBoardCollector] failed to finish a scan");
        }
    }

    // ---------- 上傳佇列：送出、重試、不丟資料 ----------

    private readonly record struct SendResult(SendOutcome Outcome, TimeSpan? RetryAfter, string Detail);

    private void EnqueueUpload(UploadJob job)
    {
        (EnqueueResult Result, UploadJob? Dropped) queued;
        lock (queueLock)
        {
            queued = queue.Enqueue(job);
        }

        if (queued.Result == EnqueueResult.QueuedDroppedOldest && queued.Dropped is { } dropped)
        {
            log.Warning("[MarketBoardCollector] upload queue is full, dropped the oldest scan (item#{Item})", dropped.ItemId);
            status.RecordUpload(false, $"item#{dropped.ItemId}：排隊的太多，最舊的一筆被丟棄");
        }

        StartPump();
    }

    private void StartPump()
    {
        if (Interlocked.CompareExchange(ref pumping, 1, 0) != 0) return;
        _ = Task.Run(PumpAsync);
    }

    /// <summary>依序送出佇列裡的東西，限流或暫時失敗就等一下再送。</summary>
    private async Task PumpAsync()
    {
        var crashed = false;
        try
        {
            while (!stop.IsCancellationRequested)
            {
                if (!IsUploadEnabled(config))
                {
                    lock (queueLock) queue.Clear();
                    break;
                }

                QueueStep step;
                lock (queueLock) step = queue.Next(DateTime.UtcNow);
                foreach (var expired in step.Expired)
                {
                    status.RecordUpload(false, $"item#{expired.ItemId}：超過 14 分鐘還沒送出去，放棄（伺服器不收太舊的掃描）");
                }

                if (step.Job is null)
                {
                    if (step.Wait is null) break;
                    var wait = step.Wait.Value < TimeSpan.FromSeconds(30) ? step.Wait.Value : TimeSpan.FromSeconds(30);
                    await Task.Delay(wait, stop.Token);
                    continue;
                }

                var result = await SendAsync(step.Job);
                ReportResult report;
                lock (queueLock) report = queue.Report(step.Job, result.Outcome, result.RetryAfter, DateTime.UtcNow);
                RecordSendResult(step.Job, result, report);
            }
        }
        catch (OperationCanceledException)
        {
            // 插件正在卸載
        }
        catch (Exception ex)
        {
            crashed = true;
            log.Error(ex, "[MarketBoardCollector] upload loop failed");
        }
        finally
        {
            Volatile.Write(ref pumping, 0);
            // 放掉旗標前可能又有新的排進來
            bool more;
            lock (queueLock) more = queue.Count > 0;
            if (more && !crashed && !stop.IsCancellationRequested) StartPump();
        }
    }

    private async Task<SendResult> SendAsync(UploadJob job)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{endpoint}/community/upload")
            {
                Content = new StringContent(job.Body, System.Text.Encoding.UTF8, "application/json"),
            };

            using var response = await http.SendAsync(request, stop.Token);
            var text = await response.Content.ReadAsStringAsync(stop.Token);
            var code = (int)response.StatusCode;
            if (response.IsSuccessStatusCode) return new SendResult(SendOutcome.Success, null, text);

            var detail = $"{DescribeHttpStatus(code)}{ServerError(text)}";
            if (code == 429) return new SendResult(SendOutcome.RateLimited, response.Headers.RetryAfter?.Delta, detail);
            if (code >= 500 || code == 408) return new SendResult(SendOutcome.Retryable, null, detail);
            return new SendResult(SendOutcome.Permanent, null, detail);
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // 網路錯誤或逾時
            return new SendResult(SendOutcome.Retryable, null, ex.Message);
        }
    }

    private void RecordSendResult(UploadJob job, SendResult result, ReportResult report)
    {
        var pause = report.PausedFor is { } paused ? $"{Math.Ceiling(paused.TotalSeconds)} 秒" : "";
        switch (result.Outcome)
        {
            case SendOutcome.Success:
                sent.Record(job.WorldId, job.ItemId, job.ContentHash, DateTime.UtcNow);
                log.Information("[MarketBoardCollector] uploaded item#{Item} world#{World}: {Listings} listings, {Sales} sales -> {Response}", job.ItemId, job.WorldId, job.ListingCount, job.SalesCount, result.Detail);
                status.RecordUpload(true, $"item#{job.ItemId} 世界{job.WorldId}：上傳成功（掛單 {job.ListingCount} 筆、成交 {job.SalesCount} 筆）");
                break;

            case SendOutcome.RateLimited:
                log.Information("[MarketBoardCollector] rate limited on item#{Item}, retrying in {Pause}", job.ItemId, pause);
                status.RecordPending($"item#{job.ItemId}：伺服器要求慢一點（429），{pause}後自動重送");
                break;

            case SendOutcome.Retryable when report.GaveUp:
                log.Warning("[MarketBoardCollector] giving up on item#{Item} after {Attempts} attempts: {Detail}", job.ItemId, job.Attempts, result.Detail);
                status.RecordUpload(false, $"item#{job.ItemId}：連續失敗，放棄（{result.Detail}）");
                break;

            case SendOutcome.Retryable:
                log.Warning("[MarketBoardCollector] upload failed for item#{Item}, retrying in {Pause}: {Detail}", job.ItemId, pause, result.Detail);
                status.RecordPending($"item#{job.ItemId}：暫時送不出去（{result.Detail}），{pause}後重試");
                break;

            default:
                log.Warning("[MarketBoardCollector] upload rejected for item#{Item}: {Detail}", job.ItemId, result.Detail);
                status.RecordUpload(false, $"item#{job.ItemId}：被伺服器拒絕（{result.Detail}）");
                break;
        }
    }

    /// <summary>取出伺服器回應裡的 error 訊息，取不到就回空字串。</summary>
    private static string ServerError(string responseText)
    {
        try
        {
            using var doc = JsonDocument.Parse(responseText);
            if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String)
            {
                return "：" + error.GetString();
            }
        }
        catch
        {
            // 不是 JSON 就略過
        }
        return "";
    }

    // ---------- 本機除錯檔 ----------

    /// <summary>向遊戲資料表查物品名稱，只給本機除錯檔用。</summary>
    private object? ItemInfo(uint itemId)
    {
        try
        {
            var row = dataManager.GetExcelSheet<Lumina.Excel.Sheets.Item>().GetRowOrDefault(itemId);
            if (row is null) return new { name = (string?)null };
            var item = row.Value;
            return new { name = item.Name.ToString(), searchCategory = item.ItemSearchCategory.RowId, untradable = item.IsUntradable, stackSize = item.StackSize };
        }
        catch
        {
            return null;
        }
    }

    private void WriteCapture(object record)
    {
        var line = JsonSerializer.Serialize(record);
        lock (writeLock)
        {
            var info = new FileInfo(capturePath);
            if (info.Exists && info.Length > MaxCaptureFileBytes)
            {
                File.Move(capturePath, capturePath + ".old", overwrite: true);
            }
            File.AppendAllText(capturePath, line + Environment.NewLine);
        }
    }
}
