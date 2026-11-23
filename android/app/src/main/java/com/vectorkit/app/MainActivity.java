package com.vectorkit.app;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebResourceRequest;
import android.webkit.WebViewClient;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;

public class MainActivity extends Activity {
    private static final int PICK = 1001;
    private WebView web;
    private ValueCallback<Uri[]> pending;
    private Uri cameraUri;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        web.setWebViewClient(new WebViewClient() {
            // YouTube / Facebook / WhatsApp / GitHub links open in their own app or the browser
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if ("file".equals(u.getScheme())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* no app can open it */ }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (pending != null) pending.onReceiveValue(null);
                pending = cb;
                openChooser(p != null && p.isCaptureEnabled());
                return true;
            }
        });
        web.loadUrl("file:///android_asset/index.html");
    }

    private void openChooser(boolean cameraOnly) {
        ArrayList<Intent> extra = new ArrayList<>();
        try {
            File dir = new File(getCacheDir(), "camera");
            dir.mkdirs();
            File f = new File(dir, "photo_" + System.currentTimeMillis() + ".jpg");
            cameraUri = FileProvider.getUriForFile(this, "com.vectorkit.app.fileprovider", f);
            Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            cam.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
            cam.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (cameraOnly) { startActivityForResult(cam, PICK); return; }
            extra.add(cam);
        } catch (Exception e) { cameraUri = null; }
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType("image/*");
        Intent chooser = Intent.createChooser(pick, "ছবি বাছুন");
        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, extra.toArray(new Intent[0]));
        startActivityForResult(chooser, PICK);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != PICK || pending == null) return;
        Uri[] out = null;
        if (res == RESULT_OK) {
            if (data != null && data.getData() != null) out = new Uri[]{data.getData()};
            else if (cameraUri != null) out = new Uri[]{cameraUri};
        }
        pending.onReceiveValue(out);
        pending = null;
    }

    @Override
    public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }

    class Bridge {
        @JavascriptInterface
        public boolean saveFile(String name, String base64, String mime) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                OutputStream os;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    cv.put(MediaStore.Downloads.MIME_TYPE, name.endsWith(".ai") ? "application/postscript" : mime);
                    cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/TIS Diagram Pro");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) return false;
                    os = getContentResolver().openOutputStream(uri);
                } else {
                    File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "TIS Diagram Pro");
                    dir.mkdirs();
                    os = new FileOutputStream(new File(dir, name));
                }
                os.write(bytes);
                os.close();
                return true;
            } catch (Exception e) {
                return false;
            }
        }
    }
}
