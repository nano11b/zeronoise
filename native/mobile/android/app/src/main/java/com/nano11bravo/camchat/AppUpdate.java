package com.nano11bravo.camchat;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * Asks the site for the latest APK, checks sha256, then hands the file to the system installer.
 * Sideloaded apps cannot install silently. The user confirms on Android's install screen.
 */
public final class AppUpdate {
    private static final long INTERVAL_MS = 6 * 60 * 60 * 1000L;
    private static final String PREFS = "zeronoise_update";
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean checking;
    private File pending;

    void onResume(Activity activity) {
        if (pending != null && canInstall(activity)) {
            handToInstaller(activity, pending);
            return;
        }
        SharedPreferences prefs = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
        long last = prefs.getLong("checkedAt", 0L);
        if (checking || System.currentTimeMillis() - last < INTERVAL_MS) return;
        checking = true;
        String site = siteUrl(activity);
        new Thread(() -> {
            try {
                check(activity, site);
            } catch (Exception ignored) {
                /* the app still opens the live site */
            } finally {
                checking = false;
                prefs.edit().putLong("checkedAt", System.currentTimeMillis()).apply();
            }
        }, "zeronoise-update").start();
    }

    private void check(Activity activity, String site) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(site + "/api/updates").openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(20000);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("Cache-Control", "no-cache");
        conn.setRequestProperty("Accept", "application/json");
        if (conn.getResponseCode() != 200) { conn.disconnect(); return; }
        String text = readAll(conn.getInputStream());
        conn.disconnect();
        JSONObject root = new JSONObject(text);
        if (root.isNull("android")) return;
        JSONObject rel = root.getJSONObject("android");
        String latest = rel.optString("version", "");
        String url = rel.optString("url", "");
        String sha = rel.optString("sha256", "");
        String notes = rel.optString("notes", "");
        String min = rel.optString("minVersion", "");
        long size = rel.optLong("size", 0L);
        if (latest.isEmpty() || url.isEmpty() || sha.isEmpty()) return;
        if (!sameHost(site, url)) return;
        String current = currentVersion(activity);
        String decision = decide(current, latest, min);
        if ("current".equals(decision)) return;
        main.post(() -> showOffer(activity, decision, latest, notes, url, sha, size));
    }

    private void showOffer(Activity activity, String decision, String latest, String notes, String url, String sha, long size) {
        if (activity.isFinishing()) return;
        AlertDialog.Builder box = new AlertDialog.Builder(activity)
            .setTitle("Update available")
            .setMessage("manual".equals(decision)
                ? "This copy of zeronoise is too old to update in place. Uninstall it, then install " + latest + " from the download page."
                : "Version " + latest + " is ready. " + (notes.isEmpty() ? "You'll confirm the install on the next screen." : notes));
        if ("manual".equals(decision)) {
            box.setPositiveButton("OK", null);
        } else {
            box.setPositiveButton("Update", (d, w) -> download(activity, latest, url, sha, size));
            box.setNegativeButton("Later", null);
        }
        box.show();
    }

    private void download(Activity activity, String version, String url, String sha, long size) {
        ProgressDialog progress = new ProgressDialog(activity);
        progress.setMessage("Downloading zeronoise " + version + "…");
        progress.setCancelable(false);
        progress.show();
        new Thread(() -> {
            File dest = new File(new File(activity.getCacheDir(), "updates"), "zeronoise-" + version + ".apk");
            String error = null;
            try {
                if (!dest.getParentFile().exists() && !dest.getParentFile().mkdirs()) throw new IllegalStateException("cache");
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(120000);
                conn.setInstanceFollowRedirects(true);
                if (conn.getResponseCode() != 200) throw new IllegalStateException("download");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long got = 0;
                try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(dest)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) >= 0) {
                        out.write(buf, 0, n);
                        digest.update(buf, 0, n);
                        got += n;
                    }
                } finally { conn.disconnect(); }
                String hash = hex(digest.digest());
                if (!hash.equalsIgnoreCase(sha) || (size > 0 && got != size)) {
                    dest.delete();
                    throw new IllegalStateException("checksum");
                }
            } catch (Exception e) {
                error = "checksum".equals(e.getMessage())
                    ? "The download did not match the published checksum. It was not opened."
                    : "The update could not be downloaded.";
            }
            String fail = error;
            main.post(() -> {
                if (progress.isShowing()) progress.dismiss();
                if (activity.isFinishing()) return;
                if (fail != null) {
                    new AlertDialog.Builder(activity).setMessage(fail).setPositiveButton("OK", null).show();
                    return;
                }
                pending = dest;
                if (!canInstall(activity)) {
                    new AlertDialog.Builder(activity)
                        .setTitle("Allow installs")
                        .setMessage("Android needs permission to install zeronoise. Turn on “Allow from this source”, then come back.")
                        .setPositiveButton("Open settings", (d, w) -> {
                            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName()));
                            activity.startActivity(intent);
                        })
                        .setNegativeButton("Later", null)
                        .show();
                    return;
                }
                handToInstaller(activity, dest);
            });
        }, "zeronoise-apk").start();
    }

    private void handToInstaller(Activity activity, File apk) {
        pending = null;
        Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(intent);
    }

    private static boolean canInstall(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        return activity.getPackageManager().canRequestPackageInstalls();
    }

    static String decide(String current, String latest, String minVersion) {
        if (latest == null || latest.isEmpty() || compareVersions(current, latest) >= 0) return "current";
        if (minVersion != null && !minVersion.isEmpty() && compareVersions(current, minVersion) < 0) return "manual";
        return "install";
    }

    static int compareVersions(String a, String b) {
        int[] pa = parts(a);
        int[] pb = parts(b);
        int n = Math.max(pa.length, pb.length);
        for (int i = 0; i < n; i++) {
            int da = i < pa.length ? pa[i] : 0;
            int db = i < pb.length ? pb[i] : 0;
            if (da != db) return da < db ? -1 : 1;
        }
        return 0;
    }

    private static int[] parts(String v) {
        List<Integer> nums = new ArrayList<>();
        if (v != null) {
            for (String bit : v.split("[^0-9]+")) {
                if (!bit.isEmpty()) nums.add(Integer.parseInt(bit));
            }
        }
        int[] out = new int[nums.size()];
        for (int i = 0; i < nums.size(); i++) out[i] = nums.get(i);
        return out;
    }

    private static String currentVersion(Activity activity) {
        try {
            PackageInfo info = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
            return info.versionName == null ? "0" : info.versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    private static String siteUrl(Activity activity) {
        try (InputStream in = activity.getAssets().open("capacitor.config.json")) {
            JSONObject json = new JSONObject(readAll(in));
            JSONObject server = json.optJSONObject("server");
            if (server != null) {
                String url = server.optString("url", "");
                if (url.startsWith("https://")) return url.replaceAll("/+$", "");
            }
        } catch (Exception ignored) { /* fall through */ }
        return "https://chat.nano11bravo.com";
    }

    private static boolean sameHost(String site, String fileUrl) {
        try {
            return new URL(site).getHost().equalsIgnoreCase(new URL(fileUrl).getHost());
        } catch (Exception e) {
            return false;
        }
    }

    private static String readAll(InputStream in) throws Exception {
        byte[] buf = new byte[4096];
        StringBuilder out = new StringBuilder();
        int n;
        while ((n = in.read(buf)) >= 0) out.append(new String(buf, 0, n, "UTF-8"));
        return out.toString();
    }

    private static String hex(byte[] raw) {
        StringBuilder out = new StringBuilder(raw.length * 2);
        for (byte b : raw) out.append(String.format("%02x", b));
        return out.toString();
    }
}
