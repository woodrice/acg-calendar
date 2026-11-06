using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace Playtime;

public sealed partial class CalendarWindow
{
    // Feedback inside cards only. The existing edge tuck/reveal controller is independent.
    readonly ComboBox motionSelect = new() { DisplayMemberPath = "Label", SelectedValuePath = "Id", Margin = new Thickness(0, 3, 0, 8) };
    readonly HashSet<string> pendingEventFeedback = [];
    string feedbackSetting = "auto", feedbackContext = "";
    string? requestedFeedbackFocus;
    string syncFeedbackSignature = "";
    bool updatingMotion;
    int feedbackGeneration;
    string FeedbackMode => feedbackSetting == "auto" ? (SystemParameters.ClientAreaAnimation ? "standard" : "reduced") : feedbackSetting;
    record CardFeedback(Dictionary<string, double> Positions, string? Focus, int Generation);

    void BuildMotionSettings()
    {
        PreviewMouseDown += (_, _) => requestedFeedbackFocus = null;
        PreviewKeyDown += (_, _) => requestedFeedbackFocus = null;
        Section(desktopSettings, "界面反馈动效");
        foreach (var choice in new[] { new GameChoice("auto", "跟随系统（默认）"), new GameChoice("standard", "标准 · 利落位移"), new GameChoice("reduced", "减少 · 仅轻微淡入淡出"), new GameChoice("off", "关闭") }) motionSelect.Items.Add(choice);
        AutomationProperties.SetName(motionSelect, "界面反馈动效");
        motionSelect.IsEnabled = false; desktopSettings.Children.Add(motionSelect);
        var note = Text("与网页共用；不改变现有气泡贴边收起与展开效果。", 10); note.Foreground = Muted; desktopSettings.Children.Add(note);
        motionSelect.SelectionChanged += async (_, _) => {
            if (updatingMotion || motionSelect.SelectedValue is not string value || value == feedbackSetting) return;
            motionSelect.IsEnabled = false;
            try { await Mutate("/api/settings", new { ui_motion = value }); }
            finally { updatingMotion = true; motionSelect.SelectedValue = feedbackSetting; updatingMotion = false; motionSelect.IsEnabled = true; }
        };
    }

    void UpdateMotion(JsonElement settings)
    {
        feedbackSetting = settings.TryGetProperty("ui_motion", out var value) ? value.GetString() ?? "auto" : "auto";
        updatingMotion = true; motionSelect.SelectedValue = feedbackSetting; motionSelect.IsEnabled = true; updatingMotion = false;
    }

    CardFeedback CaptureCardFeedback()
    {
        string context = $"{selectedGame}|{selected}|{showAll}|{dense}|{hideFuture}";
        bool same = feedbackContext == context; feedbackContext = context;
        var positions = new Dictionary<string, double>();
        if (same && FeedbackMode != "off" && cards.IsVisible)
            foreach (var card in cards.Children.OfType<Border>())
                if (card.Tag is string id && card.ActualHeight > 0) positions[id] = card.TranslatePoint(new Point(), cards).Y;
        var focused = Keyboard.FocusedElement as FrameworkElement;
        string? focus = requestedFeedbackFocus ?? (focused is Button && cards.IsAncestorOf(focused) ? focused.Tag as string : null);
        requestedFeedbackFocus = null;
        return new CardFeedback(positions, focus, ++feedbackGeneration);
    }

    void AnimateCardFeedback(CardFeedback before)
    {
        Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(() => {
            if (before.Generation != feedbackGeneration || exiting) return;
            cards.UpdateLayout();
            foreach (var card in cards.Children.OfType<Border>())
            {
                if (card.Tag is not string id) continue;
                if (before.Focus != null)
                {
                    var button = VisualButtons(card).FirstOrDefault(b => b.Tag as string == before.Focus);
                    if (button != null && button.IsVisible && button.IsEnabled) button.Focus();
                }
                if (!before.Positions.TryGetValue(id, out double oldY) || !card.IsVisible || FeedbackMode == "off") continue;
                double dy = oldY - card.TranslatePoint(new Point(), cards).Y;
                if (Math.Abs(dy) < 1) continue;
                if (FeedbackMode == "reduced")
                    card.BeginAnimation(OpacityProperty, new DoubleAnimation(card.Opacity * .65, card.Opacity, TimeSpan.FromMilliseconds(120)) { FillBehavior = FillBehavior.Stop });
                else
                {
                    var transform = new TranslateTransform(); card.RenderTransform = transform;
                    var animation = new DoubleAnimation(dy, 0, TimeSpan.FromMilliseconds(180)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }, FillBehavior = FillBehavior.Stop };
                    animation.Completed += (_, _) => { transform.BeginAnimation(TranslateTransform.YProperty, null); card.RenderTransform = Transform.Identity; };
                    transform.BeginAnimation(TranslateTransform.YProperty, animation);
                }
            }
        }));
    }

    static IEnumerable<Button> VisualButtons(DependencyObject parent)
    {
        for (int i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is Button button) yield return button;
            foreach (var descendant in VisualButtons(child)) yield return descendant;
        }
    }

    Button EventFeedbackButton(string label, CalendarEvent entry, string action, object patch)
    {
        var button = Button(label, () => { }); button.Tag = action + ":" + entry.Id;
        button.IsEnabled = !pendingEventFeedback.Contains(entry.Id);
        button.Click += async (_, _) => {
            if (!pendingEventFeedback.Add(entry.Id)) return;
            if (button.IsKeyboardFocusWithin) requestedFeedbackFocus = button.Tag as string;
            button.IsEnabled = false;
            try { await Mutate("/api/events/" + entry.Id, patch, true); }
            finally {
                pendingEventFeedback.Remove(entry.Id); button.IsEnabled = true;
                foreach (var current in VisualButtons(cards))
                    if (current.Tag is string key && key.EndsWith(":" + entry.Id, StringComparison.Ordinal)) current.IsEnabled = true;
                if (requestedFeedbackFocus == button.Tag as string) { requestedFeedbackFocus = null; if (button.IsVisible) button.Focus(); }
            }
        };
        return button;
    }

    void AnimateSyncFeedback(JsonElement statuses)
    {
        string signature = string.Join("|", games.Where(g => InScope(g.Id) && statuses.TryGetProperty(g.Id, out _)).Select(g => {
            var status = statuses.GetProperty(g.Id);
            string stage = status.TryGetProperty("stage", out var s) && s.ValueKind == JsonValueKind.Object && s.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
            bool waiting = status.TryGetProperty("waiting", out var w) && w.ValueKind == JsonValueKind.Object;
            string running = status.TryGetProperty("running", out var r) ? r.ToString() : "";
            string error = status.TryGetProperty("error", out var e) ? e.ToString() : "";
            return g.Id + ":" + running + ":" + stage + ":" + waiting + ":" + error;
        }));
        if (syncFeedbackSignature != "" && signature != syncFeedbackSignature && FeedbackMode != "off" && syncProgress.IsVisible)
            syncProgress.BeginAnimation(OpacityProperty, new DoubleAnimation(.55, 1, TimeSpan.FromMilliseconds(FeedbackMode == "reduced" ? 120 : 180)) { FillBehavior = FillBehavior.Stop });
        syncFeedbackSignature = signature;
    }

    async Task<bool> MotionSmokeTest()
    {
        string original = feedbackSetting;
        foreach (string value in new[] { "standard", "reduced", "off", "auto" })
        {
            await Mutate("/api/settings", new { ui_motion = value });
            if (feedbackSetting != value || motionSelect.SelectedValue as string != value) throw new Exception("Motion preference did not round trip: " + value);
        }
        await Mutate("/api/settings", new { ui_motion = original });
        return true;
    }
}
