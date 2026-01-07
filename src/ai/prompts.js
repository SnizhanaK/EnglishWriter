export function buildWordPrompt({ mode, category }) {
    return `
Return ONLY valid JSON. No markdown. No extra text.

Task:
Generate 1 vocabulary pair for a guessing game.

Mode: ${mode}  // "random" or "category"
Category (if mode=category): ${category || ''}

Uniqueness requirement (very important):
- In random mode, avoid common/repetitive categories and outputs.
- Do NOT use these categories (too common): animals, food, colors, fruits, sports, countries, cities, family, body, school, weather, transport, clothes.
- Prefer less common categories (examples): tools, woodworking, astronomy, geology, architecture, ecology, chemistry, gardening, sewing, photography, sailing, cooking methods, musical instruments, computer hardware, electrical parts, anatomy (advanced), kitchen tools.

Rules:
- category: English, 1-2 words max, lowercase, letters only (no hyphens if possible).
- ru: one common Russian noun, lowercase, Cyrillic only, no spaces.
- en: one English word, lowercase a-z only, no spaces.
- Avoid proper nouns, slang, abbreviations.
- Avoid very short words (2-3 letters). Prefer 4-9 letters for en.
- Avoid words that are extremely common in beginner lists (cat, dog, apple, red, blue, car, house, water, sun, book).

Quality:
- ru and en must be correct translations of each other (same meaning).
- Use a concrete noun (a real object/thing).

JSON format exactly:
{
  "category": "....",
  "ru": "....",
  "en": "...."
}
`.trim()
}