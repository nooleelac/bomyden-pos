// Vietnamese-friendly text helpers for the menu search ("bo nuong", "sbn", "101").

/** Lowercase, strip diacritics (đ -> d), collapse spaces. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** First letter of each word: "Steak bò nướng" -> "sbn". Digits are kept whole ("Bia 333" -> "b333"). */
export function initials(s: string): string {
  return fold(s)
    .split(' ')
    .filter(Boolean)
    .map(w => (/^\d+$/.test(w) ? w : w[0]))
    .join('')
}
