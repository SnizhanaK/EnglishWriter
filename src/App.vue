<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { RefreshCcw, PenLine, Eye, EyeOff } from 'lucide-vue-next'
import { generateWordBatch } from './ai/gemini'

const pressFx =
    'cursor-pointer select-none transition-transform duration-100 ease-out active:scale-95 active:translate-y-[1px]'

// batching
const PREFETCH_BATCH = 30
const LOW_WATERMARK = 8
const PRIME_BATCH = 10

// adaptive (kept for Round/Score display)
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

const pickRandom = (arr) => {
  if (!arr.length) return ''
  const n = crypto.getRandomValues(new Uint32Array(1))[0]
  return arr[n % arr.length]
}

const normalizeCategory = (v) => String(v || '').trim().toLowerCase()

const normalizeSpaces = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const normalizeDashes = (s) =>
    String(s || '')
        .replace(/[‐-‒–—−]/g, '-')
        .replace(/\s*-\s*/g, '-')

const normalizePair = (ru, en) => {
  const ruN = normalizeSpaces(normalizeDashes(ru)).toLowerCase()
  const enN = normalizeSpaces(normalizeDashes(en)).toLowerCase()
  return { ru: ruN, en: enN }
}

const isValidEn = (en) => {
  const s = normalizeSpaces(normalizeDashes(en)).toLowerCase()
  return /^[a-z]+(?:[ '-][a-z]+)*$/.test(s)
}

const isValidRu = (ru) => {
  const s = normalizeSpaces(normalizeDashes(ru)).toLowerCase()
  return /^[а-яё]+(?:[ -][а-яё]+)*$/i.test(s)
}

const isLetter = (ch) => /^[a-zA-Z]$/.test(ch)

const category = ref('')
const apiKey = ref('')
const isApiKeyVisible = ref(false)
const isEditingCategory = ref(false)

const difficulty = ref('medium') // easy | medium | hard
const suppressDifficultyWatch = ref(false)

const categoryInput = ref(null)
const keyInput = ref(null)

const ruWord = ref('')
const enWord = ref('')

const error = ref('')

// ✅ no more infinite loading: count active requests
const pending = ref(0)
const showLoadingDots = computed(() => pending.value > 0)

// token to ignore stale async results
const runId = ref(0)

// word state
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
let autoNextTimer = null

// stage state (display only)
const stage = ref({
  difficulty: 'medium',
  remaining: WARMUP_SIZE,
  total: WARMUP_SIZE,
  correct: 0,
  phase: 'warmup',
})
const roundNumber = ref(1)

const queueKey = computed(() => `${normalizeCategory(category.value)}|${difficulty.value}`)

const withPending = async (fn) => {
  pending.value += 1
  try {
    return await fn()
  } finally {
    pending.value = Math.max(0, pending.value - 1)
  }
}

const clearAutoNext = () => {
  if (autoNextTimer) clearTimeout(autoNextTimer)
  autoNextTimer = null
}

const clearHelpHint = () => {
  if (helpHintTimer) clearTimeout(helpHintTimer)
  helpHintTimer = null
  helpHintIndex.value = null
}

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

const hasKey = () => !!apiKey.value.trim()
const ensureKeyOrShowError = () => {
  if (!hasKey()) {
    error.value = 'Нужен API key'
    return false
  }
  return true
}

const targetChars = computed(() => (enWord.value || '').split(''))
const letterIndices = computed(() =>
    targetChars.value.map((ch, i) => (isLetter(ch) ? i : null)).filter((x) => x !== null),
)

const resetAll = () => {
  confirmed.value = false
  selectedIndex.value = null
  cursorIndex.value = letterIndices.value[0] ?? null

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
  if (!isLetter(targetChars.value[i])) return
  clearHelpHint()
  selectedIndex.value = i
  cursorIndex.value = i
  blurAll()
}

// stage helpers (display only)
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

const ensureQueueKey = () => {
  const k = queueKey.value
  if (queueMeta.value.key !== k) queueMeta.value = { key: k, items: [] }
}
const resetQueue = () => {
  queueMeta.value = { key: queueKey.value, items: [] }
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
    const { ru, en } = normalizePair(it?.ru, it?.en)
    if (!ru || !en) continue
    if (!isValidEn(en)) continue
    if (!isValidRu(ru)) continue
    if (seen.has(en)) continue
    seen.add(en)
    out.push({ ru, en })
  }
  return out
}

const fetchBatch = async ({ count }) => {
  const myRun = runId.value
  const myKey = queueKey.value
  const cat = normalizeCategory(category.value)

  const batch = await generateWordBatch({
    apiKey: apiKey.value,
    category: cat || '',
    count,
    difficulty: difficulty.value,
  })

  if (myRun !== runId.value) return { ok: false, items: [] }
  if (myKey !== queueKey.value) return { ok: false, items: [] }

  return { ok: true, items: sanitizeBatch(batch) }
}

const prefetch = async () => {
  if (isPrefetching.value) return
  if (!hasKey()) return

  const myRun = runId.value
  const myKey = queueKey.value
  ensureQueueKey()

  isPrefetching.value = true
  try {
    await withPending(async () => {
      let attempts = 0
      while (queueMeta.value.items.length < PREFETCH_BATCH && attempts < 2) {
        attempts += 1
        const res = await fetchBatch({ count: PREFETCH_BATCH })
        if (!res.ok) return
        if (myRun !== runId.value) return
        if (myKey !== queueKey.value) return
        ensureQueueKey()
        if (queueMeta.value.key !== myKey) return
        queueMeta.value.items.push(...res.items)
        if (res.items.length > 0) return
      }
    })
  } finally {
    isPrefetching.value = false
  }
}

const primeQueueAndShowFirst = async ({ count = PRIME_BATCH } = {}) => {
  if (!ensureKeyOrShowError()) return false

  const myRun = runId.value
  ensureQueueKey()

  return withPending(async () => {
    const res = await fetchBatch({ count })
    if (!res.ok) return false
    if (myRun !== runId.value) return false

    ensureQueueKey()
    if (!res.items.length) {
      error.value = 'Нет слов'
      return false
    }

    const [first, ...rest] = res.items
    queueMeta.value.items = rest
    setPair(first)
    prefetch()
    return true
  })
}

const takeFromQueue = async () => {
  ensureQueueKey()

  if (queueMeta.value.items.length > 0) {
    const item = queueMeta.value.items.shift()
    if (queueMeta.value.items.length <= LOW_WATERMARK) prefetch()
    return item
  }

  const res = await fetchBatch({ count: 1 })
  if (res.ok && res.items[0]) {
    prefetch()
    return res.items[0]
  }

  await prefetch()
  ensureQueueKey()
  const item = queueMeta.value.items.shift()
  if (!item) throw new Error('Нет слов')
  if (queueMeta.value.items.length <= LOW_WATERMARK) prefetch()
  return item
}

const loadNextWord = async () => {
  if (!ensureKeyOrShowError()) return false

  const myRun = runId.value
  const myKey = queueKey.value

  return withPending(async () => {
    if (stage.value.remaining <= 0) {
      stageFinishAndAdvance()
      resetQueue()
    }

    const item = await takeFromQueue()
    if (myRun !== runId.value) return false
    if (myKey !== queueKey.value) return false

    setPair(item)
    return true
  })
}

// ======= run control =======

const startNewRun = (newCategory) => {
  runId.value += 1
  clearAutoNext()
  clearHelpHint()

  // hard reset loading visuals
  pending.value = 0
  isPrefetching.value = false

  category.value = normalizeCategory(newCategory || category.value)

  suppressDifficultyWatch.value = true
  difficulty.value = 'medium'
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

const onRandom = async () => {
  if (!ensureKeyOrShowError()) return
  startNewRun(pickRandom(CATEGORY_SUGGESTIONS))
  await primeQueueAndShowFirst({ count: PRIME_BATCH })
}

const applyCategoryAndLoad = async () => {
  if (!ensureKeyOrShowError()) return
  isEditingCategory.value = false
  blurAll()

  startNewRun(category.value)
  await primeQueueAndShowFirst({ count: PRIME_BATCH })
}

const onEdit = async () => {
  isEditingCategory.value = true
  await focusCategory()
}

// difficulty change => reload immediately (same category)
watch(difficulty, async () => {
  if (suppressDifficultyWatch.value) return
  if (!hasKey()) return
  if (!category.value) return

  runId.value += 1
  clearAutoNext()
  clearHelpHint()
  pending.value = 0
  isPrefetching.value = false

  seenEn.value = new Set()
  resetQueue()
  error.value = ''

  await primeQueueAndShowFirst({ count: PRIME_BATCH })
})

// ======= actions =======

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

// Next = Skip: remaining decreases only if next word actually loaded
const onSkip = async () => {
  if (!ensureKeyOrShowError()) return
  if (!enWord.value) return

  usedHelpForWord.value = true
  confirmed.value = false
  clearHelpHint()
  clearAutoNext()

  wordCompleted.value = true

  try {
    const ok = await loadNextWord()
    if (ok) stage.value.remaining -= 1
    else wordCompleted.value = false
  } catch (e) {
    wordCompleted.value = false
    error.value = e?.message || 'Ошибка загрузки'
  }
}

// auto-next on all correct
watch(
    () => [confirmTick.value, isAllCorrect.value, pending.value, enWord.value],
    ([, allCorrect, p]) => {
      if (p > 0 || !enWord.value) return
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
        if (confirmed.value && pending.value === 0) loadNextWord()
      }, 350)
    }
)

const onEnter = async (e) => {
  if (pending.value > 0) return
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
    if (cursorIndex.value !== null && isLetter(targetChars.value[cursorIndex.value])) guessChars.value[cursorIndex.value] = ''
    return
  }

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
        <button
            @click="onClean"
            class="w-40 sm:w-64 py-4 sm:py-6 border border-black text-2xl sm:text-4xl font-light"
            :class="pressFx"
        >
          Clean
        </button>

        <button
            @click="onHelp"
            class="w-40 sm:w-64 py-4 sm:py-6 border border-black text-2xl sm:text-4xl font-light"
            :class="pressFx"
        >
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
            :disabled="pending > 0"
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