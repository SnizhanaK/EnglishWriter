export function buildWordPrompt({ mode, category }) {
    return `
Return ONLY valid JSON. No markdown. No extra text.

Task:
Generate 1 vocabulary pair for a guessing game.

Mode: ${mode}  // "random" or "category"
Category (if mode=category): ${category || ''}

Rules:
- category: English, 1-2 words max, lowercase, letters only (no hyphens if possible).
- ru: one common Russian noun, lowercase, Cyrillic only, no spaces.
- en: one English word, lowercase a-z only, no spaces.
- Avoid proper nouns, slang, abbreviations.
- Avoid very short words (2-3 letters). Prefer 4-9 letters for en.
- Avoid extremely common beginner words (cat, dog, apple, red, blue, car, house, water, sun, book).
- ru and en must be correct translations (same meaning).
- Use a concrete noun.

JSON format exactly:
{
  "category": "....",
  "ru": "....",
  "en": "...."
}
`.trim()
}

export function buildWordBatchPrompt({ mode, category, count }) {
    return `
Return ONLY valid JSON. No markdown. No extra text.

Task:
Generate ${count} vocabulary pairs for a guessing game.

Mode: ${mode}  // "random" or "category"
Category (if mode=category): ${category || ''}

Important:
- In random mode: choose ONE less-common category and use it for ALL items.
- Do NOT use common categories: animals, food, colors, fruits, sports, countries, cities, family, body, school, weather, transport, clothes.

Rules (for EVERY item):
- category: English, 1-2 words max, lowercase, letters only.
- ru: one common Russian noun, lowercase, Cyrillic only, no spaces.
- en: one English word, lowercase a-z only, no spaces.
- Avoid proper nouns, slang, abbreviations.
- Prefer 4-9 letters for en.
- Avoid extremely common beginner words (cat, dog, apple, red, blue, car, house, water, sun, book).
- ru and en must be correct translations (same meaning).
- Use a concrete noun.
- All "en" must be unique within the array.

JSON format exactly (array):
[
  { "category": "....", "ru": "...", "en": "..." }
]
`.trim()
}