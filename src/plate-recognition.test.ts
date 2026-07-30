import assert from "node:assert/strict";
import test from "node:test";
import {
  advancePlateEvidence,
  calculateFocusPoint,
  calculateCoverCrop,
  clampCameraZoom,
  estimateImageLuminance,
  extractDanishPlate,
  findBestPlateCandidate,
  plateCaptureFilter,
  type PlateRecognitionResult,
  type RecognizedTextLine,
} from "./plate-recognition.ts";

function line(overrides: Partial<RecognizedTextLine> = {}): RecognizedTextLine {
  return {
    text: "AB 12 345",
    confidence: 0.92,
    angle: 1.5,
    left: 210,
    top: 105,
    width: 540,
    height: 112,
    elements: [
      { text: "AB", confidence: 0.94, left: 210, top: 105, width: 125, height: 112 },
      { text: "12", confidence: 0.93, left: 355, top: 105, width: 125, height: 112 },
      { text: "345", confidence: 0.9, left: 500, top: 105, width: 250, height: 112 },
    ],
    ...overrides,
  };
}

function recognition(overrides: Partial<PlateRecognitionResult> = {}): PlateRecognitionResult {
  return {
    text: "AB 12 345",
    imageWidth: 960,
    imageHeight: 320,
    lines: [line()],
    ...overrides,
  };
}

test("finder en dansk nummerplade i en ren OCR-linje", () => {
  assert.equal(extractDanishPlate("VOLVO\nAB 12 345\nDANMARK"), "AB12345");
  assert.equal(extractDanishPlate("AB-12345"), "AB12345");
});

test("retter almindelige OCR-forvekslinger efter position", () => {
  assert.equal(extractDanishPlate("A8 I2S4S"), "AB12545");
});

test("afviser tekst, der kun indeholder nummerplademønstret som deltekst", () => {
  assert.equal(extractDanishPlate("PARKERING FORBUDT"), null);
  assert.equal(extractDanishPlate("1234567"), null);
  assert.equal(extractDanishPlate("VOLVOAB12345SERVICE"), null);
});

test("vælger en geometrisk troværdig nummerplade i scanningsfeltet", () => {
  const candidate = findBestPlateCandidate(recognition());
  assert.equal(candidate?.plate, "AB12345");
  assert.ok((candidate?.score ?? 0) >= 0.82);
});

test("samler tilstødende OCR-elementer uden at acceptere tekst omkring pladen", () => {
  const withSurroundingText = line({
    text: "VOLVO AB 12 345 DK",
    elements: [
      { text: "VOLVO", confidence: 0.91, left: 40, top: 105, width: 140, height: 112 },
      { text: "AB", confidence: 0.94, left: 210, top: 105, width: 125, height: 112 },
      { text: "12", confidence: 0.93, left: 355, top: 105, width: 125, height: 112 },
      { text: "345", confidence: 0.9, left: 500, top: 105, width: 250, height: 112 },
      { text: "DK", confidence: 0.9, left: 780, top: 105, width: 80, height: 112 },
    ],
  });
  assert.equal(findBestPlateCandidate(recognition({ lines: [withSurroundingText] }))?.plate, "AB12345");
});

test("afviser lav sikkerhed, kraftig hældning og forkert tekstgeometri", () => {
  const lowConfidence = line();
  lowConfidence.confidence = 0.2;
  lowConfidence.elements = lowConfidence.elements.map((element) => ({
    ...element,
    confidence: 0.2,
  }));
  const squareText = line({
    text: "AB12345",
    width: 120,
    height: 120,
    elements: [{
      text: "AB12345",
      confidence: 0.92,
      left: 420,
      top: 100,
      width: 120,
      height: 120,
    }],
  });

  assert.equal(findBestPlateCandidate(recognition({ lines: [lowConfidence] })), null);
  assert.equal(findBestPlateCandidate(recognition({ lines: [line({ angle: 24 })] })), null);
  assert.equal(findBestPlateCandidate(recognition({ lines: [squareText] })), null);
});

test("kræver gentagelse i flere kamerabilleder før bekræftelse", () => {
  const candidate = findBestPlateCandidate(recognition());
  assert.ok(candidate);
  const first = advancePlateEvidence(null, candidate, 1_000);
  assert.equal(first.confirmed, false);
  assert.equal(first.evidence?.hits, 1);
  const second = advancePlateEvidence(first.evidence, candidate, 1_900);
  assert.equal(second.confirmed, true);

  const other = { ...candidate, plate: "CD67890" };
  const changed = advancePlateEvidence(second.evidence, other, 2_800);
  assert.equal(changed.confirmed, false);
  assert.equal(changed.evidence?.hits, 1);
});

test("måler mørke kamerabilleder og vælger kraftigere natbehandling", () => {
  const darkPixels = new Uint8ClampedArray([
    18, 18, 18, 255,
    42, 42, 42, 255,
    30, 30, 30, 255,
    26, 26, 26, 255,
  ]);
  const daylightPixels = new Uint8ClampedArray([
    160, 165, 170, 255,
    190, 195, 200, 255,
    175, 180, 185, 255,
    210, 215, 220, 255,
  ]);

  const darkLuminance = estimateImageLuminance(darkPixels, 1);
  const daylightLuminance = estimateImageLuminance(daylightPixels, 1);

  assert.ok(darkLuminance < 52);
  assert.ok(daylightLuminance > 112);
  assert.match(plateCaptureFilter(darkLuminance), /brightness\(1\.9\)/);
  assert.equal(plateCaptureFilter(daylightLuminance), "grayscale(1) contrast(1.35)");
});

test("kortlægger den synlige scanningsramme til videoets objekt-fit-cover", () => {
  const crop = calculateCoverCrop(
    1920,
    1080,
    400,
    300,
    { left: 96, top: 141, width: 208, height: 87 },
    0,
  );
  assert.ok(Math.abs(crop.x - 585.6) < 1);
  assert.ok(Math.abs(crop.y - 507.6) < 1);
  assert.ok(Math.abs(crop.width - 748.8) < 1);
  assert.ok(Math.abs(crop.height - 313.2) < 1);
});

test("begrænser kamerazoom til telefonens understøttede område", () => {
  assert.equal(clampCameraZoom(0.5, 1, 5), 1);
  assert.equal(clampCameraZoom(3.25, 1, 5), 3.25);
  assert.equal(clampCameraZoom(9, 1, 5), 5);
});

test("omsætter et tryk på kamerafeltet til et normaliseret fokuspunkt", () => {
  assert.deepEqual(
    calculateFocusPoint(250, 175, { left: 50, top: 25, width: 400, height: 300 }),
    { x: 0.5, y: 0.5 },
  );
  assert.deepEqual(
    calculateFocusPoint(-20, 900, { left: 50, top: 25, width: 400, height: 300 }),
    { x: 0, y: 1 },
  );
});
