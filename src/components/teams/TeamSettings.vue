<script setup lang="ts">
import { computed, ref } from 'vue'
import { confirmDialog } from '../../composables/useConfirm'
import { formatSize } from '../../drive'
import { MIB, teamsApi } from '../../teams'
import type { Team } from '../../teams'
import DriveDialog from '../drive/DriveDialog.vue'

const props = defineProps<{ team: Team }>()
const emit = defineEmits<{ close: []; saved: [team: Team]; deleted: [] }>()

const form = ref({ name: props.team.name, description: props.team.description, quota: Math.round(props.team.quota / MIB) })
const busy = ref(false), error = ref('')
const minQuota = computed(() => Math.max(10, Math.ceil(props.team.used / MIB)))
const maxQuota = computed(() => props.team.max_quota == null ? null : Math.floor(props.team.max_quota / MIB))

async function save() {
  busy.value = true; error.value = ''
  try {
    emit('saved', await teamsApi<Team>(`/${props.team.id}`, 'PATCH', { name: form.value.name, description: form.value.description, quota_mb: Number(form.value.quota) }))
    emit('close')
  } catch (err) { error.value = err instanceof Error ? err.message : '保存失败' }
  finally { busy.value = false }
}

async function remove() {
  const ok = await confirmDialog({ title: `删除团队「${props.team.name}」？`, message: `团队里的 ${props.team.files} 个文件（${formatSize(props.team.used)}）和 ${props.team.docs} 篇文档会一起删除，无法恢复。划拨的空间会还给你的云盘。`, confirmText: '删除团队', danger: true })
  if (!ok) return
  busy.value = true
  try { await teamsApi(`/${props.team.id}`, 'DELETE'); emit('deleted') }
  catch (err) { error.value = err instanceof Error ? err.message : '删除失败'; busy.value = false }
}
</script>

<template>
  <DriveDialog title="团队设置" :eyebrow="team.name" @close="emit('close')">
    <form class="form" @submit.prevent="save">
      <label class="d-field">名称<input v-model="form.name" class="d-input" maxlength="80" required></label>
      <label class="d-field">简介<input v-model="form.description" class="d-input" maxlength="500"></label>
      <label class="d-field">空间（MB）
        <span class="hint">已用 {{ formatSize(team.used) }}；不能小于已用量{{ maxQuota === null ? '' : `，最多 ${maxQuota} MB` }}</span>
        <input v-model.number="form.quota" class="d-input" type="number" :min="minQuota" :max="maxQuota ?? undefined" step="10" required>
      </label>
      <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
      <div class="actions">
        <button class="d-btn danger" type="button" :disabled="busy" @click="remove">删除团队</button>
        <span class="spacer" />
        <button class="d-btn" type="button" @click="emit('close')">取消</button>
        <button class="d-btn primary" type="submit" :disabled="busy || !form.name.trim()">保存</button>
      </div>
    </form>
  </DriveDialog>
</template>

<style scoped>
.form { display:grid; gap:14px; margin-top:14px; }
.actions { display:flex; gap:8px; }
.spacer { flex:1; }
</style>
