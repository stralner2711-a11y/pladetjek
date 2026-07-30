import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL ?? "").trim();
const supabasePublishableKey = String(
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "",
).trim();

export const supabaseClient: SupabaseClient | null = supabaseUrl && supabasePublishableKey
  ? createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          "X-Client-Info": "pladetjek-android",
        },
      },
    })
  : null;

let anonymousSignIn: Promise<SupabaseClient> | null = null;

export function supabaseIsConfigured() {
  return supabaseClient !== null;
}

export async function requireAuthenticatedClient() {
  if (!supabaseClient) {
    throw new Error("Pladetjeks brugertjeneste er ikke konfigureret.");
  }

  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw error;
  if (data.session) return supabaseClient;

  if (!anonymousSignIn) {
    anonymousSignIn = (async () => {
      const signedIn = await supabaseClient.auth.signInAnonymously();
      if (signedIn.error || !signedIn.data.session) {
        throw signedIn.error ?? new Error("Anonym Supabase-session kunne ikke oprettes.");
      }
      return supabaseClient;
    })().finally(() => {
      anonymousSignIn = null;
    });
  }

  return anonymousSignIn;
}
