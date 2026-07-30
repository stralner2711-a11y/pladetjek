import assert from "node:assert/strict";
import test from "node:test";
import { extractDanishPlate } from "./plate-recognition.ts";

test("finder en dansk nummerplade i OCR-tekst", () => {
  assert.equal(extractDanishPlate("VOLVO\nAB 12 345\nDANMARK"), "AB12345");
  assert.equal(extractDanishPlate("AB-12345"), "AB12345");
});

test("retter almindelige OCR-forvekslinger efter position", () => {
  assert.equal(extractDanishPlate("A8 I2S4S"), "AB12545");
});

test("afviser tekst uden nummerplademønster", () => {
  assert.equal(extractDanishPlate("PARKERING FORBUDT"), null);
  assert.equal(extractDanishPlate("1234567"), null);
});
