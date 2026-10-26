<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { confirmDialog } from '../../composables/useConfirm'
import { socialApi } from '../../friends'
import type { FriendInvite, FriendsOverview } from '../../friends'
import DriveDialog from '../drive/DriveDialog.vue'

/** 按完整邮箱发送好友申请，或复制自己的邀请链接发给对方。 */
const emit = defineEmits<{ close: []; changed: [data: FriendsOverview] }>()
const email = ref(''), message = ref('')
const invite = ref<FriendInvite>()
const busy = ref(false), error = ref(''), notice = ref('')

async function work<T>(task: () => Promise<T>, done = '') {
  busy.value = true; error.value = ''; notice.value = ''
  try { const result = await task(); notice.value = done; return result }
  catch (err) { error.value = err instanceof Error ? err.message : '操作失败' }
  finally { busy.value = false }
}

async function send() {
  const data = await work(() => socialApi<FriendsOverview & { friend: boolean }>('/friends/requests', 'POST', { email: email.value.trim(), message: message.value.trim() }))
  if (!data) return
  notice.value = data.friend ? '对方也向你发过申请，你们已经是好友了。' : '申请已发送，等待对方同意。'
  email.value = ''; message.value = ''
  emit('changed', data)
}

async function copy() {
  if (!invite.value) return
  try { await navigator.clipboard.writeText(invite.value.url); notice.value = '邀请链接已复制'; error.value = '' }
  catch { error.value = '复制失败，请手动复制' }
}

async function reset() {
  if (!await confirmDialog({ title: '重新生成邀请链接？', message: '旧链接会立即失效，已经通过旧链接添加的好友不受影响。', confirmText: '重新生成' })) return
  const data = await work(() => socialApi<FriendInvite>('/friends/invite/reset', 'POST'), '已生成新链接，旧链接失效')
  if (data) invite.value = data
}

onMounted(async () => { invite.value = await work(() => socialApi<FriendInvite>('/friends/invite')) })
</script>

<template>
  <DriveDialog title="添加好友" @close="emit('close')">
    <form @submit.prevent="send">
      <label class="d-field">对方的注册邮箱
        <input v-model="email" class="d-input" type="email" autocomplete="off" placeholder="需要输入完整邮箱" required>
      </label>
      <label class="d-field">附言（可选）
        <input v-model="message" class="d-input" type="text" maxlength="120" placeholder="介绍一下自己">
      </label>
      <div class="d-actions"><button class="d-btn primary" type="submit" :disabled="busy || !email.trim()">发送申请</button></div>
    </form>

    <section class="invite">
      <h3>邀请链接</h3>
      <p class="d-muted">对方登录后打开链接并确认，就会直接成为你的好友。</p>
      <div v-if="invite" class="url">
        <input class="d-input" :value="invite.url" readonly aria-label="邀请链接" @focus="($event.target as HTMLInputElement).select()">
        <button class="d-btn" type="button" @click="copy">复制</button>
      </div>
      <button class="d-btn quiet small" type="button" :disabled="busy || !invite" @click="reset">重新生成链接</button>
    </section>

    <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="d-note ok" role="status">{{ notice }}</p>
  </DriveDialog>
</template>

<style scoped>
form .d-field:first-child { margin-top:8px; }
form .d-actions { margin-top:16px; }
.invite { margin-top:22px; padding-top:18px; border-top:1px solid var(--line); }
.invite h3 { margin:0; font-size:15px; }
.invite .d-muted { margin:6px 0 12px; }
.url { display:flex; gap:8px; }
.url input { flex:1; min-width:0; }
.small { margin-top:10px; padding:5px 10px; font-size:12.5px; }
</style>
