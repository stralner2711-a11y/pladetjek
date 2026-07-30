import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "npm:@supabase/server@1.4.1";

type FirebaseServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type QueueRow = {
  queue_id: string;
  push_token: string;
  plate: string;
  description: string;
  observed_at: string;
  distance_meters: number;
  approximate_latitude: number | string;
  approximate_longitude: number | string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

let cachedAccessToken: { value: string; expiresAt: number } | null = null;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function base64Url(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function privateKeyBytes(pem: string) {
  const cleaned = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(cleaned);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function getFirebaseAccessToken(account: FirebaseServiceAccount) {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.value;
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: account.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const unsignedToken = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytes(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken),
  );
  const assertion = `${unsignedToken}.${base64Url(new Uint8Array(signature))}`;
  const tokenResponse = await fetch(account.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const payload = await tokenResponse.json() as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!tokenResponse.ok || !payload.access_token) {
    throw new Error(payload.error_description ?? "Firebase OAuth-token kunne ikke hentes.");
  }

  cachedAccessToken = {
    value: payload.access_token,
    expiresAt: Date.now() + Math.max(300, payload.expires_in ?? 3600) * 1000,
  };
  return cachedAccessToken.value;
}

function displayPlate(value: string) {
  const plate = value.toUpperCase().replace(/[^A-ZÆØÅ0-9]/g, "").slice(0, 7);
  return `${plate.slice(0, 2)} ${plate.slice(2, 4)} ${plate.slice(4)}`.trim();
}

function displayDistance(meters: number) {
  if (meters < 1000) {
    const rounded = Math.max(100, Math.round(meters / 100) * 100);
    if (rounded < 1000) return `${rounded} m`;
  }
  return `${(meters / 1000).toLocaleString("da-DK", { maximumFractionDigits: 1 })} km`;
}

function readableFcmError(payload: unknown, status: number) {
  if (
    payload
    && typeof payload === "object"
    && "error" in payload
    && payload.error
    && typeof payload.error === "object"
    && "message" in payload.error
  ) {
    return `FCM ${status}: ${String(payload.error.message)}`;
  }
  return `FCM ${status}: notifikationen blev afvist.`;
}

export default {
  fetch: withSupabase({ auth: "user" }, async (request, context) => {
    if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (request.method !== "POST") return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);

    const firebaseJson = Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON");
    if (!firebaseJson) return jsonResponse({ error: "SERVER_NOT_CONFIGURED" }, 503);

    const userId = context.userClaims?.id;
    if (!userId) return jsonResponse({ error: "AUTH_REQUIRED" }, 401);

    const requestBody = await request.json().catch(() => ({})) as { eventId?: string };
    if (!requestBody.eventId || !/^[0-9a-f-]{36}$/i.test(requestBody.eventId)) {
      return jsonResponse({ error: "INVALID_EVENT" }, 400);
    }

    let firebaseAccount: FirebaseServiceAccount;
    try {
      firebaseAccount = JSON.parse(firebaseJson) as FirebaseServiceAccount;
      if (!firebaseAccount.project_id || !firebaseAccount.client_email || !firebaseAccount.private_key) {
        throw new Error("Ufuldstændig Firebase-servicekonto.");
      }
    } catch {
      return jsonResponse({ error: "FIREBASE_SECRET_INVALID" }, 503);
    }

    let accessToken: string;
    try {
      accessToken = await getFirebaseAccessToken(firebaseAccount);
    } catch (error) {
      console.error(error);
      return jsonResponse({ error: "FIREBASE_AUTH_FAILED" }, 502);
    }

    const claim = await context.supabaseAdmin.rpc("claim_nearby_notification_batch", {
      p_event_id: requestBody.eventId,
      p_requesting_user_id: userId,
      p_limit: 100,
    });
    if (claim.error) {
      const status = claim.error.message.includes("EVENT_NOT_FOUND") ? 403 : 500;
      return jsonResponse({ error: status === 403 ? "EVENT_NOT_FOUND" : "QUEUE_FAILED" }, status);
    }

    const queue = (claim.data ?? []) as QueueRow[];
    const results = await Promise.all(queue.map(async (item) => {
      try {
        const response = await fetch(
          `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(firebaseAccount.project_id)}/messages:send`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message: {
                token: item.push_token,
                notification: {
                  title: "OBS – osten lugter i nærheden af dig",
                  body: `${displayPlate(item.plate)} · ca. ${displayDistance(item.distance_meters)} væk · registreret nu`,
                },
                data: {
                  type: "nearby_match",
                  eventId: requestBody.eventId,
                  plate: item.plate,
                  description: item.description,
                  observedAt: item.observed_at,
                  distanceMeters: String(item.distance_meters),
                  approximateLatitude: String(item.approximate_latitude),
                  approximateLongitude: String(item.approximate_longitude),
                },
                android: {
                  priority: "high",
                  notification: {
                    channel_id: "nearby_matches",
                    tag: `nearby-${item.plate}`,
                    color: "#D92731",
                    sound: "default",
                    visibility: "PRIVATE",
                  },
                },
              },
            }),
          },
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(readableFcmError(payload, response.status));

        await context.supabaseAdmin.rpc("complete_nearby_notification", {
          p_queue_id: item.queue_id,
          p_sent: true,
          p_error: null,
        });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Ukendt FCM-fejl";
        console.error(message);
        await context.supabaseAdmin.rpc("complete_nearby_notification", {
          p_queue_id: item.queue_id,
          p_sent: false,
          p_error: message,
        });
        return false;
      }
    }));

    return jsonResponse({
      queued: queue.length,
      sent: results.filter(Boolean).length,
      failed: results.filter((sent) => !sent).length,
    });
  }),
};
