package io.github.zhenyufu039.playtime;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.AssetManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.security.SecureRandom;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Hosts the existing phone web page, served by the bundled Python backend on loopback. */
public class MainActivity extends Activity {
    private static final String TAG = "Playtime";
    private static final int PICK_FILE = 1;
    // The server and its session live as long as the process; a recreated activity reuses them.
    private static int port;
    private static String session;
    private static final ExecutorService worker = Executors.newSingleThreadExecutor();

    private WebView web;
    private FrameLayout frame;
    private boolean historyCleared;
    private ValueCallback<Uri[]> pendingFiles;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Android 13+ (and predictive back, on by default when targeting 15) no longer calls
        // onBackPressed(); the page must be asked through a registered callback instead.
        if (Build.VERSION.SDK_INT >= 33)
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        // Android 15 draws apps edge to edge (targetSdk 35): the page would sit under the status bar
        // and, with adjustResize no longer applied, under the keyboard. The frame keeps it inside
        // the system bars and above the keyboard; its colour fills the bars (see setBars).
        frame = new FrameLayout(this);
        frame.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(frame);
        if (Build.VERSION.SDK_INT >= 30) {
            frame.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return WindowInsets.CONSUMED;
            });
        }
        // Bar colours follow the app's own theme and preset, which can differ from the phone's.
        web.addJavascriptInterface(new Host(), "PlaytimeHost");
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        // target=_blank links load "here" and are then handed to the browser below.
        settings.setSupportMultipleWindows(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openOutside(request.getUrl());
            }

            // The startup message page is not somewhere Back should return to. Cleared once, on the
            // first load of the app page: this callback also fires for the page's own history
            // entries (pushState), which the app shell needs to keep.
            @Override
            public void onPageFinished(WebView view, String url) {
                if (url != null && url.startsWith("http://127.0.0.1:" + port + "/")) {
                    if (!historyCleared) {
                        view.clearHistory();
                        historyCleared = true;
                    }
                    pushSystemTheme();
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                try {
                    startActivityForResult(params.createIntent(), PICK_FILE);
                } catch (ActivityNotFoundException error) {
                    pendingFiles = null;
                    return false;
                }
                return true;
            }
        });
        web.setDownloadListener((url, agent, disposition, mime, length) ->
                Toast.makeText(this, "安卓测试版暂不支持导出文件", Toast.LENGTH_SHORT).show());
        if (state != null && port != 0) {
            web.restoreState(state);
            if (web.getUrl() == null) show();
            return;
        }
        message("游时正在启动…", "首次打开需要准备本地数据，约需几秒。");
        worker.execute(this::startBackend);
    }

    /** The only object the page can call. The WebView loads nothing but this app's own page
     *  (everything else opens in the browser), and this accepts two colours and nothing else. */
    private final class Host {
        @JavascriptInterface
        public void setBars(String top, String bottom) {
            final int topColor, bottomColor;
            try {
                topColor = parse(top);
                bottomColor = parse(bottom);
            } catch (IllegalArgumentException error) {
                return;
            }
            runOnUiThread(() -> applyBars(topColor, bottomColor));
        }
    }

    private static int parse(String color) {
        if (color == null || !color.matches("#[0-9A-Fa-f]{6}")) throw new IllegalArgumentException();
        return Color.parseColor(color);
    }

    private static boolean light(int color) {
        return (0.299 * Color.red(color) + 0.587 * Color.green(color) + 0.114 * Color.blue(color)) > 150;
    }

    @SuppressWarnings("deprecation")
    private void applyBars(int top, int bottom) {
        // The frame shows through edge to edge; on older systems the bars are coloured directly.
        frame.setBackground(new android.graphics.drawable.GradientDrawable(
                android.graphics.drawable.GradientDrawable.Orientation.TOP_BOTTOM, new int[]{top, top, bottom}));
        getWindow().setStatusBarColor(top);
        boolean lightTop = light(top), lightBottom = light(bottom);
        // Dark navigation icons exist from Android 8 (API 26); before that a light bar would hide
        // the system's light buttons, so the bar stays black there.
        if (Build.VERSION.SDK_INT < 26 && lightBottom) { bottom = Color.BLACK; lightBottom = false; }
        getWindow().setNavigationBarColor(bottom);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) controller.setSystemBarsAppearance(
                    (lightTop ? WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS : 0) | (lightBottom ? WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS : 0),
                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
        } else {
            View decor = getWindow().getDecorView();
            int flags = decor.getSystemUiVisibility();
            flags = lightTop ? flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR : flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= 26)
                flags = lightBottom ? flags | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : flags & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            decor.setSystemUiVisibility(flags);
        }
    }

    /** Anything that is not this app's own page opens in the system browser. */
    private boolean openOutside(Uri uri) {
        if ("http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost()) && uri.getPort() == port) return false;
        if ("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException error) {
                Toast.makeText(this, "没有可打开链接的浏览器", Toast.LENGTH_SHORT).show();
            }
        }
        return true;
    }

    private void startBackend() {
        try {
            File runtime = new File(getFilesDir(), "runtime");
            unpack(runtime);
            File data = new File(getFilesDir(), "data");
            if (!Python.isStarted()) Python.start(new AndroidPlatform(this));
            if (session == null) {
                byte[] bytes = new byte[32];
                new SecureRandom().nextBytes(bytes);
                StringBuilder hex = new StringBuilder();
                for (byte b : bytes) hex.append(String.format("%02x", b));
                session = hex.toString();
            }
            // The same port as last time when it is free, so the page keeps its origin (and what it
            // stores there) across launches.
            android.content.SharedPreferences prefs = getSharedPreferences("playtime", MODE_PRIVATE);
            port = Python.getInstance().getModule("playtime_android")
                    .callAttr("start", runtime.getAbsolutePath(), data.getAbsolutePath(), session, prefs.getInt("port", 0)).toInt();
            prefs.edit().putInt("port", port).apply();
            new Handler(Looper.getMainLooper()).post(this::show);
        } catch (Throwable error) {
            Log.e(TAG, "Backend failed to start", error);
            new Handler(Looper.getMainLooper()).post(() -> message("游时无法启动", String.valueOf(error.getMessage())));
        }
    }

    private void show() {
        String origin = "http://127.0.0.1:" + port;
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setCookie(origin, "playtime_session=" + session + "; Path=/; HttpOnly; SameSite=Strict", ok -> {
            cookies.flush();
            // Asks the page for the app shell; until the page provides it this is the ordinary page.
            web.loadUrl(origin + "/?shell=android");
        });
    }

    /** Retries an interrupted installation; personal data is in a separate directory. */
    private void unpack(File runtime) throws IOException {
        AssetManager assets = getAssets();
        RuntimeBundle.install(new RuntimeBundle.Assets() {
            public String[] list(String path) throws IOException { return assets.list(path); }
            public InputStream open(String path) throws IOException { return assets.open(path); }
        }, runtime);
    }

    private void message(String title, String detail) {
        // Follows the app theme (light / night), like the shell does.
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<meta name=color-scheme content='light dark'><style>body{font-family:sans-serif;padding:32px 20px;"
                + "background:#F4F4EF;color:#222}p{opacity:.75}@media (prefers-color-scheme:dark){body{background:#121311;color:#ECECE6}}</style>"
                + "<body><h2 style='font-weight:500'>" + escape(title) + "</h2><p>" + escape(detail) + "</p></body>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private static String escape(String text) {
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == PICK_FILE && pendingFiles != null) {
            pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            pendingFiles = null;
            return;
        }
        super.onActivityResult(request, result, data);
    }

    /** A system light/dark switch does not recreate the activity (uiMode is handled here), so a
     *  plan being typed survives it; the page is told instead. The WebView's own
     *  prefers-color-scheme stays as it was when the activity was created. */
    @Override
    public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        pushSystemTheme();
    }

    private void pushSystemTheme() {
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        web.evaluateJavascript("document.documentElement.dataset.systemDark='" + (dark ? 1 : 0)
                + "';dispatchEvent(new Event('playtime-system-theme'))", null);
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        web.saveState(state);
    }

    @Override
    public void onBackPressed() {
        // Android 12 and earlier; on 13+ the registered callback handles Back (once).
        if (Build.VERSION.SDK_INT < 33) handleBack();
    }

    /** The app shell answers first (drafts, sheets, detail, tabs); "false" or no shell means the
     *  page has nothing left to close, so fall back to page history, then leave. */
    private void handleBack() {
        web.evaluateJavascript("(function(){var s=window.PlaytimeShell;return !!(s&&s.enabled()&&s.back());})()", handled -> {
            if ("true".equals(handled)) return;
            if (web.canGoBack()) web.goBack();
            else finish();
        });
    }
}
