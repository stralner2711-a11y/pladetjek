import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  Camera, CarFront, Check, Clock3, Download, ExternalLink, FileSearch, Gauge, Menu, Play,
  History, MapPin, RefreshCw, ScanLine, Search, ShieldCheck, TriangleAlert, UserRound,
  UsersRound, X,
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
  calculateCoverCrop,
  findBestPlateCandidate,
  type PlateEvidence,
  type PlateRecognitionResult,
} from "./plate-recognition";
import {
  createSharedAlert,
  matchSharedAlert,
  sharedAlertsAreConfigured,
  type SharedVehicleAlert,
} from "./shared-alerts";
import {
  formatNearbyDistance,
  getNearbyMatchCoordinates,
  initializeNearbyNotificationListeners,
  refreshNearbyDevice,
  type NearbyCoordinates,
} from "./nearby-alerts";
import "./styles.css";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type SourceStatus = {
  name: string;
  status: "ok" | "partial" | "unavailable";
  detail: string;
};

type Lookup = {
  plate: string;
  make: string;
  model: string;
  version: string | null;
  kind: string;
  vin: string;
  firstRegistration: string | null;
  registrationStatus: string;
  insurance: {
    status: string | null;
    company: string | null;
    created: string | null;
  };
  liens: {
    count: number;
    totalAmount: number | null;
    currency: "DKK";
    creditors: Array<{ name: string; cvr: string | null }>;
    checked: boolean;
  };
  sources: SourceStatus[];
  checkedAt: string;
};

type LookupError = { code: string; message: string };

type VehicleAlert = SharedVehicleAlert;
type ActiveView = "scanner" | "account" | "admin";

const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const UPDATE_REPOSITORY_URL = String(
  import.meta.env.VITE_UPDATE_REPOSITORY_URL ?? DEFAULT_OFFICIAL_REPO,
).replace(/\/$/, "");
const UPDATE_MANIFEST_URL = String(
  import.meta.env.VITE_UPDATE_MANIFEST_URL ?? DEFAULT_MANIFEST_URL,
);
const DISMISSED_UPDATE_KEY = "pladetjek:dismissed-update";

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

function formatDate(value: string | null) {
  if (!value) return "Ikke oplyst";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("da-DK");
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

async function lookupVehicle(plate: string): Promise<Lookup> {
  const response = await fetch(apiUrl(`/api/vehicles/${encodeURIComponent(normalizePlate(plate))}`), {
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({})) as {
    data?: Lookup;
    code?: string;
    message?: string;
  };
  if (!response.ok || !payload.data) {
    throw {
      code: payload.code ?? "LOOKUP_FAILED",
      message: payload.message ?? "Opslaget kunne ikke gennemføres.",
    } satisfies LookupError;
  }
  return payload.data;
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
  const [plate, setPlate] = useState("");
  const [result, setResult] = useState<Lookup | null>(null);
  const [error, setError] = useState<LookupError | null>(null);
  const [loading, setLoading] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [scannerStatus, setScannerStatus] = useState("Eksempelvisning");
  const [matchedAlert, setMatchedAlert] = useState<VehicleAlert | null>(null);
  const [sourcesReady, setSourcesReady] = useState<boolean | null>(null);
  const [history, setHistory] = useState<Lookup[]>([]);
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
  const plateEvidenceRef = useRef<PlateEvidence | null>(null);
  const updateCheckStarted = useRef(false);
  const lastMatchCheck = useRef({ plate: "", checkedAt: 0 });

  const valid = /^[A-ZÆØÅ]{2}\s?\d{2}\s?\d{3}$/.test(plate.trim().toUpperCase());

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
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setCameraOn(false);
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
    fetch(apiUrl("/api/health/sources"))
      .then((response) => response.json())
      .then((health: { nummerpladeApi?: string }) => setSourcesReady(health.nummerpladeApi === "configured"))
      .catch(() => setSourcesReady(false));
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
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.filter = "grayscale(1) contrast(1.35)";
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
        const imageBase64 = canvas.toDataURL("image/jpeg", 0.86).split(",")[1] ?? "";
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
          if (recent.plate !== candidate.plate || now - recent.checkedAt > 15_000) {
            lastMatchCheck.current = { plate: candidate.plate, checkedAt: now };
            const coordinates = await getNearbyMatchCoordinates();
            const alert = await matchVehicleAlert(candidate.plate, coordinates);
            if (alert && !cancelled) {
              setMatchedAlert(alert);
              navigator.vibrate?.([350, 120, 350, 120, 500]);
            }
          }
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
        if (!cancelled) timer = window.setTimeout(() => void scanFrame(), 900);
      }
    }

    setScannerStatus("Scanner efter nummerplade…");
    void scanFrame();
    return () => {
      cancelled = true;
      plateEvidenceRef.current = null;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [cameraOn]);

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

  async function toggleCamera() {
    if (cameraOn) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setCameraOn(false);
      setScannerStatus("Eksempelvisning");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraOn(true);
      setScannerStatus("Scanner efter nummerplade…");
      setCameraError("");
    } catch {
      setCameraError("Kameraadgang blev afvist. Du kan stadig indtaste pladen manuelt.");
    }
  }

  async function runLookup() {
    if (!valid || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const found = await lookupVehicle(plate);
      setResult(found);
      setHistory((old) => [found, ...old.filter((item) => item.plate !== found.plate)].slice(0, 5));
    } catch (caught) {
      const sourceError = caught as Partial<LookupError>;
      setError({
        code: sourceError.code ?? "LOOKUP_FAILED",
        message: sourceError.message ?? "Opslaget kunne ikke gennemføres.",
      });
    } finally {
      setLoading(false);
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
          }}><CarFront /><span>Køretøjer</span></button>
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
            <span className={`online-dot ${sourcesReady === false ? "offline-dot" : ""}`} />
            {sourcesReady === null ? "Kontrollerer kilder" : sourcesReady ? "Kilder tilsluttet" : "API mangler"}
            <span className="divider" /><Clock3 />
            {new Date().toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" })}
          </div>
        </header>
        {activeView === "scanner" &&
        <>
        <section className="workspace">
          <div className="capture-panel panel">
            <div className="panel-head">
              <span><i /> Live scanning</span>
              <button className="icon-button" aria-label="Kamera" onClick={toggleCamera}>{cameraOn ? <X /> : <Camera />}</button>
            </div>
            <div className="camera-stage">
              <img src="/demo-road.png" alt="Eksempel på kameravisning med en bil" className={cameraOn ? "hidden" : ""} />
              <video ref={videoRef} autoPlay playsInline muted className={cameraOn ? "" : "hidden"} />
              <div ref={scanFrameRef} className="scan-frame">
                <span /><span /><span /><span />
              </div>
              <div className="recognized"><ScanLine /> {displayPlate(plate) || "AFVENTER PLADE"}</div>
            </div>
            <div className="camera-controls">
              <span><i /> {scannerStatus}</span>
              <button onClick={toggleCamera}><Play size={16} /> {cameraOn ? "Stop kamera" : "Start kamera"}</button>
            </div>
            {cameraError && <p className="camera-error">{cameraError}</p>}
            <div className="manual">
              <label htmlFor="plate">Manuel indtastning</label>
              <div className="lookup-row">
                <input
                  id="plate"
                  placeholder="AB 12 345"
                  value={plate}
                  onChange={(event) => setPlate(displayPlate(event.target.value))}
                  onKeyDown={(event) => event.key === "Enter" && runLookup()}
                  aria-invalid={plate.length > 0 && !valid}
                  autoCapitalize="characters"
                  autoComplete="off"
                />
                <button className="primary" disabled={!valid || loading} onClick={runLookup}>
                  {loading ? <span className="spinner" /> : <Search />}
                  {loading ? "Kontrollerer…" : "Slå nummerplade op"}
                </button>
              </div>
              {!valid && plate.length > 0 && <small>Brug formatet AB 12 345</small>}
            </div>
          </div>
          <ResultPanel result={result} error={error} loading={loading} />
        </section>
        <Recent history={history} />
        <AlertSection />
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
            <small>
              Observationen er indsendt af en bruger og er ikke verificeret registerinformation.
            </small>
          </section>
        </div>}
    </div>
  );
}

function AlertSection() {
  const [alertPlate, setAlertPlate] = useState("");
  const [description, setDescription] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  const validPlate = /^[A-ZÆØÅ]{2}\s?\d{2}\s?\d{3}$/.test(alertPlate.trim().toUpperCase());
  const cleanDescription = description.replace(/\s+/g, " ").trim();
  const validDescription = cleanDescription.length >= 5 && cleanDescription.length <= 240;

  async function sendAlert() {
    if (!validPlate || !validDescription || sending) return;
    setSending(true);
    setStatusMessage("");
    try {
      const result = await createVehicleAlert(alertPlate, cleanDescription);
      setStatusMessage(
        result.duplicate
          ? "Der findes allerede en aktiv advarsel for nummerpladen."
          : "Advarslen er gemt og vises kun, når scanneren finder et match.",
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
        <p className="alert-helper">Der sendes ingen alarm nu. Teksten vises kun ved et scannermatch.</p>
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

function ResultPanel({ result, error, loading }: { result: Lookup | null; error: LookupError | null; loading: boolean }) {
  if (loading) {
    return <aside className="result-panel panel empty">
      <div className="large-spinner" />
      <h2>Kontrollerer registre</h2>
      <p>Køretøjsdata, DMR-forsikring og Bilbogen hentes…</p>
    </aside>;
  }

  if (error) {
    const missingToken = error.code === "NOT_CONFIGURED";
    return <aside className="result-panel panel empty">
      <div className="empty-icon warning-icon"><TriangleAlert /></div>
      <h2>{missingToken ? "Datakilde skal tilsluttes" : "Opslaget mislykkedes"}</h2>
      <p>{error.message}</p>
      {missingToken && <a className="source-link" href="https://www.nummerpladeapi.dk/docs" target="_blank" rel="noreferrer">
        Åbn API-dokumentation <ExternalLink />
      </a>}
    </aside>;
  }

  if (!result) {
    return <aside className="result-panel panel empty">
      <div className="empty-icon"><FileSearch /></div>
      <h2>Klar til opslag</h2>
      <p>Scan en nummerplade, eller indtast den manuelt.</p>
      <div className="source-summary">Nummerplade API · DMR · Bilbogen</div>
    </aside>;
  }

  const liensTone = !result.liens.checked ? "warning" : result.liens.count ? "danger" : "success";
  const liensText = !result.liens.checked
    ? "Kunne ikke kontrolleres"
    : result.liens.count
      ? `${result.liens.count} registreret hæftelse${result.liens.count === 1 ? "" : "r"}`
      : "Ingen registrerede hæftelser";

  return <aside className="result-panel panel">
    <div className="result-inner">
      <p className="overline">Opslag for</p>
      <h1>{displayPlate(result.plate)}</h1>
      <div className="found"><span><Check /></span>Køretøj fundet</div>
      <dl className="facts">
        <Fact label="Køretøjstype">{result.kind}</Fact>
        <Fact label="Mærke / model">{result.make} {result.model} {result.version ?? ""}</Fact>
        <Fact label="Registreringsstatus">{result.registrationStatus}</Fact>
        <Fact label="Første registrering">{formatDate(result.firstRegistration)}</Fact>
      </dl>
      <section className="result-section">
        <h2><ShieldCheck /> Forsikring</h2>
        <dl>
          <Fact label="Status" tone={result.insurance.status?.toLowerCase() === "aktiv" ? "success" : "warning"}>
            {result.insurance.status ?? "Ikke tilgængelig"}
          </Fact>
          <Fact label="Selskab">{result.insurance.company ?? "Ikke oplyst"}</Fact>
        </dl>
      </section>
      <section className="result-section">
        <h2><FileSearch /> Pant og hæftelser</h2>
        <dl>
          <Fact label="Status" tone={liensTone}>{liensText}</Fact>
          {result.liens.creditors.map((creditor) =>
            <Fact label="Panthaver" key={`${creditor.cvr}-${creditor.name}`}>
              {creditor.name}{creditor.cvr ? ` · CVR ${creditor.cvr}` : ""}
            </Fact>)}
          {result.liens.totalAmount !== null &&
            <Fact label="Hovedstol">{new Intl.NumberFormat("da-DK", { style: "currency", currency: result.liens.currency, maximumFractionDigits: 0 }).format(result.liens.totalAmount)}</Fact>}
        </dl>
      </section>
      <div className="official-links">
        <a href="https://motorregister.skat.dk/dmr-kerne/koeretoejdetaljer/visKoeretoej" target="_blank" rel="noreferrer">
          Kontrollér i DMR <ExternalLink />
        </a>
        <a href="https://www.tinglysning.dk/" target="_blank" rel="noreferrer">
          Kontrollér i Bilbogen <ExternalLink />
        </a>
      </div>
    </div>
    <footer className="source">
      <div><span>Kilder</span>{result.sources.map((source) => source.name).join(" · ")}</div>
      <div><span>Senest kontrolleret</span>{formatCheckedAt(result.checkedAt)}</div>
    </footer>
  </aside>;
}

function Recent({ history }: { history: Lookup[] }) {
  return <section className="recent panel" id="seneste-scanninger">
    <div className="recent-head"><h2>Seneste scanninger</h2><span>{history.length} opslag denne session</span></div>
    {history.length === 0
      ? <div className="recent-empty">Dine gennemførte opslag vises her.</div>
      : <div className="table-wrap"><table>
        <thead><tr><th>Tidspunkt</th><th>Nummerplade</th><th>Køretøj</th><th>Forsikring</th><th>Pant og hæftelser</th></tr></thead>
        <tbody>{history.map((item) => <tr key={item.plate}>
          <td>{formatCheckedAt(item.checkedAt)}</td>
          <td className="plate-cell">{displayPlate(item.plate)}</td>
          <td>{item.make} {item.model}</td>
          <td className={item.insurance.status?.toLowerCase() === "aktiv" ? "success" : "warning"}>{item.insurance.status ?? "Ukendt"}</td>
          <td className={!item.liens.checked ? "warning" : item.liens.count ? "danger" : "success"}>
            {!item.liens.checked ? "Ikke kontrolleret" : item.liens.count ? `${item.liens.count} hæftelse${item.liens.count === 1 ? "" : "r"}` : "Ingen"}
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
