import { useEffect, useState } from "react";
import {
  AtSign,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  LogOut,
  Mail,
  ShieldCheck,
  UserRound,
  UsersRound,
} from "lucide-react";
import {
  accountsAreConfigured,
  saveMyProfile,
  sendMagicLink,
  signOutToAnonymous,
  type MyProfile,
} from "./account-service";
import { NearbyAlertsCard } from "./NearbyAlertsCard";
import "./account.css";

type AccountScreenProps = {
  profile: MyProfile | null;
  loading: boolean;
  onProfileChange: (profile: MyProfile) => void;
  onOpenAdmin: () => void;
};

export function AccountScreen({
  profile,
  loading,
  onProfileChange,
  onOpenAdmin,
}: AccountScreenProps) {
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [hideFromPeers, setHideFromPeers] = useState(true);
  const [working, setWorking] = useState(false);
  const [linkSent, setLinkSent] = useState(false);
  const [message, setMessage] = useState("");

  const permanentAccount = Boolean(profile && !profile.isAnonymous && profile.email);
  const privileged = profile?.role === "admin" || profile?.role === "creator";

  useEffect(() => {
    setUsername(profile?.username ?? "");
    setHideFromPeers(profile?.hideFromPeers ?? true);
  }, [profile?.userId, profile?.username, profile?.hideFromPeers]);

  async function requestLink() {
    if (!email.trim() || working) return;
    setWorking(true);
    setMessage("");
    try {
      await sendMagicLink(email, mode === "signup");
      setLinkSent(true);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Loginlinket kunne ikke sendes.");
    } finally {
      setWorking(false);
    }
  }

  async function saveProfile() {
    if (working) return;
    setWorking(true);
    setMessage("");
    try {
      const saved = await saveMyProfile(username, hideFromPeers);
      onProfileChange(saved);
      setMessage("Profilen er gemt.");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Profilen kunne ikke gemmes.");
    } finally {
      setWorking(false);
    }
  }

  async function logOut() {
    if (working) return;
    setWorking(true);
    setMessage("");
    try {
      const anonymousProfile = await signOutToAnonymous();
      onProfileChange(anonymousProfile);
      setLinkSent(false);
      setEmail("");
      setMessage("Du er logget ud. Appen fortsætter anonymt.");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Du kunne ikke logges ud.");
    } finally {
      setWorking(false);
    }
  }

  if (!accountsAreConfigured()) {
    return <section className="account-page">
      <div className="account-title">
        <div><p>Privat profil</p><h1>Din konto</h1></div>
      </div>
      <div className="account-card account-empty">
        <ShieldCheck />
        <h2>Brugertjenesten mangler</h2>
        <p>Supabase skal forbindes, før konti kan bruges.</p>
      </div>
    </section>;
  }

  return <section className="account-page">
    <div className="account-title">
      <div><p>Privat profil</p><h1>Din konto</h1></div>
      <span><ShieldCheck /> Beskyttet i Supabase</span>
    </div>

    {loading && !profile
      ? <div className="account-card account-empty"><span className="large-spinner" /><p>Indlæser din konto…</p></div>
      : permanentAccount
        ? <>
          <div className={`account-state ${profile?.accountStatus === "active" ? "is-active" : "is-suspended"}`}>
            <ShieldCheck />
            <div>
              <strong>{profile?.accountStatus === "active" ? "Konto beskyttet" : "Konto suspenderet"}</strong>
              <p>
                {profile?.accountStatus === "active"
                  ? "Din e-mail og dit interne bruger-id vises aldrig til almindelige brugere."
                  : "Fælles advarsler er deaktiveret. Kontakt en administrator."}
              </p>
            </div>
            <span className={`role-badge role-${profile?.role}`}>
              {profile?.role === "creator" ? "Creator" : profile?.role === "admin" ? "Admin" : "Bruger"}
            </span>
          </div>

          <div className="account-grid">
            <form className="account-card profile-editor" onSubmit={(event) => {
              event.preventDefault();
              void saveProfile();
            }}>
              <div className="card-heading">
                <UserRound />
                <div><h2>Offentlig profil</h2><p>Du bestemmer selv, hvad andre brugere ser.</p></div>
              </div>

              <label htmlFor="profile-username">Brugernavn</label>
              <div className="account-input">
                <AtSign />
                <input
                  id="profile-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="Vælg et unikt brugernavn"
                  minLength={3}
                  maxLength={24}
                  autoComplete="username"
                />
              </div>
              <small>3–24 bogstaver, tal eller understregninger.</small>

              <fieldset className="privacy-choice">
                <legend>Synlighed ved dine advarsler</legend>
                <button
                  type="button"
                  className={!hideFromPeers ? "selected" : ""}
                  onClick={() => setHideFromPeers(false)}
                >
                  <Eye /><span><strong>Vis mit brugernavn</strong><small>Andre ser kun brugernavnet.</small></span>
                </button>
                <button
                  type="button"
                  className={hideFromPeers ? "selected" : ""}
                  onClick={() => setHideFromPeers(true)}
                >
                  <EyeOff /><span><strong>Vær anonym for andre</strong><small>Andre ser “Anonym bruger”.</small></span>
                </button>
              </fieldset>

              <div className="admin-visibility-note">
                <ShieldCheck />
                <span>Creator og administratorer kan se din konto for at håndtere misbrug.</span>
              </div>

              <button
                className="account-primary"
                type="submit"
                disabled={working || profile?.accountStatus !== "active"}
              >
                {working ? <span className="spinner" /> : <CheckCircle2 />}
                {working ? "Gemmer…" : "Gem profil"}
              </button>
            </form>

            <aside className="account-card private-details">
              <div className="card-heading">
                <KeyRound />
                <div><h2>Private kontooplysninger</h2><p>Kun dig, creator og administratorer.</p></div>
              </div>
              <dl>
                <div><dt><Mail /> Din e-mail</dt><dd>{profile?.email}</dd></div>
                <div><dt><KeyRound /> Internt bruger-id</dt><dd>{profile?.userId}</dd></div>
                <div>
                  <dt>{hideFromPeers ? <EyeOff /> : <Eye />} Synlighed</dt>
                  <dd>{hideFromPeers ? "Anonym for andre" : username || "Brugernavn ikke valgt"}</dd>
                </div>
              </dl>

              {privileged &&
                <button className="admin-entry" type="button" onClick={onOpenAdmin}>
                  <UsersRound />
                  <span><strong>Åbn brugerstyring</strong><small>Søg, suspendér og administrér roller.</small></span>
                </button>}

              <button className="account-logout" type="button" onClick={() => void logOut()} disabled={working}>
                <LogOut /> Log ud
              </button>
            </aside>
          </div>
        </>
        : <div className="account-card auth-card">
          <div className="auth-tabs" role="tablist" aria-label="Kontoadgang">
            <button
              type="button"
              className={mode === "login" ? "active" : ""}
              onClick={() => { setMode("login"); setLinkSent(false); setMessage(""); }}
            >
              Log ind
            </button>
            <button
              type="button"
              className={mode === "signup" ? "active" : ""}
              onClick={() => { setMode("signup"); setLinkSent(false); setMessage(""); }}
            >
              Opret bruger
            </button>
          </div>
          <div className="auth-copy">
            <div className="card-heading">
              <Mail />
              <div>
                <h2>{mode === "signup" ? "Opret din private konto" : "Log ind på din konto"}</h2>
                <p>
                  {mode === "signup"
                    ? "Din nuværende anonyme konto og historik bevares. Du bekræfter den med et sikkert engangslink."
                    : "Ingen adgangskode. Du modtager et sikkert engangslink til din eksisterende konto."}
                </p>
              </div>
            </div>
            <label htmlFor="account-email">E-mail</label>
            <div className="account-input">
              <Mail />
              <input
                id="account-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="din@email.dk"
                autoComplete="email"
              />
            </div>
            <button
              className="account-primary"
              type="button"
              disabled={!email.trim() || working}
              onClick={() => void requestLink()}
            >
              {working ? <span className="spinner" /> : <Mail />}
              {working
                ? "Sender…"
                : mode === "signup"
                  ? "Send bekræftelseslink"
                  : "Send sikkert loginlink"}
            </button>
            {linkSent &&
              <div className="link-sent" role="status">
                <CheckCircle2 />
                <div>
                  <strong>{mode === "signup" ? "Bekræftelseslink sendt" : "Loginlink sendt"}</strong>
                  <p>Åbn linket i din e-mail for at vende tilbage til Pladetjek.</p>
                </div>
              </div>}
            <div className="admin-visibility-note">
              <ShieldCheck />
              <span>
                Andre brugere ser aldrig din e-mail. Når kontoen er oprettet, vælger du selv
                brugernavn eller fuld anonymitet.
              </span>
            </div>
          </div>
        </div>}

    {profile &&
      <NearbyAlertsCard suspended={profile.accountStatus !== "active"} />}

    {message && <p className="account-message" role="status">{message}</p>}
  </section>;
}
