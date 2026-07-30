import {
  requireAuthenticatedClient,
  supabaseIsConfigured,
} from "./supabase-client";

export type SharedVehicleAlert = {
  id: string;
  plate: string;
  description: string;
  createdAt: string;
  expiresAt: string;
  reporterName: string;
};

type AlertRow = {
  id: string;
  plate: string;
  description: string;
  created_at: string;
  expires_at: string;
  reporter_name?: string;
  duplicate?: boolean;
};

export function sharedAlertsAreConfigured() {
  return supabaseIsConfigured();
}

function mapAlert(row: AlertRow): SharedVehicleAlert {
  return {
    id: row.id,
    plate: row.plate,
    description: row.description,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    reporterName: row.reporter_name ?? "Anonym bruger",
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
  if (message.includes("ACCOUNT_SUSPENDED")) {
    return "Din konto er suspenderet og kan ikke bruge fælles advarsler.";
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
  const { data, error } = await authenticated.rpc("match_plate_alert_v2", {
    p_plate: plate,
  });

  if (error) throw new Error(mapSupabaseError(error.message));
  const row = (Array.isArray(data) ? data[0] : data) as AlertRow | undefined;
  return row ? mapAlert(row) : null;
}
