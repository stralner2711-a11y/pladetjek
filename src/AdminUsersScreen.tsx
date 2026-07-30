import { useEffect, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  Search,
  ShieldAlert,
  UserCog,
  UsersRound,
  X,
} from "lucide-react";
import {
  adminListUsers,
  adminSetUserRole,
  adminSetUserStatus,
  type AccountStatus,
  type AdminUser,
  type MyProfile,
} from "./account-service";
import "./account.css";

type AdminUsersScreenProps = {
  currentProfile: MyProfile;
  onBack: () => void;
};

function displayName(user: AdminUser) {
  return user.username || user.email || `Midlertidig · ${user.userId.slice(0, 8)}`;
}

function formatDateTime(value: string | null) {
  if (!value) return "Aldrig";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("da-DK", { dateStyle: "medium", timeStyle: "short" });
}

export function AdminUsersScreen({ currentProfile, onBack }: AdminUsersScreenProps) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | AccountStatus>("all");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");

  async function loadUsers() {
    setLoading(true);
    setMessage("");
    try {
      const result = await adminListUsers(search, status);
      setUsers(result);
      setSelected((previous) => previous
        ? result.find((user) => user.userId === previous.userId) ?? null
        : null);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Brugerne kunne ikke indlæses.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadUsers(), 250);
    return () => window.clearTimeout(timer);
  }, [search, status]);

  async function changeStatus(nextStatus: AccountStatus) {
    if (!selected || working) return;
    setWorking(true);
    setMessage("");
    try {
      await adminSetUserStatus(selected.userId, nextStatus);
      await loadUsers();
      setMessage(nextStatus === "suspended" ? "Brugeren er suspenderet." : "Brugeren er aktiveret.");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Status kunne ikke ændres.");
    } finally {
      setWorking(false);
    }
  }

  async function changeRole(nextRole: "user" | "admin") {
    if (!selected || working) return;
    setWorking(true);
    setMessage("");
    try {
      await adminSetUserRole(selected.userId, nextRole);
      await loadUsers();
      setMessage(nextRole === "admin" ? "Brugeren er nu administrator." : "Administratorrollen er fjernet.");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Rollen kunne ikke ændres.");
    } finally {
      setWorking(false);
    }
  }

  const total = users[0]?.totalCount ?? users.length;

  return <section className="admin-page">
    <div className="admin-titlebar">
      <button type="button" onClick={onBack} aria-label="Tilbage"><ArrowLeft /></button>
      <div><p><LockKeyhole /> Kun creator og administratorer</p><h1>Brugerstyring</h1></div>
    </div>

    <div className="admin-toolbar">
      <div className="admin-search">
        <Search />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Søg brugernavn, e-mail eller bruger-id"
          aria-label="Søg brugere"
        />
      </div>
      <div className="admin-filters">
        <button className={status === "all" ? "active" : ""} onClick={() => setStatus("all")}>
          <UsersRound /> Alle <span>{total}</span>
        </button>
        <button className={status === "active" ? "active" : ""} onClick={() => setStatus("active")}>
          <i className="status-dot active" /> Aktive
        </button>
        <button className={status === "suspended" ? "active" : ""} onClick={() => setStatus("suspended")}>
          <i className="status-dot suspended" /> Suspenderede
        </button>
      </div>
    </div>

    <div className="admin-table-card">
      <div className="admin-table-head">
        <span>Bruger</span><span>Rolle</span><span>Status</span><span>Senest aktiv</span><span />
      </div>
      {loading
        ? <div className="admin-loading"><span className="large-spinner" /> Indlæser brugere…</div>
        : users.length === 0
          ? <div className="admin-loading">Ingen brugere matcher søgningen.</div>
          : users.map((user) =>
            <button
              type="button"
              className={`admin-user-row ${selected?.userId === user.userId ? "selected" : ""}`}
              key={user.userId}
              onClick={() => setSelected(user)}
            >
              <span>
                <strong>{displayName(user)}</strong>
                <small>{user.isAnonymous ? "Midlertidig anonym konto" : user.email}</small>
              </span>
              <span><i className={`role-badge role-${user.role}`}>{user.role === "creator" ? "Creator" : user.role === "admin" ? "Admin" : "Bruger"}</i></span>
              <span className={`status-label ${user.accountStatus}`}>
                <i className={`status-dot ${user.accountStatus}`} />
                {user.accountStatus === "active" ? "Aktiv" : "Suspenderet"}
              </span>
              <span>{formatDateTime(user.lastActiveAt)}</span>
              <ChevronRight />
            </button>)}
    </div>

    {message && <p className="account-message" role="status">{message}</p>}

    {selected &&
      <div className="admin-detail-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setSelected(null);
      }}>
        <aside className="admin-detail" role="dialog" aria-modal="true" aria-labelledby="admin-user-title">
          <div className="detail-handle" />
          <button className="detail-close" type="button" onClick={() => setSelected(null)}><X /> Luk</button>
          <div className="detail-person">
            <UserCog />
            <div>
              <h2 id="admin-user-title">{displayName(selected)}</h2>
              <span className={`role-badge role-${selected.role}`}>
                {selected.role === "creator" ? "Creator" : selected.role === "admin" ? "Admin" : "Bruger"}
              </span>
            </div>
          </div>
          <h3>Kontooplysninger</h3>
          <dl className="detail-list">
            <div><dt>E-mail</dt><dd>{selected.email || "Ingen · midlertidig anonym konto"} <LockKeyhole /></dd></div>
            <div><dt>Internt bruger-id</dt><dd>{selected.userId}</dd></div>
            <div><dt>Oprettet</dt><dd>{formatDateTime(selected.createdAt)}</dd></div>
            <div><dt>Senest logget ind</dt><dd>{formatDateTime(selected.lastSignInAt)}</dd></div>
            <div><dt>Senest aktiv</dt><dd>{formatDateTime(selected.lastActiveAt)}</dd></div>
            <div><dt>Synlighed</dt><dd>{selected.hideFromPeers ? <><EyeOff /> Anonym for andre</> : <><Eye /> {selected.username}</>}</dd></div>
            <div>
              <dt>Moderation</dt>
              <dd className={selected.accountStatus === "active" ? "success" : "danger"}>
                {selected.accountStatus === "active" ? <CheckCircle2 /> : <ShieldAlert />}
                {selected.accountStatus === "active" ? "Ingen restriktioner" : "Suspenderet"}
              </dd>
            </div>
          </dl>

          {currentProfile.role === "creator" && selected.role !== "creator" &&
            <div className="role-actions">
              <span><KeyRound /> Rolle</span>
              <button
                type="button"
                disabled={working || selected.role === "admin"}
                onClick={() => void changeRole("admin")}
              >
                Gør til admin
              </button>
              <button
                type="button"
                disabled={working || selected.role === "user"}
                onClick={() => void changeRole("user")}
              >
                Gør til bruger
              </button>
            </div>}

          {selected.userId !== currentProfile.userId && selected.role !== "creator" &&
            <div className="moderation-actions">
              <button
                className="suspend"
                type="button"
                disabled={working || selected.accountStatus === "suspended"}
                onClick={() => void changeStatus("suspended")}
              >
                <ShieldAlert /> Suspendér bruger
              </button>
              <button
                className="activate"
                type="button"
                disabled={working || selected.accountStatus === "active"}
                onClick={() => void changeStatus("active")}
              >
                <CheckCircle2 /> Aktivér bruger
              </button>
            </div>}
        </aside>
      </div>}
  </section>;
}
