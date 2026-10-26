<script setup lang="ts">
import { computed, ref } from 'vue'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'

// 代码块：顶部一栏显示语言（可编辑时可切换）和一键复制。
const props = defineProps(nodeViewProps)

const LANGUAGES: [string, string][] = [
  ['', '纯文本'], ['python', 'Python'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'],
  ['java', 'Java'], ['c', 'C'], ['cpp', 'C++'], ['csharp', 'C#'], ['go', 'Go'], ['rust', 'Rust'],
  ['kotlin', 'Kotlin'], ['swift', 'Swift'], ['php', 'PHP'], ['ruby', 'Ruby'], ['bash', 'Shell'],
  ['powershell', 'PowerShell'], ['sql', 'SQL'], ['json', 'JSON'], ['yaml', 'YAML'], ['xml', 'HTML / XML'],
  ['css', 'CSS'], ['scss', 'SCSS'], ['markdown', 'Markdown'], ['diff', 'Diff'], ['ini', 'INI / TOML'],
  ['makefile', 'Makefile'], ['r', 'R'], ['lua', 'Lua'], ['matlab', 'MATLAB'], ['latex', 'LaTeX'],
]
const language = computed(() => (props.node.attrs.language as string | null) ?? '')
// 文档里写的语言不在列表中时（如 ```vue），仍然显示并保留它。
const options = computed(() => LANGUAGES.some(([value]) => value === language.value)
  ? LANGUAGES : [...LANGUAGES, [language.value, language.value] as [string, string]])
const label = computed(() => options.value.find(([value]) => value === language.value)?.[1] ?? language.value)
const copied = ref(false)
let timer = 0

function setLanguage(event: Event) {
  props.updateAttributes({ language: (event.target as HTMLSelectElement).value || null })
}

async function copy() {
  try {
    await navigator.clipboard.writeText(props.node.textContent)
    copied.value = true
    clearTimeout(timer)
    timer = window.setTimeout(() => { copied.value = false }, 1600)
  } catch { /* 剪贴板不可用时什么也不做 */ }
}
</script>

<template>
  <NodeViewWrapper class="code-block" :class="{ selected }">
    <div class="code-head" contenteditable="false">
      <select v-if="editor.isEditable" class="code-lang" :value="language" aria-label="代码语言" @change="setLanguage" @mousedown.stop>
        <option v-for="[value, name] in options" :key="value" :value="value">{{ name }}</option>
      </select>
      <span v-else class="code-lang">{{ label }}</span>
      <button type="button" class="code-copy" :class="{ done: copied }" :aria-label="copied ? '已复制' : '复制代码'" @mousedown.prevent @click="copy">
        <svg v-if="!copied" viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5v-3a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" /></svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
        {{ copied ? '已复制' : '复制' }}
      </button>
    </div>
    <pre><NodeViewContent as="code" :class="language ? `language-${language}` : undefined" /></pre>
  </NodeViewWrapper>
</template>
