import assert from "node:assert/strict";
import test from "node:test";
import {
  formatNearbyDistance,
  markNearbyOnboardingHandled,
  nearbyOnboardingWasHandled,
  parseNearbyMatchNotification,
} from "./nearby-alerts";

test("parses a valid privacy-rounded nearby match payload", () => {
  const notification = parseNearbyMatchNotification({
    data: {
      type: "nearby_match",
      eventId: "019fb22c-647e-7733-8fbc-5d3581c30879",
      plate: "AB12345",
      description: "Observeret ved parkeringspladsen",
      observedAt: "2026-07-30T12:34:56.000Z",
      distanceMeters: "1840",
      approximateLatitude: "55.676",
      approximateLongitude: "12.568",
    },
  });

  assert.deepEqual(notification, {
    eventId: "019fb22c-647e-7733-8fbc-5d3581c30879",
    plate: "AB12345",
    description: "Observeret ved parkeringspladsen",
    observedAt: "2026-07-30T12:34:56.000Z",
    distanceMeters: 1840,
    approximateLatitude: 55.676,
    approximateLongitude: 12.568,
  });
});

test("rejects nearby payloads outside the five kilometer boundary", () => {
  const notification = parseNearbyMatchNotification({
    data: {
      type: "nearby_match",
      eventId: "019fb22c-647e-7733-8fbc-5d3581c30879",
      plate: "AB12345",
      description: "Test",
      observedAt: "2026-07-30T12:34:56.000Z",
      distanceMeters: "5001",
      approximateLatitude: "55.676",
      approximateLongitude: "12.568",
    },
  });

  assert.equal(notification, null);
});

test("formats nearby distance without suggesting exact precision", () => {
  assert.equal(formatNearbyDistance(141), "100 m");
  assert.equal(formatNearbyDistance(978), "1 km");
  assert.equal(formatNearbyDistance(1840), "1,8 km");
});

test("shows nearby onboarding only once per permanent user on the device", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };

  assert.equal(nearbyOnboardingWasHandled("user-a", storage), false);
  markNearbyOnboardingHandled("user-a", storage);
  assert.equal(nearbyOnboardingWasHandled("user-a", storage), true);
  assert.equal(nearbyOnboardingWasHandled("user-b", storage), false);
});
