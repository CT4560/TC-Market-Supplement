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
    // 正式網址還沒決定：發佈前要把這個佔位字串換成真正的網址。還是佔位字串時，即使「啟用上傳」開著也不會送出任何請求。
    private const string DefaultEndpoint = "https://REPLACE_WITH_SERVER_URL";
    private const string EndpointOverrideVariable = "MBCOLLECTOR_ENDPOINT";

    private static readonly TimeSpan QuietPeriod = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan ItemListRefresh = TimeSpan.FromMinutes(30);
    private const long MaxCaptureFileBytes = 5 * 1024 * 1024;

    // 對齊伺服器 community.ts 的 MAX_LISTINGS_PER_UPLOAD / MAX_SALES_PER_UPLOAD：超過或有不合法數值
    // 整包會被伺服器 400 拒絕，所以外掛端先過濾、截斷，避免因為單一筆爛資料丟掉整次掃描的回報。
    private const int MaxListingsPerUpload = 100;
    private const int MaxSalesPerUpload = 50;
    // 429（上傳太頻繁）之後暫停上傳一段時間再試，而不是立刻重送，避免持續打爆伺服器。
    private static readonly TimeSpan UploadBackoff = TimeSpan.FromSeconds(60);

    private readonly IDalamudPluginInterface pluginInterface;
    private readonly ICommandManager commandManager;
    private readonly IMarketBoard marketBoard;
    private readonly IPlayerState playerState;
    private readonly IDataManager dataManager;
    private readonly IPluginLog log;
    private readonly string dir;
    private readonly string capturePath;
    private readonly string configPath;
    private readonly object writeLock = new();
    private readonly object configLock = new();
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(15) };
    private readonly CancellationTokenSource stop = new();
    private readonly ConcurrentDictionary<uint, Scan> scans = new();
    private readonly SemaphoreSlim uploadLock = new(1, 1);
    private readonly Timer flushTimer;
    private readonly CollectorStatus status = new();
    // 只在 uploadLock 保護下讀寫（上傳本來就用這把鎖序列化）。
    private DateTime uploadBackoffUntilUtc = DateTime.MinValue;
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
    }

    public Plugin(
        IDalamudPluginInterface pluginInterface,
        ICommandManager commandManager,
        IMarketBoard marketBoard,
        IPlayerState playerState,
        IDataManager dataManager,
        IPluginLog log)
    {
        this.pluginInterface = pluginInterface;
        this.commandManager = commandManager;
        this.marketBoard = marketBoard;
        this.playerState = playerState;
        this.dataManager = dataManager;
        this.log = log;

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
            Volatile.Read(ref refreshing) == 1);
    }

    /// <summary>
    /// 儲存設定到 config.json 並立刻套用（下一次上傳／取清單就用新設定，不必重開遊戲）。
    /// 成功回傳 null，失敗回傳給使用者看的錯誤說明（此時舊設定維持不變）。
    /// </summary>
    public string? SaveConfig(bool uploadEnabled, bool captureToFile)
    {
        var next = new CollectorConfig { UploadEnabled = uploadEnabled, CaptureToFile = captureToFile };

        lock (configLock)
        {
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

            var previous = config;
            config = next;
            // 從關閉切回開啟時，舊的「可上傳物品清單」可能已經過期，下次上傳時重新向伺服器要。
            if (!previous.UploadEnabled && next.UploadEnabled)
            {
                itemList = ItemList.Empty;
            }
        }

        log.Information("[MarketBoardCollector] settings saved. upload={Upload}, capture={Capture}", IsUploadEnabled(next) ? "on" : "off", next.CaptureToFile);
        return null;
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

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{endpoint}/community/items");
            using var response = await http.SendAsync(request, stop.Token);
            if (!response.IsSuccessStatusCode)
            {
                log.Warning("[MarketBoardCollector] item list request failed: {Status}", (int)response.StatusCode);
                status.RecordItemList($"取得物品清單失敗：{DescribeHttpStatus((int)response.StatusCode)}");
                return fallback;
            }

            var json = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: stop.Token);
            var ids = json.GetProperty("itemIds").EnumerateArray().Select(e => e.GetUInt32()).ToHashSet();

            // 請求期間如果使用者把上傳關掉了，這份清單就不要放進快取。
            if (config.UploadEnabled)
            {
                itemList = new ItemList(ids, DateTime.UtcNow);
            }

            log.Information("[MarketBoardCollector] server accepts reports for {Count} items", ids.Count);
            status.RecordItemList($"已取得可上傳物品清單：{ids.Count} 個");
            return ids;
        }
        catch (Exception ex)
        {
            log.Warning("[MarketBoardCollector] could not fetch the item list: {Message}", ex.Message);
            status.RecordItemList($"取得物品清單失敗：{ex.Message}");
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

                    scan.Listings.Add(new
                    {
                        pricePerUnit = l.PricePerUnit,
                        quantity = l.ItemQuantity,
                        hq = l.IsHq,
                        retainerName = l.RetainerName,
                        // 64 位元整數，用字串傳才不會在 JSON 裡失真
                        listingId = l.ListingId.ToString(),
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
                foreach (var s in history.HistoryListings)
                {
                    // 防禦：理由同掛單那邊——一筆爛資料不該拖累整包上傳。
                    if (s.SalePrice <= 0 || s.Quantity <= 0) continue;

                    scan.Sales.Add(new
                    {
                        pricePerUnit = s.SalePrice,
                        quantity = s.Quantity,
                        hq = s.IsHq,
                        // 封包裡的真實成交時間（UTC）
                        timestamp = new DateTimeOffset(DateTime.SpecifyKind(s.PurchaseTime, DateTimeKind.Utc)).ToUnixTimeMilliseconds(),
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
            bool gotOfferings;
            lock (scan)
            {
                listings = scan.Listings.ToArray();
                sales = scan.Sales.ToArray();
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

            await UploadAsync(cfg, itemId, scan, payload, listings.Length, sales.Length);
        }
        catch (Exception ex)
        {
            log.Error(ex, "[MarketBoardCollector] failed to finish a scan");
        }
    }

    private async Task UploadAsync(CollectorConfig cfg, uint itemId, Scan scan, object payload, int listingCount, int salesCount)
    {
        var body = JsonSerializer.Serialize(payload);

        await uploadLock.WaitAsync(stop.Token);
        try
        {
            if (DateTime.UtcNow < uploadBackoffUntilUtc)
            {
                // 剛被伺服器 429 過，暫停一段時間再試，而不是每次掃描都繼續打（會愈打愈久被限流）。
                log.Information("[MarketBoardCollector] skip upload for item#{Item}: backing off until {Until:o} after a previous 429", itemId, uploadBackoffUntilUtc);
                status.RecordUpload(false, $"item#{itemId}：暫停上傳中（剛才被伺服器限流 429，稍後自動恢復）");
                return;
            }

            using var request = new HttpRequestMessage(HttpMethod.Post, $"{endpoint}/community/upload")
            {
                Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
            };

            using var response = await http.SendAsync(request, stop.Token);
            var text = await response.Content.ReadAsStringAsync(stop.Token);
            if (response.IsSuccessStatusCode)
            {
                log.Information("[MarketBoardCollector] uploaded item#{Item} world#{World}: {Listings} listings, {Sales} sales -> {Response}", itemId, scan.WorldId, listingCount, salesCount, text);
                status.RecordUpload(true, $"item#{itemId} 世界{scan.WorldId}：上傳成功（掛單 {listingCount} 筆、成交 {salesCount} 筆）");
            }
            else
            {
                if ((int)response.StatusCode == 429)
                {
                    uploadBackoffUntilUtc = DateTime.UtcNow + UploadBackoff;
                }
                log.Warning("[MarketBoardCollector] upload rejected for item#{Item}: {Status} {Response}", itemId, (int)response.StatusCode, text);
                status.RecordUpload(false, $"item#{itemId}：被伺服器拒絕（{DescribeHttpStatus((int)response.StatusCode)}）{ServerError(text)}");
            }
        }
        catch (Exception ex)
        {
            log.Warning("[MarketBoardCollector] upload failed for item#{Item}: {Message}", itemId, ex.Message);
            status.RecordUpload(false, $"item#{itemId}：上傳失敗（{ex.Message}）");
        }
        finally
        {
            uploadLock.Release();
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
