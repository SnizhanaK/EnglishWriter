export function buildWordPrompt({ mode, category, difficulty }) {
    const diffRules =
        difficulty === 'easy'
            ? '- Use simple concrete nouns. Prefer 4-7 letters in EN.\n- Avoid rare/technical terms.\n'
            : difficulty === 'hard'
                ? '- Use less common concrete nouns. Prefer 7-12 letters in EN.\n- Allow technical/less common objects.\n'
                : '- Use medium difficulty concrete nouns. Prefer 5-10 letters in EN.\n- Not too beginner, not too rare.\n'

    return `
Return ONLY valid JSON. No markdown. No extra text.

Task:
Generate 1 vocabulary pair for a guessing game.

Mode: ${mode}  // "random" or "category"
Difficulty: ${difficulty} // "easy" | "medium" | "hard"
Category (if mode=category): ${category || ''}

Rules:
- category: English, 1-2 words max, lowercase, letters only.
- ru: one Russian noun, lowercase, Cyrillic only, no spaces.
- en: one English word, lowercase a-z only, no spaces.
- Avoid proper nouns, slang, abbreviations.
- ru and en must be correct translations (same meaning).
- Use a concrete noun (a real object/thing).
${diffRules}
JSON format exactly:
{
  "category": "....",
  "ru": "....",
  "en": "...."
}
`.trim()
}

export function buildWordBatchPrompt({ mode, category, count, difficulty }) {
    const diffRules =
        difficulty === 'easy'
            ? '- Use simple concrete nouns. Prefer 4-7 letters in EN.\n- Avoid rare/technical terms.\n'
            : difficulty === 'hard'
                ? '- Use less common concrete nouns. Prefer 7-12 letters in EN.\n- Allow technical/less common objects.\n'
                : '- Use medium difficulty concrete nouns. Prefer 5-10 letters in EN.\n- Not too beginner, not too rare.\n'

    return `
Return ONLY valid JSON. No markdown. No extra text.

Task:
Generate ${count} vocabulary pairs for a guessing game.

Mode: ${mode}  // "random" or "category"
Difficulty: ${difficulty} // "easy" | "medium" | "hard"
Category (if mode=category): ${category || ''}

Important:
- In random mode: choose ONE category and use it for ALL items in the array.
- All "en" must be unique within the array.

Rules (for EVERY item):
- category: English, 1-2 words max, lowercase, letters only.
- ru: one Russian noun, lowercase, Cyrillic only, no spaces.
- en: one English word, lowercase a-z only, no spaces.
- Avoid proper nouns, slang, abbreviations.
- ru and en must be correct translations (same meaning).
- Use a concrete noun (a real object/thing).
${diffRules}

JSON format exactly (array):
[
  { "category": "....", "ru": "...", "en": "..." }
]
`.trim()
}

/**
 * ✅ Batch validator prompt (2nd request)
 * Returns array of booleans same length as items:
 * true = keep, false = drop
 */
export function buildCategoryValidationPrompt({ category, items }) {
    const safeItems = (items || []).map((x) => ({
        ru: String(x?.ru || '').trim().toLowerCase(),
        en: String(x?.en || '').trim().toLowerCase(),
    }))

    return `
Return ONLY valid JSON. No markdown. No extra text.

Task:
You are validating vocabulary pairs for a guessing game.

Target category: "${String(category || '').trim().toLowerCase()}"

For each item, decide if it belongs to the target category AND is a correct translation pair.
Also reject items that are too generic or clearly belong to another category (e.g. "salamander" for "restaurants").

Rules:
- Output MUST be a JSON array of booleans, same length and order as input.
- true = keep (fits category + correct translation + concrete noun)
- false = reject

Input items:
${JSON.stringify(safeItems)}

Output format exactly:
[ true, false, ... ]
`.trim()
}