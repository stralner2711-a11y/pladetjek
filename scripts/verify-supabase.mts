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

await supabase.auth.signOut();
console.log(
  "Supabase verificeret: anonym profil, privat RLS, rolleblokering, dubletkontrol og anonymt match.",
);
