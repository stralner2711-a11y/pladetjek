import { useEffect, useState } from "react";
import {
  Ban,
  CheckCircle2,
  ClipboardCheck,
  FileClock,
  Flag,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import {
  adminListAlertReports,
  adminListAlerts,
  adminListModerationAudit,
  adminResolveAlertReport,
  adminSetAlertStatus,
  type AdminAlert,
  type AdminAlertReport,
  type AdminAuditEntry,
} from "./account-service";

export type AdminRegistrySection = "alerts" | "reports" | "audit";

function displayPlate(value: string) {
  const compact = value.toUpperCase().replace(/[^A-ZÆØÅ0-9]/g, "");
  return `${compact.slice(0, 2)} ${compact.slice(2, 4)} ${compact.slice(4)}`.trim();
}

function formatDateTime(value: string | null) {
  if (!value) return "Aldrig";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("da-DK", { dateStyle: "medium", timeStyle: "short" });
}

function auditLabel(action: string) {
  if (action === "user_status_changed") return "Brugerstatus ændret";
  if (action === "user_role_changed") return "Brugerrolle ændret";
  if (action === "alert_status_changed") return "Advarselsstatus ændret";
  if (action === "alert_report_resolved") return "Fejlrapport behandlet";
  return action;
}

export function AdminRegistryPanel({ section }: { section: AdminRegistrySection }) {
  const [alerts, setAlerts] = useState<AdminAlert[]>([]);
  const [reports, setReports] = useState<AdminAlertReport[]>([]);
  const [audit, setAudit] = useState<AdminAuditEntry[]>([]);
  const [search, setSearch] = useState("");
  const [alertStatus, setAlertStatus] = useState<"all" | "active" | "inactive">("all");
  const [reportStatus, setReportStatus] = useState<"all" | "pending" | "confirmed" | "dismissed">("pending");
  const [resolutionNotes, setResolutionNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    setLoading(true);
    setMessage("");
    try {
      if (section === "alerts") setAlerts(await adminListAlerts(search, alertStatus));
      if (section === "reports") setReports(await adminListAlertReports(reportStatus));
      if (section === "audit") setAudit(await adminListModerationAudit());
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Admin-data kunne ikke indlæses.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 220);
    return () => window.clearTimeout(timer);
  }, [section, search, alertStatus, reportStatus]);

  async function changeAlertStatus(alert: AdminAlert) {
    setWorkingId(alert.alertId);
    setMessage("");
    try {
      await adminSetAlertStatus(
        alert.alertId,
        !alert.isActive,
        alert.isActive ? "Deaktiveret manuelt i adminpanelet" : "Genaktiveret manuelt i adminpanelet",
      );
      await load();
      setMessage(alert.isActive ? "Advarslen er deaktiveret." : "Advarslen er genaktiveret.");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Status kunne ikke ændres.");
    } finally {
      setWorkingId("");
    }
  }

  async function resolveReport(
    report: AdminAlertReport,
    resolution: "confirmed" | "dismissed",
  ) {
    const note = (resolutionNotes[report.reportId] ?? "").trim();
    if (note.length < 3) {
      setMessage("Skriv en kort begrundelse på mindst 3 tegn.");
      return;
    }
    setWorkingId(report.reportId);
    setMessage("");
    try {
      await adminResolveAlertReport(report.reportId, resolution, note);
      await load();
      setMessage(
        resolution === "confirmed"
          ? "Rapporten er bekræftet, og advarslen er deaktiveret."
          : "Rapporten er afvist, og advarslen forbliver aktiv.",
      );
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Rapporten kunne ikke behandles.");
    } finally {
      setWorkingId("");
    }
  }

  return <div className="admin-registry-panel">
    {section === "alerts" &&
      <>
        <div className="admin-toolbar">
          <div className="admin-search">
            <Search />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Søg nummerplade, beskrivelse eller bruger"
              aria-label="Søg advarsler"
            />
          </div>
          <div className="admin-filters">
            {(["all", "active", "inactive"] as const).map((value) =>
              <button
                key={value}
                className={alertStatus === value ? "active" : ""}
                onClick={() => setAlertStatus(value)}
              >
                {value === "all" ? "Alle" : value === "active" ? "Aktive" : "Deaktiverede"}
              </button>)}
          </div>
        </div>
        <div className="admin-registry-list">
          {loading
            ? <div className="admin-loading"><span className="large-spinner" /> Indlæser advarsler…</div>
            : alerts.length === 0
              ? <div className="admin-loading">Ingen advarsler matcher.</div>
              : alerts.map((alert) =>
                <article className="admin-alert-card" key={alert.alertId}>
                  <div className="admin-alert-plate">
                    <strong>{displayPlate(alert.plate)}</strong>
                    <span className={alert.isActive ? "success" : "danger"}>
                      {alert.isActive ? "Aktiv" : "Deaktiveret"}
                    </span>
                  </div>
                  <p>{alert.description}</p>
                  <dl>
                    <div><dt>Indsender</dt><dd>{alert.reporterUsername || alert.reporterEmail || alert.reporterId}</dd></div>
                    <div><dt>Observationer</dt><dd>{alert.observationCount} · {alert.distinctReporterCount} brugere</dd></div>
                    <div><dt>Fejlrapporter</dt><dd>{alert.reportCount}</dd></div>
                    <div><dt>Troværdighed</dt><dd>{alert.reputationScore}/100</dd></div>
                  </dl>
                  <button
                    className={alert.isActive ? "admin-danger-action" : "admin-safe-action"}
                    disabled={workingId === alert.alertId}
                    onClick={() => void changeAlertStatus(alert)}
                  >
                    {alert.isActive ? <Ban /> : <CheckCircle2 />}
                    {alert.isActive ? "Deaktivér" : "Genaktivér"}
                  </button>
                </article>)}
        </div>
      </>}

    {section === "reports" &&
      <>
        <div className="admin-toolbar admin-report-toolbar">
          <div><Flag /> Moderationskø</div>
          <div className="admin-filters">
            {(["pending", "confirmed", "dismissed", "all"] as const).map((value) =>
              <button
                key={value}
                className={reportStatus === value ? "active" : ""}
                onClick={() => setReportStatus(value)}
              >
                {value === "pending" ? "Afventer" : value === "confirmed" ? "Bekræftede" : value === "dismissed" ? "Afviste" : "Alle"}
              </button>)}
          </div>
        </div>
        <div className="admin-report-list">
          {loading
            ? <div className="admin-loading"><span className="large-spinner" /> Indlæser rapporter…</div>
            : reports.length === 0
              ? <div className="admin-loading">Ingen rapporter i denne kø.</div>
              : reports.map((report) =>
                <article className="admin-report-card" key={report.reportId}>
                  <header>
                    <div><strong>{displayPlate(report.plate)}</strong><span>{formatDateTime(report.createdAt)}</span></div>
                    <i className={`report-state ${report.reportStatus}`}>{report.reportStatus}</i>
                  </header>
                  <div className="reported-observation">
                    <small>Advarsel</small>
                    <p>{report.alertDescription}</p>
                  </div>
                  <div className="report-reason">
                    <small>Brugerens begrundelse</small>
                    <p>{report.reason}</p>
                  </div>
                  <dl>
                    <div><dt>Advarsel oprettet af</dt><dd>{report.alertReporterEmail || report.alertReporterId}</dd></div>
                    <div><dt>Rapporteret af</dt><dd>{report.reportedByEmail || report.reportedBy}</dd></div>
                  </dl>
                  {report.reportStatus === "pending"
                    ? <>
                      <textarea
                        value={resolutionNotes[report.reportId] ?? ""}
                        onChange={(event) => setResolutionNotes((current) => ({
                          ...current,
                          [report.reportId]: event.target.value,
                        }))}
                        placeholder="Admin-begrundelse"
                        maxLength={500}
                      />
                      <div className="report-actions">
                        <button
                          className="confirm-report"
                          disabled={workingId === report.reportId}
                          onClick={() => void resolveReport(report, "confirmed")}
                        >
                          <ClipboardCheck /> Bekræft fejl
                        </button>
                        <button
                          className="dismiss-report"
                          disabled={workingId === report.reportId}
                          onClick={() => void resolveReport(report, "dismissed")}
                        >
                          <ShieldCheck /> Afvis rapport
                        </button>
                      </div>
                    </>
                    : <p className="resolution-note"><strong>Afgørelse:</strong> {report.resolutionNote}</p>}
                </article>)}
        </div>
      </>}

    {section === "audit" &&
      <div className="admin-audit-card">
        <header><FileClock /><div><h2>Revisionshistorik</h2><p>Administrative ændringer kan ikke skjules i klienten.</p></div><button onClick={() => void load()}><RefreshCw /></button></header>
        {loading
          ? <div className="admin-loading"><span className="large-spinner" /> Indlæser historik…</div>
          : audit.length === 0
            ? <div className="admin-loading">Ingen administrative ændringer endnu.</div>
            : <ol>{audit.map((entry) =>
              <li key={entry.auditId}>
                <span><FileClock /></span>
                <div>
                  <strong>{auditLabel(entry.action)}</strong>
                  <p>{entry.actorEmail || entry.actorId || "System"}</p>
                  <small>{formatDateTime(entry.createdAt)} · {entry.targetType}</small>
                </div>
              </li>)}</ol>}
      </div>}

    {message && <p className="account-message" role="status">{message}</p>}
  </div>;
}
