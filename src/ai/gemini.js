import { buildWordPrompt, buildWordBatchPrompt, buildCategoryValidationPrompt } from './prompts.js'

// ✅ Fast & cheap default (Developer API / AI Studio):
// gemini-2.5-flash-lite is positioned as fastest + cost-efficient.  [oai_citation:1‡Android Central](https://www.androidcentral.com/apps-software/ai/gemini-2-5-flash-lite-generally-available-fastest-cost-efficient-series-version?utm_source=chatgpt.com)
const MODEL_GENERATE = 'gemini-2.5-flash-lite'
const MODEL_VALIDATE = 'gemini-2.5-flash-lite'

const extractText = (json) =>
    json?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('')?.trim() ?? ''

const safeJsonParse = (text) =>
    JSON.parse(text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim())

async function callGemini({ apiKey, prompt, model, maxOutputTokens = 2048 }) {
    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey.trim(),
            },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0,
                    maxOutputTokens,
                },
            }),
        }
    )

    if (!res.ok) {
        const t = await res.text().catch(() => '')
        throw new Error(`Gemini error ${res.status}${t ? `: ${t}` : ''}`)
    }

    return res.json()
}

export async function generateWordPair({ apiKey, category, difficulty = 'medium' }) {
    const prompt = buildWordPrompt({
        mode: category ? 'category' : 'random',
        category,
        difficulty,
    })

    const data = await callGemini({ apiKey, prompt, model: MODEL_GENERATE, maxOutputTokens: 512 })
    const obj = safeJsonParse(extractText(data))

    return {
        ru: String(obj.ru || '').trim().toLowerCase(),
        en: String(obj.en || '').trim().toLowerCase(),
        category: String(obj.category || '').trim().toLowerCase(),
    }
}

const normalizeCategory = (v) => String(v || '').trim().toLowerCase()

async function validateCategoryBatch({ apiKey, category, items }) {
    if (!items?.length) return []

    const prompt = buildCategoryValidationPrompt({
        category,
        items,
    })

    const data = await callGemini({
        apiKey,
        prompt,
        model: MODEL_VALIDATE,
        maxOutputTokens: 512,
    })

    const arr = safeJsonParse(extractText(data))
    if (!Array.isArray(arr)) return items.map(() => false)

    // harden: must be booleans, align length
    const out = arr.map((x) => x === true)
    while (out.length < items.length) out.push(false)
    return out.slice(0, items.length)
}

export async function generateWordBatch({ apiKey, category, count = 20, difficulty = 'medium' }) {
    const prompt = buildWordBatchPrompt({
        mode: category ? 'category' : 'random',
        category,
        count,
        difficulty,
    })

    const data = await callGemini({ apiKey, prompt, model: MODEL_GENERATE, maxOutputTokens: 4096 })
    const arr = safeJsonParse(extractText(data))

    if (!Array.isArray(arr)) throw new Error('Gemini batch: expected JSON array')

    const cleaned = arr
        .map((x) => ({
            category: normalizeCategory(x?.category),
            ru: String(x?.ru || '').trim().toLowerCase(),
            en: String(x?.en || '').trim().toLowerCase(),
        }))
        .filter((x) => x.category && x.ru && x.en)
        .filter((x) => /^[a-z]+$/.test(x.en))
        .filter((x) => /^[а-яё]+$/i.test(x.ru))

    // unique inside batch
    const seen = new Set()
    const unique = []
    for (const it of cleaned) {
        if (seen.has(it.en)) continue
        seen.add(it.en)
        unique.push(it)
    }

    // ✅ 2nd request: category + translation validation (1 request per batch)
    const targetCategory = normalizeCategory(category || (unique[0]?.category ?? ''))
    if (targetCategory) {
        const ok = await validateCategoryBatch({
            apiKey,
            category: targetCategory,
            items: unique,
        })

        const filtered = []
        for (let i = 0; i < unique.length; i += 1) {
            if (ok[i]) filtered.push(unique[i])
        }
        return filtered
    }

    return unique
}