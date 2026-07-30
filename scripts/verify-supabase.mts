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

const plate = "ZZ99999";
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

const matched = await supabase.rpc("match_plate_alert", { p_plate: plate });
if (
  matched.error
  || !Array.isArray(matched.data)
  || matched.data[0]?.plate !== plate
) {
  throw matched.error ?? new Error("Matchopslaget virkede ikke.");
}

await supabase.auth.signOut();
console.log("Supabase verificeret: anonym login, RLS, dubletkontrol og præcist match.");
