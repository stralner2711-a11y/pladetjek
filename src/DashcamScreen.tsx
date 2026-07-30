import { useEffect, useRef, useState } from "react";
import {
  BellRing,
  Camera,
  Check,
  CircleStop,
  Link2,
  LoaderCircle,
  Play,
  Plus,
  Power,
  Radio,
  Router,
  Save,
  ScanLine,
  ShieldCheck,
  Smartphone,
  Trash2,
  TriangleAlert,
  Wifi,
} from "lucide-react";
import {
  connectDashcamWifi,
  dashcamIsSupported,
  getDashcamNetworkInfo,
  notifyDashcamEvent,
  openDashcamWifiSettings,
  prepareDashcamNotifications,
  startDashcam,
  stopDashcam,
  subscribeToDashcam,
  type DashcamFrame,
  type DashcamProtocol,
  type DashcamStatus,
} from "./dashcam-stream";
import {
  advancePlateEvidence,
  findBestPlateCandidate,
  type PlateEvidence,
} from "./plate-recognition";
import "./dashcam.css";

type DashcamProfile = {
  id: string;
  name: string;
  url: string;
  protocol: DashcamProtocol;
  username: string;
  ssid: string;
};

type DashcamScreenProps = {
  onPlateConfirmed: (plate: string) => void | Promise<void>;
};

const DASHCAM_PROFILES_KEY = "pladetjek:dashcam-profiles:v1";
const DASHCAM_ACTIVE_KEY = "pladetjek:dashcam-active-profile:v1";
const DASHCAM_MODE_KEY = "pladetjek:dashcam-mode-enabled:v1";

function loadProfiles(): DashcamProfile[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(DASHCAM_PROFILES_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((profile) => (
      typeof profile?.id === "string"
      && typeof profile?.name === "string"
      && typeof profile?.url === "string"
      && typeof profile?.protocol === "string"
    )).map((profile) => ({
      ...profile,
      ssid: typeof profile.ssid === "string" ? profile.ssid : "",
      username: typeof profile.username === "string" ? profile.username : "",
    })).slice(0, 20);
  } catch {
    return [];
  }
}

function createProfileId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `dashcam-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readableProtocol(protocol: DashcamProtocol | string) {
  if (protocol === "rtsp") return "RTSP";
  if (protocol === "hls") return "HLS";
  if (protocol === "mjpeg") return "MJPEG";
  if (protocol === "snapshot") return "JPEG-billeder";
  return "Automatisk";
}

function validStreamUrl(value: string) {
  return /^(rtsp|https?):\/\/[^\s]+$/i.test(value.trim());
}

export function DashcamScreen({ onPlateConfirmed }: DashcamScreenProps) {
  const supported = dashcamIsSupported();
  const [profiles, setProfiles] = useState<DashcamProfile[]>(loadProfiles);
  const [profileId, setProfileId] = useState(
    () => localStorage.getItem(DASHCAM_ACTIVE_KEY) ?? "",
  );
  const [modeEnabled, setModeEnabled] = useState(
    () => localStorage.getItem(DASHCAM_MODE_KEY) === "true",
  );
  const [name, setName] = useState("Mit dashcam");
  const [url, setUrl] = useState("");
  const [protocol, setProtocol] = useState<DashcamProtocol>("auto");
  const [ssid, setSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [username, setUsername] = useState("");
  const [streamPassword, setStreamPassword] = useState("");
  const [running, setRunning] = useState(false);
  const [working, setWorking] = useState(false);
  const [preview, setPreview] = useState("");
  const [status, setStatus] = useState<DashcamStatus>({
    state: "stopped",
    message: "Dashcam-scanningen er klar",
    protocol: "",
  });
  const [scannerText, setScannerText] = useState("Afventer videofeed");
  const [message, setMessage] = useState("");
  const evidenceRef = useRef<PlateEvidence | null>(null);
  const confirmedCooldownRef = useRef(new Map<string, number>());

  useEffect(() => {
    if (!supported || !modeEnabled) return;
    let removeListeners: () => void = () => undefined;
    let cancelled = false;

    void subscribeToDashcam(
      (frame) => {
        if (!cancelled) handleFrame(frame);
      },
      (nextStatus) => {
        if (cancelled) return;
        setStatus(nextStatus);
        if (nextStatus.state === "stopped") {
          setRunning(false);
        }
      },
    ).then((remove) => {
      if (cancelled) remove();
      else removeListeners = remove;
    });

    return () => {
      cancelled = true;
      removeListeners();
      void stopDashcam().catch(() => undefined);
    };
  }, [supported, modeEnabled]);

  useEffect(() => {
    localStorage.setItem(DASHCAM_PROFILES_KEY, JSON.stringify(profiles));
  }, [profiles]);

  useEffect(() => {
    if (!profileId) return;
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) return;
    setName(profile.name);
    setUrl(profile.url);
    setProtocol(profile.protocol);
    setSsid(profile.ssid);
    setUsername(profile.username);
    setWifiPassword("");
    setStreamPassword("");
  }, [profileId, profiles]);

  function handleFrame(frame: DashcamFrame) {
    setPreview(`data:image/jpeg;base64,${frame.imageBase64}`);
    const candidate = findBestPlateCandidate(frame);
    const update = advancePlateEvidence(evidenceRef.current, candidate, frame.capturedAt);
    evidenceRef.current = update.evidence;

    if (candidate && update.evidence && !update.confirmed) {
      setScannerText(
        `Kontrollerer ${candidate.plate} · `
        + `${update.evidence.hits}/${update.evidence.requiredHits}`,
      );
      return;
    }
    if (!candidate) {
      setScannerText("Scanner automatisk efter nummerplader…");
      return;
    }
    if (!update.confirmed) return;

    const cooldowns = confirmedCooldownRef.current;
    const lastSeenAt = cooldowns.get(candidate.plate) ?? 0;
    if (frame.capturedAt - lastSeenAt < 60_000) {
      evidenceRef.current = null;
      return;
    }
    cooldowns.set(candidate.plate, frame.capturedAt);
    for (const [knownPlate, knownAt] of cooldowns) {
      if (frame.capturedAt - knownAt > 10 * 60_000) {
        cooldowns.delete(knownPlate);
      }
    }
    evidenceRef.current = null;
    setScannerText(`Bekræftet ${candidate.plate} · lokal hændelse sendt`);
    void notifyDashcamEvent({
      plate: candidate.plate,
      title: "OBS · dashcam-hændelse",
      body: `Nummerplade ${candidate.plate} er registreret. Pladetjek kører offline.`,
    }).then((result) => {
      if (!result.shown && result.reason === "notification_permission") {
        setMessage("Pladen blev registreret, men notifikationer er ikke tilladt.");
      }
    }).catch(() => {
      setMessage(
        "Pladen blev registreret, men den lokale notifikation kunne ikke vises.",
      );
    });
    void onPlateConfirmed(candidate.plate);
  }

  async function start() {
    if (!supported || !validStreamUrl(url) || working) return;
    setWorking(true);
    setMessage("");
    setPreview("");
    evidenceRef.current = null;
    try {
      if (ssid.trim()) {
        setScannerText(`Forbinder til ${ssid.trim()}…`);
        const network = await connectDashcamWifi({
          ssid: ssid.trim(),
          password: wifiPassword,
        });
        if (!network.connected) {
          throw new Error("Android kunne ikke binde appen til dashcamets Wi‑Fi.");
        }
      }
      const notifications = await prepareDashcamNotifications();
      if (!notifications.granted) {
        setMessage(
          "Scanning starter, men lokale hændelser kan ikke vises, før notifikationer tillades.",
        );
      }
      const started = await startDashcam({
        url: url.trim(),
        protocol,
        username: username.trim(),
        password: streamPassword,
      });
      setRunning(started.started);
      setScannerText("Forbinder til videofeed…");
    } catch (caught) {
      await stopDashcam().catch(() => undefined);
      setMessage(caught instanceof Error ? caught.message : "Dashcamet kunne ikke startes.");
      setRunning(false);
    } finally {
      setWorking(false);
    }
  }

  async function stop() {
    if (working) return;
    setWorking(true);
    try {
      await stopDashcam();
      setRunning(false);
      setPreview("");
      setScannerText("Afventer videofeed");
      evidenceRef.current = null;
    } finally {
      setWorking(false);
    }
  }

  async function toggleMode() {
    if (working) return;
    const nextEnabled = !modeEnabled;
    if (!nextEnabled && supported) {
      setWorking(true);
      try {
        await stopDashcam();
        setRunning(false);
        setPreview("");
        setScannerText("Afventer videofeed");
        evidenceRef.current = null;
      } finally {
        setWorking(false);
      }
    }
    localStorage.setItem(DASHCAM_MODE_KEY, String(nextEnabled));
    setModeEnabled(nextEnabled);
    setMessage("");
  }

  function saveProfile() {
    if (!validStreamUrl(url) || name.trim().length < 2) {
      setMessage("Giv profilen et navn, og indtast en gyldig streamadresse.");
      return;
    }
    const id = profileId || createProfileId();
    const profile: DashcamProfile = {
      id,
      name: name.trim(),
      url: url.trim(),
      protocol,
      username: username.trim(),
      ssid: ssid.trim(),
    };
    setProfiles((current) => [
      profile,
      ...current.filter((item) => item.id !== id),
    ].slice(0, 20));
    setProfileId(id);
    localStorage.setItem(DASHCAM_ACTIVE_KEY, id);
    setMessage("Dashcamprofilen er gemt lokalt. Adgangskoder gemmes ikke.");
  }

  function newProfile() {
    setProfileId("");
    localStorage.removeItem(DASHCAM_ACTIVE_KEY);
    setName("Mit dashcam");
    setUrl("");
    setProtocol("auto");
    setSsid("");
    setWifiPassword("");
    setUsername("");
    setStreamPassword("");
    setMessage("");
  }

  function deleteProfile(id: string) {
    setProfiles((current) => current.filter((item) => item.id !== id));
    if (profileId === id) newProfile();
  }

  async function useCurrentGateway() {
    if (!supported) return;
    setMessage("");
    try {
      const network = await getDashcamNetworkInfo();
      if (!network.wifiEnabled) {
        setMessage("Wi-Fi er slået fra. Åbn Wi-Fi og forbind til dashcamet først.");
        return;
      }
      if (!network.gateway) {
        setMessage("Dashcamets netværksadresse kunne ikke findes automatisk.");
        return;
      }
      setUrl(`http://${network.gateway}/`);
      setProtocol("auto");
      setMessage(
        `Netværkets kameraadresse ${network.gateway} er indsat. `
        + "Tilføj eventuelt producentens streamsti.",
      );
    } catch {
      setMessage("Netværksadressen kunne ikke læses.");
    }
  }

  return <section className="dashcam-page">
    <div className="dashcam-title">
      <div>
        <p><Radio /> AUTOMATISK LIVE-SCANNING</p>
        <h1>Dashcam</h1>
      </div>
      <span className={`dashcam-connection ${status.state}`}>
        <i /> {status.message}
      </span>
    </div>

    <div className={`dashcam-mode-card ${modeEnabled ? "enabled" : ""}`}>
      <span className="dashcam-mode-icon">
        {modeEnabled ? <Wifi /> : <Smartphone />}
      </span>
      <div>
        <strong>Dashcam-tilstand</strong>
        <p>
          {modeEnabled
            ? "Aktivér først forbindelsen, når du vil bruge kameraets lokale Wi‑Fi."
            : "Slå kun funktionen til ved dashcam-kørsel. Mobilscanneren virker fortsat under Scanner."}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={modeEnabled}
        className={modeEnabled ? "active" : ""}
        onClick={() => void toggleMode()}
        disabled={working}
      >
        <Power /> {modeEnabled ? "Slå fra" : "Slå til"}
      </button>
    </div>

    {!modeEnabled &&
      <div className="dashcam-disabled-card">
        <Smartphone />
        <div>
          <h2>Mobilscanneren er stadig aktiv</h2>
          <p>
            Brug fanen Scanner som normalt. Dashcamet overtager først Wi‑Fi-forbindelsen,
            når du selv slår tilstanden til og trykker Start.
          </p>
        </div>
      </div>}

    {modeEnabled && <>
    <div className="dashcam-grid">
      <div className="dashcam-live-card">
        <div className="dashcam-live-head">
          <span><Camera /> Livevisning</span>
          <i>{status.protocol ? readableProtocol(status.protocol) : "Ingen kilde"}</i>
        </div>
        <div className="dashcam-stage">
          {preview
            ? <img src={preview} alt="Livebillede fra dashcam" />
            : <div className="dashcam-placeholder">
                {working || status.state === "connecting"
                  ? <LoaderCircle className="rotating" />
                  : <Router />}
                <strong>{supported ? "Forbind et dashcam" : "Kræver Android-appen"}</strong>
                <p>
                  {supported
                    ? "Forbind telefonen til kameraets Wi‑Fi og start en gemt profil."
                    : "Live dashcam-feed og automatisk OCR kører kun i APK-versionen."}
                </p>
              </div>}
          {preview && <div className="dashcam-scan-zone"><span /><span /><span /><span /></div>}
          {running &&
            <div className="dashcam-live-badge"><i /> LIVE · OCR AKTIV</div>}
          <div className="dashcam-recognition"><ScanLine /> {scannerText}</div>
        </div>
        <div className="dashcam-controls">
          <button
            className="dashcam-start"
            disabled={!supported || !validStreamUrl(url) || running || working}
            onClick={() => void start()}
          >
            {working && !running ? <LoaderCircle className="rotating" /> : <Play />}
            Start automatisk scanning
          </button>
          <button
            className="dashcam-stop"
            disabled={!running || working}
            onClick={() => void stop()}
          >
            <CircleStop /> Stop
          </button>
        </div>
        <p className="dashcam-live-note">
          <ShieldCheck /> OCR og alarm kører direkte på telefonen uden internet. Pladerne
          gemmes ikke i appens historik.
        </p>
        <div className="dashcam-offline-features">
          <span><BellRing /> Lokal alarm</span>
          <span><Smartphone /> Skærm holdes tændt</span>
          <span><Wifi /> App-bundet Wi‑Fi</span>
        </div>
      </div>

      <div className="dashcam-setup-card">
        <div className="dashcam-setup-head">
          <div><Link2 /><span><h2>Forbindelse</h2><p>Åbne streamstandarder · alle kompatible mærker</p></span></div>
          <button onClick={newProfile}><Plus /> Ny</button>
        </div>

        <label htmlFor="dashcam-name">Profilnavn</label>
        <input
          id="dashcam-name"
          value={name}
          maxLength={40}
          onChange={(event) => setName(event.target.value)}
          placeholder="Fx Frontkamera"
        />

        <div className="dashcam-section-label">Dashcamets Wi‑Fi</div>
        <div className="dashcam-auth-grid">
          <div>
            <label htmlFor="dashcam-ssid">Netværksnavn (SSID)</label>
            <input
              id="dashcam-ssid"
              value={ssid}
              onChange={(event) => setSsid(event.target.value)}
              placeholder="Fx DASHCAM_1234"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div>
            <label htmlFor="dashcam-wifi-password">Wi‑Fi-kode</label>
            <input
              id="dashcam-wifi-password"
              type="password"
              value={wifiPassword}
              onChange={(event) => setWifiPassword(event.target.value)}
              placeholder="Tom ved åbent netværk"
              autoComplete="off"
            />
          </div>
        </div>
        <p className="dashcam-field-note">
          Android viser en sikker systemdialog første gang. Wi‑Fi-koden gemmes ikke.
        </p>

        <div className="dashcam-section-label">Videofeed</div>
        <label htmlFor="dashcam-protocol">Videostandard</label>
        <select
          id="dashcam-protocol"
          value={protocol}
          onChange={(event) => setProtocol(event.target.value as DashcamProtocol)}
        >
          <option value="auto">Automatisk registrering</option>
          <option value="rtsp">RTSP</option>
          <option value="hls">HLS / M3U8</option>
          <option value="mjpeg">MJPEG</option>
          <option value="snapshot">Gentagne JPEG-billeder</option>
        </select>

        <label htmlFor="dashcam-url">Streamadresse</label>
        <input
          id="dashcam-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="rtsp://192.168.1.254/live"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
        />
        <div className="dashcam-network-actions">
          <button disabled={!supported} onClick={() => void openDashcamWifiSettings()}>
            <Wifi /> Åbn Wi‑Fi
          </button>
          <button disabled={!supported} onClick={() => void useCurrentGateway()}>
            <Router /> Brug kameraets netværk
          </button>
        </div>

        <div className="dashcam-auth-grid">
          <div>
            <label htmlFor="dashcam-username">Stream-brugernavn</label>
            <input
              id="dashcam-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoCapitalize="none"
              autoComplete="username"
            />
          </div>
          <div>
            <label htmlFor="dashcam-password">Stream-adgangskode</label>
            <input
              id="dashcam-password"
              type="password"
              value={streamPassword}
              onChange={(event) => setStreamPassword(event.target.value)}
              autoComplete="current-password"
            />
          </div>
        </div>
        <button className="dashcam-save" onClick={saveProfile}>
          <Save /> Gem profil lokalt
        </button>
        {message && <p className="dashcam-message" role="status">{message}</p>}

        <div className="dashcam-formats">
          {(["rtsp", "hls", "mjpeg", "snapshot"] as DashcamProtocol[]).map((item) =>
            <span key={item}><Check /> {readableProtocol(item)}</span>)}
        </div>
      </div>
    </div>

    <div className="dashcam-profiles">
      <div className="dashcam-profiles-head">
        <div><h2>Gemte dashcams</h2><p>Profilerne gemmes kun på denne telefon</p></div>
        <span>{profiles.length} profiler</span>
      </div>
      {profiles.length === 0
        ? <div className="dashcam-profile-empty">
            <Router /> Gem kameraets streamadresse for hurtig tilslutning næste gang.
          </div>
        : <div className="dashcam-profile-list">{profiles.map((profile) =>
            <article className={profile.id === profileId ? "active" : ""} key={profile.id}>
              <button className="dashcam-profile-select" onClick={() => {
                setProfileId(profile.id);
                localStorage.setItem(DASHCAM_ACTIVE_KEY, profile.id);
              }}>
                <Radio />
                <span>
                  <strong>{profile.name}</strong>
                  <small>
                    {profile.ssid ? `${profile.ssid} · ` : ""}
                    {readableProtocol(profile.protocol)} · {profile.url}
                  </small>
                </span>
              </button>
              <button
                className="dashcam-profile-delete"
                onClick={() => deleteProfile(profile.id)}
                aria-label={`Slet ${profile.name}`}
              ><Trash2 /></button>
            </article>)}</div>}
    </div>

    <div className="dashcam-warning">
      <TriangleAlert />
      <p>
        Opsæt kamera og scanning, mens bilen holder stille. Proprietære eller krypterede
        producentfeeds kræver en særskilt adapter, men kan tilføjes som nye profiler senere.
      </p>
    </div>
    </>}
  </section>;
}
