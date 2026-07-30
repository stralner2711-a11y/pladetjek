const API_BASE = "https://api.nrpla.de";

type UnknownRecord = Record<string, unknown>;

export type VehicleLookup = {
  plate: string;
  make: string;
  model: string;
  version: string | null;
  kind: string;
  vin: string;
  firstRegistration: string | null;
  registrationStatus: string;
  insurance: {
    status: string | null;
    company: string | null;
    created: string | null;
  };
  liens: {
    count: number;
    totalAmount: number | null;
    currency: "DKK";
    creditors: Array<{ name: string; cvr: string | null }>;
    checked: boolean;
  };
  sources: Array<{
    name: string;
    status: "ok" | "partial" | "unavailable";
    detail: string;
  }>;
  checkedAt: string;
};

export class SourceError extends Error {
  constructor(
    public code: "NOT_CONFIGURED" | "NOT_FOUND" | "UPSTREAM_ERROR",
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? value as UnknownRecord : {};
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unwrapData(value: unknown): unknown {
  const record = asRecord(value);
  return "data" in record ? record.data : value;
}

async function apiGet(path: string, token: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "Pladetjek/0.2",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = await response.json().catch(() => null);
  if (response.status === 404) {
    throw new SourceError("NOT_FOUND", "Køretøjet blev ikke fundet.", 404);
  }
  if (!response.ok) {
    const message = asText(asRecord(body).message) ?? `Datakilden svarede med HTTP ${response.status}.`;
    throw new SourceError("UPSTREAM_ERROR", message, response.status >= 500 ? 502 : response.status);
  }
  return body;
}

function parseCreditors(debt: UnknownRecord): Array<{ name: string; cvr: string | null }> {
  const raw = Array.isArray(debt.creditors) ? debt.creditors : [];
  return raw
    .map((item) => {
      const creditor = asRecord(item);
      const name = asText(creditor.name);
      const cvrValue = creditor.cvr;
      return name ? { name, cvr: cvrValue == null ? null : String(cvrValue) } : null;
    })
    .filter((item): item is { name: string; cvr: string | null } => item !== null);
}

function parseDetailedLiens(value: unknown) {
  const detailed = asRecord(unwrapData(value));
  const liabilities = Array.isArray(detailed.liabilities) ? detailed.liabilities : [];
  const creditors = new Map<string, { name: string; cvr: string | null }>();
  let totalAmount = 0;
  let hasAmount = false;

  for (const item of liabilities) {
    const liability = asRecord(item);
    const amount = asNumber(liability.amount);
    if (amount !== null) {
      totalAmount += amount;
      hasAmount = true;
    }
    for (const creditor of parseCreditors(liability)) {
      creditors.set(`${creditor.cvr ?? ""}:${creditor.name}`, creditor);
    }
  }

  return {
    count: liabilities.length,
    totalAmount: hasAmount ? totalAmount : null,
    creditors: [...creditors.values()],
  };
}

export async function lookupViaNummerpladeApi(
  registration: string,
  token: string | undefined,
  timeoutMs: number,
): Promise<VehicleLookup> {
  if (!token) {
    throw new SourceError(
      "NOT_CONFIGURED",
      "Nummerplade API er ikke konfigureret. Tilføj NUMMERPLADE_API_TOKEN på serveren.",
      503,
    );
  }

  const plate = registration.toUpperCase().replace(/[^A-ZÆØÅ0-9]/g, "");
  const vehicleRaw = await apiGet(`/${encodeURIComponent(plate)}?advanced=1`, token, timeoutMs);
  const vehicle = asRecord(unwrapData(vehicleRaw));
  const vehicleId = vehicle.vehicle_id == null ? null : String(vehicle.vehicle_id);
  const vin = asText(vehicle.vin);

  const [dmrResult, detailedResult, debtResult] = await Promise.allSettled([
    apiGet(`/dmr/registration/${encodeURIComponent(plate)}`, token, timeoutMs),
    vin
      ? apiGet(`/tinglysning/${encodeURIComponent(vin)}`, token, timeoutMs)
      : Promise.reject(new Error("Intet stelnummer i køretøjsresultatet.")),
    vehicleId
      ? apiGet(`/debt/${encodeURIComponent(vehicleId)}`, token, timeoutMs)
      : Promise.reject(new Error("Intet vehicle_id i køretøjsresultatet.")),
  ]);

  const dmr = dmrResult.status === "fulfilled" ? asRecord(unwrapData(dmrResult.value)) : {};
  const debt = debtResult.status === "fulfilled" ? asRecord(unwrapData(debtResult.value)) : {};
  const insuranceCompany = asText(dmr.insurance_company);
  const insuranceStatus = asText(dmr.insurance_status);
  const noDebt = typeof debt.no_debt === "boolean" ? debt.no_debt : null;
  const detailedLiens = detailedResult.status === "fulfilled"
    ? parseDetailedLiens(detailedResult.value)
    : null;
  const creditors = detailedLiens
    ? detailedLiens.creditors
    : noDebt === false ? parseCreditors(debt) : [];
  const debtAmount = detailedLiens
    ? detailedLiens.totalAmount
    : noDebt === false ? asNumber(debt.amount) : null;
  const lienCount = detailedLiens
    ? detailedLiens.count
    : noDebt === false ? Math.max(creditors.length, 1) : 0;
  const liensChecked = detailedResult.status === "fulfilled" || noDebt !== null;

  return {
    plate,
    make: asText(vehicle.brand) ?? "Ukendt",
    model: asText(vehicle.model) ?? "Ukendt",
    version: asText(vehicle.version),
    kind: asText(vehicle.type) ?? "Ukendt",
    vin: vin ?? "",
    firstRegistration: asText(vehicle.first_registration_date),
    registrationStatus: asText(vehicle.registration_status) ?? "Ukendt",
    insurance: {
      status: insuranceStatus,
      company: insuranceCompany,
      created: asText(dmr.insurance_created),
    },
    liens: {
      count: lienCount,
      totalAmount: debtAmount,
      currency: "DKK",
      creditors,
      checked: liensChecked,
    },
    sources: [
      {
        name: "Nummerplade API",
        status: "ok",
        detail: "Køretøjsdata via registreringsnummer",
      },
      {
        name: "DMR",
        status: dmrResult.status === "fulfilled" ? "ok" : "unavailable",
        detail: dmrResult.status === "fulfilled"
          ? "Forsikringsdata hentet via DMR-endpoint"
          : "DMR-data kunne ikke hentes",
      },
      {
        name: "Bilbogen / Tinglysning",
        status: liensChecked ? (detailedResult.status === "fulfilled" ? "ok" : "partial") : "unavailable",
        detail: detailedResult.status === "fulfilled"
          ? "Detaljerede hæftelser kontrolleret"
          : debtResult.status === "fulfilled"
            ? "Hæftelser kontrolleret via basisopslag"
          : "Tinglysningsdata kunne ikke hentes",
      },
    ],
    checkedAt: new Date().toISOString(),
  };
}
