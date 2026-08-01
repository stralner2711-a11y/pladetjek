package dk.pladetjek.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.net.ConnectivityManager;
import android.net.DhcpInfo;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiNetworkSpecifier;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Base64;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.annotation.RequiresApi;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.rtsp.RtspMediaSource;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(
    name = "DashcamStream",
    permissions = {
        @Permission(
            alias = DashcamStreamPlugin.NEARBY_WIFI_PERMISSION,
            strings = { Manifest.permission.NEARBY_WIFI_DEVICES }
        ),
        @Permission(
            alias = DashcamStreamPlugin.LOCATION_PERMISSION,
            strings = { Manifest.permission.ACCESS_FINE_LOCATION }
        ),
        @Permission(
            alias = DashcamStreamPlugin.NOTIFICATION_PERMISSION,
            strings = { Manifest.permission.POST_NOTIFICATIONS }
        )
    }
)
public class DashcamStreamPlugin extends Plugin {
    static final String NEARBY_WIFI_PERMISSION = "nearbyWifi";
    static final String LOCATION_PERMISSION = "wifiLocation";
    static final String NOTIFICATION_PERMISSION = "notifications";

    private static final String NOTIFICATION_CHANNEL_ID = "dashcam_events";
    private static final int MAX_JPEG_BYTES = 8_000_000;
    private static final long FRAME_INTERVAL_MS = 650;
    private static final int PREVIEW_WIDTH = 720;
    private static final int PLAYER_WIDTH = 1280;
    private static final int PLAYER_HEIGHT = 720;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicBoolean processing = new AtomicBoolean(false);
    private final TextRecognizer recognizer =
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);

    private volatile HttpURLConnection activeConnection;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback wifiCallback;
    private Network dashcamNetwork;
    private ExoPlayer player;
    private TextureView playerTexture;
    private FrameLayout playerContainer;
    private Runnable captureRunnable;
    private String username = "";
    private String password = "";
    private String requestedSsid = "";

    @Override
    public void load() {
        connectivityManager = (ConnectivityManager) getContext()
            .getSystemService(Context.CONNECTIVITY_SERVICE);
        createNotificationChannel();
    }

    @PluginMethod
    public void connectWifi(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Automatisk dashcam-Wi-Fi kræver Android 10 eller nyere.");
            return;
        }

        requestedSsid = call.getString("ssid", "").trim();
        if (requestedSsid.isEmpty()) {
            call.reject("Indtast dashcamets Wi-Fi-navn (SSID).");
            return;
        }

        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState(NEARBY_WIFI_PERMISSION) != PermissionState.GRANTED
        ) {
            requestPermissionForAlias(
                NEARBY_WIFI_PERMISSION,
                call,
                "wifiPermissionCallback"
            );
            return;
        }

        if (
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            && getPermissionState(LOCATION_PERMISSION) != PermissionState.GRANTED
        ) {
            requestPermissionForAlias(
                LOCATION_PERMISSION,
                call,
                "wifiPermissionCallback"
            );
            return;
        }

        connectWifiInternal(call);
    }

    @PermissionCallback
    private void wifiPermissionCallback(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Automatisk dashcam-Wi-Fi kræver Android 10 eller nyere.");
            return;
        }

        String alias = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            ? NEARBY_WIFI_PERMISSION
            : LOCATION_PERMISSION;
        if (getPermissionState(alias) != PermissionState.GRANTED) {
            call.reject("Wi-Fi-tilladelsen blev ikke givet.");
            return;
        }
        connectWifiInternal(call);
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private void connectWifiInternal(PluginCall call) {
        String wifiPassword = call.getString("password", "");
        releaseDashcamNetwork();

        try {
            WifiNetworkSpecifier.Builder specifierBuilder =
                new WifiNetworkSpecifier.Builder().setSsid(requestedSsid);
            if (!wifiPassword.isEmpty()) {
                specifierBuilder.setWpa2Passphrase(wifiPassword);
            }

            NetworkRequest request = new NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .setNetworkSpecifier(specifierBuilder.build())
                .build();
            AtomicBoolean callFinished = new AtomicBoolean(false);

            wifiCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(@NonNull Network network) {
                    dashcamNetwork = network;
                    boolean bound = connectivityManager.bindProcessToNetwork(network);
                    emitStatus(
                        "wifi",
                        bound
                            ? "Forbundet til " + requestedSsid
                            : "Dashcam-Wi-Fi fundet, men kunne ikke bindes",
                        ""
                    );
                    if (callFinished.compareAndSet(false, true)) {
                        JSObject result = new JSObject();
                        result.put("connected", bound);
                        result.put("ssid", requestedSsid);
                        call.resolve(result);
                    }
                }

                @Override
                public void onLost(@NonNull Network network) {
                    if (network.equals(dashcamNetwork)) {
                        dashcamNetwork = null;
                        emitStatus(
                            "wifi_lost",
                            "Forbindelsen til " + requestedSsid + " blev afbrudt",
                            ""
                        );
                    }
                }

                @Override
                public void onUnavailable() {
                    if (callFinished.compareAndSet(false, true)) {
                        call.reject(
                            "Dashcamets Wi-Fi blev ikke fundet eller blev afvist."
                        );
                    }
                    emitStatus(
                        "error",
                        "Kunne ikke forbinde til " + requestedSsid,
                        ""
                    );
                }
            };
            connectivityManager.requestNetwork(request, wifiCallback, 30_000);
        } catch (Exception error) {
            releaseDashcamNetwork();
            call.reject(
                "Wi-Fi-forbindelsen kunne ikke startes: " + safeMessage(error),
                error
            );
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        String streamUrl = call.getString("url", "").trim();
        String requestedProtocol = call.getString("protocol", "auto")
            .trim()
            .toLowerCase(Locale.ROOT);
        username = call.getString("username", "");
        password = call.getString("password", "");

        if (!isSupportedUrl(streamUrl)) {
            call.reject("Brug en RTSP-, HTTP- eller HTTPS-adresse til dashcamet.");
            return;
        }

        stopStreamInternal(false);
        setKeepScreenOn(true);
        running.set(true);
        String protocol = resolveProtocol(streamUrl, requestedProtocol);
        emitStatus("connecting", "Forbinder til dashcam…", protocol);

        if ("rtsp".equals(protocol) || "hls".equals(protocol)) {
            startMediaPlayer(streamUrl, protocol);
        } else {
            startHttpReader(streamUrl, protocol);
        }

        JSObject result = new JSObject();
        result.put("started", true);
        result.put("protocol", protocol);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopStreamInternal(true);
        call.resolve();
    }

    @PluginMethod
    public void setWakeLock(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        setKeepScreenOn(enabled);
        JSObject result = new JSObject();
        result.put("enabled", enabled);
        call.resolve(result);
    }

    @PluginMethod
    public void prepareLocalNotifications(PluginCall call) {
        createNotificationChannel();
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState(NOTIFICATION_PERMISSION) != PermissionState.GRANTED
        ) {
            requestPermissionForAlias(
                NOTIFICATION_PERMISSION,
                call,
                "notificationPermissionCallback"
            );
            return;
        }
        resolveNotificationPermission(call);
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        resolveNotificationPermission(call);
    }

    private void resolveNotificationPermission(PluginCall call) {
        boolean granted =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getPermissionState(NOTIFICATION_PERMISSION) == PermissionState.GRANTED;
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    @PluginMethod
    public void notifyEvent(PluginCall call) {
        String plate = PlateFormat.normalize(call.getString("plate", ""));
        if (!PlateFormat.isDanishRegistration(plate)) plate = "";
        String title = call.getString(
            "title",
            "OBS · nummerplade registreret"
        ).trim();
        String body = call.getString(
            "body",
            plate.isEmpty()
                ? "Dashcamet har registreret en hændelse."
                : "Plade " + plate + " er registreret af dashcamet."
        ).trim();

        boolean permissionGranted =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || ContextCompat.checkSelfPermission(
                getContext(),
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED;
        if (!permissionGranted) {
            JSObject result = new JSObject();
            result.put("shown", false);
            result.put("reason", "notification_permission");
            call.resolve(result);
            return;
        }

        try {
            createNotificationChannel();
            Intent intent = new Intent(getContext(), MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pendingIntent = PendingIntent.getActivity(
                getContext(),
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            Notification notification = new NotificationCompat.Builder(
                getContext(),
                NOTIFICATION_CHANNEL_ID
            )
                .setSmallIcon(R.drawable.ic_notification_plate)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setDefaults(Notification.DEFAULT_ALL)
                .setVibrate(new long[] { 0, 220, 100, 220, 100, 350 })
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .build();

            int notificationId = (int) (
                System.currentTimeMillis() & 0x0fffffff
            );
            NotificationManagerCompat.from(getContext())
                .notify(notificationId, notification);
            JSObject result = new JSObject();
            result.put("shown", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Den lokale notifikation kunne ikke vises.", error);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getContext()
            .getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        NotificationChannel channel = new NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "Dashcam-hændelser",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription(
            "Øjeblikkelige offline-advarsler fra dashcam-scanningen"
        );
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[] { 0, 220, 100, 220, 100, 350 });
        channel.enableLights(true);
        manager.createNotificationChannel(channel);
    }

    @PluginMethod
    public void openWifiSettings(PluginCall call) {
        try {
            Intent intent = new Intent(
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? Settings.Panel.ACTION_WIFI
                    : Settings.ACTION_WIFI_SETTINGS
            );
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("Wi-Fi-indstillingerne kunne ikke åbnes.", error);
        }
    }

    @PluginMethod
    public void getNetworkInfo(PluginCall call) {
        JSObject result = new JSObject();
        try {
            WifiManager wifiManager = (WifiManager) getContext()
                .getApplicationContext()
                .getSystemService(Context.WIFI_SERVICE);
            DhcpInfo dhcpInfo = wifiManager == null ? null : wifiManager.getDhcpInfo();
            result.put("gateway", dhcpInfo == null ? "" : ipv4Address(dhcpInfo.gateway));
            result.put("wifiEnabled", wifiManager != null && wifiManager.isWifiEnabled());
            result.put("dashcamConnected", dashcamNetwork != null);
            result.put("ssid", dashcamNetwork == null ? "" : requestedSsid);

            Network active = connectivityManager == null
                ? null
                : connectivityManager.getActiveNetwork();
            NetworkCapabilities capabilities = active == null || connectivityManager == null
                ? null
                : connectivityManager.getNetworkCapabilities(active);
            result.put(
                "hasInternet",
                capabilities != null
                    && capabilities.hasCapability(
                        NetworkCapabilities.NET_CAPABILITY_VALIDATED
                    )
            );
        } catch (Exception ignored) {
            result.put("gateway", "");
            result.put("wifiEnabled", false);
            result.put("dashcamConnected", false);
            result.put("ssid", "");
            result.put("hasInternet", false);
        }
        call.resolve(result);
    }

    private boolean isSupportedUrl(String value) {
        String lower = value.toLowerCase(Locale.ROOT);
        return lower.startsWith("rtsp://")
            || lower.startsWith("http://")
            || lower.startsWith("https://");
    }

    private String resolveProtocol(String streamUrl, String requestedProtocol) {
        if (!"auto".equals(requestedProtocol)) return requestedProtocol;
        String lower = streamUrl.toLowerCase(Locale.ROOT);
        if (lower.startsWith("rtsp://")) return "rtsp";
        if (lower.contains(".m3u8")) return "hls";
        return "mjpeg";
    }

    private Uri authenticatedMediaUri(String streamUrl) {
        Uri parsed = Uri.parse(streamUrl);
        if (username.isEmpty() || parsed.getEncodedUserInfo() != null) {
            return parsed;
        }
        String credentials = Uri.encode(username);
        if (!password.isEmpty()) credentials += ":" + Uri.encode(password);
        return parsed.buildUpon()
            .encodedAuthority(credentials + "@" + parsed.getEncodedAuthority())
            .build();
    }

    @OptIn(markerClass = UnstableApi.class)
    private void startMediaPlayer(String streamUrl, String protocol) {
        mainHandler.post(() -> {
            if (!running.get()) return;
            try {
                FrameLayout root = getActivity().findViewById(android.R.id.content);
                playerContainer = new FrameLayout(getContext());
                playerContainer.setAlpha(0.01f);
                playerContainer.setImportantForAccessibility(
                    View.IMPORTANT_FOR_ACCESSIBILITY_NO
                );
                playerTexture = new TextureView(getContext());
                playerContainer.addView(
                    playerTexture,
                    new FrameLayout.LayoutParams(PLAYER_WIDTH, PLAYER_HEIGHT)
                );
                root.addView(
                    playerContainer,
                    0,
                    new FrameLayout.LayoutParams(PLAYER_WIDTH, PLAYER_HEIGHT)
                );

                DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
                    .setBufferDurationsMs(800, 1_500, 250, 500)
                    .setPrioritizeTimeOverSizeThresholds(true)
                    .build();
                player = new ExoPlayer.Builder(getContext())
                    .setLoadControl(loadControl)
                    .build();
                player.setVolume(0f);
                player.setVideoTextureView(playerTexture);
                player.addListener(new Player.Listener() {
                    @Override
                    public void onPlaybackStateChanged(int state) {
                        if (state == Player.STATE_READY) {
                            emitStatus(
                                "live",
                                "Dashcam-feedet er live · lav forsinkelse",
                                protocol
                            );
                        }
                    }

                    @Override
                    public void onPlayerError(@NonNull PlaybackException error) {
                        emitStatus(
                            "error",
                            "Videostrømmen kunne ikke åbnes: " + safeMessage(error),
                            protocol
                        );
                    }
                });

                MediaItem item = MediaItem.fromUri(authenticatedMediaUri(streamUrl));
                if ("rtsp".equals(protocol)) {
                    player.setMediaSource(
                        new RtspMediaSource.Factory()
                            .setForceUseRtpTcp(true)
                            .setTimeoutMs(4_000)
                            .createMediaSource(item)
                    );
                } else {
                    player.setMediaItem(item);
                }
                player.prepare();
                player.play();
                schedulePlayerCapture(protocol);
            } catch (Exception error) {
                emitStatus(
                    "error",
                    "Dashcam-afspilleren kunne ikke startes: " + safeMessage(error),
                    protocol
                );
            }
        });
    }

    private void schedulePlayerCapture(String protocol) {
        captureRunnable = new Runnable() {
            @Override
            public void run() {
                if (!running.get()) return;
                if (
                    playerTexture != null
                    && playerTexture.isAvailable()
                    && !processing.get()
                ) {
                    try {
                        Bitmap bitmap = playerTexture.getBitmap(
                            PLAYER_WIDTH,
                            PLAYER_HEIGHT
                        );
                        if (bitmap != null) processFrame(bitmap, protocol);
                    } catch (Exception ignored) {
                        // Næste videobillede forsøges automatisk.
                    }
                }
                mainHandler.postDelayed(this, FRAME_INTERVAL_MS);
            }
        };
        mainHandler.postDelayed(captureRunnable, FRAME_INTERVAL_MS);
    }

    private void startHttpReader(String streamUrl, String protocol) {
        networkExecutor.execute(() -> {
            while (running.get()) {
                try {
                    HttpURLConnection connection = (HttpURLConnection) new URL(streamUrl)
                        .openConnection();
                    activeConnection = connection;
                    connection.setConnectTimeout(6_000);
                    connection.setReadTimeout(10_000);
                    connection.setUseCaches(false);
                    connection.setRequestProperty(
                        "Accept",
                        "multipart/x-mixed-replace,image/jpeg,*/*"
                    );
                    if (!username.isEmpty()) {
                        String credentials = username + ":" + password;
                        String encoded = Base64.encodeToString(
                            credentials.getBytes(StandardCharsets.UTF_8),
                            Base64.NO_WRAP
                        );
                        connection.setRequestProperty(
                            "Authorization",
                            "Basic " + encoded
                        );
                    }

                    int status = connection.getResponseCode();
                    if (status < 200 || status >= 300) {
                        throw new IllegalStateException("HTTP " + status);
                    }
                    emitStatus(
                        "live",
                        "Dashcam-feedet er live · lav forsinkelse",
                        protocol
                    );

                    try (InputStream input = connection.getInputStream()) {
                        while (running.get()) {
                            byte[] jpeg = readNextJpeg(input);
                            if (jpeg == null) break;
                            if (processing.get()) continue;
                            Bitmap bitmap = BitmapFactory.decodeByteArray(
                                jpeg,
                                0,
                                jpeg.length
                            );
                            if (bitmap != null) processFrame(bitmap, protocol);
                            if ("snapshot".equals(protocol)) break;
                        }
                    } finally {
                        connection.disconnect();
                        activeConnection = null;
                    }
                    if ("snapshot".equals(protocol)) sleep(FRAME_INTERVAL_MS);
                } catch (Exception error) {
                    if (running.get()) {
                        emitStatus(
                            "reconnecting",
                            "Forbindelsen blev afbrudt · prøver igen",
                            protocol
                        );
                        sleep(900);
                    }
                }
            }
        });
    }

    private byte[] readNextJpeg(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream(160_000);
        int previous = -1;
        boolean started = false;

        while (running.get()) {
            int current = input.read();
            if (current == -1) return null;

            if (!started) {
                if (previous == 0xff && current == 0xd8) {
                    output.write(0xff);
                    output.write(0xd8);
                    started = true;
                }
            } else {
                output.write(current);
                if (output.size() > MAX_JPEG_BYTES) {
                    throw new IllegalStateException("Videobilledet er for stort.");
                }
                if (previous == 0xff && current == 0xd9) {
                    return output.toByteArray();
                }
            }
            previous = current;
        }
        return null;
    }

    private void processFrame(Bitmap source, String protocol) {
        if (!processing.compareAndSet(false, true)) {
            source.recycle();
            return;
        }

        Bitmap preview = null;
        Bitmap scanRegion = null;
        try {
            int previewHeight = Math.max(
                1,
                Math.round((float) source.getHeight() * PREVIEW_WIDTH / source.getWidth())
            );
            preview = Bitmap.createScaledBitmap(
                source,
                PREVIEW_WIDTH,
                previewHeight,
                true
            );

            int cropLeft = Math.round(source.getWidth() * 0.06f);
            int cropTop = Math.round(source.getHeight() * 0.24f);
            int cropWidth = Math.max(1, Math.round(source.getWidth() * 0.88f));
            int cropHeight = Math.max(1, Math.round(source.getHeight() * 0.58f));
            cropWidth = Math.min(cropWidth, source.getWidth() - cropLeft);
            cropHeight = Math.min(cropHeight, source.getHeight() - cropTop);
            scanRegion = Bitmap.createBitmap(
                source,
                cropLeft,
                cropTop,
                cropWidth,
                cropHeight
            );
            source.recycle();

            ByteArrayOutputStream previewBytes = new ByteArrayOutputStream(120_000);
            preview.compress(Bitmap.CompressFormat.JPEG, 72, previewBytes);
            String previewBase64 = Base64.encodeToString(
                previewBytes.toByteArray(),
                Base64.NO_WRAP
            );

            Bitmap recognitionBitmap = scanRegion;
            Bitmap previewBitmap = preview;
            InputImage image = InputImage.fromBitmap(recognitionBitmap, 0);
            recognizer.process(image)
                .addOnSuccessListener(result -> {
                    JSObject payload = recognitionPayload(result, recognitionBitmap);
                    payload.put("imageBase64", previewBase64);
                    payload.put("capturedAt", System.currentTimeMillis());
                    payload.put("protocol", protocol);
                    notifyListeners("dashcamFrame", payload);
                    recognitionBitmap.recycle();
                    previewBitmap.recycle();
                    processing.set(false);
                })
                .addOnFailureListener(error -> {
                    recognitionBitmap.recycle();
                    previewBitmap.recycle();
                    processing.set(false);
                });
        } catch (Exception error) {
            if (!source.isRecycled()) source.recycle();
            if (preview != null && !preview.isRecycled()) preview.recycle();
            if (scanRegion != null && !scanRegion.isRecycled()) scanRegion.recycle();
            processing.set(false);
        }
    }

    private JSObject recognitionPayload(Text result, Bitmap bitmap) {
        JSObject payload = new JSObject();
        payload.put("text", result.getText());
        payload.put("imageWidth", bitmap.getWidth());
        payload.put("imageHeight", bitmap.getHeight());

        JSArray lines = new JSArray();
        for (Text.TextBlock block : result.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                Rect lineBounds = line.getBoundingBox();
                if (lineBounds == null) continue;
                JSObject linePayload = geometryPayload(
                    line.getText(),
                    line.getConfidence(),
                    lineBounds
                );
                linePayload.put("angle", line.getAngle());

                JSArray elements = new JSArray();
                for (Text.Element element : line.getElements()) {
                    Rect elementBounds = element.getBoundingBox();
                    if (elementBounds == null) continue;
                    elements.put(geometryPayload(
                        element.getText(),
                        element.getConfidence(),
                        elementBounds
                    ));
                }
                linePayload.put("elements", elements);
                lines.put(linePayload);
            }
        }
        payload.put("lines", lines);
        return payload;
    }

    private JSObject geometryPayload(String text, float confidence, Rect bounds) {
        JSObject payload = new JSObject();
        payload.put("text", text);
        payload.put("confidence", confidence);
        payload.put("left", bounds.left);
        payload.put("top", bounds.top);
        payload.put("width", bounds.width());
        payload.put("height", bounds.height());
        return payload;
    }

    private void emitStatus(String state, String message, String protocol) {
        JSObject payload = new JSObject();
        payload.put("state", state);
        payload.put("message", message);
        payload.put("protocol", protocol);
        notifyListeners("dashcamStatus", payload, true);
    }

    private String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty()
            ? error.getClass().getSimpleName()
            : message;
    }

    private String ipv4Address(int address) {
        return (address & 0xff) + "."
            + ((address >> 8) & 0xff) + "."
            + ((address >> 16) & 0xff) + "."
            + ((address >> 24) & 0xff);
    }

    private void sleep(long milliseconds) {
        try {
            Thread.sleep(milliseconds);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    private void setKeepScreenOn(boolean enabled) {
        mainHandler.post(() -> {
            if (getActivity() == null) return;
            if (enabled) {
                getActivity().getWindow().addFlags(
                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                );
            } else {
                getActivity().getWindow().clearFlags(
                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                );
            }
        });
    }

    private void releaseDashcamNetwork() {
        if (connectivityManager == null) return;
        try {
            connectivityManager.bindProcessToNetwork(null);
        } catch (Exception ignored) {
            // Forbindelsen er allerede frigivet.
        }
        if (wifiCallback != null) {
            try {
                connectivityManager.unregisterNetworkCallback(wifiCallback);
            } catch (Exception ignored) {
                // Callbacken er allerede afregistreret.
            }
            wifiCallback = null;
        }
        dashcamNetwork = null;
    }

    private void stopStreamInternal(boolean releaseWifi) {
        running.set(false);
        processing.set(false);
        HttpURLConnection connection = activeConnection;
        activeConnection = null;
        if (connection != null) connection.disconnect();

        mainHandler.post(() -> {
            if (captureRunnable != null) {
                mainHandler.removeCallbacks(captureRunnable);
                captureRunnable = null;
            }
            if (player != null) {
                player.stop();
                player.release();
                player = null;
            }
            if (playerContainer != null) {
                ViewGroup parent = (ViewGroup) playerContainer.getParent();
                if (parent != null) parent.removeView(playerContainer);
                playerContainer = null;
            }
            playerTexture = null;
        });
        setKeepScreenOn(false);
        if (releaseWifi) releaseDashcamNetwork();
        emitStatus("stopped", "Dashcam-scanningen er stoppet", "");
    }

    @Override
    protected void handleOnDestroy() {
        stopStreamInternal(true);
        recognizer.close();
        networkExecutor.shutdownNow();
        super.handleOnDestroy();
    }
}
