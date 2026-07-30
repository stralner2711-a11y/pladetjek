import { App as CapacitorApp, type URLOpenListenerEvent } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { parseAuthCallback } from "./auth-callback";
import {
  requireAuthenticatedClient,
  supabaseClient,
  supabaseIsConfigured,
} from "./supabase-client";

export type AccountRole = "user" | "admin" | "creator";
export type AccountStatus = "active" | "suspended";

export type MyProfile = {
  userId: string;
  email: string | null;
  username: string | null;
  hideFromPeers: boolean;
  role: AccountRole;
  accountStatus: AccountStatus;
  createdAt: string;
  lastActiveAt: string;
  isAnonymous: boolean;
};

export type AdminUser = MyProfile & {
  lastSignInAt: string | null;
  totalCount: number;
  reputationScore: number;
  trustLevel: "trusted" | "established" | "watch";
  alertCount: number;
  pendingReportCount: number;
};

export type AdminAlert = {
  alertId: string;
  plate: string;
  description: string;
  reporterId: string;
  reporterEmail: string | null;
  reporterUsername: string | null;
  isActive: boolean;
  createdAt: string;
  observationCount: number;
  distinctReporterCount: number;
  reportCount: number;
  reputationScore: number;
  totalCount: number;
};

export type AdminAlertReport = {
  reportId: string;
  reportStatus: "pending" | "confirmed" | "dismissed";
  reason: string;
  createdAt: string;
  reviewedAt: string | null;
  resolutionNote: string | null;
  alertId: string;
  plate: string;
  alertDescription: string;
  alertIsActive: boolean;
  alertReporterId: string;
  alertReporterEmail: string | null;
  reportedBy: string;
  reportedByEmail: string | null;
  totalCount: number;
};

export type AdminAuditEntry = {
  auditId: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: "user" | "alert" | "report";
  targetUserId: string | null;
  targetAlertId: string | null;
  targetReportId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

type ProfileRow = {
  user_id: string;
  email: string | null;
  username: string | null;
  hide_from_peers: boolean;
  role: AccountRole;
  account_status: AccountStatus;
  created_at: string;
  last_active_at: string;
  is_anonymous: boolean;
  last_sign_in_at?: string | null;
  total_count?: number | string;
  reputation_score?: number | string;
  trust_level?: "trusted" | "established" | "watch";
  alert_count?: number | string;
  pending_report_count?: number | string;
};

const NATIVE_LOGIN_REDIRECT = "dk.pladetjek.app://login-callback";

function mapProfile(row: ProfileRow): MyProfile {
  return {
    userId: row.user_id,
    email: row.email,
    username: row.username,
    hideFromPeers: row.hide_from_peers,
    role: row.role,
    accountStatus: row.account_status,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    isAnonymous: row.is_anonymous,
  };
}

function readableAccountError(message: string) {
  if (message.includes("USERNAME_TAKEN")) return "Brugernavnet er allerede taget.";
  if (message.includes("INVALID_USERNAME")) {
    return "Brug 3–24 bogstaver, tal eller understregninger i brugernavnet.";
  }
  if (message.includes("PERMANENT_ACCOUNT_REQUIRED")) {
    return "Opret eller log ind på en permanent konto først.";
  }
  if (message.includes("ACCOUNT_SUSPENDED")) return "Kontoen er suspenderet.";
  if (message.includes("ADMIN_REQUIRED")) return "Du har ikke adgang til brugerstyringen.";
  if (message.includes("CREATOR_REQUIRED")) return "Kun creator kan ændre denne bruger.";
  if (message.includes("PROTECTED_ACCOUNT")) return "Denne konto er beskyttet.";
  if (message.includes("USER_NOT_FOUND")) return "Brugeren findes ikke længere.";
  if (message.includes("ALERT_NOT_FOUND")) return "Advarslen findes ikke længere.";
  if (message.includes("REPORT_NOT_FOUND")) return "Rapporten findes ikke længere.";
  if (message.includes("REPORT_ALREADY_RESOLVED")) return "Rapporten er allerede behandlet.";
  if (message.includes("INVALID_NOTE")) return "Skriv en kort begrundelse på mindst 3 tegn.";
  if (message.toLowerCase().includes("signups not allowed")) {
    return "Der findes ingen konto med den e-mail. Vælg “Opret bruger”.";
  }
  if (message.toLowerCase().includes("rate limit")) {
    return "Der er sendt for mange loginlinks. Vent lidt og prøv igen.";
  }
  return "Brugertjenesten kunne ikke gennemføre handlingen.";
}

function firstRow<T>(data: unknown) {
  return (Array.isArray(data) ? data[0] : data) as T | undefined;
}

export function accountsAreConfigured() {
  return supabaseIsConfigured();
}

export async function getMyProfile(): Promise<MyProfile> {
  const client = await requireAuthenticatedClient();
  const { data, error } = await client.rpc("get_my_profile");
  if (error) throw new Error(readableAccountError(error.message));
  const row = firstRow<ProfileRow>(data);
  if (!row) throw new Error("Din brugerprofil kunne ikke indlæses.");
  return mapProfile(row);
}

export async function saveMyProfile(
  username: string,
  hideFromPeers: boolean,
): Promise<MyProfile> {
  const client = await requireAuthenticatedClient();
  const { data, error } = await client.rpc("save_my_profile", {
    p_username: username,
    p_hide_from_peers: hideFromPeers,
  });
  if (error) throw new Error(readableAccountError(error.message));
  const row = firstRow<ProfileRow>(data);
  if (!row) throw new Error("Din profil kunne ikke gemmes.");
  return mapProfile(row);
}

export async function sendMagicLink(email: string, createAccount: boolean) {
  const client = await requireAuthenticatedClient();
  const redirectTo = Capacitor.isNativePlatform()
    ? NATIVE_LOGIN_REDIRECT
    : `${window.location.origin}${window.location.pathname}`;
  const { error } = await client.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: {
      emailRedirectTo: redirectTo,
      shouldCreateUser: createAccount,
    },
  });
  if (error) throw new Error(readableAccountError(error.message));
}

export async function handleAuthCallback(url: string) {
  if (!supabaseClient) return false;
  const { accessToken, refreshToken, code } = parseAuthCallback(url);

  if (accessToken && refreshToken) {
    const { error } = await supabaseClient.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) throw new Error(readableAccountError(error.message));
    return true;
  }

  if (code) {
    const { error } = await supabaseClient.auth.exchangeCodeForSession(code);
    if (error) throw new Error(readableAccountError(error.message));
    return true;
  }

  return false;
}

export async function initializeAuthLinks(onLogin: () => void | Promise<void>) {
  if (!supabaseClient) return () => undefined;

  if (!Capacitor.isNativePlatform()) {
    if (await handleAuthCallback(window.location.href)) await onLogin();
    return () => undefined;
  }

  const openUrl = async ({ url }: URLOpenListenerEvent) => {
    if (await handleAuthCallback(url)) await onLogin();
  };
  const launch = await CapacitorApp.getLaunchUrl();
  if (launch?.url && await handleAuthCallback(launch.url)) await onLogin();
  const listener = await CapacitorApp.addListener("appUrlOpen", (event) => {
    void openUrl(event);
  });
  return () => {
    void listener.remove();
  };
}

export function subscribeToAuthChanges(
  listener: (event: AuthChangeEvent, session: Session | null) => void,
) {
  if (!supabaseClient) return () => undefined;
  const { data } = supabaseClient.auth.onAuthStateChange(listener);
  return () => data.subscription.unsubscribe();
}

export async function signOutToAnonymous() {
  if (!supabaseClient) throw new Error("Brugertjenesten er ikke konfigureret.");
  const { error } = await supabaseClient.auth.signOut();
  if (error) throw new Error(readableAccountError(error.message));
  return getMyProfile();
}

export async function adminListUsers(search: string, status: "all" | AccountStatus) {
  const client = await requireAuthenticatedClient();
  const { data, error } = await client.rpc("admin_list_users_v2", {
    p_search: search,
    p_status: status,
    p_limit: 100,
    p_offset: 0,
  });
  if (error) throw new Error(readableAccountError(error.message));
  return ((data ?? []) as ProfileRow[]).map((row): AdminUser => ({
    ...mapProfile(row),
    lastSignInAt: row.last_sign_in_at ?? null,
    totalCount: Number(row.total_count ?? 0),
    reputationScore: Number(row.reputation_score ?? 50),
    trustLevel: row.trust_level ?? "established",
    alertCount: Number(row.alert_count ?? 0),
    pendingReportCount: Number(row.pending_report_count ?? 0),
  }));
}

export async function adminSetUserStatus(
  userId: string,
  status: AccountStatus,
) {
  const client = await requireAuthenticatedClient();
  const { error } = await client.rpc("admin_set_user_status", {
    p_user_id: userId,
    p_status: status,
    p_reason: status === "suspended" ? "Suspenderet i Pladetjeks brugerstyring" : null,
  });
  if (error) throw new Error(readableAccountError(error.message));
}

export async function adminSetUserRole(userId: string, role: "user" | "admin") {
  const client = await requireAuthenticatedClient();
  const { error } = await client.rpc("admin_set_user_role", {
    p_user_id: userId,
    p_role: role,
  });
  if (error) throw new Error(readableAccountError(error.message));
}

export async function adminListAlerts(
  search: string,
  status: "all" | "active" | "inactive",
) {
  const client = await requireAuthenticatedClient();
  const { data, error } = await client.rpc("admin_list_alerts", {
    p_search: search,
    p_status: status,
    p_limit: 200,
    p_offset: 0,
  });
  if (error) throw new Error(readableAccountError(error.message));
  return ((data ?? []) as Array<Record<string, unknown>>).map((row): AdminAlert => ({
    alertId: String(row.alert_id),
    plate: String(row.plate),
    description: String(row.description),
    reporterId: String(row.reporter_id),
    reporterEmail: row.reporter_email ? String(row.reporter_email) : null,
    reporterUsername: row.reporter_username ? String(row.reporter_username) : null,
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    observationCount: Number(row.observation_count ?? 0),
    distinctReporterCount: Number(row.distinct_reporter_count ?? 0),
    reportCount: Number(row.report_count ?? 0),
    reputationScore: Number(row.reputation_score ?? 50),
    totalCount: Number(row.total_count ?? 0),
  }));
}

export async function adminSetAlertStatus(
  alertId: string,
  isActive: boolean,
  note: string,
) {
  const client = await requireAuthenticatedClient();
  const { error } = await client.rpc("admin_set_alert_status", {
    p_alert_id: alertId,
    p_is_active: isActive,
    p_note: note || null,
  });
  if (error) throw new Error(readableAccountError(error.message));
}

export async function adminListAlertReports(
  status: "all" | "pending" | "confirmed" | "dismissed",
) {
  const client = await requireAuthenticatedClient();
  const { data, error } = await client.rpc("admin_list_alert_reports", {
    p_status: status,
    p_limit: 200,
    p_offset: 0,
  });
  if (error) throw new Error(readableAccountError(error.message));
  return ((data ?? []) as Array<Record<string, unknown>>).map((row): AdminAlertReport => ({
    reportId: String(row.report_id),
    reportStatus: String(row.report_status) as AdminAlertReport["reportStatus"],
    reason: String(row.reason),
    createdAt: String(row.created_at),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    resolutionNote: row.resolution_note ? String(row.resolution_note) : null,
    alertId: String(row.alert_id),
    plate: String(row.plate),
    alertDescription: String(row.alert_description),
    alertIsActive: Boolean(row.alert_is_active),
    alertReporterId: String(row.alert_reporter_id),
    alertReporterEmail: row.alert_reporter_email ? String(row.alert_reporter_email) : null,
    reportedBy: String(row.reported_by),
    reportedByEmail: row.reported_by_email ? String(row.reported_by_email) : null,
    totalCount: Number(row.total_count ?? 0),
  }));
}

export async function adminResolveAlertReport(
  reportId: string,
  resolution: "confirmed" | "dismissed",
  note: string,
) {
  const client = await requireAuthenticatedClient();
  const { error } = await client.rpc("admin_resolve_alert_report", {
    p_report_id: reportId,
    p_resolution: resolution,
    p_note: note,
  });
  if (error) throw new Error(readableAccountError(error.message));
}

export async function adminListModerationAudit() {
  const client = await requireAuthenticatedClient();
  const { data, error } = await client.rpc("admin_list_moderation_audit", {
    p_limit: 200,
  });
  if (error) throw new Error(readableAccountError(error.message));
  return ((data ?? []) as Array<Record<string, unknown>>).map((row): AdminAuditEntry => ({
    auditId: String(row.audit_id),
    actorId: row.actor_id ? String(row.actor_id) : null,
    actorEmail: row.actor_email ? String(row.actor_email) : null,
    action: String(row.action),
    targetType: String(row.target_type) as AdminAuditEntry["targetType"],
    targetUserId: row.target_user_id ? String(row.target_user_id) : null,
    targetAlertId: row.target_alert_id ? String(row.target_alert_id) : null,
    targetReportId: row.target_report_id ? String(row.target_report_id) : null,
    details: (row.details ?? {}) as Record<string, unknown>,
    createdAt: String(row.created_at),
  }));
}
