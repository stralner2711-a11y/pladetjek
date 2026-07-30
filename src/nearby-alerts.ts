import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import {
  PushNotifications,
  type PushNotificationSchema,
} from "@capacitor/push-notifications";
import { requireAuthenticatedClient } from "./supabase-client";

const INSTALLATION_KEY = "pladetjek:installation-id";
const NEARBY_ENABLED_KEY = "pladetjek:nearby-alerts-enabled";
const NEARBY_ONBOARDING_KEY_PREFIX = "pladetjek:nearby-onboarding:v1:";
const REGISTRATION_TIMEOUT_MS = 20_000;

export type NearbyCoordinates = {
  installationId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
};

export type NearbyAlertStatus = {
  supported: boolean;
  enabled: boolean;
  lastLocationAt: string | null;
  message: string;
};

export type NearbyMatchNotification = {
  eventId: string;
  plate: string;
  description: string;
  observedAt: string;
  distanceMeters: number;
  approximateLatitude: number;
  approximateLongitude: number;
};

type DeviceRow = {
  enabled: boolean;
  location_updated_at: string | null;
};

function firstRow<T>(value: unknown) {
  return (Array.isArray(value) ? value[0] : value) as T | undefined;
}

export function nearbyAlertsAreSupported() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export function nearbyAlertsAreEnabledLocally() {
  return localStorage.getItem(NEARBY_ENABLED_KEY) === "true";
}

type NearbyOnboardingStorage = Pick<Storage, "getItem" | "setItem">;

function nearbyOnboardingKey(userId: string) {
  return `${NEARBY_ONBOARDING_KEY_PREFIX}${userId.trim().toLowerCase()}`;
}

export function nearbyOnboardingWasHandled(
  userId: string,
  storage: NearbyOnboardingStorage = localStorage,
) {
  if (!userId.trim()) return true;
  try {
    return storage.getItem(nearbyOnboardingKey(userId)) === "handled";
  } catch {
    return false;
  }
}

export function markNearbyOnboardingHandled(
  userId: string,
  storage: NearbyOnboardingStorage = localStorage,
) {
  if (!userId.trim()) return;
  try {
    storage.setItem(nearbyOnboardingKey(userId), "handled");
  } catch {
    // Manglende lokal lagring må ikke blokere aktivering af nærhedsadvarsler.
  }
}

export function getInstallationId() {
  const existing = localStorage.getItem(INSTALLATION_KEY);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const created = globalThis.crypto.randomUUID();
  localStorage.setItem(INSTALLATION_KEY, created);
  return created;
}

function nearbyErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("ACCOUNT_SUSPENDED")) return "Din konto er suspenderet.";
  if (message.includes("INVALID_LOCATION")) return "Telefonens position kunne ikke godkendes.";
  if (message.includes("AUTH_REQUIRED")) return "Din sikre brugersession mangler.";
  if (/google-services|firebase|registration/i.test(message)) {
    return "Push-tjenesten er endnu ikke forbundet til denne appversion.";
  }
  if (/location|position|gps/i.test(message)) {
    return "Telefonens lokation er slået fra eller kunne ikke findes.";
  }
  return "Nærhedsadvarsler kunne ikke aktiveres.";
}

async function currentCoordinates(requestPermission: boolean): Promise<NearbyCoordinates> {
  if (!nearbyAlertsAreSupported()) {
    throw new Error("Nærhedsadvarsler kræver Android-appen.");
  }

  let permission = await Geolocation.checkPermissions();
  if (
    requestPermission
    && permission.location !== "granted"
    && permission.coarseLocation !== "granted"
  ) {
    permission = await Geolocation.requestPermissions({ permissions: ["location"] });
  }
  if (permission.location !== "granted" && permission.coarseLocation !== "granted") {
    throw new Error("Lokationstilladelse blev ikke givet.");
  }

  const position = await Geolocation.getCurrentPosition({
    enableHighAccuracy: permission.location === "granted",
    maximumAge: 30_000,
    timeout: 15_000,
  });
  return {
    installationId: getInstallationId(),
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyMeters: Math.max(0, Math.min(10_000, position.coords.accuracy)),
  };
}

async function registerPushToken(requestPermission: boolean) {
  let permission = await PushNotifications.checkPermissions();
  if (requestPermission && permission.receive !== "granted") {
    permission = await PushNotifications.requestPermissions();
  }
  if (permission.receive !== "granted") {
    throw new Error("Notifikationstilladelse blev ikke givet.");
  }

  await PushNotifications.createChannel({
    id: "nearby_matches",
    name: "Match i nærheden",
    description: "OBS-advarsler, når en registreret nummerplade matches inden for 5 km.",
    importance: 4,
    visibility: 0,
    vibration: true,
    lights: true,
    lightColor: "#D92731",
  });

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const handles: PluginListenerHandle[] = [];
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      for (const handle of handles) void handle.remove();
      callback();
    };
    const timeout = window.setTimeout(() => {
      finish(() => reject(new Error("Push-registrering fik timeout.")));
    }, REGISTRATION_TIMEOUT_MS);

    void (async () => {
      handles.push(await PushNotifications.addListener("registration", (token) => {
        finish(() => resolve(token.value));
      }));
      handles.push(await PushNotifications.addListener("registrationError", (error) => {
        finish(() => reject(new Error(error.error)));
      }));
      await PushNotifications.register();
    })().catch((error) => {
      finish(() => reject(error));
    });
  });
}

async function saveNearbyDevice(
  coordinates: NearbyCoordinates,
  pushToken: string,
  enabled: boolean,
) {
  const client = await requireAuthenticatedClient();
  const { data, error } = await client.rpc("set_nearby_device", {
    p_installation_id: coordinates.installationId,
    p_push_token: enabled ? pushToken : null,
    p_enabled: enabled,
    p_latitude: enabled ? coordinates.latitude : null,
    p_longitude: enabled ? coordinates.longitude : null,
    p_accuracy_meters: enabled ? coordinates.accuracyMeters : null,
  });
  if (error) throw new Error(error.message);
  return firstRow<DeviceRow>(data);
}

export async function getNearbyAlertStatus(): Promise<NearbyAlertStatus> {
  if (!nearbyAlertsAreSupported()) {
    return {
      supported: false,
      enabled: false,
      lastLocationAt: null,
      message: "Nærhedsadvarsler kan aktiveres i Android-appen.",
    };
  }

  const client = await requireAuthenticatedClient();
  const { data, error } = await client.rpc("get_nearby_device", {
    p_installation_id: getInstallationId(),
  });
  if (error) {
    return {
      supported: true,
      enabled: nearbyAlertsAreEnabledLocally(),
      lastLocationAt: null,
      message: nearbyErrorMessage(new Error(error.message)),
    };
  }
  const row = firstRow<DeviceRow>(data);
  const enabled = Boolean(row?.enabled && nearbyAlertsAreEnabledLocally());
  return {
    supported: true,
    enabled,
    lastLocationAt: row?.location_updated_at ?? null,
    message: enabled
      ? "Aktiv · din position bruges kun kortvarigt til 5 km-radius."
      : "Slå funktionen til for at modtage OBS-match i nærheden.",
  };
}

export async function enableNearbyAlerts(): Promise<NearbyAlertStatus> {
  try {
    const coordinates = await currentCoordinates(true);
    const pushToken = await registerPushToken(true);
    const row = await saveNearbyDevice(coordinates, pushToken, true);
    localStorage.setItem(NEARBY_ENABLED_KEY, "true");
    return {
      supported: true,
      enabled: true,
      lastLocationAt: row?.location_updated_at ?? new Date().toISOString(),
      message: "Aktiv · du får OBS-match inden for 5 km.",
    };
  } catch (error) {
    localStorage.removeItem(NEARBY_ENABLED_KEY);
    await PushNotifications.unregister().catch(() => undefined);
    return {
      supported: nearbyAlertsAreSupported(),
      enabled: false,
      lastLocationAt: null,
      message: nearbyErrorMessage(error),
    };
  }
}

export async function disableNearbyAlerts(): Promise<NearbyAlertStatus> {
  let removedFromServer = false;
  try {
    const emptyCoordinates: NearbyCoordinates = {
      installationId: getInstallationId(),
      latitude: 0,
      longitude: 0,
      accuracyMeters: 0,
    };
    await saveNearbyDevice(emptyCoordinates, "", false);
    removedFromServer = true;
  } catch {
    removedFromServer = false;
  } finally {
    localStorage.removeItem(NEARBY_ENABLED_KEY);
    await PushNotifications.unregister().catch(() => undefined);
  }
  return {
    supported: nearbyAlertsAreSupported(),
    enabled: false,
    lastLocationAt: null,
    message: removedFromServer
      ? "Nærhedsadvarsler er slået fra, og lokationen er fjernet."
      : "Slået fra på telefonen. En tidligere serverposition udløber senest efter 30 minutter.",
  };
}

export async function refreshNearbyDevice() {
  if (!nearbyAlertsAreEnabledLocally() || !nearbyAlertsAreSupported()) return null;
  try {
    const coordinates = await currentCoordinates(false);
    const pushToken = await registerPushToken(false);
    await saveNearbyDevice(coordinates, pushToken, true);
    return coordinates;
  } catch {
    return null;
  }
}

export async function getNearbyMatchCoordinates() {
  if (!nearbyAlertsAreEnabledLocally()) return null;
  return currentCoordinates(false).catch(() => null);
}

export async function requestNearbyNotificationDispatch(eventId: string) {
  const client = await requireAuthenticatedClient();
  const { error } = await client.functions.invoke("send-nearby-notifications", {
    body: { eventId },
  });
  if (error) throw error;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function parseNearbyMatchNotification(
  notification: Pick<PushNotificationSchema, "data">,
): NearbyMatchNotification | null {
  const data = notification.data as Record<string, unknown> | null;
  if (!data || data.type !== "nearby_match") return null;

  const eventId = stringValue(data.eventId);
  const plate = stringValue(data.plate).toUpperCase().replace(/[^A-ZÆØÅ0-9]/g, "");
  const observedAt = stringValue(data.observedAt);
  const distanceMeters = Number(data.distanceMeters);
  const approximateLatitude = Number(data.approximateLatitude);
  const approximateLongitude = Number(data.approximateLongitude);
  if (
    !/^[0-9a-f-]{36}$/i.test(eventId)
    || !/^[A-ZÆØÅ]{2}[0-9]{5}$/.test(plate)
    || Number.isNaN(Date.parse(observedAt))
    || !Number.isFinite(distanceMeters)
    || distanceMeters < 0
    || distanceMeters > 5000
    || !Number.isFinite(approximateLatitude)
    || approximateLatitude < -90
    || approximateLatitude > 90
    || !Number.isFinite(approximateLongitude)
    || approximateLongitude < -180
    || approximateLongitude > 180
  ) {
    return null;
  }

  return {
    eventId,
    plate,
    description: stringValue(data.description).slice(0, 240),
    observedAt,
    distanceMeters,
    approximateLatitude,
    approximateLongitude,
  };
}

export function formatNearbyDistance(distanceMeters: number) {
  if (distanceMeters < 1000) {
    const roundedMeters = Math.max(100, Math.round(distanceMeters / 100) * 100);
    if (roundedMeters < 1000) return `${roundedMeters} m`;
  }
  return `${(distanceMeters / 1000).toLocaleString("da-DK", {
    maximumFractionDigits: 1,
  })} km`;
}

export async function initializeNearbyNotificationListeners(
  onNotification: (notification: NearbyMatchNotification) => void,
) {
  if (!nearbyAlertsAreSupported()) return () => undefined;

  const received = await PushNotifications.addListener(
    "pushNotificationReceived",
    (notification) => {
      const parsed = parseNearbyMatchNotification(notification);
      if (parsed) onNotification(parsed);
    },
  );
  const action = await PushNotifications.addListener(
    "pushNotificationActionPerformed",
    (event) => {
      const parsed = parseNearbyMatchNotification(event.notification);
      if (parsed) onNotification(parsed);
    },
  );

  return () => {
    void received.remove();
    void action.remove();
  };
}
