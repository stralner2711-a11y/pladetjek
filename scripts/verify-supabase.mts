import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

loadEnvFile(resolve(import.meta.dirname, "../.env"));

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) throw new Error("Supabase URL eller publishable-nøgle mangler.");

const supabase = createClient(url, key, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

const signedIn = await supabase.auth.signInAnonymously();
if (signedIn.error || !signedIn.data.user) {
  throw signedIn.error ?? new Error("Anonym login mislykkedes.");
}

const directRead = await supabase.from("plate_alerts").select("id").limit(1);
if (!directRead.error) {
  throw new Error("Sikkerhedsfejl: klienten kunne læse hele advarselstabellen.");
}

const profileRead = await supabase.from("user_profiles").select("user_id").limit(1);
if (!profileRead.error) {
  throw new Error("Sikkerhedsfejl: klienten kunne læse hele profiltabellen.");
}

const nearbyDeviceRead = await supabase.from("nearby_devices").select("*").limit(1);
if (!nearbyDeviceRead.error) {
  throw new Error("Sikkerhedsfejl: klienten kunne læse private lokationer eller push-tokens.");
}

const ownProfile = await supabase.rpc("get_my_profile");
if (
  ownProfile.error
  || !Array.isArray(ownProfile.data)
  || ownProfile.data[0]?.user_id !== signedIn.data.user.id
  || ownProfile.data[0]?.is_anonymous !== true
  || ownProfile.data[0]?.role !== "user"
) {
  throw ownProfile.error ?? new Error("Den private egenprofil kunne ikke hentes.");
}

const anonymousProfileWrite = await supabase.rpc("save_my_profile", {
  p_username: "SupabaseTest",
  p_hide_from_peers: false,
});
if (!anonymousProfileWrite.error?.message.includes("PERMANENT_ACCOUNT_REQUIRED")) {
  throw new Error("Sikkerhedsfejl: en midlertidig konto kunne gemme en offentlig profil.");
}

const adminRead = await supabase.rpc("admin_list_users", {
  p_search: "",
  p_status: "all",
  p_limit: 10,
  p_offset: 0,
});
if (!adminRead.error?.message.includes("ADMIN_REQUIRED")) {
  throw new Error("Sikkerhedsfejl: en almindelig bruger kunne åbne brugerstyringen.");
}

const plate = `ZZ${String(Date.now()).slice(-5)}`;
const description = "Automatisk Supabase-forbindelsestest";
const created = await supabase.rpc("create_plate_alert", {
  p_plate: plate,
  p_description: description,
});
if (created.error || !Array.isArray(created.data) || !created.data[0]) {
  throw created.error ?? new Error("Testadvarslen kunne ikke oprettes.");
}

const duplicate = await supabase.rpc("create_plate_alert", {
  p_plate: plate,
  p_description: description,
});
if (
  duplicate.error
  || !Array.isArray(duplicate.data)
  || duplicate.data[0]?.duplicate !== true
) {
  throw duplicate.error ?? new Error("Dubletkontrollen virkede ikke.");
}

const matched = await supabase.rpc("match_plate_alert_v2", { p_plate: plate });
if (
  matched.error
  || !Array.isArray(matched.data)
  || matched.data[0]?.plate !== plate
  || matched.data[0]?.reporter_name !== "Anonym bruger"
) {
  throw matched.error ?? new Error("Matchopslaget virkede ikke.");
}

const installationId = crypto.randomUUID();
const nearbyDevice = await supabase.rpc("set_nearby_device", {
  p_installation_id: installationId,
  p_push_token: `supabase-security-test-${crypto.randomUUID()}`,
  p_enabled: true,
  p_latitude: 0,
  p_longitude: 0,
  p_accuracy_meters: 25,
});
if (
  nearbyDevice.error
  || !Array.isArray(nearbyDevice.data)
  || nearbyDevice.data[0]?.enabled !== true
) {
  throw nearbyDevice.error ?? new Error("Den private enhedsregistrering virkede ikke.");
}

const nearbyMatch = await supabase.rpc("match_plate_alert_v3", {
  p_plate: plate,
  p_installation_id: installationId,
  p_latitude: 0,
  p_longitude: 0,
  p_accuracy_meters: 25,
});
if (
  nearbyMatch.error
  || !Array.isArray(nearbyMatch.data)
  || nearbyMatch.data[0]?.plate !== plate
  || !nearbyMatch.data[0]?.notification_event_id
  || typeof nearbyMatch.data[0]?.notifications_queued !== "boolean"
) {
  throw nearbyMatch.error ?? new Error("5 km-matchflowet kunne ikke verificeres.");
}

let edgeDispatch;
try {
  edgeDispatch = await supabase.functions.invoke("send-nearby-notifications", {
    body: { eventId: nearbyMatch.data[0].notification_event_id },
  });
} catch (caught) {
  const response = (caught as { context?: Response }).context;
  const detail = response ? await response.text().catch(() => "") : "";
  throw new Error(
    `Pushfunktionen returnerede ${response?.status ?? "ukendt status"}: ${detail}`,
    { cause: caught },
  );
}
if (edgeDispatch.error) {
  const response = (edgeDispatch.error as { context?: Response }).context;
  const detail = response ? await response.text().catch(() => "") : "";
  throw new Error(
    `Pushfunktionen returnerede ${response?.status ?? "ukendt status"}: ${detail}`,
    { cause: edgeDispatch.error },
  );
}
const dispatchQueued = Number(edgeDispatch.data?.queued);
const dispatchSent = Number(edgeDispatch.data?.sent);
const dispatchFailed = Number(edgeDispatch.data?.failed);
if (
  !Number.isInteger(dispatchQueued)
  || dispatchQueued < 0
  || dispatchSent !== 0
  || dispatchFailed !== dispatchQueued
) {
  throw new Error("Den beskyttede Firebase-pushfunktion kunne ikke kaldes.");
}

const forbiddenQueueClaim = await supabase.rpc("claim_nearby_notification_batch", {
  p_event_id: nearbyMatch.data[0].notification_event_id,
  p_requesting_user_id: signedIn.data.user.id,
  p_limit: 10,
});
if (!forbiddenQueueClaim.error) {
  throw new Error("Sikkerhedsfejl: en klient kunne hente push-køen.");
}

const disabledNearby = await supabase.rpc("set_nearby_device", {
  p_installation_id: installationId,
  p_push_token: null,
  p_enabled: false,
  p_latitude: null,
  p_longitude: null,
  p_accuracy_meters: null,
});
if (
  disabledNearby.error
  || !Array.isArray(disabledNearby.data)
  || disabledNearby.data[0]?.enabled !== false
) {
  throw disabledNearby.error ?? new Error("Enhedens lokation kunne ikke fjernes igen.");
}

await supabase.auth.signOut();
console.log(
  "Supabase verificeret: privat RLS, 5 km-match, skjult push-kø og slettet enhedslokation.",
);
