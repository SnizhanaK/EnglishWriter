<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { RefreshCcw, PenLine } from 'lucide-vue-next'
import { generateWordPair, generateWordBatch } from './ai/gemini'

const pressFx =
    'cursor-pointer select-none transition-transform duration-100 ease-out active:scale-95 active:translate-y-[1px]'

const BATCH_SIZE = 20
const LOW_WATERMARK = 5

const category = ref('')
const apiKey = ref('')
const isEditingCategory = ref(false)

const categoryInput = ref(null)
const keyInput = ref(null)

const ruWord = ref('')
const enWord = ref('')

const isLoading = ref(false)
const error = ref('')

const confirmed = ref(false)
const selectedIndex = ref(null)
const cursorIndex = ref(null)
const guessChars = ref([])

// batch queue (per current category)
const queue = ref([])
const seenEn = ref(new Set())
const isPrefetching = ref(false)

// help highlight (underline)
const helpHintIndex = ref(null)
let helpHintTimer = null

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
const letterIndices = computed(() =>
    targetChars.value.map((ch, i) => (ch === ' ' ? null : i)).filter((x) => x !== null),
)

const resetAll = () => {
  confirmed.value = false
  selectedIndex.value = null
  cursorIndex.value = letterIndices.value[0] ?? null
  guessChars.value = targetChars.value.map((ch) => (ch === ' ' ? ' ' : ''))
}
watch(enWord, resetAll, { immediate: true })

const statusByIndex = computed(() =>
    targetChars.value.map((ch, i) => {
      if (ch === ' ') return 'space'
      if (!confirmed.value) return 'idle'
      const g = guessChars.value[i] || ''
      if (!g) return 'empty'
      return g.toLowerCase() === ch.toLowerCase() ? 'correct' : 'wrong'
    }),
)

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

const clearHelpHint = () => {
  if (helpHintTimer) clearTimeout(helpHintTimer)
  helpHintTimer = null
  helpHintIndex.value = null
}

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
  clearHelpHint()
  selectedIndex.value = i
  cursorIndex.value = i
  blurAll()
}

const onEdit = async () => {
  isEditingCategory.value = !isEditingCategory.value
  if (isEditingCategory.value) await focusCategory()
  else blurAll()
}

const ensureKey = () => {
  if (!apiKey.value.trim()) {
    error.value = 'Нужен API key'
    return false
  }
  return true
}

const resetQueue = () => {
  queue.value = []
  seenEn.value = new Set()
}

const prefetch = async () => {
  if (isPrefetching.value) return
  if (!ensureKey()) return

  const cat = category.value.trim().toLowerCase()
  if (!cat) return

  isPrefetching.value = true
  try {
    const batch = await generateWordBatch({
      apiKey: apiKey.value,
      category: cat,
      count: BATCH_SIZE,
    })

    const seen = seenEn.value
    const filtered = []
    for (const it of batch) {
      if (!it?.en) continue
      if (seen.has(it.en)) continue
      seen.add(it.en)
      filtered.push(it)
    }
    queue.value.push(...filtered)
  } catch (e) {
    console.warn(e)
  } finally {
    isPrefetching.value = false
  }
}

const takeFromQueue = async () => {
  if (queue.value.length === 0) {
    await prefetch()
  }
  const item = queue.value.shift()
  if (!item) throw new Error('Нет слов')

  if (queue.value.length <= LOW_WATERMARK) {
    prefetch()
  }
  return item
}

const setPair = (r) => {
  ruWord.value = r.ru
  enWord.value = r.en
  resetAll()
  confirmed.value = false
  clearHelpHint()
  blurAll()
}

const onRandom = async () => {
  error.value = ''
  if (!ensureKey()) return

  isLoading.value = true
  try {
    const r = await generateWordPair({ apiKey: apiKey.value, category: '' })
    category.value = (r.category || '').trim().toLowerCase()
    setPair(r)

    resetQueue()
    prefetch()
  } catch (e) {
    error.value = e?.message || 'Gemini error'
  } finally {
    isLoading.value = false
  }
}

const onNext = async () => {
  error.value = ''
  if (!ensureKey()) return
  const cat = category.value.trim().toLowerCase()
  if (!cat) {
    error.value = 'Категория пустая'
    return
  }

  isLoading.value = true
  try {
    const item = await takeFromQueue()
    setPair(item)
    isEditingCategory.value = false
  } catch (e) {
    error.value = e?.message || 'Gemini error'
  } finally {
    isLoading.value = false
  }
}

const onClean = () => {
  confirmed.value = false
  clearHelpHint()

  if (selectedIndex.value !== null && targetChars.value[selectedIndex.value] !== ' ') {
    guessChars.value[selectedIndex.value] = ''
    selectedIndex.value = null
    return
  }
  resetAll()
}

const onHelp = () => {
  confirmed.value = false

  // 1) if there is a wrong typed letter -> FIX it (write correct char permanently)
  const wrongIdx = targetChars.value.findIndex((ch, i) => {
    if (ch === ' ') return false
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

  // 2) otherwise fill next missing letter
  const emptyIdx = targetChars.value.findIndex((ch, i) => ch !== ' ' && !guessChars.value[i])
  if (emptyIdx === -1) return

  guessChars.value[emptyIdx] = targetChars.value[emptyIdx].toLowerCase()
  selectedIndex.value = null
  cursorIndex.value = emptyIdx
  hintIndex(emptyIdx)
  moveCursorToNext(emptyIdx)
}

const onConfirm = () => {
  confirmed.value = true
  blurAll()
}

const onEnter = async (e) => {
  if (isLoading.value) return
  if (!enWord.value) return

  const el = document.activeElement
  const isOurInput = el === categoryInput.value || el === keyInput.value
  if (isOurInput) {
    if (el === categoryInput.value && isEditingCategory.value) return
    blurAll()
  }

  e.preventDefault()

  if (!confirmed.value) {
    onConfirm()
    return
  }

  await onNext()
}

const onKeydown = async (e) => {
  if (!enWord.value) return
  if (e.metaKey || e.ctrlKey || e.altKey) return

  const key = e.key
  const el = document.activeElement

  const isOurInput = el === categoryInput.value || el === keyInput.value
  if (isOurInput) {
    if (el === categoryInput.value && isEditingCategory.value) return
    blurAll()
  }

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

    if (selectedIndex.value !== null) {
      guessChars.value[selectedIndex.value] = ''
      return
    }

    if (guessChars.value[idx]) {
      guessChars.value[idx] = ''
      return
    }

    moveCursorToPrev(idx)
    if (cursorIndex.value !== null) guessChars.value[cursorIndex.value] = ''
    return
  }

  if (/^[a-zA-Z]$/.test(key)) {
    e.preventDefault()
    confirmed.value = false
    clearHelpHint()

    guessChars.value[idx] = key.toLowerCase()
    selectedIndex.value = null
    moveCursorToNext(idx)
  }
}

watch(
    () => category.value,
    () => {
      resetQueue()
      if (category.value.trim()) prefetch()
    }
)

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (helpHintTimer) clearTimeout(helpHintTimer)
})
</script>

<template>
  <div class="min-h-screen p-4">
    <div class="w-full border-2 border-black p-6 min-h-[calc(100vh-2rem)] overflow-hidden">
      <div class="w-full mb-12">
        <div class="flex justify-end mb-6">
          <div class="w-44 sm:w-64 py-2 border border-black font-light">
            <input
                ref="keyInput"
                v-model="apiKey"
                type="text"
                class="w-full outline-none bg-transparent px-3 sm:px-4 text-base sm:text-xl"
                placeholder="KEY:"
                @keydown.enter.prevent="blurAll"
            />
          </div>
        </div>

        <div class="flex items-center gap-3 sm:gap-4">
          <div class="w-48 sm:w-64 py-2 border border-black text-xl sm:text-3xl font-light flex items-center justify-center">
            <input
                ref="categoryInput"
                v-model="category"
                :readonly="!isEditingCategory"
                type="text"
                class="w-full outline-none bg-transparent text-center"
                placeholder="Category"
                @keydown.enter.prevent="() => { isEditingCategory = false; blurAll() }"
            />
          </div>

          <button @click="onEdit" class="p-2 border border-black" :class="pressFx">
            <PenLine class="h-6 w-6 sm:h-7 sm:w-7" />
          </button>

          <button
              @click="onRandom"
              class="p-2 border border-black"
              :class="pressFx"
              :disabled="isLoading"
              title="Random category + word"
          >
            <RefreshCcw class="h-6 w-6 sm:h-7 sm:w-7" />
          </button>
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
            v-show="!confirmed"
            @click="onConfirm"
            class="w-40 sm:w-64 py-4 sm:py-6 border border-black text-2xl sm:text-4xl font-light"
            :class="pressFx"
        >
          Confirm
        </button>

        <button
            v-show="confirmed"
            @click="onNext"
            class="w-40 sm:w-64 py-4 sm:py-6 border border-black text-2xl sm:text-4xl font-light"
            :class="pressFx"
            :disabled="isLoading"
        >
          Next
        </button>
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
</style>