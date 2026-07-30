import assert from "node:assert/strict";
import test from "node:test";
import {
  AlertService,
  isValidDanishPlate,
  normalizeDescription,
  normalizePlate,
} from "./alert-service.ts";

test("nummerplader normaliseres og valideres", () => {
  assert.equal(normalizePlate("ab 12-345"), "AB12345");
  assert.equal(isValidDanishPlate("AB 12 345"), true);
  assert.equal(isValidDanishPlate("12345"), false);
  assert.equal(normalizeDescription("  Kørte\nlangsomt  "), "Kørte langsomt");
});

test("samme nummerplade udsendes ikke igen inden for dubletvinduet", () => {
  const service = new AlertService(60_000, 15_000);
  const first = service.create("AB12345", "Kørte langsomt forbi", 1_000);
  const second = service.create("AB 12 345", "Ny tekst ignoreres som dublet", 5_000);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.alert.id, first.alert.id);
  assert.equal(service.active(5_000).length, 1);
});

test("advarsler udløber automatisk", () => {
  const service = new AlertService(10_000);
  service.create("AB12345", "Kørte langsomt forbi", 1_000);
  assert.equal(service.active(10_999).length, 1);
  assert.equal(service.match("AB 12 345", 10_999)?.description, "Kørte langsomt forbi");
  assert.equal(service.match("CD 67 890", 10_999), null);
  assert.equal(service.active(11_001).length, 0);
  assert.equal(service.match("AB12345", 11_001), null);
});

test("nummerpladeadvarsler gemmes uden automatisk udløb som standard", () => {
  const service = new AlertService();
  const created = service.create("AB12345", "Kørte langsomt forbi", 1_000);
  const oneYearLater = 1_000 + 365 * 24 * 60 * 60 * 1000;

  assert.equal(created.alert.expiresAt, "9999-12-31T23:59:59.999Z");
  assert.equal(service.match("AB12345", oneYearLater)?.id, created.alert.id);
});

test("en observationstekst på 5 til 240 tegn er påkrævet", () => {
  const service = new AlertService();
  assert.throws(() => service.create("AB12345", "kort", 1_000), /INVALID_DESCRIPTION/);
  assert.throws(() => service.create("AB12345", "x".repeat(241), 1_000), /INVALID_DESCRIPTION/);
});
