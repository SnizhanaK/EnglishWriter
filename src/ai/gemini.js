import { buildWordPrompt, buildWordBatchPrompt } from './prompts.js'

const MODEL = 'gemini-2.5-flash'

const extractText = (json) =>
    json?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('')?.trim() ?? ''

const safeJsonParse = (text) =>
    JSON.parse(text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim())

async function callGemini({ apiKey, prompt }) {
    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey.trim(),
            },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
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

    const data = await callGemini({ apiKey, prompt })
    const obj = safeJsonParse(extractText(data))

    return {
        ru: String(obj.ru || '').trim().toLowerCase(),
        en: String(obj.en || '').trim().toLowerCase(),
        category: String(obj.category || '').trim().toLowerCase(),
    }
}

export async function generateWordBatch({ apiKey, category, count = 20, difficulty = 'medium' }) {
    const prompt = buildWordBatchPrompt({
        mode: category ? 'category' : 'random',
        category,
        count,
        difficulty,
    })

    const data = await callGemini({ apiKey, prompt })
    const arr = safeJsonParse(extractText(data))

    if (!Array.isArray(arr)) throw new Error('Gemini batch: expected JSON array')

    const cleaned = arr
        .map((x) => ({
            category: String(x?.category || '').trim().toLowerCase(),
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

    return unique
}