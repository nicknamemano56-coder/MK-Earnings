package com.mk.earningsdemo;

import android.app.Activity;
import android.os.Bundle;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

public class MainActivity extends Activity {

    private WebView web;

    @Override
    public void onCreate(Bundle b) {
        super.onCreate(b);

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();

        // JavaScript
        s.setJavaScriptEnabled(true);

        // LocalStorage / DOM Storage
        s.setDomStorageEnabled(true);

        // Database
        s.setDatabaseEnabled(true);

        // File access
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);

        // Mixed content
        s.setMixedContentMode(
                WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        );

        /*
         * Handle links clicked inside WebView.
         *
         * Normal web pages can stay inside WebView.
         * UPI / Telegram / Android intent links
         * are sent to Android so the corresponding
         * external app can open.
         */
        web.setWebViewClient(new WebViewClient() {

            @Override
            public boolean shouldOverrideUrlLoading(
                    WebView view,
                    WebResourceRequest request
            ) {
                return handleExternalUrl(
                        request.getUrl().toString()
                );
            }

            @Override
            public boolean shouldOverrideUrlLoading(
                    WebView view,
                    String url
            ) {
                return handleExternalUrl(url);
            }
        });

        // Load User App
        web.loadUrl("file:///android_asset/user.html");
    }


    /*
     * Decide whether URL should remain in WebView
     * or be opened by Android.
     */
    private boolean handleExternalUrl(String url) {

        if (url == null || url.isEmpty()) {
            return false;
        }

        Uri uri = Uri.parse(url);

        String scheme = uri.getScheme();

        if (scheme == null) {
            return false;
        }


        /*
         * Normal HTTP website.
         *
         * Keep it inside the WebView.
         */
        if (scheme.equalsIgnoreCase("http")) {
            return false;
        }


        /*
         * Telegram HTTPS links.
         *
         * Example:
         * https://t.me/ManoMano56?text=...
         *
         * Send outside WebView.
         */
        if (scheme.equalsIgnoreCase("https")
                && (
                url.startsWith("https://t.me/")
                || url.startsWith("https://telegram.me/")
        )) {

            openExternalUrl(url);

            return true;
        }


        /*
         * Other HTTPS pages.
         *
         * Keep inside WebView.
         */
        if (scheme.equalsIgnoreCase("https")) {
            return false;
        }


        /*
         * UPI payment links.
         *
         * Example:
         * upi://pay?pa=...
         */
        if (scheme.equalsIgnoreCase("upi")) {

            openExternalUrl(url);

            return true;
        }


        /*
         * Telegram deep links.
         *
         * Example:
         * tg://resolve?domain=...
         */
        if (scheme.equalsIgnoreCase("tg")) {

            openExternalUrl(url);

            return true;
        }


        /*
         * Android intent:// links.
         *
         * These need Intent.parseUri().
         */
        if (scheme.equalsIgnoreCase("intent")) {

            try {

                Intent intent = Intent.parseUri(
                        url,
                        Intent.URI_INTENT_SCHEME
                );

                intent.addFlags(
                        Intent.FLAG_ACTIVITY_NEW_TASK
                );

                startActivity(intent);

                return true;

            } catch (ActivityNotFoundException e) {

                Toast.makeText(
                        MainActivity.this,
                        "No supported app found",
                        Toast.LENGTH_SHORT
                ).show();

                return true;

            } catch (Exception e) {

                Toast.makeText(
                        MainActivity.this,
                        "Unable to open link",
                        Toast.LENGTH_SHORT
                ).show();

                return true;
            }
        }


        /*
         * Any other external scheme.
         */
        openExternalUrl(url);

        return true;
    }


    /*
     * Open external Android application.
     */
    private void openExternalUrl(String url) {

        try {

            Intent intent = new Intent(
                    Intent.ACTION_VIEW,
                    Uri.parse(url)
            );

            intent.addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK
            );

            startActivity(intent);

        } catch (ActivityNotFoundException e) {

            Toast.makeText(
                    MainActivity.this,
                    "Required app is not installed",
                    Toast.LENGTH_SHORT
            ).show();

        } catch (Exception e) {

            Toast.makeText(
                    MainActivity.this,
                    "Unable to open link",
                    Toast.LENGTH_SHORT
            ).show();
        }
    }


    /*
     * Android back button.
     */
    @Override
    public void onBackPressed() {

        if (web != null && web.canGoBack()) {

            web.goBack();

        } else {

            super.onBackPressed();
        }
    }
}
