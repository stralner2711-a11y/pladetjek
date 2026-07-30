const LETTER_FROM_DIGIT: Record<string, string> = {
  "0": "O",
  "1": "I",
  "2": "Z",
  "5": "S",
  "8": "B",
};

const DIGIT_FROM_LETTER: Record<string, string> = {
  B: "8",
  G: "6",
  I: "1",
  O: "0",
  S: "5",
  T: "7",
  Z: "2",
};

export type RecognizedTextElement = {
  text: string;
  confidence: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type RecognizedTextLine = RecognizedTextElement & {
  angle: number;
  elements: RecognizedTextElement[];
};

export type PlateRecognitionResult = {
  text: string;
  imageWidth: number;
  imageHeight: number;
  lines: RecognizedTextLine[];
};

export type PlateCandidate = {
  plate: string;
  score: number;
  confidence: number;
};

export type PlateEvidence = {
  plate: string;
  hits: number;
  misses: number;
  lastSeenAt: number;
  requiredHits: number;
};

export type VideoCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type NormalizedCandidate = {
  plate: string;
  substitutions: number;
};

function normalizeCandidate(value: string): NormalizedCandidate | null {
  const compact = value.toUpperCase().replace(/[^A-ZÆØÅ0-9]/g, "");
  if (compact.length !== 7) return null;

  const rawFirst = compact.slice(0, 2);
  if (![...rawFirst].some((character) => /[A-ZÆØÅ]/.test(character))) return null;

  let substitutions = 0;
  const first = [...rawFirst]
    .map((character) => {
      const corrected = LETTER_FROM_DIGIT[character] ?? character;
      if (corrected !== character) substitutions += 1;
      return corrected;
    })
    .join("");
  const last = [...compact.slice(2)]
    .map((character) => {
      const corrected = DIGIT_FROM_LETTER[character] ?? character;
      if (corrected !== character) substitutions += 1;
      return corrected;
    })
    .join("");
  const plate = `${first}${last}`;

  return /^[A-ZÆØÅ]{2}\d{5}$/.test(plate)
    ? { plate, substitutions }
    : null;
}

export function extractDanishPlate(recognizedText: string) {
  const lines = recognizedText
    .split(/\r?\n/)
    .map((line) => normalizeCandidate(line))
    .filter((candidate): candidate is NormalizedCandidate => candidate !== null);
  return lines[0]?.plate ?? null;
}

function unionElements(elements: RecognizedTextElement[]) {
  const left = Math.min(...elements.map((element) => element.left));
  const top = Math.min(...elements.map((element) => element.top));
  const right = Math.max(...elements.map((element) => element.left + element.width));
  const bottom = Math.max(...elements.map((element) => element.top + element.height));
  const totalWidth = elements.reduce((sum, element) => sum + Math.max(1, element.width), 0);
  const confidence = elements.reduce(
    (sum, element) => sum + element.confidence * Math.max(1, element.width),
    0,
  ) / totalWidth;

  return {
    text: elements.map((element) => element.text).join(""),
    confidence,
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

function candidateRegions(line: RecognizedTextLine) {
  const regions: RecognizedTextElement[] = [{
    text: line.text,
    confidence: line.confidence,
    left: line.left,
    top: line.top,
    width: line.width,
    height: line.height,
  }];

  for (let start = 0; start < line.elements.length; start += 1) {
    for (let end = start + 1; end <= Math.min(line.elements.length, start + 4); end += 1) {
      const region = unionElements(line.elements.slice(start, end));
      const length = region.text.toUpperCase().replace(/[^A-ZÆØÅ0-9]/g, "").length;
      if (length === 7) regions.push(region);
      if (length >= 7) break;
    }
  }

  return regions;
}

function scoreRegion(
  region: RecognizedTextElement,
  lineAngle: number,
  imageWidth: number,
  imageHeight: number,
  substitutions: number,
) {
  if (region.width <= 0 || region.height <= 0 || imageWidth <= 0 || imageHeight <= 0) return null;

  const relativeWidth = region.width / imageWidth;
  const relativeHeight = region.height / imageHeight;
  const aspectRatio = region.width / region.height;
  const centerX = (region.left + region.width / 2) / imageWidth;
  const centerY = (region.top + region.height / 2) / imageHeight;
  const angle = Math.abs(lineAngle);
  const reportedConfidence = Number.isFinite(region.confidence) ? region.confidence : 0;

  if (
    relativeWidth < 0.16
    || relativeWidth > 0.98
    || relativeHeight < 0.07
    || relativeHeight > 0.48
    || aspectRatio < 1.8
    || aspectRatio > 9
    || centerX < 0.1
    || centerX > 0.9
    || centerY < 0.08
    || centerY > 0.92
    || angle > 16
    || (reportedConfidence > 0 && reportedConfidence < 0.48)
  ) {
    return null;
  }

  const confidence = reportedConfidence > 0 ? reportedConfidence : 0.58;
  const aspectScore = Math.max(0, 1 - Math.abs(aspectRatio - 4.6) / 4.6);
  const angleScore = Math.max(0, 1 - angle / 16);
  const centerDistance = Math.hypot(centerX - 0.5, centerY - 0.5);
  const centerScore = Math.max(0, 1 - centerDistance / 0.62);
  const correctionScore = Math.max(0, 1 - substitutions * 0.12);
  const score = (
    confidence * 0.45
    + aspectScore * 0.2
    + angleScore * 0.15
    + centerScore * 0.1
    + correctionScore * 0.1
  );

  return score >= 0.62 ? Math.min(1, score) : null;
}

export function findBestPlateCandidate(result: PlateRecognitionResult): PlateCandidate | null {
  const candidates: PlateCandidate[] = [];

  for (const line of result.lines ?? []) {
    for (const region of candidateRegions(line)) {
      const normalized = normalizeCandidate(region.text);
      if (!normalized) continue;
      const score = scoreRegion(
        region,
        line.angle,
        result.imageWidth,
        result.imageHeight,
        normalized.substitutions,
      );
      if (score === null) continue;
      candidates.push({
        plate: normalized.plate,
        score,
        confidence: region.confidence,
      });
    }
  }

  return candidates.sort((left, right) => right.score - left.score)[0] ?? null;
}

export function advancePlateEvidence(
  previous: PlateEvidence | null,
  candidate: PlateCandidate | null,
  now: number,
) {
  if (!candidate) {
    if (previous && previous.misses < 1 && now - previous.lastSeenAt <= 2_500) {
      return { evidence: { ...previous, misses: previous.misses + 1 }, confirmed: false };
    }
    return { evidence: null, confirmed: false };
  }

  const requiredHits = candidate.score >= 0.82 ? 2 : 3;
  const continuing = previous?.plate === candidate.plate
    && now - previous.lastSeenAt <= 3_500;
  const evidence: PlateEvidence = continuing
    ? {
        plate: candidate.plate,
        hits: previous.hits + 1,
        misses: 0,
        lastSeenAt: now,
        requiredHits: Math.min(previous.requiredHits, requiredHits),
      }
    : {
        plate: candidate.plate,
        hits: 1,
        misses: 0,
        lastSeenAt: now,
        requiredHits,
      };

  return { evidence, confirmed: evidence.hits >= evidence.requiredHits };
}

export function estimateImageLuminance(
  pixels: Uint8ClampedArray,
  sampleEveryPixels = 4,
) {
  if (pixels.length < 4) return 0;
  const stride = Math.max(1, Math.floor(sampleEveryPixels)) * 4;
  let total = 0;
  let samples = 0;

  for (let index = 0; index + 2 < pixels.length; index += stride) {
    total += (
      pixels[index] * 0.2126
      + pixels[index + 1] * 0.7152
      + pixels[index + 2] * 0.0722
    );
    samples += 1;
  }

  return samples ? total / samples : 0;
}

export function plateCaptureFilter(luminance: number) {
  if (luminance < 52) return "grayscale(1) brightness(1.9) contrast(1.7)";
  if (luminance < 82) return "grayscale(1) brightness(1.5) contrast(1.55)";
  if (luminance < 112) return "grayscale(1) brightness(1.2) contrast(1.45)";
  return "grayscale(1) contrast(1.35)";
}

export function calculateCoverCrop(
  videoWidth: number,
  videoHeight: number,
  containerWidth: number,
  containerHeight: number,
  overlay: { left: number; top: number; width: number; height: number },
  paddingRatio = 0.08,
): VideoCrop {
  if (
    videoWidth <= 0
    || videoHeight <= 0
    || containerWidth <= 0
    || containerHeight <= 0
    || overlay.width <= 0
    || overlay.height <= 0
  ) {
    throw new Error("Ugyldige kameramål.");
  }

  const scale = Math.max(containerWidth / videoWidth, containerHeight / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  const offsetX = (containerWidth - renderedWidth) / 2;
  const offsetY = (containerHeight - renderedHeight) / 2;
  const raw = {
    x: (overlay.left - offsetX) / scale,
    y: (overlay.top - offsetY) / scale,
    width: overlay.width / scale,
    height: overlay.height / scale,
  };
  const paddingX = raw.width * paddingRatio;
  const paddingY = raw.height * paddingRatio;
  const x = Math.max(0, raw.x - paddingX);
  const y = Math.max(0, raw.y - paddingY);
  const right = Math.min(videoWidth, raw.x + raw.width + paddingX);
  const bottom = Math.min(videoHeight, raw.y + raw.height + paddingY);

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}
