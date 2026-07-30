import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type SharedVehicleAlert = {
  id: string;
  plate: string;
  description: string;
  createdAt: string;
  expiresAt: string;
};

type AlertRow = {
  id: string;
  plate: string;
  description: string;
  created_at: string;
  expires_at: string;
  duplicate?: boolean;
};

const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL ?? "").trim();
const supabasePublishableKey = String(
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "",
).trim();

const client: SupabaseClient | null = supabaseUrl && supabasePublishableKey
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

let sessionPromise: Promise<SupabaseClient> | null = null;

export function sharedAlertsAreConfigured() {
  return client !== null;
}

async function requireAuthenticatedClient() {
  if (!client) {
    throw new Error("Den fælles advarselstjeneste er ikke konfigureret.");
  }

  if (!sessionPromise) {
    sessionPromise = (async () => {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      if (data.session) return client;

      const signedIn = await client.auth.signInAnonymously();
      if (signedIn.error || !signedIn.data.session) {
        throw signedIn.error ?? new Error("Anonym Supabase-session kunne ikke oprettes.");
      }
      return client;
    })().catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }

  return sessionPromise;
}

function mapAlert(row: AlertRow): SharedVehicleAlert {
  return {
    id: row.id,
    plate: row.plate,
    description: row.description,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function mapSupabaseError(message: string) {
  if (message.includes("RATE_LIMITED")) {
    return "Du har sendt for mange forespørgsler. Vent lidt og prøv igen.";
  }
  if (message.includes("INVALID_PLATE")) {
    return "Indtast en gyldig dansk nummerplade, fx AB 12 345.";
  }
  if (message.includes("INVALID_DESCRIPTION")) {
    return "Beskriv observationen med 5 til 240 tegn.";
  }
  if (message.includes("AUTH_REQUIRED")) {
    return "Telefonen kunne ikke oprette en sikker brugersession.";
  }
  return "Den fælles advarselstjeneste kunne ikke kontaktes.";
}

export async function createSharedAlert(
  plate: string,
  description: string,
): Promise<{ alert: SharedVehicleAlert; duplicate: boolean }> {
  const authenticated = await requireAuthenticatedClient();
  const { data, error } = await authenticated.rpc("create_plate_alert", {
    p_plate: plate,
    p_description: description,
  });

  if (error) throw new Error(mapSupabaseError(error.message));
  const row = (Array.isArray(data) ? data[0] : data) as AlertRow | undefined;
  if (!row) throw new Error("Advarslen kunne ikke gemmes.");

  return {
    alert: mapAlert(row),
    duplicate: Boolean(row.duplicate),
  };
}

export async function matchSharedAlert(
  plate: string,
): Promise<SharedVehicleAlert | null> {
  const authenticated = await requireAuthenticatedClient();
  const { data, error } = await authenticated.rpc("match_plate_alert", {
    p_plate: plate,
  });

  if (error) throw new Error(mapSupabaseError(error.message));
  const row = (Array.isArray(data) ? data[0] : data) as AlertRow | undefined;
  return row ? mapAlert(row) : null;
}
