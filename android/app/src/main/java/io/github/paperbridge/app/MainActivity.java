package io.github.paperbridge.app;

import android.annotation.SuppressLint;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public class MainActivity extends AppCompatActivity {
    private static final String APP_ORIGIN = "https://appassets.androidplatform.net";
    private static final String APP_START_URL = APP_ORIGIN + "/index.html";

    private WebView webView;
    private LocalProxyServer proxyServer;
    private ValueCallback<Uri[]> pendingFileChooser;
    private final List<PendingPdf> pendingPdfs = new ArrayList<>();
    private volatile boolean pageReady = false;
    private long lastBackPressMs = 0L;

    private static final class PendingPdf {
        final String name;
        final String base64;

        PendingPdf(String name, String base64) {
            this.name = name;
            this.base64 = base64;
        }
    }

    private final ActivityResultLauncher<Intent> filePickerLauncher =
        registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            ValueCallback<Uri[]> cb = pendingFileChooser;
            pendingFileChooser = null;
            if (cb == null) return;
            if (result.getResultCode() != RESULT_OK || result.getData() == null) {
                cb.onReceiveValue(null);
                return;
            }
            Intent data = result.getData();
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                Uri[] uris = new Uri[count];
                for (int i = 0; i < count; i++) {
                    uris[i] = data.getClipData().getItemAt(i).getUri();
                }
                cb.onReceiveValue(uris);
            } else if (data.getData() != null) {
                cb.onReceiveValue(new Uri[]{data.getData()});
            } else {
                cb.onReceiveValue(null);
            }
        });

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        proxyServer = new LocalProxyServer();
        try {
            proxyServer.start();
        } catch (IOException ignored) {
        }

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
            .addPathHandler("/", new StrictMimeAssetsHandler())
            .build();

        webView.addJavascriptInterface(new NativeBridge(), "PaperBridgeAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Nullable
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith(APP_ORIGIN)) return false;
                if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:")) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception ignored) {
                    }
                    return true;
                }
                return false;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                WebView webView,
                ValueCallback<Uri[]> filePathCallback,
                FileChooserParams fileChooserParams
            ) {
                if (pendingFileChooser != null) {
                    pendingFileChooser.onReceiveValue(null);
                }
                pendingFileChooser = filePathCallback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    filePickerLauncher.launch(Intent.createChooser(intent, "选择文献或备份文件"));
                    return true;
                } catch (Exception e) {
                    pendingFileChooser = null;
                    return false;
                }
            }
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(function(){if(window.__pbAndroidBack&&window.__pbAndroidBack())return 'handled';return 'exit';})()",
                    value -> {
                        if ("\"handled\"".equals(value)) return;
                        long now = System.currentTimeMillis();
                        if (now - lastBackPressMs < 1800) {
                            finish();
                        } else {
                            lastBackPressMs = now;
                            Toast.makeText(MainActivity.this, "再按一次返回退出 PaperBridge", Toast.LENGTH_SHORT).show();
                        }
                    }
                );
            }
        });

        handleIncomingIntent(getIntent());
        webView.loadUrl(APP_START_URL);
    }

    @Override
    protected void onNewIntent(@NonNull Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
    }

    @Override
    protected void onDestroy() {
        if (proxyServer != null) proxyServer.stop();
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private void handleIncomingIntent(@Nullable Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (uri == null) return;

        final Uri targetUri = uri;
        new Thread(() -> {
            try {
                String name = resolveFileName(targetUri);
                byte[] bytes = readUriBytes(targetUri);
                if (bytes == null || bytes.length == 0) return;
                String b64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                synchronized (pendingPdfs) {
                    pendingPdfs.add(new PendingPdf(name, b64));
                }
                flushPendingPdfs();
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this, "读取 PDF 失败：" + e.getMessage(), Toast.LENGTH_SHORT).show());
            }
        }).start();
    }

    private void flushPendingPdfs() {
        if (!pageReady || webView == null) return;
        final List<PendingPdf> batch;
        synchronized (pendingPdfs) {
            if (pendingPdfs.isEmpty()) return;
            batch = new ArrayList<>(pendingPdfs);
            pendingPdfs.clear();
        }
        runOnUiThread(() -> {
            if (webView == null) return;
            for (PendingPdf pdf : batch) {
                String js = "window.__pbAndroidOpenFile && window.__pbAndroidOpenFile("
                    + JSONObject.quote(pdf.name) + "," + JSONObject.quote(pdf.base64) + ");";
                webView.evaluateJavascript(js, null);
            }
        });
    }

    private String resolveFileName(Uri uri) {
        ContentResolver cr = getContentResolver();
        try (Cursor c = cr.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String name = c.getString(0);
                if (name != null && !name.trim().isEmpty()) return name.trim();
            }
        } catch (Exception ignored) {
        }
        String last = uri.getLastPathSegment();
        if (last != null && !last.trim().isEmpty()) {
            return last.endsWith(".pdf") ? last : last + ".pdf";
        }
        return "document.pdf";
    }

    private byte[] readUriBytes(Uri uri) throws IOException {
        try (InputStream is = getContentResolver().openInputStream(uri)) {
            if (is == null) return null;
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) != -1) baos.write(buf, 0, n);
            return baos.toByteArray();
        }
    }

    /** Serves dist/ from assets/www/ with strict MIME types for ES module workers (.mjs) and WebAssembly (.wasm). */
    private final class StrictMimeAssetsHandler implements WebViewAssetLoader.PathHandler {
        private final Map<String, String> mimeMap = new HashMap<>();

        StrictMimeAssetsHandler() {
            mimeMap.put(".html", "text/html");
            mimeMap.put(".js", "text/javascript");
            mimeMap.put(".mjs", "text/javascript");
            mimeMap.put(".css", "text/css");
            mimeMap.put(".json", "application/json");
            mimeMap.put(".webmanifest", "application/manifest+json");
            mimeMap.put(".wasm", "application/wasm");
            mimeMap.put(".svg", "image/svg+xml");
            mimeMap.put(".png", "image/png");
            mimeMap.put(".jpg", "image/jpeg");
            mimeMap.put(".jpeg", "image/jpeg");
            mimeMap.put(".webp", "image/webp");
            mimeMap.put(".ico", "image/x-icon");
            mimeMap.put(".ttf", "font/ttf");
            mimeMap.put(".otf", "font/otf");
            mimeMap.put(".woff", "font/woff");
            mimeMap.put(".woff2", "font/woff2");
            mimeMap.put(".bcmap", "application/octet-stream");
            mimeMap.put(".pfb", "application/octet-stream");
        }

        @Nullable
        @Override
        public WebResourceResponse handle(@NonNull String path) {
            String rel = path.isEmpty() || "/".equals(path) ? "index.html" : path;
            while (rel.startsWith("/")) rel = rel.substring(1);
            if (rel.contains("..")) return null;
            String assetPath = "www/" + rel;
            try {
                InputStream stream = getAssets().open(assetPath);
                String mime = guessMime(rel);
                String encoding = (mime.startsWith("text/") || mime.contains("json") || mime.contains("svg")) ? "utf-8" : null;
                return new WebResourceResponse(mime, encoding, stream);
            } catch (IOException e) {
                return null;
            }
        }

        private String guessMime(String name) {
            int dot = name.lastIndexOf('.');
            if (dot >= 0) {
                String ext = name.substring(dot).toLowerCase(Locale.US);
                String hit = mimeMap.get(ext);
                if (hit != null) return hit;
            }
            return "application/octet-stream";
        }
    }

    private final class NativeBridge {
        @JavascriptInterface
        public String getProxyUrl() {
            return proxyServer != null ? proxyServer.getBaseUrl() : "";
        }

        @JavascriptInterface
        public String getProxyToken() {
            return proxyServer != null ? proxyServer.getToken() : "";
        }

        @JavascriptInterface
        public String getVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "0.9.0";
            }
        }

        @JavascriptInterface
        public void markReady() {
            pageReady = true;
            flushPendingPdfs();
        }

        @JavascriptInterface
        public boolean saveFile(String filename, String base64Data, String mimeType) {
            String safeName = (filename == null || filename.trim().isEmpty())
                ? "paperbridge-export.bin"
                : filename.replaceAll("[\\\\/:*?\"<>|]+", "_");
            String mime = (mimeType == null || mimeType.isEmpty()) ? "application/octet-stream" : mimeType;
            try {
                byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                    values.put(MediaStore.Downloads.MIME_TYPE, mime);
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/PaperBridge");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) return false;
                    try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                        if (os == null) return false;
                        os.write(bytes);
                        os.flush();
                    }
                } else {
                    File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "PaperBridge");
                    if (!dir.exists()) dir.mkdirs();
                    File outFile = new File(dir, safeName);
                    try (FileOutputStream fos = new FileOutputStream(outFile)) {
                        fos.write(bytes);
                        fos.flush();
                    }
                }
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "已保存到「下载/PaperBridge」：" + safeName, Toast.LENGTH_LONG).show());
                return true;
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "保存失败：" + e.getMessage(), Toast.LENGTH_LONG).show());
                return false;
            }
        }
    }
}
