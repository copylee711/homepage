<script setup lang="ts">
import { computed } from 'vue'
import { NodeViewWrapper } from '@tiptap/vue-3'
import type { NodeViewProps } from '@tiptap/vue-3'
import { formatSize } from '../../drive'
import { kindIcons, kindOf } from '../drive/fileKinds'
import { fileRefs, isImage, resolveRef } from './fileRef'

const props = defineProps<NodeViewProps>()
const target = computed(() => String(props.node.attrs.target ?? ''))
const file = computed(() => resolveRef(target.value))
const label = computed(() => target.value.split('/').filter(Boolean).pop() || target.value)
const embedded = computed(() => !!props.node.attrs.embed && !!file.value && isImage(file.value.name))
const icon = computed(() => kindIcons[kindOf(label.value)])

function open(event: MouseEvent) {
  if (!file.value || !fileRefs.value) return
  event.preventDefault()
  fileRefs.value.open(file.value)
}
</script>

<template>
  <NodeViewWrapper as="span" class="file-ref" :class="{ selected, missing: fileRefs && !file, plain: !fileRefs, embed: embedded }" :data-file-ref="target" contenteditable="false">
    <img v-if="embedded && fileRefs" :src="fileRefs.url(file!)" :alt="label" :title="file!.path" draggable="false" @dblclick="open">
    <button v-else-if="fileRefs" type="button" :title="file ? `${file.path}（点击打开）` : '团队里找不到这个文件'" @click="open">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="icon" /></svg>
      <span class="name">{{ label }}</span>
      <span class="meta">{{ file ? formatSize(file.size) : '找不到文件' }}</span>
    </button>
    <template v-else>{{ node.attrs.embed ? '!' : '' }}[[{{ target }}]]</template>
  </NodeViewWrapper>
</template>
