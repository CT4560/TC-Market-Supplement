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
/// 掃描市場板時收集「繁中服可交易、但 Universalis 沒有價格資料」的物品（舊染劑等），回報給我們自己的伺服器。
///
/// 一次掃描 ＝ 你在市場板點進某個商品：遊戲會分好幾個封包傳掛單（每包最多 10 筆，同一個 RequestId），
/// 再傳一包成交紀錄。封包沒有「掛單結束」的標記，所以用「這個物品安靜 2 秒」當作這次掃描結束。
/// 沒有人在賣時，遊戲不會傳掛單封包，只有成交紀錄 —— 這種情況視為「目前沒有掛單」。
/// 不記錄玩家名稱，只留雇員名稱（市場板上公開的）。
///
/// 外掛完全被動：只處理玩家自己打開市場板時收到的封包，不會操作遊戲、不會自動翻市場板。
/// </summary>
public sealed class Plugin : IDalamudPlugin
{
    private const string CommandName = "/mbcollector";

    // 所有玩家都回報到同一個官方社群伺服器，所以網址寫死在這裡，不讓玩家自己填。
    // 官方社群伺服器的網址（Cloudflare Tunnel 接到 VPS 上的容器）。如果哪天換成還沒填的佔位字串（含 REPLACE_WITH），
    // 即使「啟用上傳」開著也不會送出任何請求。
    private const string DefaultEndpoint = "https://api-ffxiv-bot.epicurean-expedition.com";
    private const string EndpointOverrideVariable = "MBCOLLECTOR_ENDPOINT";

    private static readonly TimeSpan QuietPeriod = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan ItemListRefresh = TimeSpan.FromMinutes(30);
    private const long MaxCaptureFileBytes = 5 * 1024 * 1024;

    // 對齊伺服器 community.ts 的 MAX_LISTINGS_PER_UPLOAD / MAX_SALES_PER_UPLOAD：超過或有不合法數值
    // 整包會被伺服器 400 拒絕，所以外掛端先過濾、截斷，避免因為單一筆爛資料丟掉整次掃描的回報。
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
    // 上傳佇列（見 UploadQueue.cs）：被限流或暫時失敗的掃描結果留在裡面重試，不直接丟掉。queue 只在 queueLock 保護下讀寫。
    private readonly UploadQueue queue = new();
    private readonly object queueLock = new();
    private readonly SentTracker sent = new();
    private readonly RetryGate itemListGate = new();
    private int pumping;
    private readonly WindowSystem windowSystem = new("MarketBoardCollector");
    private readonly ConfigWindow configWindow;

    // 設定與物品清單會在背景 Task（掃描結束、上傳）與 UI 執行緒（設定視窗）之間共用。
    // 兩者都只用「整個換掉」的方式更新（參考指派是不可分割的），讀取端每次操作先抓一份快照，不會看到改到一半的狀態。
    private volatile CollectorConfig config = new();
    // 開發者測試用：啟動時讀一次環境變數 MBCOLLECTOR_ENDPOINT，非空白就取代寫死的網址（環境變數不會在遊戲執行中變動）。
    // 不出現在設定視窗、也不寫進 config.json，一般玩家用不到。
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
        // 同一次掃描裡，同一筆掛單（同編號）只留一次：使用者在 2 秒內重開同一個物品時，封包會再來一輪。
        public readonly HashSet<string> ListingIds = new();
        // 內容指紋用的關鍵欄位（見 ScanFingerprint），跟 Listings／Sales 一一對應。
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
        commandManager.AddHandler(CommandName, new CommandInfo(OnCommand) { HelpMessage = "開啟或關閉 Market Board Collector 的設定視窗" });

        marketBoard.OfferingsReceived += OnOfferings;
        marketBoard.HistoryReceived += OnHistory;
        flushTimer = new Timer(_ => FlushQuietScans(), null, TimeSpan.FromMilliseconds(500), TimeSpan.FromMilliseconds(500));

        // 第一次使用：登入遊戲之後在聊天視窗說明一次「預設會回報什麼、怎麼關」。
        if (!config.NoticeShown) framework.Update += OnFrameworkUpdate;

        log.Information(
            "[MarketBoardCollector] started. upload={Upload}, capture file={Path}",
            IsUploadEnabled(config) ? endpoint : (config.UploadEnabled ? "off (server endpoint not set yet)" : "off (disabled in settings)"),
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

    /// <summary>伺服器網址還是佔位字串（尚未填入正式網址、也沒用環境變數覆寫）。</summary>
    public bool EndpointIsPlaceholder => endpoint.Contains("REPLACE_WITH", StringComparison.Ordinal);

    /// <summary>真正會上傳：使用者的「啟用上傳」開著，而且已經有可用的伺服器網址。</summary>
    private bool IsUploadEnabled(CollectorConfig c) => c.UploadEnabled && !EndpointIsPlaceholder;

    // ---------- 設定視窗 ----------

    private void OpenSettings() => configWindow.IsOpen = true;

    private void OnCommand(string command, string args) => configWindow.Toggle();

    /// <summary>目前生效的設定（唯讀快照，不要就地修改）。</summary>
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

    /// <summary>
    /// 儲存設定到 config.json 並立刻套用（下一次上傳／取清單就用新設定，不必重開遊戲）。
    /// 成功回傳 null，失敗回傳給使用者看的錯誤說明（此時舊設定維持不變）。
    /// </summary>
    public string? SaveConfig(bool uploadEnabled, bool captureToFile)
    {
        CollectorConfig next;
        lock (configLock)
        {
            next = new CollectorConfig { UploadEnabled = uploadEnabled, CaptureToFile = captureToFile, NoticeShown = config.NoticeShown };
            var error = PersistConfig(next, out var previous);
            if (error is not null) return error;

            // 從關閉切回開啟時，舊的「可上傳物品清單」可能已經過期，下次上傳時重新向伺服器要。
            if (!previous.UploadEnabled && next.UploadEnabled)
            {
                itemList = ItemList.Empty;
            }
        }

        // 關掉上傳：還在排隊的掃描結果不送了（使用者不想回報）
        if (!next.UploadEnabled)
        {
            lock (queueLock) queue.Clear();
        }

        log.Information("[MarketBoardCollector] settings saved. upload={Upload}, capture={Capture}", IsUploadEnabled(next) ? "on" : "off", next.CaptureToFile);
        return null;
    }

    /// <summary>把設定寫進 config.json 並換上新的實例。要在 configLock 裡呼叫。成功回傳 null（previous 是換掉前的設定）。</summary>
    private string? PersistConfig(CollectorConfig next, out CollectorConfig previous)
    {
        previous = config;
        try
        {
            // 先寫暫存檔再換掉，避免寫到一半當機留下壞掉的 config.json。
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
        chatGui.Print("[Market Board Collector] 這個外掛預設會把你在市場板打開的舊染劑等物品資料（掛單與成交紀錄，含雇員名稱與買家名稱）匿名回報給社群伺服器，不含你自己的角色資訊。不想回報：輸入 /mbcollector，取消「啟用上傳」。");

        lock (configLock)
        {
            var current = config;
            PersistConfig(new CollectorConfig { UploadEnabled = current.UploadEnabled, CaptureToFile = current.CaptureToFile, NoticeShown = true }, out _);
        }
    }

    /// <summary>在背景向伺服器重新取得物品清單（給設定視窗的「測試連線」按鈕用）。已在進行中或未啟用上傳時回傳 false。</summary>
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
            // 舊版 config.json 裡的 Endpoint／UploadKey 欄位已經不存在，反序列化時會被忽略，不需要處理。
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

    /// <summary>
    /// 取得目前可上傳的物品清單。回傳 null 表示拿不到（未啟用上傳、或請求失敗且沒有舊清單可用）。
    /// 用呼叫當下的設定快照 cfg 判斷是否啟用，中途改設定不會讓舊設定的結果蓋掉新設定的清單。
    /// </summary>
    private async Task<HashSet<uint>?> EnsureItemListAsync(CollectorConfig cfg, bool force = false)
    {
        if (!IsUploadEnabled(cfg)) return null;

        var cached = itemList;
        if (!force && DateTime.UtcNow - cached.FetchedAtUtc < ItemListRefresh && cached.Ids.Count > 0) return cached.Ids;
        var fallback = cached.Ids.Count > 0 ? cached.Ids : null;
        // 剛失敗過：一段時間內不再敲伺服器（每掃一個物品就試一次會白等 15 秒逾時）
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

            // 請求期間如果使用者把上傳關掉了，這份清單就不要放進快取。
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
                    // 防禦：理論上遊戲不會給 0 或負值，但一旦出現，伺服器會把整包上傳都拒絕（400）；
                    // 略過這一筆比丟掉整次掃描的其他正常資料好。
                    if (l.PricePerUnit <= 0 || l.ItemQuantity <= 0) continue;

                    var listingId = l.ListingId.ToString();
                    if (!scan.ListingIds.Add(listingId)) continue; // 同一次掃描裡已經有這筆了

                    scan.ListingKeys.Add($"{listingId}:{l.PricePerUnit}:{l.ItemQuantity}:{l.RetainerName}");
                    scan.Listings.Add(new
                    {
                        pricePerUnit = l.PricePerUnit,
                        quantity = l.ItemQuantity,
                        hq = l.IsHq,
                        retainerName = l.RetainerName,
                        // 64 位元整數，用字串傳才不會在 JSON 裡失真
                        listingId,
                    });
                }

                // 對齊伺服器上限（見 MaxListingsPerUpload 的說明）；正常情況不會觸發，只是保險。
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
                    // 防禦：理由同掛單那邊——一筆爛資料不該拖累整包上傳。
                    if (s.SalePrice <= 0 || s.Quantity <= 0) continue;

                    var purchasedAtMs = new DateTimeOffset(DateTime.SpecifyKind(s.PurchaseTime, DateTimeKind.Utc)).ToUnixTimeMilliseconds();
                    scan.SaleKeys.Add($"{purchasedAtMs}:{s.SalePrice}:{s.Quantity}:{s.BuyerName}");
                    scan.Sales.Add(new
                    {
                        pricePerUnit = s.SalePrice,
                        quantity = s.Quantity,
                        hq = s.IsHq,
                        // 市場板成交紀錄本來就公開顯示的買家名稱。
                        buyerName = s.BuyerName ?? "",
                        // 封包裡的真實成交時間（UTC）
                        timestamp = purchasedAtMs,
                    });
                }

                // 成交紀錄固定是最近 20 筆，理論上不會超過伺服器上限，這裡只是保險。
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
            // 這次掃描從頭到尾用同一份設定快照，中途儲存新設定不會讓一次掃描前後不一致。
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
            if (!accepted.Contains(itemId)) return; // Universalis 有資料的物品不用我們回報

            // 跟最近成功送出的內容完全一樣就不用再送（玩家反覆點同一個物品時）；超過 10 分鐘會再送一次，刷新伺服器的掃描時間。
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

    /// <summary>一次只跑一個：依序送出佇列裡的東西；被限流或暫時失敗就等一下再送同一筆，佇列空了就結束。</summary>
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
                    if (step.Wait is null) break; // 佇列空了
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
            // 外掛正在卸載
        }
        catch (Exception ex)
        {
            crashed = true;
            log.Error(ex, "[MarketBoardCollector] upload loop failed");
        }
        finally
        {
            Volatile.Write(ref pumping, 0);
            // 迴圈結束到放掉旗標之間，可能又有新的排進來
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
            return new SendResult(SendOutcome.Permanent, null, detail); // 400／413／422／404…：重送也不會成功
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // 網路錯誤、連不上、逾時（HttpClient 逾時是 TaskCanceledException，但不是我們取消的）
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

    /// <summary>伺服器錯誤回應是 {"ok":false,"error":"..."}；取出 error 給狀態畫面看，解析不了就不顯示。</summary>
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
            // 不是 JSON（例如代理伺服器的錯誤頁），略過
        }
        return "";
    }

    // ---------- 本機除錯檔 ----------

    /// <summary>封包裡只有物品編號。名稱向遊戲客戶端自己的資料表查（繁中版客戶端就是繁中名稱），僅供核對。</summary>
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
