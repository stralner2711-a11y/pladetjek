import { useEffect, useState } from "react";
import { BellRing, LocateFixed, MapPin, ShieldCheck } from "lucide-react";
import {
  disableNearbyAlerts,
  enableNearbyAlerts,
  getNearbyAlertStatus,
  type NearbyAlertStatus,
} from "./nearby-alerts";

const INITIAL_STATUS: NearbyAlertStatus = {
  supported: true,
  enabled: false,
  lastLocationAt: null,
  message: "Kontrollerer nærhedsadvarsler…",
};

function formatUpdatedAt(value: string | null) {
  if (!value) return "Ingen position gemt";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Positionen er registreret";
  return `Position opdateret ${date.toLocaleTimeString("da-DK", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export function NearbyAlertsCard({ suspended }: { suspended: boolean }) {
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getNearbyAlertStatus().then((nextStatus) => {
      if (!cancelled) setStatus(nextStatus);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle() {
    if (working || suspended || !status.supported) return;
    setWorking(true);
    try {
      setStatus(status.enabled
        ? await disableNearbyAlerts()
        : await enableNearbyAlerts());
    } finally {
      setWorking(false);
    }
  }

  return <section className={`account-card nearby-card ${status.enabled ? "is-enabled" : ""}`}>
    <div className="nearby-card-copy">
      <div className="nearby-symbol"><BellRing /></div>
      <div>
        <p className="nearby-overline">Match i nærheden</p>
        <h2>OBS-notifikationer inden for 5 km</h2>
        <p>
          Ved et præcist nummerpladematch får aktive telefoner i nærheden beskeden
          “OBS – osten lugter i nærheden af dig”.
        </p>
      </div>
    </div>

    <div className="nearby-status">
      <span className={status.enabled ? "enabled-dot" : "disabled-dot"} />
      <div>
        <strong>{status.enabled ? "Aktiveret" : "Deaktiveret"}</strong>
        <p>{status.message}</p>
        {status.enabled && <small><LocateFixed /> {formatUpdatedAt(status.lastLocationAt)}</small>}
      </div>
    </div>

    <div className="nearby-privacy">
      <MapPin />
      <p>
        GPS-positionen bruges privat til radiusberegningen og udløber efter 30 minutter.
        Modtageren ser kun afstand, tidspunkt og et område afrundet til cirka 100–200 meter.
      </p>
      <ShieldCheck />
    </div>

    <button
      className={`nearby-toggle ${status.enabled ? "turn-off" : ""}`}
      type="button"
      onClick={() => void toggle()}
      disabled={working || suspended || !status.supported}
    >
      {working ? <span className="spinner" /> : <BellRing />}
      {working
        ? "Arbejder…"
        : status.enabled
          ? "Slå nærhedsadvarsler fra"
          : "Aktivér lokation og notifikationer"}
    </button>
  </section>;
}
