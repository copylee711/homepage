<script setup lang="ts">
import { computed, ref } from 'vue'
import { baseName, driveApi } from '../../drive'
import type { DriveShare } from '../../drive'
import DriveDialog from './DriveDialog.vue'

const props = defineProps<{ paths: string[]; folder: boolean }>()
const emit = defineEmits<{ close: [] }>()
const mode = ref<'read' | 'upload'>('read')
const name = ref(props.paths.length === 1 ? baseName(props.paths[0]!) : '')
const password = ref(''), days = ref(7), maxUses = ref(0)
const result = ref<DriveShare>()
const busy = ref(false), error = ref(''), copied = ref(false)
const canUpload = computed(() => props.paths.length === 1 && props.folder)
const durations = [[1, '1 天'], [7, '7 天'], [30, '30 天'], [0, '永久']] as const

async function create() {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    result.value = await driveApi<DriveShare>('/shares', 'POST', {
      paths: props.paths, mode: mode.value, name: name.value, password: password.value,
      expires_at: days.value ? Date.now() / 1000 + days.value * 86400 : 0, max_uses: maxUses.value || 0,
    })
  } catch (err) { error.value = err instanceof Error ? err.message : '创建失败' }
  finally { busy.value = false }
}
async function copy() {
  if (!result.value) return
  const text = password.value ? `${result.value.url}\n提取密码：${password.value}` : result.value.url
  try { await navigator.clipboard.writeText(text); copied.value = true } catch { error.value = '复制失败，请手动复制' }
}
</script>

<template>
  <DriveDialog :title="result ? '分享链接已创建' : '创建分享'" eyebrow="Share" @close="emit('close')">
    <template v-if="!result">
      <form @submit.prevent="create">
        <p class="d-muted summary">{{ paths.length === 1 ? baseName(paths[0]!) : `${paths.length} 个项目` }}</p>
        <div v-if="canUpload" class="modes" role="radiogroup" aria-label="分享方式">
          <button type="button" role="radio" :aria-checked="mode === 'read'" :class="{ active: mode === 'read' }" @click="mode = 'read'">查看与下载</button>
          <button type="button" role="radio" :aria-checked="mode === 'upload'" :class="{ active: mode === 'upload' }" @click="mode = 'upload'">仅允许上传</button>
        </div>
        <p v-if="mode === 'upload'" class="d-muted">拿到链接的人只能往这个文件夹放文件，看不到其中的内容。</p>
        <label class="d-field">名称<input v-model="name" class="d-input" maxlength="120" placeholder="显示给访客的标题"></label>
        <label class="d-field">提取密码<span class="hint">留空则无需密码</span><input v-model="password" class="d-input" maxlength="128" autocomplete="off"></label>
        <div class="d-field">有效期<div class="durations"><button v-for="[value, label] in durations" :key="value" type="button" :class="{ active: days === value }" @click="days = value">{{ label }}</button></div></div>
        <label class="d-field">最多使用次数<span class="hint">下载或上传一次计一次，0 表示不限</span><input v-model.number="maxUses" class="d-input" type="number" min="0" max="1000000"></label>
        <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
        <div class="d-actions"><button class="d-btn" type="button" @click="emit('close')">取消</button><button class="d-btn primary" type="submit" :disabled="busy">{{ busy ? '创建中…' : '创建链接' }}</button></div>
      </form>
    </template>
    <template v-else>
      <p class="d-muted summary">{{ result.mode === 'upload' ? '访客可以通过此链接上传文件。' : '访客可以通过此链接查看与下载。' }}{{ result.expires_at ? `有效期至 ${new Date(result.expires_at * 1000).toLocaleString('zh-CN', { hour12: false })}。` : '长期有效。' }}</p>
      <input class="d-input link" :value="result.url" readonly @focus="($event.target as HTMLInputElement).select()">
      <p v-if="password" class="d-muted">提取密码：<span class="d-code">{{ password }}</span></p>
      <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
      <div class="d-actions"><a class="d-btn" :href="result.url" target="_blank" rel="noopener">打开</a><button class="d-btn primary" type="button" @click="copy">{{ copied ? '已复制' : password ? '复制链接和密码' : '复制链接' }}</button></div>
    </template>
  </DriveDialog>
</template>

<style scoped>
.summary { margin-top:8px; overflow-wrap:anywhere; }
.modes,.durations { display:flex; gap:4px; padding:4px; border-radius:10px; background:var(--bg-tint); }
.modes { margin-top:16px; }
.modes button,.durations button { flex:1; padding:8px 10px; border:0; border-radius:8px; background:none; color:var(--muted); font:13px var(--font); cursor:pointer; }
.modes button.active,.durations button.active { background:var(--surface); color:var(--text); box-shadow:0 2px 8px -4px rgba(17,24,39,.25); }
.link { margin-top:16px; font-family:var(--font-mono); font-size:13px; }
</style>
