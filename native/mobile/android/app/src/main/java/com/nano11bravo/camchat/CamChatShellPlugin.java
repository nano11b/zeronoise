package com.nano11bravo.camchat;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Base64;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import org.json.JSONObject;

/**
 * Keeps the live site inside the webview, and sends Google/Discord sign-in to the system browser.
 * The browser comes back through camchat://auth. The verifier that can redeem the session never leaves this app.
 */
@CapacitorPlugin(name = "CamChatShell")
public class CamChatShellPlugin extends Plugin {
    private static final String PREFS = "camchat_shell";
    private static final long MAX_AGE_MS = 10 * 60 * 1000L;
    private String siteUrl;

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        if (url == null) return null;
        if ("camchat".equalsIgnoreCase(url.getScheme())) {
            adopt(url);
            return true;
        }
        if (isOAuth(url)) {
            openOAuth(url);
            return true;
        }
        return null;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (data != null && "camchat".equalsIgnoreCase(data.getScheme())) adopt(data);
    }

    private boolean isOAuth(Uri url) {
        String scheme = url.getScheme();
        if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)) return false;
        String path = url.getPath() == null ? "" : url.getPath().replaceAll("/+$", "");
        if (!"/api/auth/google".equals(path) && !"/api/auth/discord".equals(path)) return false;
        String host = url.getHost();
        return host != null && host.equalsIgnoreCase(siteHost());
    }

    private void openOAuth(Uri url) {
        Activity activity = getActivity();
        if (activity == null) return;
        byte[] buf = new byte[32];
        new SecureRandom().nextBytes(buf);
        String verifier = Base64.encodeToString(buf, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        String challenge;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.UTF_8));
            challenge = Base64.encodeToString(digest, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        } catch (Exception e) {
            return;
        }
        prefs().edit()
            .putString("verifier", verifier)
            .putString("challenge", challenge)
            .putLong("exp", System.currentTimeMillis() + MAX_AGE_MS)
            .apply();
        Uri.Builder b = url.buildUpon().clearQuery();
        for (String name : url.getQueryParameterNames()) {
            if ("client".equals(name) || "nonce".equals(name)) continue;
            for (String value : url.getQueryParameters(name)) b.appendQueryParameter(name, value);
        }
        b.appendQueryParameter("client", "native").appendQueryParameter("nonce", challenge);
        Uri outbound = b.build();
        try {
            new CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, outbound);
        } catch (ActivityNotFoundException ex) {
            try {
                activity.startActivity(new Intent(Intent.ACTION_VIEW, outbound));
            } catch (ActivityNotFoundException ignored) { /* no browser */ }
        }
    }

    private void adopt(Uri url) {
        if (!"auth".equalsIgnoreCase(url.getHost())) return;
        String challenge = url.getQueryParameter("nonce");
        SharedPreferences p = prefs();
        long exp = p.getLong("exp", 0);
        String expect = p.getString("challenge", null);
        String verifier = p.getString("verifier", null);
        if (exp < System.currentTimeMillis()) {
            p.edit().clear().apply();
            return;
        }
        if (challenge == null || verifier == null || !challenge.equals(expect)) return;
        p.edit().clear().apply();
        String error = url.getQueryParameter("error");
        String token = url.getQueryParameter("token");
        String target;
        if (error != null && !error.isEmpty()) {
            target = siteOrigin() + "/?authError=" + Uri.encode(error);
        } else if (token != null && !token.isEmpty()) {
            target = siteOrigin() + "/api/auth/native?token=" + Uri.encode(token) + "&verifier=" + Uri.encode(verifier);
        } else return;
        if (getBridge() == null || getBridge().getWebView() == null) return;
        final String next = target;
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(next));
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
    }

    private String siteOrigin() {
        try {
            Uri u = Uri.parse(siteUrl());
            return u.getScheme() + "://" + u.getHost();
        } catch (Exception e) {
            return "https://chat.nano11bravo.com";
        }
    }

    private String siteHost() {
        try { return Uri.parse(siteUrl()).getHost(); } catch (Exception e) { return "chat.nano11bravo.com"; }
    }

    private String siteUrl() {
        if (siteUrl != null) return siteUrl;
        siteUrl = "https://chat.nano11bravo.com";
        try (InputStream in = getContext().getAssets().open("capacitor.config.json")) {
            String json = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            String url = new JSONObject(json).getJSONObject("server").getString("url");
            if (url != null && url.startsWith("https://")) siteUrl = url.replaceAll("/+$", "");
        } catch (Exception ignored) { /* fall back to the live site */ }
        return siteUrl;
    }
}
