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

function normalizeCandidate(value: string) {
  if (value.length !== 7) return null;
  const rawFirst = value.slice(0, 2);
  if (!/[A-ZÆØÅ]/.test(rawFirst)) return null;
  const first = rawFirst
    .split("")
    .map((character) => LETTER_FROM_DIGIT[character] ?? character)
    .join("");
  const last = value
    .slice(2)
    .split("")
    .map((character) => DIGIT_FROM_LETTER[character] ?? character)
    .join("");
  const candidate = `${first}${last}`;
  return /^[A-ZÆØÅ]{2}\d{5}$/.test(candidate) ? candidate : null;
}

export function extractDanishPlate(recognizedText: string) {
  const lines = recognizedText
    .toUpperCase()
    .split(/\r?\n/)
    .map((line) => line.replace(/[^A-ZÆØÅ0-9]/g, ""))
    .filter(Boolean);

  for (const line of lines) {
    for (let index = 0; index <= line.length - 7; index += 1) {
      const candidate = normalizeCandidate(line.slice(index, index + 7));
      if (candidate) return candidate;
    }
  }
  return null;
}
