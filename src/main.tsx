import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  Camera, Check, Clock3, Download, ExternalLink, Flag, Flashlight, FlaskConical,
  Focus, Gauge, History, MapPin, Menu, Play, RefreshCw, ScanLine, Search, ShieldCheck,
  Trash2, TriangleAlert, UserRound, UsersRound, X, ZoomIn,
} from "lucide-react";
import { AccountScreen } from "./AccountScreen";
import { AdminUsersScreen } from "./AdminUsersScreen";
import {
  getMyProfile,
  initializeAuthLinks,
  subscribeToAuthChanges,
  type MyProfile,
} from "./account-service";
import {
  DEFAULT_MANIFEST_URL,
  DEFAULT_OFFICIAL_REPO,
  fetchUpdateManifest,
  type UpdateManifest,
  updateIsAvailable,
  updateIsRequired,
} from "./update-system";
import {
  advancePlateEvidence,
  calculateFocusPoint,
  calculateCoverCrop,
  clampCameraZoom,
  estimateImageLuminance,
  findBestPlateCandidate,
  plateCaptureFilter,
  type PlateEvidence,
  type PlateRecognitionResult,
} from "./plate-recognition";
import {
  createSharedAlert,
  matchSharedAlert,
  reportSharedAlert,
  sharedAlertsAreConfigured,
  type SharedVehicleAlert,
} from "./shared-alerts";
import {
  formatNearbyDistance,
  getNearbyMatchCoordinates,
  initializeNearbyNotificationListeners,
  nearbyOnboardingWasHandled,
  refreshNearbyDevice,
  type NearbyCoordinates,
} from "./nearby-alerts";
import { NearbyAlertsOnboarding } from "./NearbyAlertsCard";
import "./styles.css";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type VehicleAlert = SharedVehicleAlert;
type RegistryCheck = {
  plate: string;
  checkedAt: string;
  alert: VehicleAlert | null;
};

type RegistryError = { code: string; message: string };
type ActiveView = "scanner" | "account" | "admin";
type AlertScanResult = {
  plate: string;
  capturedAt: number;
};
type PendingPlateConfirmation = {
  plate: string;
  purpose: "lookup" | "alert";
};

type ExtendedCameraCapabilities = MediaTrackCapabilities & {
  focusMode?: string[];
  pointsOfInterest?: boolean;
  torch?: boolean;
  zoom?: {
    min: number;
    max: number;
    step: number;
  };
};

type ExtendedCameraConstraintSet = MediaTrackConstraintSet & {
  focusMode?: string;
  pointsOfInterest?: Array<{ x: number; y: number }>;
  torch?: boolean;
  zoom?: number;
};

const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const UPDATE_REPOSITORY_URL = String(
  import.meta.env.VITE_UPDATE_REPOSITORY_URL ?? DEFAULT_OFFICIAL_REPO,
).replace(/\/$/, "");
const UPDATE_MANIFEST_URL = String(
  import.meta.env.VITE_UPDATE_MANIFEST_URL ?? DEFAULT_MANIFEST_URL,
);
const DISMISSED_UPDATE_KEY = "pladetjek:dismissed-update";
const HISTORY_KEY = "pladetjek:scan-history:v1";
const TEST_MODE_KEY = "pladetjek:test-mode";
const TEST_PLATE = "TT00000";

function loadPrivateHistory(): RegistryCheck[] {
  try {
    const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as RegistryCheck[];
    if (!Array.isArray(stored)) return [];
    return stored.filter((item) => (
      typeof item?.plate === "string"
      && typeof item?.checkedAt === "string"
      && (item.alert === null || typeof item.alert?.description === "string")
    )).slice(0, 50);
  } catch {
    return [];
  }
}

function localTestAlert(): VehicleAlert {
  const now = new Date().toISOString();
  return {
    id: "local-test-alert",
    plate: TEST_PLATE,
    description: "Lokalt testmatch – ingen data eller notifikation er sendt.",
    createdAt: now,
    expiresAt: now,
    reporterName: "Testtilstand",
    observationCount: 3,
    distinctReporterCount: 2,
    lastSeenAt: now,
  };
}

type NativeUpdater = {
  getCurrentVersion: () => Promise<{ versionName: string; versionCode: number }>;
  install: (options: {
    url: string;
    sha256: string;
  }) => Promise<{ started?: boolean; needsPermission?: boolean; message?: string }>;
};

type NativePlateTextRecognizer = {
  recognize: (options: { imageBase64: string }) => Promise<PlateRecognitionResult>;
};

const AppUpdater = registerPlugin<NativeUpdater>("AppUpdater");
const PlateTextRecognizer = registerPlugin<NativePlateTextRecognizer>("PlateTextRecognizer");

function apiUrl(path: string) {
  return `${API_BASE_URL}${path}`;
}

function normalizePlate(value: string) {
  return value.toUpperCase().replace(/[^A-ZÆØÅ0-9]/g, "").slice(0, 7);
}

function displayPlate(value: string) {
  const p = normalizePlate(value);
  return p.length > 2 ? `${p.slice(0, 2)} ${p.slice(2, 4)} ${p.slice(4)}`.trim() : p;
}

function formatCheckedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("da-DK");
}

function formatRelativeTime(value: string) {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (elapsed < 60_000) return "lige nu";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `for ${minutes} min. siden`;
  const hours = Math.floor(minutes / 60);
  return `for ${hours} ${hours === 1 ? "time" : "timer"} siden`;
}

function getClientId() {
  const key = "pladetjek:alert-client";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const created = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(key, created);
  return created;
}

async function matchVehicleAlert(
  plate: string,
  coordinates?: NearbyCoordinates | null,
): Promise<VehicleAlert | null> {
  if (sharedAlertsAreConfigured()) return matchSharedAlert(plate, coordinates);

  const response = await fetch(
    apiUrl(`/api/alerts/match/${encodeURIComponent(normalizePlate(plate))}`),
    { headers: { Accept: "application/json" } },
  );
  const payload = await response.json().catch(() => ({})) as {
    data?: VehicleAlert | null;
  };
  if (!response.ok) throw new Error("Advarselsmatch kunne ikke kontrolleres.");
  return payload.data ?? null;
}

async function createVehicleAlert(
  plate: string,
  description: string,
): Promise<{ alert: VehicleAlert; duplicate: boolean }> {
  if (sharedAlertsAreConfigured()) return createSharedAlert(plate, description);

  const response = await fetch(apiUrl("/api/alerts"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      plate: normalizePlate(plate),
      description,
      clientId: getClientId(),
      confirmed: true,
    }),
  });
  const payload = await response.json().catch(() => ({})) as {
    data?: VehicleAlert;
    duplicate?: boolean;
    message?: string;
  };
  if (!response.ok || !payload.data) {
    throw new Error(payload.message ?? "Advarslen kunne ikke sendes.");
  }
  return { alert: payload.data, duplicate: Boolean(payload.duplicate) };
}

function App() {
  const [activeView, setActiveView] = useState<ActiveView>("scanner");
  const [accountProfile, setAccountProfile] = useState<MyProfile | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [nearbyOnboardingUserId, setNearbyOnboardingUserId] = useState<string | null>(null);
  const [plate, setPlate] = useState("");
  const [result, setResult] = useState<RegistryCheck | null>(null);
  const [error, setError] = useState<RegistryError | null>(null);
  const [loading, setLoading] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [scannerStatus, setScannerStatus] = useState("Eksempelvisning");
  const [lowLightDetected, setLowLightDetected] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [zoomSupported, setZoomSupported] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [zoomMinimum, setZoomMinimum] = useState(1);
  const [zoomMaximum, setZoomMaximum] = useState(1);
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number } | null>(null);
  const [alertScanActive, setAlertScanActive] = useState(false);
  const [alertScanResult, setAlertScanResult] = useState<AlertScanResult | null>(null);
  const [pendingPlateConfirmation, setPendingPlateConfirmation] =
    useState<PendingPlateConfirmation | null>(null);
  const [matchedAlert, setMatchedAlert] = useState<VehicleAlert | null>(null);
  const [history, setHistory] = useState<RegistryCheck[]>(loadPrivateHistory);
  const [testMode, setTestMode] = useState(() => localStorage.getItem(TEST_MODE_KEY) === "true");
  const [reportAlert, setReportAlert] = useState<VehicleAlert | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [reporting, setReporting] = useState(false);
  const [reportMessage, setReportMessage] = useState("");
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(
    () => window.matchMedia("(display-mode: standalone)").matches,
  );
  const [updateInfo, setUpdateInfo] = useState<UpdateManifest | null>(null);
  const [currentAppVersion, setCurrentAppVersion] = useState({ versionName: "1.0.0", versionCode: 1 });
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateRequired, setUpdateRequired] = useState(false);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateMessage, setUpdateMessage] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanFrameRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lightCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const plateEvidenceRef = useRef<PlateEvidence | null>(null);
  const updateCheckStarted = useRef(false);
  const lastMatchCheck = useRef({ plate: "", checkedAt: 0 });

  const valid = /^[A-ZÆØÅ]{2}\s?\d{2}\s?\d{3}$/.test(plate.trim().toUpperCase());

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraOn(false);
    setAlertScanActive(false);
    setLowLightDetected(false);
    setTorchSupported(false);
    setTorchOn(false);
    setZoomSupported(false);
    setZoom(1);
    setZoomMinimum(1);
    setZoomMaximum(1);
    setFocusPoint(null);
    setScannerStatus("Eksempelvisning");
  }

  async function refreshAccount() {
    setAccountLoading(true);
    try {
      setAccountProfile(await getMyProfile());
    } catch {
      setAccountProfile(null);
    } finally {
      setAccountLoading(false);
    }
  }

  function navigateTo(view: ActiveView) {
    if (view !== "scanner") {
      stopCamera();
    }
    setActiveView(view);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  useEffect(() => {
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    if (Capacitor.isNativePlatform() && !updateCheckStarted.current) {
      updateCheckStarted.current = true;
      void checkForAppUpdate(false);
    }

    let removeAuthLinkListener: () => void = () => undefined;
    let cancelled = false;
    void initializeAuthLinks(async () => {
      if (cancelled) return;
      setActiveView("account");
      await refreshAccount();
    }).then((remove) => {
      if (cancelled) remove();
      else removeAuthLinkListener = remove;
    });
    const unsubscribeAuth = subscribeToAuthChanges((event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
        void refreshAccount();
      }
    });
    void refreshAccount();

    return () => {
      cancelled = true;
      removeAuthLinkListener();
      unsubscribeAuth();
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
  }, [history]);

  useEffect(() => {
    localStorage.setItem(TEST_MODE_KEY, String(testMode));
  }, [testMode]);

  useEffect(() => {
    let removeNearbyListeners: () => void = () => undefined;
    let cancelled = false;

    void initializeNearbyNotificationListeners((notification) => {
      if (cancelled) return;
      setMatchedAlert({
        id: notification.eventId,
        plate: notification.plate,
        description: notification.description,
        createdAt: notification.observedAt,
        expiresAt: new Date(Date.parse(notification.observedAt) + 60 * 60_000).toISOString(),
        reporterName: "Fælles match",
        observationCount: 1,
        distinctReporterCount: 1,
        lastSeenAt: notification.observedAt,
        notificationEventId: notification.eventId,
        observedAt: notification.observedAt,
        nearbyDistanceMeters: notification.distanceMeters,
        approximateLatitude: notification.approximateLatitude,
        approximateLongitude: notification.approximateLongitude,
      });
      setActiveView("scanner");
      navigator.vibrate?.([350, 120, 350, 120, 500]);
    }).then((remove) => {
      if (cancelled) remove();
      else removeNearbyListeners = remove;
    });
    void refreshNearbyDevice();
    const refreshTimer = window.setInterval(() => {
      void refreshNearbyDevice();
    }, 10 * 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
      removeNearbyListeners();
    };
  }, []);

  useEffect(() => {
    if (
      accountLoading
      || !accountProfile
      || accountProfile.isAnonymous
      || accountProfile.accountStatus !== "active"
      || !Capacitor.isNativePlatform()
      || Capacitor.getPlatform() !== "android"
      || nearbyOnboardingWasHandled(accountProfile.userId)
    ) {
      setNearbyOnboardingUserId(null);
      return;
    }
    setNearbyOnboardingUserId(accountProfile.userId);
  }, [
    accountLoading,
    accountProfile?.accountStatus,
    accountProfile?.isAnonymous,
    accountProfile?.userId,
  ]);

  useEffect(() => {
    if (!cameraOn) {
      setScannerStatus("Eksempelvisning");
      plateEvidenceRef.current = null;
      return;
    }
    if (!Capacitor.isNativePlatform()) {
      setScannerStatus("Kamera aktivt · OCR kører i Android-appen");
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    async function scanFrame() {
      if (cancelled) return;
      const video = videoRef.current;
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) {
        timer = window.setTimeout(() => void scanFrame(), 500);
        return;
      }

      try {
        const canvas = scanCanvasRef.current ?? document.createElement("canvas");
        const scanFrame = scanFrameRef.current;
        if (!scanFrame) throw new Error("Scanningsrammen kunne ikke findes.");
        scanCanvasRef.current = canvas;
        const videoBounds = video.getBoundingClientRect();
        const frameBounds = scanFrame.getBoundingClientRect();
        const crop = calculateCoverCrop(
          video.videoWidth,
          video.videoHeight,
          videoBounds.width,
          videoBounds.height,
          {
            left: frameBounds.left - videoBounds.left,
            top: frameBounds.top - videoBounds.top,
            width: frameBounds.width,
            height: frameBounds.height,
          },
        );
        canvas.width = 1280;
        canvas.height = Math.max(280, Math.round(1280 * crop.height / crop.width));
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Kamerabilledet kunne ikke behandles.");

        const lightCanvas = lightCanvasRef.current ?? document.createElement("canvas");
        lightCanvasRef.current = lightCanvas;
        lightCanvas.width = 96;
        lightCanvas.height = Math.max(28, Math.round(96 * crop.height / crop.width));
        const lightContext = lightCanvas.getContext("2d", { alpha: false });
        if (!lightContext) throw new Error("Lysniveauet kunne ikke måles.");
        lightContext.drawImage(
          video,
          crop.x,
          crop.y,
          crop.width,
          crop.height,
          0,
          0,
          lightCanvas.width,
          lightCanvas.height,
        );
        const luminance = estimateImageLuminance(
          lightContext.getImageData(0, 0, lightCanvas.width, lightCanvas.height).data,
          3,
        );
        const isLowLight = luminance < 82;
        setLowLightDetected((current) => current === isLowLight ? current : isLowLight);

        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.filter = plateCaptureFilter(luminance);
        context.drawImage(
          video,
          crop.x,
          crop.y,
          crop.width,
          crop.height,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        context.filter = "none";
        const imageBase64 = canvas.toDataURL("image/jpeg", 0.92).split(",")[1] ?? "";
        const recognized = await PlateTextRecognizer.recognize({ imageBase64 });
        const candidate = findBestPlateCandidate(recognized);
        const evidenceUpdate = advancePlateEvidence(
          plateEvidenceRef.current,
          candidate,
          Date.now(),
        );
        plateEvidenceRef.current = evidenceUpdate.evidence;

        if (candidate && evidenceUpdate.evidence && !evidenceUpdate.confirmed && !cancelled) {
          const formatted = displayPlate(candidate.plate);
          setScannerStatus(
            `Kontrollerer nummerplade · ${formatted} `
            + `(${evidenceUpdate.evidence.hits}/${evidenceUpdate.evidence.requiredHits})`,
          );
        } else if (candidate && evidenceUpdate.confirmed && !cancelled) {
          const formatted = displayPlate(candidate.plate);
          setPlate(formatted);
          setScannerStatus(`Nummerplade bekræftet · ${formatted}`);
          const now = Date.now();
          const recent = lastMatchCheck.current;
          if (recent.plate === candidate.plate && now - recent.checkedAt <= 15_000) return;
          lastMatchCheck.current = { plate: candidate.plate, checkedAt: now };
          setPendingPlateConfirmation({
            plate: formatted,
            purpose: alertScanActive ? "alert" : "lookup",
          });
          navigator.vibrate?.(180);
          stopCamera();
          return;
        } else if (!cancelled) {
          setScannerStatus(
            evidenceUpdate.evidence
              ? "Holder fokus · placér pladen midt i rammen…"
              : "Placér en nummerplade midt i rammen…",
          );
        }
      } catch {
        if (!cancelled) setScannerStatus("Placér en nummerplade midt i rammen…");
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void scanFrame(), 700);
      }
    }

    setScannerStatus("Scanner efter nummerplade…");
    void scanFrame();
    return () => {
      cancelled = true;
      plateEvidenceRef.current = null;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [alertScanActive, cameraOn]);

  async function installApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") setInstallPrompt(null);
  }

  async function checkForAppUpdate(manual: boolean) {
    if (!Capacitor.isNativePlatform()) return;
    setUpdateChecking(true);
    if (manual) setUpdateMessage("");
    try {
      const current = await AppUpdater.getCurrentVersion();
      setCurrentAppVersion(current);
      const manifest = await fetchUpdateManifest(UPDATE_MANIFEST_URL, {
        officialRepo: UPDATE_REPOSITORY_URL,
      });
      setUpdateInfo(manifest);

      const available = updateIsAvailable(manifest, current.versionCode);
      const required = available && updateIsRequired(manifest, current.versionCode);
      const dismissed = Number(localStorage.getItem(DISMISSED_UPDATE_KEY) ?? 0);
      setUpdateRequired(required);

      if (available && (manual || required || dismissed !== manifest.activeVersionCode)) {
        setUpdateOpen(true);
      } else if (manual) {
        setUpdateMessage(`Pladetjek ${current.versionName} er den nyeste version.`);
      }
    } catch (caught) {
      if (manual) {
        const message = caught instanceof Error ? caught.message : "Opdateringskontrollen mislykkedes.";
        setUpdateMessage(message);
      }
    } finally {
      setUpdateChecking(false);
    }
  }

  async function installUpdate() {
    if (!updateInfo || updateInstalling) return;
    setUpdateInstalling(true);
    setUpdateMessage("");
    try {
      const result = await AppUpdater.install({
        url: updateInfo.apkDownloadUrl,
        sha256: updateInfo.sha256,
      });
      if (result.needsPermission) {
        setUpdateMessage(result.message ?? "Tillad installation, gå tilbage og tryk Opdater igen.");
      } else if (result.started) {
        setUpdateMessage("Androids installation er åbnet. Bekræft opdateringen på telefonen.");
      }
    } catch (caught) {
      setUpdateMessage(caught instanceof Error ? caught.message : "Opdateringen kunne ikke startes.");
    } finally {
      setUpdateInstalling(false);
    }
  }

  function dismissUpdate() {
    if (!updateInfo || updateRequired) return;
    localStorage.setItem(DISMISSED_UPDATE_KEY, String(updateInfo.activeVersionCode));
    setUpdateOpen(false);
  }

  async function startCamera(scanForAlert: boolean) {
    setAlertScanActive(scanForAlert);
    if (cameraOn && streamRef.current) {
      setScannerStatus(
        scanForAlert ? "Scan nummerpladen til advarslen…" : "Scanner efter nummerplade…",
      );
      return true;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        const capabilities = videoTrack.getCapabilities() as ExtendedCameraCapabilities;
        setTorchSupported(capabilities.torch === true);
        if (
          capabilities.zoom
          && Number.isFinite(capabilities.zoom.min)
          && Number.isFinite(capabilities.zoom.max)
          && capabilities.zoom.max > capabilities.zoom.min
        ) {
          const settings = videoTrack.getSettings() as MediaTrackSettings & { zoom?: number };
          const currentZoom = clampCameraZoom(
            settings.zoom ?? capabilities.zoom.min,
            capabilities.zoom.min,
            capabilities.zoom.max,
          );
          setZoomSupported(true);
          setZoomMinimum(capabilities.zoom.min);
          setZoomMaximum(capabilities.zoom.max);
          setZoom(currentZoom);
        } else {
          setZoomSupported(false);
        }
        if (capabilities.focusMode?.includes("continuous")) {
          await videoTrack.applyConstraints({
            advanced: [{
              focusMode: "continuous",
            } as ExtendedCameraConstraintSet],
          }).catch(() => undefined);
        }
      }
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraOn(true);
      setScannerStatus(
        scanForAlert ? "Scan nummerpladen til advarslen…" : "Scanner efter nummerplade…",
      );
      setCameraError("");
      return true;
    } catch {
      setAlertScanActive(false);
      setCameraError("Kameraadgang blev afvist. Du kan stadig indtaste pladen manuelt.");
      return false;
    }
  }

  async function toggleTorch() {
    const videoTrack = streamRef.current?.getVideoTracks()[0];
    if (!videoTrack || !torchSupported) return;
    const next = !torchOn;
    try {
      await videoTrack.applyConstraints({
        advanced: [{
          torch: next,
        } as ExtendedCameraConstraintSet],
      });
      setTorchOn(next);
      setCameraError("");
    } catch {
      setCameraError("Telefonens lygte kunne ikke styres. Brug mere lys omkring nummerpladen.");
    }
  }

  async function applyZoom(nextValue: number) {
    const videoTrack = streamRef.current?.getVideoTracks()[0];
    if (!videoTrack || !zoomSupported) return;
    const next = clampCameraZoom(nextValue, zoomMinimum, zoomMaximum);
    try {
      await videoTrack.applyConstraints({
        advanced: [{ zoom: next } as ExtendedCameraConstraintSet],
      });
      setZoom(next);
      setCameraError("");
    } catch {
      setCameraError("Telefonens kamerazoom kunne ikke ændres.");
    }
  }

  async function focusCamera(event: React.PointerEvent<HTMLDivElement>) {
    if (!cameraOn) return;
    const videoTrack = streamRef.current?.getVideoTracks()[0];
    if (!videoTrack) return;
    const point = calculateFocusPoint(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
    );
    setFocusPoint(point);
    window.setTimeout(() => setFocusPoint(null), 900);

    const capabilities = videoTrack.getCapabilities() as ExtendedCameraCapabilities;
    const focusMode = capabilities.focusMode?.includes("single-shot")
      ? "single-shot"
      : capabilities.focusMode?.includes("continuous")
        ? "continuous"
        : undefined;
    if (!focusMode && !capabilities.pointsOfInterest) return;

    try {
      await videoTrack.applyConstraints({
        advanced: [{
          ...(focusMode ? { focusMode } : {}),
          ...(capabilities.pointsOfInterest ? { pointsOfInterest: [point] } : {}),
        } as ExtendedCameraConstraintSet],
      });
    } catch {
      // Fokusmarkeringen giver stadig præcis visuel feedback på telefoner uden manuel fokus.
    }
  }

  async function toggleCamera() {
    if (cameraOn) {
      stopCamera();
      return;
    }
    await startCamera(false);
  }

  async function startAlertPlateScan() {
    setAlertScanResult(null);
    const started = await startCamera(true);
    if (started) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function addHistory(check: RegistryCheck) {
    setHistory((current) => [check, ...current].slice(0, 50));
  }

  async function runRegistryCheckForPlate(rawPlate: string, viaCamera: boolean) {
    const normalized = normalizePlate(rawPlate);
    if (!/^[A-ZÆØÅ]{2}\d{5}$/.test(normalized) || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const alert = testMode && normalized === TEST_PLATE
        ? localTestAlert()
        : await matchVehicleAlert(
            normalized,
            viaCamera ? await getNearbyMatchCoordinates() : null,
          );
      const check = {
        plate: normalized,
        checkedAt: new Date().toISOString(),
        alert,
      };
      setResult(check);
      addHistory(check);
      if (alert && viaCamera) {
        setMatchedAlert(alert);
        navigator.vibrate?.([350, 120, 350, 120, 500]);
      }
    } catch (caught) {
      setError({
        code: "REGISTRY_CHECK_FAILED",
        message: caught instanceof Error
          ? caught.message
          : "Brugerregisteret kunne ikke kontrolleres.",
      });
    } finally {
      setLoading(false);
    }
  }

  async function runRegistryCheck() {
    if (!valid) return;
    await runRegistryCheckForPlate(plate, false);
  }

  async function confirmScannedPlate() {
    if (!pendingPlateConfirmation) return;
    const confirmedPlate = normalizePlate(pendingPlateConfirmation.plate);
    if (!/^[A-ZÆØÅ]{2}\d{5}$/.test(confirmedPlate)) return;
    const purpose = pendingPlateConfirmation.purpose;
    setPendingPlateConfirmation(null);
    setPlate(displayPlate(confirmedPlate));
    if (purpose === "alert") {
      setAlertScanResult({ plate: confirmedPlate, capturedAt: Date.now() });
      window.setTimeout(() => {
        document.getElementById("tilfoej-advarsel")?.scrollIntoView({ behavior: "smooth" });
        document.getElementById("alert-description")?.focus();
      }, 250);
      return;
    }
    await runRegistryCheckForPlate(confirmedPlate, true);
  }

  function runLocalTestMatch() {
    setTestMode(true);
    const formatted = displayPlate(TEST_PLATE);
    const check = {
      plate: TEST_PLATE,
      checkedAt: new Date().toISOString(),
      alert: localTestAlert(),
    };
    setPlate(formatted);
    setError(null);
    setResult(check);
    addHistory(check);
    setMatchedAlert(check.alert);
    navigator.vibrate?.([180, 80, 180]);
  }

  function openReport(alert: VehicleAlert) {
    setReportAlert(alert);
    setReportReason("");
    setReportMessage("");
  }

  async function submitReport() {
    const reason = reportReason.replace(/\s+/g, " ").trim();
    if (!reportAlert || reason.length < 10 || reporting || reportAlert.id === "local-test-alert") return;
    setReporting(true);
    setReportMessage("");
    try {
      await reportSharedAlert(reportAlert.id, reason);
      setReportMessage("Tak. Rapporten er sendt til administratorernes moderationskø.");
    } catch (caught) {
      setReportMessage(caught instanceof Error ? caught.message : "Rapporten kunne ikke sendes.");
    } finally {
      setReporting(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="rail-brand"><ScanLine size={25} /></div>
        <nav>
          <button
            className={`nav-item ${activeView === "scanner" ? "active" : ""}`}
            onClick={() => navigateTo("scanner")}
          ><Gauge /><span>Scanning</span></button>
          <button className="nav-item" onClick={() => {
            navigateTo("scanner");
            window.setTimeout(() => document.getElementById("plate")?.focus(), 250);
          }}><Search /><span>Søgning</span></button>
          <button className="nav-item" onClick={() => {
            navigateTo("scanner");
            window.setTimeout(() => document.getElementById("seneste-scanninger")?.scrollIntoView({ behavior: "smooth" }), 250);
          }}><History /><span>Historik</span></button>
          <button
            className="nav-item"
            onClick={() => {
              navigateTo("scanner");
              window.setTimeout(() => document.getElementById("tilfoej-advarsel")?.scrollIntoView({ behavior: "smooth" }), 250);
            }}
          >
            <TriangleAlert /><span>Advarsel</span>
          </button>
          <button
            className={`nav-item ${activeView === "account" ? "active" : ""}`}
            onClick={() => navigateTo("account")}
          ><UserRound /><span>Profil</span></button>
          {(accountProfile?.role === "admin" || accountProfile?.role === "creator") &&
            <button
              className={`nav-item ${activeView === "admin" ? "active" : ""}`}
              onClick={() => navigateTo("admin")}
            ><UsersRound /><span>Brugere</span></button>}
        </nav>
      </aside>
      <main>
        <header>
          <div className="brand"><Menu className="mobile-menu" /><span className="brand-mark"><ScanLine /></span> PLADETJEK</div>
          <div className="header-meta">
            {Capacitor.isNativePlatform() &&
              <button className="update-button" onClick={() => void checkForAppUpdate(true)} disabled={updateChecking}>
                <RefreshCw className={updateChecking ? "rotating" : ""} />
                {updateChecking ? "Tjekker…" : "Opdatering"}
              </button>}
            {!installed && installPrompt &&
              <button className="install-button" onClick={installApp}>
                <Download /> Installér app
              </button>}
            <span className={`online-dot ${sharedAlertsAreConfigured() ? "" : "offline-dot"}`} />
            {sharedAlertsAreConfigured() ? "Fælles brugerregister" : "Register mangler"}
            <span className="divider" /><Clock3 />
            {new Date().toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" })}
          </div>
        </header>
        {activeView === "scanner" &&
        <>
        <section className="workspace">
          <div className="capture-panel panel">
            <div className="panel-head">
              <span><i /> {alertScanActive ? "Scan til advarsel" : "Live scanning"}</span>
              <button className="icon-button" aria-label="Kamera" onClick={toggleCamera}>{cameraOn ? <X /> : <Camera />}</button>
            </div>
            <div
              className={`camera-stage ${cameraOn ? "focus-enabled" : ""}`}
              onPointerDown={(event) => void focusCamera(event)}
            >
              <img src="/demo-road.png" alt="Eksempel på kameravisning med en bil" className={cameraOn ? "hidden" : ""} />
              <video ref={videoRef} autoPlay playsInline muted className={cameraOn ? "" : "hidden"} />
              {alertScanActive &&
                <div className="alert-scan-banner">
                  <TriangleAlert /> Nummerpladen overføres til advarslen efter bekræftelse
                </div>}
              {cameraOn && lowLightDetected && !torchOn &&
                (torchSupported
                  ? <button
                      type="button"
                      className="low-light-hint"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        void toggleTorch();
                      }}
                    >
                      <Flashlight /> Mørkt billede · tænd lygten
                    </button>
                  : <div className="low-light-hint low-light-static">
                      <Flashlight /> Mørkt billede · brug mere lys
                    </div>)}
              {focusPoint &&
                <span
                  className="focus-ring"
                  style={{ left: `${focusPoint.x * 100}%`, top: `${focusPoint.y * 100}%` }}
                ><Focus /></span>}
              <div ref={scanFrameRef} className="scan-frame">
                <span /><span /><span /><span />
              </div>
              <div className="recognized"><ScanLine /> {displayPlate(plate) || "AFVENTER PLADE"}</div>
            </div>
            {cameraOn && zoomSupported &&
              <div className="camera-zoom">
                <ZoomIn />
                <label htmlFor="camera-zoom">Zoom {zoom.toFixed(1)}×</label>
                <input
                  id="camera-zoom"
                  type="range"
                  min={zoomMinimum}
                  max={zoomMaximum}
                  step={0.1}
                  value={zoom}
                  onChange={(event) => void applyZoom(Number(event.target.value))}
                />
              </div>}
            <div className="camera-controls">
              <span><i /> {scannerStatus}</span>
              <div className="camera-actions">
                {cameraOn && torchSupported &&
                  <button
                    className={`torch-button ${torchOn ? "active" : ""} ${lowLightDetected && !torchOn ? "recommended" : ""}`}
                    onClick={() => void toggleTorch()}
                  >
                    <Flashlight size={16} />
                    {torchOn ? "Sluk lygte" : "Tænd lygte"}
                  </button>}
                <button onClick={toggleCamera}>
                  {cameraOn ? <X size={16} /> : <Play size={16} />}
                  {alertScanActive ? "Annuller scanning" : cameraOn ? "Stop kamera" : "Start kamera"}
                </button>
              </div>
            </div>
            {cameraError && <p className="camera-error">{cameraError}</p>}
            <div className="manual">
              <label htmlFor="plate">Manuelt registertjek</label>
              <div className="lookup-row">
                <input
                  id="plate"
                  placeholder="AB 12 345"
                  value={plate}
                  onChange={(event) => setPlate(displayPlate(event.target.value))}
                  onKeyDown={(event) => event.key === "Enter" && runRegistryCheck()}
                  aria-invalid={plate.length > 0 && !valid}
                  autoCapitalize="characters"
                  autoComplete="off"
                />
                <button className="primary" disabled={!valid || loading} onClick={runRegistryCheck}>
                  {loading ? <span className="spinner" /> : <Search />}
                  {loading ? "Kontrollerer…" : "Tjek brugerregister"}
                </button>
              </div>
              {!valid && plate.length > 0 && <small>Brug formatet AB 12 345</small>}
            </div>
            <div className={`test-mode-card ${testMode ? "active" : ""}`}>
              <div>
                <FlaskConical />
                <span>
                  <strong>Testtilstand</strong>
                  <small>Test med TT 00 000 uden database, lokation eller push.</small>
                </span>
              </div>
              <div>
                <button type="button" onClick={() => setTestMode((current) => !current)}>
                  {testMode ? "Slå fra" : "Slå til"}
                </button>
                <button type="button" className="test-run" onClick={runLocalTestMatch}>
                  Kør testmatch
                </button>
              </div>
            </div>
          </div>
          <ResultPanel
            result={result}
            error={error}
            loading={loading}
            onReport={openReport}
          />
        </section>
        <Recent
          history={history}
          onDelete={(checkedAt) => setHistory((current) =>
            current.filter((item) => item.checkedAt !== checkedAt))}
          onClear={() => setHistory([])}
        />
        <AlertSection
          scanResult={alertScanResult}
          scanSupported={Capacitor.isNativePlatform()}
          onStartScan={() => void startAlertPlateScan()}
        />
        </>}
        {activeView === "account" &&
          <AccountScreen
            profile={accountProfile}
            loading={accountLoading}
            onProfileChange={setAccountProfile}
            onOpenAdmin={() => navigateTo("admin")}
          />}
        {activeView === "admin" && accountProfile &&
          (accountProfile.role === "admin" || accountProfile.role === "creator")
          ? <AdminUsersScreen currentProfile={accountProfile} onBack={() => navigateTo("account")} />
          : activeView === "admin"
            ? <AccountScreen
                profile={accountProfile}
                loading={accountLoading}
                onProfileChange={setAccountProfile}
                onOpenAdmin={() => navigateTo("admin")}
              />
            : null}
      </main>
      <nav className="mobile-bottom-nav" aria-label="Primær navigation">
        <button className={activeView === "scanner" ? "active" : ""} onClick={() => navigateTo("scanner")}>
          <ScanLine /> Scanner
        </button>
        <button onClick={() => {
          navigateTo("scanner");
          window.setTimeout(() => document.getElementById("seneste-scanninger")?.scrollIntoView({ behavior: "smooth" }), 250);
        }}>
          <History /> Historik
        </button>
        <button className={activeView === "account" || activeView === "admin" ? "active" : ""} onClick={() => navigateTo("account")}>
          <UserRound /> Profil
        </button>
      </nav>
      {updateMessage &&
        <button className="update-toast" onClick={() => setUpdateMessage("")} aria-label="Luk besked">
          {updateMessage}<X />
        </button>}
      {updateOpen && updateInfo &&
        <div className="update-backdrop" role="presentation">
          <section className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
            {!updateRequired &&
              <button className="update-close" onClick={dismissUpdate} aria-label="Ikke nu"><X /></button>}
            <div className="update-symbol"><Download /></div>
            <p className="update-overline">{updateRequired ? "Påkrævet opdatering" : "Ny version klar"}</p>
            <h2 id="update-title">Pladetjek {updateInfo.activeVersion}</h2>
            <p>
              Du bruger version {currentAppVersion.versionName}. APK-filen kontrolleres automatisk
              med både SHA-256 og Pladetjeks signatur før installation.
            </p>
            {updateInfo.changelog.length > 0 &&
              <ul>{updateInfo.changelog.map((line) => <li key={line}>{line}</li>)}</ul>}
            <button className="update-primary" onClick={() => void installUpdate()} disabled={updateInstalling}>
              {updateInstalling ? <span className="spinner" /> : <Download />}
              {updateInstalling ? "Henter opdatering…" : "Hent og installér"}
            </button>
            {!updateRequired &&
              <button className="update-later" onClick={dismissUpdate}>Senere</button>}
            {updateInfo.releasePageUrl &&
              <a href={updateInfo.releasePageUrl} target="_blank" rel="noreferrer">
                Se udgivelsen på GitHub <ExternalLink />
              </a>}
          </section>
        </div>}
      {pendingPlateConfirmation &&
        <div className="plate-confirm-backdrop" role="presentation">
          <section className="plate-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="plate-confirm-title">
            <div className="plate-confirm-icon"><ScanLine /></div>
            <p>Kontrollér aflæsningen</p>
            <h2 id="plate-confirm-title">
              {pendingPlateConfirmation.purpose === "alert"
                ? "Brug denne plade i advarslen?"
                : "Tjek denne nummerplade?"}
            </h2>
            <input
              value={displayPlate(pendingPlateConfirmation.plate)}
              onChange={(event) => setPendingPlateConfirmation((current) => current
                ? { ...current, plate: displayPlate(event.target.value) }
                : current)}
              autoFocus
              autoCapitalize="characters"
              aria-label="Bekræft scannet nummerplade"
            />
            <small>Ret nummerpladen, hvis kameraet har læst et tegn forkert.</small>
            <button
              className="plate-confirm-primary"
              disabled={!/^[A-ZÆØÅ]{2}\s?\d{2}\s?\d{3}$/.test(pendingPlateConfirmation.plate)}
              onClick={() => void confirmScannedPlate()}
            >
              <Check /> Bekræft nummerplade
            </button>
            <button className="plate-confirm-cancel" onClick={() => setPendingPlateConfirmation(null)}>
              Scan igen senere
            </button>
          </section>
        </div>}
      {matchedAlert &&
        <div className="match-backdrop" role="presentation">
          <section className="match-dialog" role="alertdialog" aria-modal="true" aria-labelledby="match-title">
            <div className="match-icon"><TriangleAlert /></div>
            <h2 id="match-title">
              {matchedAlert.nearbyDistanceMeters !== undefined
                ? "OBS – OSTEN LUGTER I NÆRHEDEN AF DIG"
                : "ADVARSEL · MATCH FUNDET"}
            </h2>
            <div className="match-plate">{displayPlate(matchedAlert.plate)}</div>
            <div className="match-copy">
              <strong>Brugerobservation</strong>
              <p>{matchedAlert.description}</p>
              {matchedAlert.nearbyDistanceMeters !== undefined &&
                <div className="nearby-match-meta">
                  <span><MapPin /> Ca. {formatNearbyDistance(matchedAlert.nearbyDistanceMeters)} væk</span>
                  {matchedAlert.approximateLatitude !== undefined &&
                    matchedAlert.approximateLongitude !== undefined &&
                    <span>
                      Område {matchedAlert.approximateLatitude.toFixed(3)},{" "}
                      {matchedAlert.approximateLongitude.toFixed(3)}
                    </span>}
                </div>}
              {matchedAlert.nearbyDistanceMeters === undefined &&
                <span className="match-reporter">Indsendt af {matchedAlert.reporterName}</span>}
              <time>
                {matchedAlert.nearbyDistanceMeters !== undefined ? "Registreret" : "Oprettet"}{" "}
                {formatRelativeTime(matchedAlert.observedAt ?? matchedAlert.createdAt)}
              </time>
            </div>
            <button onClick={() => setMatchedAlert(null)}>FORSTÅET</button>
            {matchedAlert.id !== "local-test-alert" &&
              <button className="match-report" onClick={() => {
                openReport(matchedAlert);
                setMatchedAlert(null);
              }}>
                <Flag /> Rapportér forkert advarsel
              </button>}
            <small>
              Observationen er indsendt af en bruger og er ikke verificeret registerinformation.
            </small>
          </section>
        </div>}
      {reportAlert &&
        <div className="report-dialog-backdrop" role="presentation">
          <section className="report-dialog" role="dialog" aria-modal="true" aria-labelledby="report-title">
            <button className="report-close" onClick={() => setReportAlert(null)} aria-label="Luk"><X /></button>
            <Flag />
            <h2 id="report-title">Rapportér forkert advarsel</h2>
            <p>{displayPlate(reportAlert.plate)} · Forklar kort, hvorfor observationen bør gennemgås.</p>
            <textarea
              value={reportReason}
              onChange={(event) => setReportReason(event.target.value)}
              placeholder="Fx nummerpladen er læst forkert eller observationen er ikke længere relevant"
              minLength={10}
              maxLength={300}
            />
            <span>{reportReason.length} / 300</span>
            <button
              className="report-submit"
              disabled={reportReason.trim().length < 10 || reporting || Boolean(reportMessage)}
              onClick={() => void submitReport()}
            >
              {reporting ? <span className="spinner" /> : <Flag />}
              {reporting ? "Sender…" : "Send til moderation"}
            </button>
            {reportMessage && <p className="report-message" role="status">{reportMessage}</p>}
          </section>
        </div>}
      {nearbyOnboardingUserId &&
        <NearbyAlertsOnboarding
          userId={nearbyOnboardingUserId}
          onComplete={() => setNearbyOnboardingUserId(null)}
        />}
    </div>
  );
}

function AlertSection({
  scanResult,
  scanSupported,
  onStartScan,
}: {
  scanResult: AlertScanResult | null;
  scanSupported: boolean;
  onStartScan: () => void;
}) {
  const [alertPlate, setAlertPlate] = useState("");
  const [description, setDescription] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  const validPlate = /^[A-ZÆØÅ]{2}\s?\d{2}\s?\d{3}$/.test(alertPlate.trim().toUpperCase());
  const cleanDescription = description.replace(/\s+/g, " ").trim();
  const validDescription = cleanDescription.length >= 5 && cleanDescription.length <= 240;

  useEffect(() => {
    if (!scanResult) return;
    setAlertPlate(displayPlate(scanResult.plate));
    setStatusMessage(
      `Nummerpladen ${displayPlate(scanResult.plate)} er scannet. Tilføj en kort beskrivelse.`,
    );
  }, [scanResult]);

  async function sendAlert() {
    if (!validPlate || !validDescription || sending) return;
    setSending(true);
    setStatusMessage("");
    try {
      const result = await createVehicleAlert(alertPlate, cleanDescription);
      setStatusMessage(
        result.duplicate
          ? "Der findes allerede en aktiv advarsel for nummerpladen."
          : "Advarslen er gemt og vises kun ved et scannermatch.",
      );
      setAlertPlate("");
      setDescription("");
      setConfirmOpen(false);
    } catch (caught) {
      setStatusMessage(caught instanceof Error ? caught.message : "Advarslen kunne ikke sendes.");
    } finally {
      setSending(false);
    }
  }

  return <section className="alerts-panel panel" id="tilfoej-advarsel">
    <div className="alerts-section-head">
      <div>
        <h2>Tilføj advarsel</h2>
        <p>Gem en observation, som kun vises ved et aktivt scannermatch</p>
      </div>
      <span className="match-based"><ScanLine /> Matchbaseret</span>
    </div>
    <div className="alerts-grid">
      <form className="alert-form" onSubmit={(event) => {
        event.preventDefault();
        if (validPlate && validDescription) setConfirmOpen(true);
      }}>
        <label htmlFor="alert-plate">Nummerplade</label>
        <div className="alert-plate-controls">
          <div className="alert-plate-input">
            <span><b>••••••••••••</b>DK</span>
            <input
              id="alert-plate"
              placeholder="AB 12 345"
              value={alertPlate}
              onChange={(event) => setAlertPlate(displayPlate(event.target.value))}
              autoCapitalize="characters"
              autoComplete="off"
              aria-invalid={alertPlate.length > 0 && !validPlate}
            />
          </div>
          <button
            className="alert-scan-button"
            type="button"
            onClick={onStartScan}
            disabled={!scanSupported}
            title={scanSupported ? "Scan nummerpladen med kameraet" : "Kræver Android-appen"}
          >
            <Camera /> Scan nummerplade
          </button>
        </div>
        <label htmlFor="alert-description">Kort beskrivelse</label>
        <div className="alert-text-wrap">
          <textarea
            id="alert-description"
            placeholder="Fx bilen kørte flere gange langsomt forbi området"
            value={description}
            maxLength={240}
            onChange={(event) => setDescription(event.target.value)}
          />
          <span>{description.length} / 240</span>
        </div>
        <button className="alert-send" type="submit" disabled={!validPlate || !validDescription}>
          <TriangleAlert /> GEM ADVARSEL
        </button>
        <p className="alert-helper">
          Gemmes uden automatisk udløb. Der sendes først en alarm ved et scannermatch.
        </p>
        {statusMessage && <p className="alert-status" role="status">{statusMessage}</p>}
      </form>
      <div className="match-explanation">
        <h3>Sådan vises advarslen</h3>
        <ol>
          <li><span>1</span><div><strong>Advarslen gemmes</strong><p>Nummerplade og beskrivelse lægges på den fælles matchliste.</p></div></li>
          <li><span>2</span><div><strong>En bruger starter scanneren</strong><p>Kameraet genkender nummerpladen lokalt på Android-telefonen.</p></div></li>
          <li><span>3</span><div><strong>Kun et præcist match advarer</strong><p>Beskrivelsen vises først, når den scannede nummerplade matcher.</p></div></li>
        </ol>
        <p className="match-privacy"><ShieldCheck /> Listen over advarsler udleveres ikke til appen.</p>
      </div>
    </div>
    {confirmOpen &&
      <div className="alert-confirm-backdrop" role="presentation">
        <section className="alert-confirm" role="dialog" aria-modal="true" aria-labelledby="confirm-alert-title">
          <h2 id="confirm-alert-title">Gem advarsel til scannermatch?</h2>
          <dl>
            <div><dt>Nummerplade</dt><dd>{displayPlate(alertPlate)}</dd></div>
            <div><dt>Beskrivelse</dt><dd>{cleanDescription}</dd></div>
          </dl>
          <div className="alert-confirm-actions">
            <button className="confirm-send" onClick={() => void sendAlert()} disabled={sending}>
              {sending ? <span className="spinner" /> : <TriangleAlert />}
              {sending ? "Gemmer…" : "JA, GEM ADVARSEL"}
            </button>
            <button className="confirm-cancel" onClick={() => setConfirmOpen(false)} disabled={sending}>
              Annuller
            </button>
          </div>
          <p>Del kun observationer, du selv har foretaget. Undgå navne og andre personoplysninger.</p>
        </section>
      </div>}
  </section>;
}

function Fact({ label, children, tone }: { label: string; children: React.ReactNode; tone?: string }) {
  return <div className="fact"><dt>{label}</dt><dd className={tone}>{children}</dd></div>;
}

function ResultPanel({
  result,
  error,
  loading,
  onReport,
}: {
  result: RegistryCheck | null;
  error: RegistryError | null;
  loading: boolean;
  onReport: (alert: VehicleAlert) => void;
}) {
  if (loading) {
    return <aside className="result-panel panel empty">
      <div className="large-spinner" />
      <h2>Kontrollerer brugerregisteret</h2>
      <p>Søger efter et præcist match på nummerpladen…</p>
    </aside>;
  }

  if (error) {
    return <aside className="result-panel panel empty">
      <div className="empty-icon warning-icon"><TriangleAlert /></div>
      <h2>Registertjek mislykkedes</h2>
      <p>{error.message}</p>
    </aside>;
  }

  if (!result) {
    return <aside className="result-panel panel empty">
      <div className="empty-icon"><UsersRound /></div>
      <h2>Klar til registertjek</h2>
      <p>Scan en nummerplade, eller indtast den manuelt for at kontrollere brugernes advarsler.</p>
      <div className="source-summary">Fælles brugerregister · kun præcise match</div>
    </aside>;
  }

  return <aside className="result-panel panel">
    <div className="result-inner">
      <p className="overline">Registertjek for</p>
      <h1>{displayPlate(result.plate)}</h1>
      <div className={`found ${result.alert ? "match-found" : ""}`}>
        <span>{result.alert ? <TriangleAlert /> : <Check />}</span>
        {result.alert ? "Match i brugerregisteret" : "Ingen advarsel fundet"}
      </div>
      {result.alert
        ? <section className="result-section registry-observation">
            <h2><UsersRound /> Brugerobservation</h2>
            <p>{result.alert.description}</p>
            <dl>
              <Fact label="Indsendt af">{result.alert.reporterName}</Fact>
              <Fact label="Oprettet">{formatRelativeTime(result.alert.createdAt)}</Fact>
              <Fact label="Senest set">
                {formatRelativeTime(result.alert.lastSeenAt ?? result.alert.createdAt)}
              </Fact>
              <Fact label="Observationer">
                {result.alert.observationCount} fra {result.alert.distinctReporterCount} bruger
                {result.alert.distinctReporterCount === 1 ? "" : "e"}
              </Fact>
            </dl>
            <small>Observationen er indsendt af en bruger og er ikke verificeret registerinformation.</small>
            {result.alert.id !== "local-test-alert" &&
              <button className="result-report-button" onClick={() => onReport(result.alert!)}>
                <Flag /> Rapportér forkert advarsel
              </button>}
          </section>
        : <section className="registry-clear">
            <ShieldCheck />
            <div>
              <h2>Ingen aktiv brugeradvarsel</h2>
              <p>Resultatet betyder kun, at nummerpladen ikke findes i Pladetjeks fælles brugerregister lige nu.</p>
            </div>
          </section>}
    </div>
    <footer className="source">
      <div><span>Kilde</span>Fælles brugerregister</div>
      <div><span>Kontrolleret</span>{formatCheckedAt(result.checkedAt)}</div>
    </footer>
  </aside>;
}

function Recent({
  history,
  onDelete,
  onClear,
}: {
  history: RegistryCheck[];
  onDelete: (checkedAt: string) => void;
  onClear: () => void;
}) {
  return <section className="recent panel" id="seneste-scanninger">
    <div className="recent-head">
      <div>
        <h2>Privat scanningshistorik</h2>
        <span>Gemmes kun lokalt på denne telefon · {history.length} tjek</span>
      </div>
      {history.length > 0 &&
        <button type="button" onClick={onClear}><Trash2 /> Ryd historik</button>}
    </div>
    {history.length === 0
      ? <div className="recent-empty">Dine gennemførte registertjek vises her.</div>
      : <div className="table-wrap"><table>
        <thead><tr><th>Tidspunkt</th><th>Nummerplade</th><th>Resultat</th><th>Observation</th><th /></tr></thead>
        <tbody>{history.map((item) => <tr key={`${item.checkedAt}-${item.plate}`}>
          <td>{formatCheckedAt(item.checkedAt)}</td>
          <td className="plate-cell">{displayPlate(item.plate)}</td>
          <td className={item.alert ? "danger" : "success"}>
            {item.alert ? "Match fundet" : "Intet match"}
          </td>
          <td>{item.alert?.description ?? "Ingen aktiv brugeradvarsel"}</td>
          <td>
            <button
              type="button"
              className="history-delete"
              onClick={() => onDelete(item.checkedAt)}
              aria-label={`Slet registertjek for ${displayPlate(item.plate)}`}
            ><Trash2 /></button>
          </td>
        </tr>)}</tbody>
      </table></div>}
  </section>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Appen virker fortsat online, selv hvis offline-skallen ikke kan registreres.
    });
  });
}
