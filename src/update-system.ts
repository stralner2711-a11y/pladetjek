export type UpdateManifest = {
  activeVersion: string;
  activeVersionCode: number;
  minimumSupportedVersionCode: number;
  apkDownloadUrl: string;
  releasePageUrl: string;
  sha256: string;
  changelog: string[];
  forceUpdate: boolean;
  updatedAt: string;
};

type UpdateOptions = {
  officialRepo?: string;
};

export const DEFAULT_OFFICIAL_REPO = "https://github.com/stralner2711-a11y/pladetjek";
export const DEFAULT_MANIFEST_URL =
  "https://raw.githubusercontent.com/stralner2711-a11y/pladetjek/main/version.json";

export function isAllowedUpdateUrl(value: string, options: UpdateOptions = {}) {
  try {
    const parsed = new URL(value);
    const repo = new URL(options.officialRepo ?? DEFAULT_OFFICIAL_REPO);
    if (parsed.protocol !== "https:") return false;

    const [owner, name] = repo.pathname
      .replace(/^\/|\/$/g, "")
      .split("/")
      .map((part) => part.toLowerCase());
    const parts = parsed.pathname
      .replace(/^\/|\/$/g, "")
      .split("/")
      .map((part) => part.toLowerCase());
    const host = parsed.hostname.toLowerCase();

    if (!owner || !name) return false;
    if (host === "github.com") return parts[0] === owner && parts[1] === name;
    if (host === "raw.githubusercontent.com") return parts[0] === owner && parts[1] === name;
    if (host === `${owner}.github.io`) return parts[0] === name;
    return false;
  } catch {
    return false;
  }
}

export function normalizeUpdateManifest(
  raw: unknown,
  options: UpdateOptions = {},
): UpdateManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error("Versionsfilen er ikke gyldig.");
  }

  const source = raw as Record<string, unknown>;
  const activeVersion = String(source.activeVersion ?? "").trim();
  const activeVersionCode = Number(source.activeVersionCode);
  const minimumSupportedVersionCode = Number(source.minimumSupportedVersionCode ?? 1);
  const apkDownloadUrl = String(source.apkDownloadUrl ?? "").trim();
  const releasePageUrl = String(source.releasePageUrl ?? "").trim();
  const sha256 = String(source.sha256 ?? "").trim().toLowerCase();

  if (!activeVersion) throw new Error("activeVersion mangler.");
  if (!Number.isSafeInteger(activeVersionCode) || activeVersionCode < 1) {
    throw new Error("activeVersionCode er ugyldig.");
  }
  if (!Number.isSafeInteger(minimumSupportedVersionCode) || minimumSupportedVersionCode < 1) {
    throw new Error("minimumSupportedVersionCode er ugyldig.");
  }
  if (!isAllowedUpdateUrl(apkDownloadUrl, options) || !/\.apk(?:$|\?)/i.test(apkDownloadUrl)) {
    throw new Error("APK-linket kommer ikke fra den godkendte GitHub-kilde.");
  }
  if (releasePageUrl && !isAllowedUpdateUrl(releasePageUrl, options)) {
    throw new Error("Release-linket kommer ikke fra den godkendte GitHub-kilde.");
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("APK-filens SHA-256-kontrolsum mangler eller er ugyldig.");
  }

  return {
    activeVersion,
    activeVersionCode,
    minimumSupportedVersionCode,
    apkDownloadUrl,
    releasePageUrl,
    sha256,
    changelog: Array.isArray(source.changelog)
      ? source.changelog.map(String).map((line) => line.trim()).filter(Boolean).slice(0, 8)
      : [],
    forceUpdate: Boolean(source.forceUpdate),
    updatedAt: String(source.updatedAt ?? ""),
  };
}

export function updateIsRequired(manifest: UpdateManifest, currentVersionCode: number) {
  return manifest.forceUpdate || currentVersionCode < manifest.minimumSupportedVersionCode;
}

export function updateIsAvailable(manifest: UpdateManifest, currentVersionCode: number) {
  return manifest.activeVersionCode > currentVersionCode;
}

export async function fetchUpdateManifest(
  manifestUrl: string,
  options: UpdateOptions = {},
): Promise<UpdateManifest> {
  if (!isAllowedUpdateUrl(manifestUrl, options)) {
    throw new Error("Versionsadressen er ikke godkendt.");
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const separator = manifestUrl.includes("?") ? "&" : "?";
    const response = await fetch(`${manifestUrl}${separator}t=${Date.now()}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Opdateringsserveren svarede ${response.status}.`);
    return normalizeUpdateManifest(await response.json(), options);
  } finally {
    window.clearTimeout(timeout);
  }
}
