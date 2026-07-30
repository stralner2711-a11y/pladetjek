package dk.pladetjek.app;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    private static final String OFFICIAL_RELEASE_PREFIX =
        "/stralner2711-a11y/pladetjek/releases/download/";
    private static final long MAX_APK_BYTES = 100L * 1024L * 1024L;

    @PluginMethod
    public void getCurrentVersion(PluginCall call) {
        try {
            PackageInfo info = getPackageInfo(getContext().getPackageName());
            JSObject result = new JSObject();
            result.put("versionName", info.versionName == null ? "" : info.versionName);
            result.put("versionCode", getVersionCode(info));
            call.resolve(result);
        } catch (Exception exception) {
            call.reject("Kunne ikke læse appversionen.", exception);
        }
    }

    @PluginMethod
    public void install(PluginCall call) {
        String apkUrl = call.getString("url", "");
        String expectedSha256 = call.getString("sha256", "").toLowerCase(Locale.ROOT);
        if (!isAllowedApkUrl(apkUrl)) {
            call.reject("Downloadlinket er ikke godkendt.");
            return;
        }
        if (!expectedSha256.matches("^[a-f0-9]{64}$")) {
            call.reject("Opdateringens kontrolsum er ugyldig.");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !getContext().getPackageManager().canRequestPackageInstalls()) {
            openUnknownAppsSettings();
            JSObject result = new JSObject();
            result.put("needsPermission", true);
            result.put("message", "Tillad installation fra Pladetjek, gå tilbage og tryk Opdater igen.");
            call.resolve(result);
            return;
        }

        getBridge().execute(() -> {
            try {
                File apkFile = downloadAndVerify(apkUrl, expectedSha256);
                verifyApkIdentity(apkFile);
                openInstaller(apkFile);
                JSObject result = new JSObject();
                result.put("started", true);
                call.resolve(result);
            } catch (Exception exception) {
                call.reject("Kunne ikke installere opdateringen: " + exception.getMessage(), exception);
            }
        });
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        openUnknownAppsSettings();
        call.resolve();
    }

    private boolean isAllowedApkUrl(String value) {
        if (value == null || value.trim().isEmpty()) return false;
        try {
            Uri uri = Uri.parse(value);
            String host = uri.getHost();
            String path = uri.getPath();
            return "https".equalsIgnoreCase(uri.getScheme())
                && "github.com".equalsIgnoreCase(host)
                && path != null
                && path.toLowerCase(Locale.ROOT).startsWith(OFFICIAL_RELEASE_PREFIX)
                && path.toLowerCase(Locale.ROOT).endsWith(".apk");
        } catch (Exception ignored) {
            return false;
        }
    }

    private File downloadAndVerify(String apkUrl, String expectedSha256) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(apkUrl).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(60_000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
        connection.connect();

        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            connection.disconnect();
            throw new IllegalStateException("Downloadserveren svarede " + status);
        }
        URL finalUrl = connection.getURL();
        String finalHost = finalUrl.getHost().toLowerCase(Locale.ROOT);
        if (!"https".equalsIgnoreCase(finalUrl.getProtocol())
            || !(finalHost.equals("github.com") || finalHost.endsWith(".githubusercontent.com"))) {
            connection.disconnect();
            throw new IllegalStateException("Downloaden blev viderestillet til en ukendt server.");
        }

        long announcedSize = connection.getContentLengthLong();
        if (announcedSize > MAX_APK_BYTES) {
            connection.disconnect();
            throw new IllegalStateException("APK-filen er større end den tilladte grænse.");
        }

        File directory = new File(getContext().getCacheDir(), "updates");
        if (!directory.exists() && !directory.mkdirs()) {
            connection.disconnect();
            throw new IllegalStateException("Kunne ikke oprette update-mappen.");
        }

        File apkFile = new File(directory, "pladetjek-update.apk");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long total = 0;
        try (InputStream input = connection.getInputStream();
             FileOutputStream output = new FileOutputStream(apkFile, false)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_APK_BYTES) {
                    throw new IllegalStateException("APK-filen er større end den tilladte grænse.");
                }
                output.write(buffer, 0, read);
                digest.update(buffer, 0, read);
            }
        } finally {
            connection.disconnect();
        }

        String actualSha256 = toHex(digest.digest());
        if (!actualSha256.equalsIgnoreCase(expectedSha256)) {
            apkFile.delete();
            throw new IllegalStateException("APK-filens SHA-256 stemmer ikke.");
        }
        return apkFile;
    }

    private void verifyApkIdentity(File apkFile) throws Exception {
        PackageManager manager = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
        PackageInfo downloaded = manager.getPackageArchiveInfo(apkFile.getAbsolutePath(), flags);
        if (downloaded == null || !getContext().getPackageName().equals(downloaded.packageName)) {
            throw new IllegalStateException("APK-filen tilhører ikke Pladetjek.");
        }

        PackageInfo current = getPackageInfo(getContext().getPackageName());
        if (getVersionCode(downloaded) <= getVersionCode(current)) {
            throw new IllegalStateException("Opdateringen har ikke et højere versionsnummer.");
        }
        if (!hasMatchingSignature(current, downloaded)) {
            throw new IllegalStateException("APK-filen er ikke signeret med Pladetjeks nøgle.");
        }
    }

    private PackageInfo getPackageInfo(String packageName) throws PackageManager.NameNotFoundException {
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
        return getContext().getPackageManager().getPackageInfo(packageName, flags);
    }

    private long getVersionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? info.getLongVersionCode()
            : info.versionCode;
    }

    private Signature[] signatures(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
            return info.signingInfo.hasMultipleSigners()
                ? info.signingInfo.getApkContentsSigners()
                : info.signingInfo.getSigningCertificateHistory();
        }
        return info.signatures == null ? new Signature[0] : info.signatures;
    }

    private boolean hasMatchingSignature(PackageInfo current, PackageInfo downloaded) {
        Signature[] currentSignatures = signatures(current);
        Signature[] downloadedSignatures = signatures(downloaded);
        for (Signature currentSignature : currentSignatures) {
            for (Signature downloadedSignature : downloadedSignatures) {
                if (currentSignature.equals(downloadedSignature)) return true;
            }
        }
        return false;
    }

    private void openInstaller(File apkFile) {
        Uri apkUri = FileProvider.getUriForFile(
            getContext(),
            getContext().getPackageName() + ".fileprovider",
            apkFile
        );
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getContext().startActivity(intent);
    }

    private void openUnknownAppsSettings() {
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        } else {
            intent = new Intent(Settings.ACTION_SECURITY_SETTINGS);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
    }

    private String toHex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value));
        return result.toString();
    }
}
