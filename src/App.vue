<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { RefreshCcw, PenLine, Eye, EyeOff } from 'lucide-vue-next'
import { generateWordBatch } from './ai/gemini'

const pressFx =
    'cursor-pointer select-none transition-transform duration-100 ease-out active:scale-95 active:translate-y-[1px]'

// batching
const PREFETCH_BATCH = 30
const LOW_WATERMARK = 8
const PRIME_BATCH = 10 // ✅ always fetch 10 first for new context

// adaptive rules (kept for Round/Score display)
const WARMUP_SIZE = 10
const STEP_HARD_SIZE = 30
const LOOP_SIZE = 40
const PASS_RATE = 0.8

const CATEGORY_SUGGESTIONS = [
  'everyday life','daily activities','common objects','things around you','places','time','weather','numbers','colors','shapes',
  'body','body parts','health','appearance','clothing','accessories','emotions','feelings','personality','relationships','family',
  'conversation','spoken english','everyday phrases','common expressions','reactions','opinions','questions','answers','polite phrases','informal speech','slang',
  'actions','movements','states','changes','habits','problems','solutions',
  'home','household items','rooms','furniture','cleaning','repairs','tools','kitchen','kitchenware','appliances','bathroom',
  'food','meals','ingredients','cooking','baking','drinks','fruits','vegetables','snacks','desserts',
  'animals','pets','wild animals','plants','trees','flowers','nature','environment',
  'transport','vehicles','streets','directions','travel','tourism','hotels','restaurants','airports',
  'work','jobs','professions','office','meetings','education','school','university','learning',
  'business','finance','money','banking','payments','shopping','online shopping','services',
  'technology','computers','hardware','software','programming','coding basics','web development','frontend','backend','databases','apis',
  'testing','debugging','version control','git','devops','cloud computing','operating systems','linux','mobile apps',
  'cybersecurity','ai','machine learning',
  'internet','websites','browsers','search','email','messaging','social media','online communication','content creation',
  'devices','gadgets','smartphones','laptops','tablets','wearables',
  'hobbies','free time','sports','fitness','games','video games','music','movies','tv shows','books','reading',
  'qualities','character traits','advantages','disadvantages','goals','plans','decisions','results',
]

// random picker (stable)
const pickRandom = (arr) => {
  if (!arr.length) return ''
  const n = crypto.getRandomValues(new Uint32Array(1))[0]
  return arr[n % arr.length]
}

const normalizeCategory = (v) => String(v || '').trim().toLowerCase()
const normalizeSpaces = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const normalizeDashes = (s) =>
    String(s || '')
        .replace(/[‐-‒–—−]/g, '-') // dash variants -> '-'
        .replace(/\s*-\s*/g, '-') // remove spaces around '-'

const normalizePair = (ru, en) => {
  const ruN = normalizeSpaces(normalizeDashes(ru))
  const enN = normalizeSpaces(normalizeDashes(en)).toLowerCase()
  return { ru: ruN, en: enN }
}

// ✅ allow phrases + hyphens + apostrophes in EN
const isValidEnglish = (en) => {
  const s = normalizeSpaces(normalizeDashes(en)).toLowerCase()
  // letters, spaces, hyphens, apostrophes
  return /^[a-z]+(?:[ '-][a-z]+)*$/.test(s)
}

const isLetter = (ch) => /^[a-zA-Z]$/.test(ch)

const category = ref('')
const apiKey = ref('')
const isApiKeyVisible = ref(false)
const isEditingCategory = ref(false)

// user-selected difficulty; reset to medium on category change
const difficulty = ref('medium') // 'easy' | 'medium' | 'hard'
const suppressDifficultyWatch = ref(false)

const categoryInput = ref(null)
const keyInput = ref(null)

const ruWord = ref('')
const enWord = ref('')

const isLoading = ref(false)
const isWaitingWord = ref(false)
const error = ref('')

// unified lock to prevent races
const loadLock = ref(false)

// scoring / word state
const confirmed = ref(false)
const selectedIndex = ref(null)
const cursorIndex = ref(null)
const guessChars = ref([])

const usedHelpForWord = ref(false)
const confirmAttemptsForWord = ref(0)
const confirmTick = ref(0)
const wordCompleted = ref(false)

// global no-repeat across session
const seenEn = ref(new Set())

// queue keyed by category+difficulty
const queueMeta = ref({ key: '', items: [] })
const isPrefetching = ref(false)

// help underline
const helpHintIndex = ref(null)
let helpHintTimer = null

// auto-next timer
let autoNextTimer = null

// run token to ignore stale async results
const runId = ref(0)

// stage state (kept for Round/Score display)
const stage = ref({
  difficulty: 'medium',
  remaining: WARMUP_SIZE,
  total: WARMUP_SIZE,
  correct: 0,
  phase: 'warmup',
})
const roundNumber = ref(1)

// queue context key
const queueKey = computed(() => `${normalizeCategory(category.value)}|${difficulty.value}`)

// show 5 dots for any network activity
const showLoadingDots = computed(() => isWaitingWord.value || isPrefetching.value)

const blurAll = () => {
  categoryInput.value?.blur?.()
  keyInput.value?.blur?.()
  document.activeElement?.blur?.()
}

const focusCategory = async () => {
  await nextTick()
  categoryInput.value?.focus?.()
  categoryInput.value?.select?.()
}

const targetChars = computed(() => (enWord.value || '').split(''))

// ✅ only letters are "fillable" slots; spaces are gaps; hyphens/apostrophes are fixed chars
const letterIndices = computed(() =>
    targetChars.value
        .map((ch, i) => (isLetter(ch) ? i : null))
        .filter((x) => x !== null),
)

const clearAutoNext = () => {
  if (autoNextTimer) clearTimeout(autoNextTimer)
  autoNextTimer = null
}

const clearHelpHint = () => {
  if (helpHintTimer) clearTimeout(helpHintTimer)
  helpHintTimer = null
  helpHintIndex.value = null
}

const resetAll = () => {
  confirmed.value = false
  selectedIndex.value = null
  cursorIndex.value = letterIndices.value[0] ?? null

  // auto-fill fixed characters (hyphen, apostrophe, punctuation) and spaces
  guessChars.value = targetChars.value.map((ch) => {
    if (ch === ' ') return ' '
    if (!isLetter(ch)) return ch
    return ''
  })

  usedHelpForWord.value = false
  confirmAttemptsForWord.value = 0
  wordCompleted.value = false
}
watch(enWord, resetAll, { immediate: true })

const statusByIndex = computed(() =>
    targetChars.value.map((ch, i) => {
      if (ch === ' ') return 'space'
      if (!confirmed.value) return 'idle'
      if (!isLetter(ch)) return 'correct'
      const g = guessChars.value[i] || ''
      if (!g) return 'empty'
      return g.toLowerCase() === ch.toLowerCase() ? 'correct' : 'wrong'
    }),
)

const isAllCorrect = computed(() => {
  if (!enWord.value) return false
  return targetChars.value.every((ch, i) => {
    if (ch === ' ') return true
    if (!isLetter(ch)) return true
    const g = guessChars.value[i]
    if (!g) return false
    return g.toLowerCase() === ch.toLowerCase()
  })
})

const moveCursorToNext = (fromIndex) => {
  const pos = letterIndices.value.indexOf(fromIndex)
  const next = letterIndices.value[pos + 1]
  cursorIndex.value = next ?? fromIndex
}
const moveCursorToPrev = (fromIndex) => {
  const pos = letterIndices.value.indexOf(fromIndex)
  const prev = letterIndices.value[pos - 1]
  cursorIndex.value = prev ?? fromIndex
}

const activeWriteIndex = computed(() => {
  if (selectedIndex.value !== null) return selectedIndex.value
  if (cursorIndex.value !== null) return cursorIndex.value
  return letterIndices.value[0] ?? null
})

const hintIndex = (i) => {
  clearHelpHint()
  helpHintIndex.value = i
  helpHintTimer = setTimeout(() => {
    helpHintIndex.value = null
    helpHintTimer = null
  }, 900)
}

const onClickSlot = (i) => {
  if (targetChars.value[i] === ' ') return
  if (!isLetter(targetChars.value[i])) return
  clearHelpHint()
  selectedIndex.value = i
  cursorIndex.value = i
  blurAll()
}

const hasKey = () => !!apiKey.value.trim()
const ensureKeyOrShowError = () => {
  if (!hasKey()) {
    error.value = 'Нужен API key'
    return false
  }
  return true
}

const stageSet = (difficultyName, count, phase, { incRound = true } = {}) => {
  stage.value = { difficulty: difficultyName, remaining: count, total: count, correct: 0, phase }
  if (incRound) roundNumber.value += 1
}
const stageInit = () => {
  roundNumber.value = 1
  stage.value = { difficulty: 'medium', remaining: WARMUP_SIZE, total: WARMUP_SIZE, correct: 0, phase: 'warmup' }
}
const stageFinishAndAdvance = () => {
  const s = stage.value
  const rate = s.total ? s.correct / s.total : 0

  if (s.phase === 'warmup') {
    if (rate >= PASS_RATE) stageSet('hard', STEP_HARD_SIZE, 'step')
    else stageSet('easy', LOOP_SIZE, 'loop')
    return
  }

  if (s.phase === 'step') {
    if (rate >= PASS_RATE) stageSet('hard', LOOP_SIZE, 'loop')
    else stageSet('easy', LOOP_SIZE, 'loop')
    return
  }

  if (rate >= PASS_RATE) stageSet('hard', LOOP_SIZE, 'loop')
  else stageSet('easy', LOOP_SIZE, 'loop')
}

// queue helpers
const resetQueue = () => {
  queueMeta.value = { key: queueKey.value, items: [] }
}
const ensureQueueKey = () => {
  const k = queueKey.value
  if (queueMeta.value.key !== k) queueMeta.value = { key: k, items: [] }
}

const setPair = (r) => {
  error.value = ''
  ruWord.value = r.ru
  enWord.value = r.en
  confirmed.value = false
  clearHelpHint()
  clearAutoNext()
  blurAll()
}

const sanitizeBatch = (batch) => {
  const seen = seenEn.value
  const out = []

  for (const it of batch || []) {
    const rawEn = String(it?.en || '')
    const rawRu = String(it?.ru || '')
    const { en, ru } = normalizePair(rawRu, rawEn)

    if (!en || !ru) continue
    if (!isValidEnglish(en)) continue
    if (seen.has(en)) continue

    seen.add(en)
    out.push({ en, ru })
  }

  return out
}

// ✅ fast 1-word fetch to avoid long pause between words
const fetchOneFast = async () => {
  const myRun = runId.value
  const myKey = queueKey.value
  const cat = normalizeCategory(category.value)

  const batch = await generateWordBatch({
    apiKey: apiKey.value,
    category: cat || '',
    count: 1,
    difficulty: difficulty.value,
  })

  if (myRun !== runId.value) return null
  if (myKey !== queueKey.value) return null

  const filtered = sanitizeBatch(batch)
  return filtered[0] || null
}

// prime: fetch 10, show first, queue rest, then bg prefetch
const primeQueueAndShowFirst = async ({ count = PRIME_BATCH } = {}) => {
  if (!ensureKeyOrShowError()) return false

  ensureQueueKey()
  const myRun = runId.value
  const myKey = queueKey.value
  const cat = normalizeCategory(category.value)

  isWaitingWord.value = true
  isLoading.value = true
  try {
    const batch = await generateWordBatch({
      apiKey: apiKey.value,
      category: cat || '',
      count,
      difficulty: difficulty.value,
    })

    if (myRun !== runId.value) return false
    if (myKey !== queueKey.value) return false

    ensureQueueKey()
    if (queueMeta.value.key !== myKey) return false

    const filtered = sanitizeBatch(batch)
    if (!filtered.length) throw new Error('Нет слов')

    const [first, ...rest] = filtered
    queueMeta.value.items = rest
    setPair(first)

    prefetch() // bg
    return true
  } catch (e) {
    if (!ruWord.value && !enWord.value) error.value = e?.message || 'Ошибка загрузки'
    return false
  } finally {
    if (myRun === runId.value && myKey === queueKey.value) {
      isLoading.value = false
      isWaitingWord.value = false
    }
  }
}

// prefetch batch into queue (background)
const prefetch = async () => {
  if (isPrefetching.value) return
  if (!hasKey()) return

  ensureQueueKey()
  const myRun = runId.value
  const myKey = queueKey.value
  const cat = normalizeCategory(category.value)

  isPrefetching.value = true
  try {
    let attempts = 0
    while (queueMeta.value.items.length < PREFETCH_BATCH && attempts < 3) {
      attempts += 1
      const batch = await generateWordBatch({
        apiKey: apiKey.value,
        category: cat || '',
        count: PREFETCH_BATCH,
        difficulty: difficulty.value,
      })

      if (myRun !== runId.value) return
      if (myKey !== queueKey.value) return
      ensureQueueKey()
      if (queueMeta.value.key !== myKey) return

      const filtered = sanitizeBatch(batch)
      queueMeta.value.items.push(...filtered)
      if (filtered.length > 0) break
    }
  } catch (e) {
    console.warn(e)
  } finally {
    isPrefetching.value = false
  }
}

const takeFromQueue = async () => {
  ensureQueueKey()

  if (queueMeta.value.items.length > 0) {
    const item = queueMeta.value.items.shift()
    if (queueMeta.value.items.length <= LOW_WATERMARK) prefetch()
    return item
  }

  const one = await fetchOneFast()
  if (one) {
    prefetch()
    return one
  }

  await prefetch()
  ensureQueueKey()

  const item = queueMeta.value.items.shift()
  if (!item) throw new Error('Нет слов')

  if (queueMeta.value.items.length <= LOW_WATERMARK) prefetch()
  return item
}

const loadNextWord = async () => {
  error.value = ''
  if (!ensureKeyOrShowError()) return false

  const myRun = runId.value
  const myKey = queueKey.value

  isWaitingWord.value = true
  isLoading.value = true
  try {
    if (stage.value.remaining <= 0) {
      stageFinishAndAdvance()
      resetQueue()
    }

    const item = await takeFromQueue()
    if (myRun !== runId.value) return false
    if (myKey !== queueKey.value) return false

    setPair(item)
    return true
  } catch (e) {
    if (myRun !== runId.value) return false
    if (myKey !== queueKey.value) return false
    if (!ruWord.value && !enWord.value) error.value = e?.message || 'Ошибка загрузки'
    return false
  } finally {
    if (myRun === runId.value && myKey === queueKey.value) {
      isLoading.value = false
      isWaitingWord.value = false
    }
  }
}

// hard reset (always when category changes / random)
const startNewRun = (newCategory) => {
  runId.value += 1
  clearAutoNext()
  clearHelpHint()

  category.value = normalizeCategory(newCategory || category.value)

  suppressDifficultyWatch.value = true
  difficulty.value = 'medium'
  queueMeta.value = { key: `${normalizeCategory(category.value)}|medium`, items: [] }
  queueMeta.value.key = queueKey.value
  suppressDifficultyWatch.value = false

  seenEn.value = new Set()
  resetQueue()
  stageInit()

  ruWord.value = ''
  enWord.value = ''
  resetAll()
  confirmed.value = false
  error.value = ''
  blurAll()
}

// Random: choose category, reset to medium, prime 10
const onRandom = async () => {
  if (loadLock.value) return
  if (!ensureKeyOrShowError()) return

  loadLock.value = true
  error.value = ''

  try {
    startNewRun(pickRandom(CATEGORY_SUGGESTIONS))
    await primeQueueAndShowFirst({ count: PRIME_BATCH })
  } finally {
    loadLock.value = false
  }
}

// Pencil apply: reset to medium, prime 10
const applyCategoryAndLoad = async () => {
  if (loadLock.value) return
  if (!ensureKeyOrShowError()) return

  loadLock.value = true
  isEditingCategory.value = false
  blurAll()
  error.value = ''

  try {
    startNewRun(category.value)
    await primeQueueAndShowFirst({ count: PRIME_BATCH })
  } finally {
    loadLock.value = false
  }
}

const onEdit = async () => {
  isEditingCategory.value = true
  await focusCategory()
}

// when user changes difficulty: same category, reload immediately with PRIME_BATCH=10
watch(difficulty, async () => {
  if (suppressDifficultyWatch.value) return

  resetQueue()
  runId.value += 1
  clearAutoNext()
  clearHelpHint()
  error.value = ''

  if (!hasKey()) return
  if (loadLock.value) return
  if (!category.value) return

  loadLock.value = true
  try {
    await primeQueueAndShowFirst({ count: PRIME_BATCH })
  } finally {
    loadLock.value = false
  }
})

const onHelp = () => {
  if (!enWord.value) return

  usedHelpForWord.value = true
  confirmed.value = false
  clearHelpHint()
  clearAutoNext()

  const wrongIdx = targetChars.value.findIndex((ch, i) => {
    if (!isLetter(ch)) return false
    const g = guessChars.value[i]
    if (!g) return false
    return g.toLowerCase() !== ch.toLowerCase()
  })

  if (wrongIdx !== -1) {
    guessChars.value[wrongIdx] = targetChars.value[wrongIdx].toLowerCase()
    selectedIndex.value = null
    cursorIndex.value = wrongIdx
    hintIndex(wrongIdx)
    moveCursorToNext(wrongIdx)
    return
  }

  const emptyIdx = targetChars.value.findIndex((ch, i) => isLetter(ch) && !guessChars.value[i])
  if (emptyIdx === -1) return

  guessChars.value[emptyIdx] = targetChars.value[emptyIdx].toLowerCase()
  selectedIndex.value = null
  cursorIndex.value = emptyIdx
  hintIndex(emptyIdx)
  moveCursorToNext(emptyIdx)
}

const onClean = () => {
  confirmed.value = false
  clearHelpHint()
  clearAutoNext()

  if (selectedIndex.value !== null) {
    if (isLetter(targetChars.value[selectedIndex.value])) guessChars.value[selectedIndex.value] = ''
    selectedIndex.value = null
    return
  }
  resetAll()
}

const onConfirm = () => {
  if (!enWord.value) return
  confirmAttemptsForWord.value += 1
  confirmTick.value += 1
  confirmed.value = true
  blurAll()
}

// Next = Skip (does not change remaining if next didn't load)
const onSkip = async () => {
  if (loadLock.value) return
  if (!ensureKeyOrShowError()) return
  if (!enWord.value) return

  loadLock.value = true
  usedHelpForWord.value = true
  confirmed.value = false
  clearHelpHint()
  clearAutoNext()
  wordCompleted.value = true

  try {
    const ok = await loadNextWord()
    if (ok) stage.value.remaining -= 1
    else wordCompleted.value = false
  } finally {
    loadLock.value = false
  }
}

// auto-next if ALL GREEN; score only if first confirm and no help
watch(
    () => [confirmTick.value, isAllCorrect.value, isLoading.value, enWord.value],
    ([, allCorrect, loading]) => {
      if (loading || !enWord.value) return
      if (!confirmed.value) return
      if (!allCorrect) return
      if (wordCompleted.value) return

      wordCompleted.value = true
      stage.value.remaining -= 1

      const firstTry = confirmAttemptsForWord.value === 1
      const noHelp = !usedHelpForWord.value
      if (firstTry && noHelp) stage.value.correct += 1

      clearAutoNext()
      autoNextTimer = setTimeout(() => {
        if (confirmed.value && !isLoading.value && !loadLock.value) loadNextWord()
      }, 350)
    }
)

const onEnter = async (e) => {
  if (isLoading.value) return
  e.preventDefault()
  onConfirm()
}

const onKeydown = async (e) => {
  if (!enWord.value) return
  if (e.metaKey || e.ctrlKey || e.altKey) return

  const key = e.key
  const el = document.activeElement
  const isOurInput = el === categoryInput.value || el === keyInput.value
  if (isOurInput) return

  if (key === 'Enter') {
    await onEnter(e)
    return
  }

  const idx = activeWriteIndex.value
  if (idx === null) return

  if (key === 'ArrowLeft') {
    e.preventDefault()
    clearHelpHint()
    selectedIndex.value = null
    moveCursorToPrev(idx)
    return
  }

  if (key === 'ArrowRight') {
    e.preventDefault()
    clearHelpHint()
    selectedIndex.value = null
    moveCursorToNext(idx)
    return
  }

  if (key === 'Backspace') {
    e.preventDefault()
    confirmed.value = false
    clearHelpHint()
    clearAutoNext()

    if (selectedIndex.value !== null) {
      if (isLetter(targetChars.value[selectedIndex.value])) guessChars.value[selectedIndex.value] = ''
      return
    }

    if (guessChars.value[idx] && isLetter(targetChars.value[idx])) {
      guessChars.value[idx] = ''
      return
    }

    moveCursorToPrev(idx)
    if (cursorIndex.value !== null && isLetter(targetChars.value[cursorIndex.value])) {
      guessChars.value[cursorIndex.value] = ''
    }
    return
  }

  // letters
  if (/^[a-zA-Z]$/.test(key)) {
    e.preventDefault()
    confirmed.value = false
    clearHelpHint()
    clearAutoNext()

    if (!isLetter(targetChars.value[idx])) return

    guessChars.value[idx] = key.toLowerCase()
    selectedIndex.value = null
    moveCursorToNext(idx)
    return
  }

  // ✅ allow typing '-' or "'" only if target expects it (usually auto-filled anyway)
  if (key === '-' || key === "'") {
    if (targetChars.value[idx] !== key) return

    e.preventDefault()
    confirmed.value = false
    clearHelpHint()
    clearAutoNext()

    guessChars.value[idx] = key
    selectedIndex.value = null
    moveCursorToNext(idx)
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (helpHintTimer) clearTimeout(helpHintTimer)
  clearAutoNext()
})
</script>

<template>
  <div class="min-h-screen p-4">
    <div class="w-full border-2 border-black p-6 min-h-[calc(100vh-2rem)] overflow-hidden">
      <div class="w-full mb-10">
        <div class="flex justify-end mb-4">
          <div class="w-44 sm:w-64 py-2 border border-black font-light flex items-center gap-2 px-2">
            <input
                ref="keyInput"
                v-model="apiKey"
                :type="isApiKeyVisible ? 'text' : 'password'"
                class="w-full outline-none bg-transparent px-2 sm:px-3 text-base sm:text-xl"
                placeholder="KEY:"
                @keydown.enter.prevent="blurAll"
            />
            <button
                type="button"
                class="p-1 border border-black"
                :class="pressFx"
                @click="() => { isApiKeyVisible = !isApiKeyVisible }"
                :title="isApiKeyVisible ? 'Hide key' : 'Show key'"
            >
              <EyeOff v-if="isApiKeyVisible" class="h-5 w-5" />
              <Eye v-else class="h-5 w-5" />
            </button>
          </div>
        </div>

        <div class="flex items-center gap-3 sm:gap-4">
          <div class="w-48 sm:w-64 py-2 border border-black text-xl sm:text-3xl font-light flex items-center justify-center">
            <input
                ref="categoryInput"
                v-model="category"
                :readonly="!isEditingCategory"
                :list="isEditingCategory ? 'category-list' : null"
                type="text"
                class="w-full outline-none bg-transparent text-center"
                placeholder="Category"
                @change="applyCategoryAndLoad"
                @blur="() => isEditingCategory && applyCategoryAndLoad()"
                @keydown.enter.prevent="applyCategoryAndLoad"
            />
            <datalist id="category-list">
              <option v-for="c in CATEGORY_SUGGESTIONS" :key="c" :value="c" />
            </datalist>
          </div>

          <button @click="onEdit" class="p-2 border border-black" :class="pressFx">
            <PenLine class="h-6 w-6 sm:h-7 sm:w-7" />
          </button>

          <button
              @click="onRandom"
              class="p-2 border border-black"
              :class="pressFx"
              :disabled="isLoading"
              title="Random category + start"
          >
            <RefreshCcw class="h-6 w-6 sm:h-7 sm:w-7" />
          </button>
        </div>

        <div class="mt-3 text-xs sm:text-sm font-light flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-2">
            <span>Difficulty:</span>
            <select v-model="difficulty" class="border border-black bg-transparent px-2 py-1" title="Select difficulty">
              <option value="easy">easy</option>
              <option value="medium">medium</option>
              <option value="hard">hard</option>
            </select>
          </div>

          <div>Round: {{ roundNumber }}</div>
          <div>Score: {{ stage.correct }}/{{ stage.total }}</div>
        </div>
      </div>

      <div class="min-h-[2rem] text-center mb-6">
        <span v-if="error" class="text-red-600">{{ error }}</span>
      </div>

      <div class="flex justify-center py-6 sm:py-10">
        <div class="text-4xl sm:text-6xl font-normal text-center px-2 break-words">
          {{ ruWord }}
        </div>
      </div>

      <div class="flex justify-center py-6 sm:py-8">
        <div class="flex flex-wrap justify-center items-end gap-2 sm:gap-4 max-w-full" @click="blurAll">
          <template v-for="(ch, i) in targetChars" :key="i">
            <div v-if="ch === ' '" class="w-3 sm:w-6"></div>

            <button
                v-else
                type="button"
                @click.stop="onClickSlot(i)"
                class="flex flex-col items-center outline-none"
                :class="pressFx"
            >
              <div
                  class="w-7 sm:w-10 text-3xl sm:text-5xl text-center"
                  :class="[
                  selectedIndex === i ? 'underline underline-offset-4' : '',
                  helpHintIndex === i ? 'underline underline-offset-8' : '',
                  statusByIndex[i] === 'correct' ? 'text-green-600' : '',
                  statusByIndex[i] === 'wrong' ? 'text-red-600' : '',
                ]"
              >
                {{ guessChars[i] || '' }}
              </div>
              <div class="w-8 sm:w-12 border-b-2 border-black -mt-1 sm:-mt-2"></div>
            </button>
          </template>
        </div>
      </div>

      <div class="flex flex-wrap justify-center gap-3 sm:gap-6 py-6 sm:py-10">
        <button @click="onClean" class="w-40 sm:w-64 py-4 sm:py-6 border border-black text-2xl sm:text-4xl font-light" :class="pressFx">
          Clean
        </button>

        <button @click="onHelp" class="w-40 sm:w-64 py-4 sm:py-6 border border-black text-2xl sm:text-4xl font-light" :class="pressFx">
          Help
        </button>

        <button
            @click="onConfirm"
            class="w-40 sm:w-64 py-4 sm:py-6 border border-black text-2xl sm:text-4xl font-light"
            :class="pressFx"
        >
          Confirm
        </button>

        <button
            @click="onSkip"
            class="w-40 sm:w-64 py-4 sm:py-6 border border-black text-2xl sm:text-4xl font-light"
            :class="pressFx"
            :disabled="isLoading"
        >
          Next
        </button>
      </div>

      <div class="flex justify-center -mt-2 pb-2 h-6">
        <div v-if="showLoadingDots" class="loading-dots" aria-label="loading">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="dot"></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
button:focus,
button:focus-visible {
  outline: none;
}
* {
  -webkit-tap-highlight-color: transparent;
}
.loading-dots {
  display: inline-flex;
  gap: 10px;
  align-items: center;
}
.loading-dots .dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: #000;
  opacity: 0.2;
  animation: dotPulse 1s infinite ease-in-out;
}
.loading-dots .dot:nth-child(2) { animation-delay: 0.12s; }
.loading-dots .dot:nth-child(3) { animation-delay: 0.24s; }
.loading-dots .dot:nth-child(4) { animation-delay: 0.36s; }
.loading-dots .dot:nth-child(5) { animation-delay: 0.48s; }
@keyframes dotPulse {
  0%, 100% { opacity: 0.2; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-2px); }
}
</style>