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
  const { data, error } = await client.rpc("admin_list_users", {
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
