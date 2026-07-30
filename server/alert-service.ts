import { randomUUID } from "node:crypto";

export type VehicleAlert = {
  id: string;
  plate: string;
  description: string;
  createdAt: string;
  expiresAt: string;
};

export type CreateAlertResult = {
  alert: VehicleAlert;
  duplicate: boolean;
};

export function normalizePlate(value: string) {
  return value.toUpperCase().replace(/[^A-ZÆØÅ0-9]/g, "").slice(0, 7);
}

export function isValidDanishPlate(value: string) {
  return /^[A-ZÆØÅ]{2}\d{5}$/.test(normalizePlate(value));
}

export function normalizeDescription(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

export class AlertService {
  private alerts: VehicleAlert[];

  constructor(
    private readonly lifetimeMs = Number.POSITIVE_INFINITY,
    private readonly duplicateWindowMs = 15 * 60 * 1000,
    private readonly maxAlerts = 500,
    initialAlerts: VehicleAlert[] = [],
  ) {
    this.alerts = initialAlerts
      .filter((alert) =>
        Boolean(
          alert
          && typeof alert.id === "string"
          && isValidDanishPlate(alert.plate)
          && normalizeDescription(alert.description).length >= 5
          && Number.isFinite(Date.parse(alert.createdAt))
          && Number.isFinite(Date.parse(alert.expiresAt)),
        ))
      .slice(0, maxAlerts);
  }

  active(now = Date.now()) {
    this.removeExpired(now);
    return [...this.alerts].sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    );
  }

  match(value: string, now = Date.now()) {
    const plate = normalizePlate(value);
    if (!isValidDanishPlate(plate)) {
      throw new Error("INVALID_PLATE");
    }
    this.removeExpired(now);
    return this.alerts.find((alert) => alert.plate === plate) ?? null;
  }

  create(value: string, descriptionValue: string, now = Date.now()): CreateAlertResult {
    const plate = normalizePlate(value);
    if (!isValidDanishPlate(plate)) {
      throw new Error("INVALID_PLATE");
    }
    const description = normalizeDescription(descriptionValue);
    if (description.length < 5 || description.length > 240) {
      throw new Error("INVALID_DESCRIPTION");
    }

    this.removeExpired(now);
    const duplicate = this.alerts.find(
      (alert) =>
        alert.plate === plate
        && now - Date.parse(alert.createdAt) < this.duplicateWindowMs,
    );
    if (duplicate) return { alert: duplicate, duplicate: true };

    const alert: VehicleAlert = {
      id: randomUUID(),
      plate,
      description,
      createdAt: new Date(now).toISOString(),
      expiresAt: Number.isFinite(this.lifetimeMs)
        ? new Date(now + this.lifetimeMs).toISOString()
        : "9999-12-31T23:59:59.999Z",
    };
    this.alerts = [alert, ...this.alerts].slice(0, this.maxAlerts);
    return { alert, duplicate: false };
  }

  private removeExpired(now: number) {
    this.alerts = this.alerts.filter((alert) => Date.parse(alert.expiresAt) > now);
  }
}
