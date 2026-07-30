import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AlertService } from "./alert-service.js";
import { lookupViaNummerpladeApi, SourceError, type VehicleLookup } from "./nummerplade-api.js";

const app = express();
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const timeoutMs = Number(process.env.NUMMERPLADE_API_TIMEOUT_MS ?? 8000);
const cacheMs = Number(process.env.NUMMERPLADE_CACHE_SECONDS ?? 30) * 1000;
const token = process.env.NUMMERPLADE_API_TOKEN;
const alertLifetimeMs = Number(process.env.ALERT_LIFETIME_MINUTES ?? 60) * 60_000;
const alertDataFile = path.resolve(process.env.ALERT_DATA_FILE ?? "data/alerts.json");
const alerts = new AlertService(alertLifetimeMs, 15 * 60_000, 500, loadStoredAlerts());
const lookupCache = new Map<string, { expires: number; value: VehicleLookup }>();
const lookupRate = new Map<string, { reset: number; count: number }>();
const matchRate = new Map<string, { reset: number; count: number }>();
const postRate = new Map<string, { reset: number; count: number }>();
const allowedOrigins = new Set(
  String(
    process.env.ALLOWED_APP_ORIGINS
      ?? "https://localhost,http://localhost:5173,http://127.0.0.1:5173",
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(self)");
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");

  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/health/sources", (_req, res) => {
  res.json({
    nummerpladeApi: token ? "configured" : "not_configured",
    dmr: token ? "via_nummerplade_api" : "not_configured",
    tinglysning: token ? "via_nummerplade_api" : "not_configured",
  });
});

app.get("/api/vehicles/:registration", async (req, res) => {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const currentRate = lookupRate.get(ip);
  if (!currentRate || currentRate.reset < now) {
    lookupRate.set(ip, { reset: now + 60_000, count: 1 });
  } else if (++currentRate.count > 60) {
    return res.status(429).json({
      code: "RATE_LIMITED",
      message: "For mange opslag. Prøv igen om lidt.",
    });
  }

  const plate = req.params.registration.toUpperCase().replace(/[^A-ZÆØÅ0-9]/g, "");
  if (!/^[A-ZÆØÅ]{2}\d{5}$/.test(plate)) {
    return res.status(400).json({ code: "INVALID_PLATE", message: "Ugyldigt registreringsnummer." });
  }

  const cached = lookupCache.get(plate);
  if (cached && cached.expires > now) return res.json({ data: cached.value, cached: true });

  try {
    const value = await lookupViaNummerpladeApi(plate, token, timeoutMs);
    lookupCache.set(plate, { expires: now + cacheMs, value });
    return res.json({ data: value, cached: false });
  } catch (error) {
    if (error instanceof SourceError) {
      return res.status(error.status).json({ code: error.code, message: error.message });
    }
    console.error("vehicle lookup failed", error instanceof Error ? error.message : error);
    return res.status(502).json({ code: "UPSTREAM_ERROR", message: "Opslaget kunne ikke gennemføres." });
  }
});

app.get("/api/alerts/match/:registration", (req, res) => {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const currentRate = matchRate.get(ip);
  if (!currentRate || currentRate.reset < now) {
    matchRate.set(ip, { reset: now + 60_000, count: 1 });
  } else if (++currentRate.count > 120) {
    return res.status(429).json({
      code: "RATE_LIMITED",
      message: "For mange scanninger. Prøv igen om lidt.",
    });
  }

  try {
    return res.json({ data: alerts.match(req.params.registration, now) });
  } catch {
    return res.status(400).json({
      code: "INVALID_PLATE",
      message: "Ugyldigt registreringsnummer.",
    });
  }
});

app.post("/api/alerts", (req, res) => {
  if (req.body?.confirmed !== true) {
    return res.status(400).json({
      code: "CONFIRMATION_REQUIRED",
      message: "Advarslen skal bekræftes, før den kan sendes.",
    });
  }

  const clientId = String(req.body?.clientId ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  const rateKey = `${req.ip ?? "unknown"}:${clientId || "unknown"}`;
  const now = Date.now();
  const currentRate = postRate.get(rateKey);
  if (!currentRate || currentRate.reset < now) {
    postRate.set(rateKey, { reset: now + 10 * 60_000, count: 1 });
  } else if (++currentRate.count > 3) {
    return res.status(429).json({
      code: "RATE_LIMITED",
      message: "Du har sendt for mange advarsler. Vent lidt og prøv igen.",
    });
  }

  try {
    const result = alerts.create(
      String(req.body?.plate ?? ""),
      String(req.body?.description ?? ""),
      now,
    );
    if (!result.duplicate && !persistAlerts()) {
      return res.status(500).json({
        code: "STORAGE_ERROR",
        message: "Advarslen kunne ikke gemmes sikkert. Prøv igen.",
      });
    }
    return res.status(result.duplicate ? 200 : 201).json({
      data: result.alert,
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_DESCRIPTION") {
      return res.status(400).json({
        code: "INVALID_DESCRIPTION",
        message: "Beskriv observationen med 5 til 240 tegn.",
      });
    }
    return res.status(400).json({
      code: "INVALID_PLATE",
      message: "Indtast en gyldig dansk nummerplade, fx AB 12 345.",
    });
  }
});

function loadStoredAlerts() {
  try {
    if (!fs.existsSync(alertDataFile)) return [];
    const stored = JSON.parse(fs.readFileSync(alertDataFile, "utf8"));
    return Array.isArray(stored) ? stored : [];
  } catch (error) {
    console.error("alert storage could not be read", error instanceof Error ? error.message : error);
    return [];
  }
}

function persistAlerts() {
  try {
    fs.mkdirSync(path.dirname(alertDataFile), { recursive: true });
    const temporaryFile = `${alertDataFile}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(alerts.active(), null, 2), "utf8");
    fs.renameSync(temporaryFile, alertDataFile);
    return true;
  } catch (error) {
    console.error("alert storage could not be written", error instanceof Error ? error.message : error);
    return false;
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(currentDir, "../dist");
app.use(express.static(distDir, { index: false, maxAge: "1h" }));
app.get("/{*splat}", (_req, res) => res.sendFile(path.join(distDir, "index.html")));

app.listen(port, host, () => {
  console.log(`Pladevarsel server kører på http://${host}:${port}`);
});
