import assert from "node:assert/strict";
import test from "node:test";
import {
  isAllowedUpdateUrl,
  normalizeUpdateManifest,
  updateIsAvailable,
  updateIsRequired,
} from "./update-system.ts";

const validManifest = {
  activeVersion: "1.1.0",
  activeVersionCode: 2,
  minimumSupportedVersionCode: 1,
  apkDownloadUrl:
    "https://github.com/stralner2711-a11y/pladetjek/releases/download/v1.1.0/Pladetjek.apk",
  releasePageUrl: "https://github.com/stralner2711-a11y/pladetjek/releases/tag/v1.1.0",
  sha256: "a".repeat(64),
  changelog: ["Bedre scanning"],
  forceUpdate: false,
};

test("updatekilder begrænses til det officielle repository", () => {
  assert.equal(isAllowedUpdateUrl(validManifest.apkDownloadUrl), true);
  assert.equal(
    isAllowedUpdateUrl("https://github.com/en-anden/ejer/releases/download/v1/app.apk"),
    false,
  );
  assert.equal(isAllowedUpdateUrl("http://github.com/stralner2711-a11y/pladetjek/app.apk"), false);
});

test("manifest valideres og versionsregler anvendes", () => {
  const manifest = normalizeUpdateManifest(validManifest);
  assert.equal(updateIsAvailable(manifest, 1), true);
  assert.equal(updateIsAvailable(manifest, 2), false);
  assert.equal(updateIsRequired(manifest, 1), false);

  const forced = normalizeUpdateManifest({ ...validManifest, minimumSupportedVersionCode: 2 });
  assert.equal(updateIsRequired(forced, 1), true);
});

test("manifest uden gyldig SHA-256 afvises", () => {
  assert.throws(
    () => normalizeUpdateManifest({ ...validManifest, sha256: "ukendt" }),
    /SHA-256/,
  );
});
