using System.Numerics;
using Dalamud.Bindings.ImGui;
using Dalamud.Interface.Windowing;

namespace MarketBoardCollector;

/// <summary>
/// 設定視窗：切換上傳與本機寫檔，並顯示上傳狀態。
/// 一律在 UI 執行緒繪製；與背景上傳工作共用的資料都透過 Plugin 的快照方法取得。
/// </summary>
public sealed class ConfigWindow : Window
{
    private static readonly Vector4 Green = new(0.45f, 0.9f, 0.45f, 1f);
    private static readonly Vector4 Red = new(1f, 0.45f, 0.45f, 1f);
    private static readonly Vector4 Yellow = new(1f, 0.85f, 0.35f, 1f);
    private static readonly Vector4 Grey = new(0.7f, 0.7f, 0.7f, 1f);

    private readonly Plugin plugin;

    private bool uploadEnabled = true;
    private bool captureToFile = true;
    private string feedback = "";
    private bool feedbackIsError;

    public ConfigWindow(Plugin plugin) : base("Market Board Collector 設定###MarketBoardCollectorConfig")
    {
        this.plugin = plugin;
        Size = new Vector2(560, 470);
        SizeCondition = ImGuiCond.FirstUseEver;
        SizeConstraints = new WindowSizeConstraints { MinimumSize = new Vector2(420, 360), MaximumSize = new Vector2(1200, 1000) };
    }

    /// <summary>每次打開視窗都從目前生效的設定重新載入輸入欄（放棄沒儲存的修改）。</summary>
    public override void OnOpen() => ResetInputs();

    private void ResetInputs()
    {
        var cfg = plugin.CurrentConfig;
        uploadEnabled = cfg.UploadEnabled;
        captureToFile = cfg.CaptureToFile;
        feedback = "";
    }

    public override void Draw()
    {
        DrawSettings();
        ImGui.Spacing();
        ImGui.Separator();
        ImGui.Spacing();
        DrawStatus();
    }

    private void DrawSettings()
    {
        ImGui.TextWrapped("本外掛只被動記錄你自己在市場板打開的物品，不會操作遊戲。預設會把 Universalis 沒有資料的物品（例如繁中服舊染劑）的掛單與成交紀錄回報給社群伺服器，只送市場板上公開顯示的資料（含成交紀錄的買家名稱與雇員名稱），不含你自己的角色資訊。關閉「啟用上傳」就只寫本機檔案、不會上傳。");
        ImGui.Spacing();

        ImGui.Checkbox("啟用上傳（回報給社群伺服器）", ref uploadEnabled);
        ImGui.Checkbox("寫入本機檔案（capture.jsonl，除錯用）", ref captureToFile);

        var cfg = plugin.CurrentConfig;
        var dirty = uploadEnabled != cfg.UploadEnabled || captureToFile != cfg.CaptureToFile;

        ImGui.Spacing();
        if (ImGui.Button("儲存"))
        {
            var error = plugin.SaveConfig(uploadEnabled, captureToFile);
            if (error is null)
            {
                ResetInputs();
                feedback = "已儲存，立即生效。";
                feedbackIsError = false;
            }
            else
            {
                feedback = error;
                feedbackIsError = true;
            }
        }

        ImGui.SameLine();
        if (!dirty) ImGui.BeginDisabled();
        if (ImGui.Button("放棄變更"))
        {
            ResetInputs();
        }
        if (!dirty) ImGui.EndDisabled();

        ImGui.SameLine();
        if (dirty) ImGui.TextColored(Yellow, "有尚未儲存的變更");
        else if (feedback.Length > 0) ImGui.TextColored(feedbackIsError ? Red : Green, feedback);

        if (dirty && feedbackIsError && feedback.Length > 0) ImGui.TextColored(Red, feedback);
    }

    private void DrawStatus()
    {
        var s = plugin.GetStatus();

        ImGui.Text("狀態");

        if (s.UploadEnabled)
        {
            ImGui.TextColored(Green, "上傳：已啟用");
            ImGui.SameLine();
            ImGui.TextColored(Grey, $"（{s.Endpoint}）");
        }
        else
        {
            ImGui.TextColored(Yellow, plugin.CurrentConfig.UploadEnabled ? "上傳：暫時不會送出（尚未設定社群伺服器網址，目前只寫本機檔案）" : "上傳：已關閉（目前只寫本機檔案）");
        }

        if (s.ItemListAtUtc is { } fetchedAt)
        {
            ImGui.Text($"可上傳物品清單：{s.ItemCount} 個，更新於 {fetchedAt.ToLocalTime():HH:mm:ss}");
        }
        else
        {
            ImGui.Text("可上傳物品清單：尚未取得（第一次掃描到物品時，或按下面的按鈕會向伺服器要）");
        }
        if (s.ListMessage.Length > 0 && s.ListMessageAtUtc is { } listAt)
        {
            ImGui.TextWrapped($"　清單最近一次結果 [{listAt.ToLocalTime():HH:mm:ss}]：{s.ListMessage}");
        }

        ImGui.Text($"本次遊戲階段上傳：成功 {s.UploadOk} 筆、失敗 {s.UploadFailed} 筆");
        if (s.UploadMessage.Length > 0 && s.UploadMessageAtUtc is { } uploadAt)
        {
            ImGui.TextColored(s.UploadMessageOk ? Green : Red, $"最近一次上傳 [{uploadAt.ToLocalTime():HH:mm:ss}]：{s.UploadMessage}");
        }
        else
        {
            ImGui.TextColored(Grey, "最近一次上傳：尚無");
        }

        ImGui.Spacing();
        var disabled = !s.UploadEnabled || s.Refreshing;
        if (disabled) ImGui.BeginDisabled();
        if (ImGui.Button(s.Refreshing ? "更新中..." : "測試連線並更新物品清單"))
        {
            plugin.RefreshItemListNow();
        }
        if (disabled) ImGui.EndDisabled();
        ImGui.SameLine();
        ImGui.TextColored(Grey, "（使用已儲存的設定）");
    }
}
