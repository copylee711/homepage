<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'

// 代码块：顶部一栏显示语言（可编辑时点开可输入搜索）和一键复制。
const props = defineProps(nodeViewProps)

// [值, 显示名, 搜索别名]
const LANGUAGES: [string, string, string][] = [
  ['', '纯文本', 'text plain txt'], ['python', 'Python', 'py'], ['javascript', 'JavaScript', 'js node'],
  ['typescript', 'TypeScript', 'ts'], ['java', 'Java', ''], ['c', 'C', ''], ['cpp', 'C++', 'cpp cxx'],
  ['csharp', 'C#', 'cs dotnet'], ['go', 'Go', 'golang'], ['rust', 'Rust', 'rs'], ['kotlin', 'Kotlin', 'kt'],
  ['swift', 'Swift', ''], ['php', 'PHP', ''], ['ruby', 'Ruby', 'rb'], ['bash', 'Shell', 'sh bash zsh shell'],
  ['powershell', 'PowerShell', 'ps ps1'], ['sql', 'SQL', 'mysql postgres sqlite'], ['json', 'JSON', ''],
  ['yaml', 'YAML', 'yml'], ['xml', 'HTML / XML', 'html xml vue svg'], ['css', 'CSS', ''], ['scss', 'SCSS', 'sass'],
  ['markdown', 'Markdown', 'md'], ['diff', 'Diff', 'patch'], ['ini', 'INI / TOML', 'toml conf'],
  ['makefile', 'Makefile', 'make'], ['r', 'R', ''], ['lua', 'Lua', ''], ['matlab', 'MATLAB', 'octave'],
  ['latex', 'LaTeX', 'tex'], ['dockerfile', 'Dockerfile', 'docker'], ['nginx', 'Nginx', ''],
]
const language = computed(() => (props.node.attrs.language as string | null) ?? '')
const label = computed(() => LANGUAGES.find(([value]) => value === language.value)?.[1] ?? language.value)

const open = ref(false)
const query = ref('')
const active = ref(0)
const field = ref<HTMLInputElement>()
const root = ref<HTMLElement>()
const matches = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return LANGUAGES
  return LANGUAGES.filter(([value, name, alias]) => value.includes(q) || name.toLowerCase().includes(q) || alias.includes(q))
})
// 列表里没有时，允许直接使用输入的语言名（如 ```vue），写入 Markdown 的就是它。
const custom = computed(() => {
  const q = query.value.trim().toLowerCase()
  return /^[\w+#.-]{1,24}$/.test(q) && !LANGUAGES.some(([value, , alias]) => value === q || alias.split(' ').includes(q)) ? q : ''
})
const count = computed(() => matches.value.length + (custom.value ? 1 : 0))

async function toggle() {
  if (open.value) { close(); return }
  if (!props.editor.isEditable) return
  open.value = true
  query.value = ''
  active.value = Math.max(0, LANGUAGES.findIndex(([value]) => value === language.value))
  document.addEventListener('pointerdown', outside, true)
  await nextTick()
  field.value?.focus()
  scrollActive()
}

function close() {
  open.value = false
  document.removeEventListener('pointerdown', outside, true)
}

function outside(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) close()
}

function choose(value: string) {
  props.updateAttributes({ language: value || null })
  close()
  props.editor.commands.focus()
}

function scrollActive() {
  void nextTick(() => root.value?.querySelector('.lang-option.on')?.scrollIntoView({ block: 'nearest' }))
}

function key(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (count.value) active.value = (active.value + (event.key === 'ArrowDown' ? 1 : count.value - 1)) % count.value
    scrollActive()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    if (active.value < matches.value.length) choose(matches.value[active.value][0])
    else if (custom.value) choose(custom.value)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    close()
    props.editor.commands.focus()
  }
}

const copied = ref(false)
let timer = 0
async function copy() {
  try {
    await navigator.clipboard.writeText(props.node.textContent)
    copied.value = true
    clearTimeout(timer)
    timer = window.setTimeout(() => { copied.value = false }, 1600)
  } catch { /* 剪贴板不可用时什么也不做 */ }
}

onBeforeUnmount(() => {
  clearTimeout(timer)
  document.removeEventListener('pointerdown', outside, true)
})
</script>

<template>
  <NodeViewWrapper class="code-block" :class="{ selected }">
    <div class="code-head" contenteditable="false">
      <!-- 两种都渲染，由编辑器的 contenteditable 决定显示哪个（见 editor.css）：
           editor.isEditable 不是响应式的，切换阅读模式后节点视图不会重新渲染。 -->
      <div ref="root" class="lang">
        <button type="button" class="lang-button" :class="{ open }" :aria-expanded="open" aria-label="代码语言" @mousedown.prevent @click="toggle">
          {{ label || '纯文本' }}<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5 5 5-5" /></svg>
        </button>
        <div v-if="open" class="lang-menu" role="listbox">
          <input ref="field" v-model="query" class="lang-search" placeholder="搜索或输入语言" spellcheck="false" @input="active = 0" @keydown.stop="key">
          <div class="lang-list">
            <button v-for="([value, name], i) in matches" :key="value" type="button" role="option" class="lang-option" :class="{ on: i === active, current: value === language }" :aria-selected="value === language" @mousedown.prevent @mouseenter="active = i" @click="choose(value)">
              <span>{{ name }}</span><svg v-if="value === language" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-6.5" /></svg>
            </button>
            <button v-if="custom" type="button" role="option" class="lang-option" :class="{ on: active === matches.length }" @mousedown.prevent @mouseenter="active = matches.length" @click="choose(custom)">
              <span>使用「{{ custom }}」</span>
            </button>
            <p v-if="!count" class="lang-empty">没有匹配的语言</p>
          </div>
        </div>
      </div>
      <span class="lang-static">{{ label || '纯文本' }}</span>
      <button type="button" class="code-copy" :class="{ done: copied }" :aria-label="copied ? '已复制' : '复制代码'" @mousedown.prevent @click="copy">
        <svg v-if="!copied" viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5v-3a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" /></svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
        {{ copied ? '已复制' : '复制' }}
      </button>
    </div>
    <pre><NodeViewContent as="code" :class="language ? `language-${language}` : undefined" /></pre>
  </NodeViewWrapper>
</template>
