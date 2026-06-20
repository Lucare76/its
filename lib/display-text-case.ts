const preservedUppercaseWords = new Set([
  "BIC",
  "EU",
  "GPS",
  "IBAN",
  "PDF",
  "SNAV",
  "SUV",
  "VIP",
]);

const englishLowercaseTitleWords = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from",
  "in", "of", "on", "or", "the", "to", "with",
]);

const italianLowercaseTitleWords = new Set([
  "a", "al", "alla", "con", "da", "dal", "dalla", "dei", "del",
  "della", "di", "e", "in", "o", "per", "su", "tra",
]);

function isAllCapsText(value: string) {
  const letters = value.match(/\p{L}/gu) ?? [];
  return letters.length > 1 && letters.every((letter) => letter === letter.toLocaleUpperCase());
}

function restorePreservedWord(value: string) {
  const upper = value.toLocaleUpperCase();
  return preservedUppercaseWords.has(upper) ? upper : value;
}

function capitalizeWord(value: string) {
  const restored = restorePreservedWord(value);
  if (restored !== value) return restored;
  return value.replace(/(^|[-'’])(\p{L})/gu, (_, separator: string, letter: string) =>
    `${separator}${letter.toLocaleUpperCase()}`,
  );
}

export function displayTitleCase(value: string | null | undefined, language: "it" | "en" = "en") {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!normalized || !isAllCapsText(normalized)) return normalized;

  const words = normalized.toLocaleLowerCase().split(" ");
  const lowercaseWords = language === "it" ? italianLowercaseTitleWords : englishLowercaseTitleWords;

  return words.map((word, index) => {
    const bareWord = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    if (index > 0 && index < words.length - 1 && lowercaseWords.has(bareWord)) {
      return restorePreservedWord(word);
    }
    return capitalizeWord(word);
  }).join(" ");
}

export function displaySentenceCase(value: string | null | undefined) {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!normalized || !isAllCapsText(normalized)) return normalized;

  const lowered = normalized.toLocaleLowerCase();
  const capitalized = lowered.replace(/(^|[.!?]\s+)(\p{L})/gu, (_, prefix: string, letter: string) =>
    `${prefix}${letter.toLocaleUpperCase()}`,
  );

  return capitalized.replace(/\b[\p{L}\p{N}]+\b/gu, restorePreservedWord);
}
