import {
  requireAuthenticatedClient,
  supabaseIsConfigured,
} from "./supabase-client";
import {
  requestNearbyNotificationDispatch,
  type NearbyCoordinates,
} from "./nearby-alerts";

export type SharedVehicleAlert = {
  id: string;
  plate: string;
  description: string;
  createdAt: string;
  expiresAt: string;
  reporterName: string;
  notificationEventId?: string;
  observedAt?: string;
  notificationsQueued?: boolean;
  observationCount: number;
  distinctReporterCount: number;
  lastSeenAt?: string;
  nearbyDistanceMeters?: number;
  approximateLatitude?: number;
  approximateLongitude?: number;
};

type AlertRow = {
  id: string;
  plate: string;
  description: string;
  created_at: string;
  expires_at: string;
  reporter_name?: string;
  duplicate?: boolean;
  notification_event_id?: string | null;
  observed_at?: string | null;
  notifications_queued?: boolean;
  observation_count?: number | string;
  distinct_reporter_count?: number | string;
  last_seen_at?: string | null;
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
    notificationEventId: row.notification_event_id ?? undefined,
    observedAt: row.observed_at ?? undefined,
    notificationsQueued: Boolean(row.notifications_queued),
    observationCount: Number(row.observation_count ?? 1),
    distinctReporterCount: Number(row.distinct_reporter_count ?? 1),
    lastSeenAt: row.last_seen_at ?? undefined,
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
  if (message.includes("INVALID_REPORT_REASON")) {
    return "Beskriv fejlen med 10 til 300 tegn.";
  }
  if (message.includes("ALERT_NOT_FOUND")) {
    return "Advarslen findes ikke længere.";
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
  const { data, error } = await authenticated.rpc("create_plate_alert_v2", {
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
  coordinates?: NearbyCoordinates | null,
): Promise<SharedVehicleAlert | null> {
  const authenticated = await requireAuthenticatedClient();
  const { data, error } = await authenticated.rpc("match_plate_alert_v4", {
    p_plate: plate,
    p_installation_id: coordinates?.installationId ?? null,
    p_latitude: coordinates?.latitude ?? null,
    p_longitude: coordinates?.longitude ?? null,
    p_accuracy_meters: coordinates?.accuracyMeters ?? null,
  });

  if (error) throw new Error(mapSupabaseError(error.message));
  const row = (Array.isArray(data) ? data[0] : data) as AlertRow | undefined;
  if (!row) return null;

  const alert = mapAlert(row);
  if (alert.notificationEventId && alert.notificationsQueued) {
    void requestNearbyNotificationDispatch(alert.notificationEventId).catch(() => undefined);
  }
  return alert;
}

export async function reportSharedAlert(alertId: string, reason: string) {
  const authenticated = await requireAuthenticatedClient();
  const { data, error } = await authenticated.rpc("report_plate_alert", {
    p_alert_id: alertId,
    p_reason: reason,
  });
  if (error) throw new Error(mapSupabaseError(error.message));
  const row = (Array.isArray(data) ? data[0] : data) as {
    report_id?: string;
    report_status?: string;
  } | undefined;
  if (!row?.report_id) throw new Error("Rapporten kunne ikke gemmes.");
  return {
    reportId: row.report_id,
    status: row.report_status ?? "pending",
  };
}
