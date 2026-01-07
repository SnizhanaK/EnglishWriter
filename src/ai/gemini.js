import { buildWordPrompt } from './prompts'

const MODEL = 'gemini-2.5-flash'

const extractText = (json) =>
    json?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('')?.trim() ?? ''

const safeJsonParse = (text) =>
    JSON.parse(
        text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
    )

export async function generateWordPair({ apiKey, category }) {
    const prompt = buildWordPrompt({
        mode: category ? 'category' : 'random',
        category,
    })

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

    if (!res.ok) throw new Error(`Gemini error ${res.status}`)

    const data = await res.json()
    const obj = safeJsonParse(extractText(data))

    return {
        ru: String(obj.ru || '').trim().toLowerCase(),
        en: String(obj.en || '').trim().toLowerCase(),
        category: String(obj.category || '').trim(),
    }
}