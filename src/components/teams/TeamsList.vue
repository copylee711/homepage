<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { account, accountChecked, loadAccount } from '../../account'
import { accountUrl, formatSize } from '../../drive'
import { timeAgo } from '../../docs'
import '../../styles/drive.css'
import { MIB, roleLabel, teamUrl, teamsApi } from '../../teams'
import type { Team } from '../../teams'
import DriveDialog from '../drive/DriveDialog.vue'

const teams = ref<Team[]>([])
const canCreate = ref(false), remaining = ref<number | null>(0), defaultQuota = ref(0)
const loading = ref(true), error = ref('')
const creating = ref(false), busy = ref(false), formError = ref('')
const form = ref({ name: '', description: '', quota: 1024 })
const maxQuota = computed(() => remaining.value === null ? null : Math.floor(remaining.value / MIB))

async function load() {
  await loadAccount()
  if (!account.value) { loading.value = false; return }
  loading.value = true; error.value = ''
  try {
    const data = await teamsApi<{ can_create: boolean; remaining: number | null; default_quota: number; teams: Team[] }>('')
    teams.value = data.teams; canCreate.value = data.can_create
    remaining.value = data.remaining; defaultQuota.value = data.default_quota
  } catch (err) { error.value = err instanceof Error ? err.message : '读取失败' }
  finally { loading.value = false }
}

function openCreate() {
  form.value = { name: '', description: '', quota: Math.max(10, Math.floor(defaultQuota.value / MIB)) }
  formError.value = ''; creating.value = true
}

async function create() {
  if (busy.value) return
  busy.value = true; formError.value = ''
  try {
    const team = await teamsApi<Team>('', 'POST', { name: form.value.name, description: form.value.description, quota_mb: Number(form.value.quota) })
    location.href = teamUrl(team.id)
  } catch (err) { formError.value = err instanceof Error ? err.message : '创建失败' }
  finally { busy.value = false }
}

const percent = (team: Team) => team.quota ? Math.min(100, team.used / team.quota * 100) : 0

onMounted(load)
</script>

<template>
  <section v-if="accountChecked && !account" class="teams signin">
    <h2>团队</h2>
    <p class="d-muted">登录后查看你创建和加入的团队。</p>
    <a class="d-btn primary" :href="accountUrl()">登录</a>
  </section>
  <section v-else class="teams">
    <header>
      <div><h2>团队</h2><p class="d-muted">和几个人一起做事时的共享空间：资料、代码与协作文档放在一起，还能映射成本地磁盘。</p></div>
      <button v-if="canCreate" class="d-btn primary" type="button" @click="openCreate">＋ 新建团队</button>
    </header>
    <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
    <p v-if="loading" class="d-muted empty">正在读取…</p>
    <div v-else-if="!teams.length" class="empty-state">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9a6 6 0 0 1 12 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.5a6 6 0 0 1 3 5.5" /></svg>
      <p>{{ canCreate ? '还没有团队。新建一个，空间从你的云盘配额里划拨。' : '还没有加入任何团队。别人邀请你之后，团队会出现在这里。' }}</p>
    </div>
    <ul v-else>
      <li v-for="team in teams" :key="team.id">
        <a class="main" :href="teamUrl(team.id)">
          <span class="badge" aria-hidden="true">{{ team.name.slice(0, 1) }}</span>
          <span class="text">
            <strong>{{ team.name }}</strong>
            <small>{{ roleLabel[team.role] }}<template v-if="team.role !== 'owner'"> · {{ team.owner?.name }} 创建</template> · {{ team.members }} 人 · {{ team.docs }} 篇文档 · {{ timeAgo(team.updated_at) }}更新</small>
            <span v-if="team.description" class="desc">{{ team.description }}</span>
          </span>
          <span class="usage" :title="`已用 ${formatSize(team.used)}，共 ${formatSize(team.quota)}`">
            <span class="bar"><span :style="{ width: `${percent(team)}%` }" /></span>
            <small>{{ formatSize(team.used) }} / {{ formatSize(team.quota) }}</small>
          </span>
        </a>
      </li>
    </ul>

    <DriveDialog v-if="creating" title="新建团队" @close="creating = false">
      <form class="create" @submit.prevent="create">
        <label class="d-field">名称<input v-model="form.name" class="d-input" maxlength="80" required placeholder="例如 2026 数模国赛"></label>
        <label class="d-field">简介<span class="hint">可选</span><input v-model="form.description" class="d-input" maxlength="500" placeholder="一句话说明这个团队做什么"></label>
        <label class="d-field">空间（MB）
          <span class="hint">从你的云盘配额里划拨，空着也算占用；之后可以调整。{{ maxQuota === null ? '' : `最多 ${maxQuota} MB` }}</span>
          <input v-model.number="form.quota" class="d-input" type="number" min="10" :max="maxQuota ?? undefined" step="10" required>
        </label>
        <p v-if="formError" class="d-note error" role="alert">{{ formError }}</p>
        <div class="actions">
          <button class="d-btn" type="button" @click="creating = false">取消</button>
          <button class="d-btn primary" type="submit" :disabled="busy || !form.name.trim()">创建</button>
        </div>
      </form>
    </DriveDialog>
  </section>
</template>

<style scoped>
.signin { display:grid; justify-items:start; gap:12px; }
header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
h2 { font-size:20px; }
header p { margin-top:4px; max-width:560px; }
ul { list-style:none; margin:20px 0 0; padding:0; border-top:1px solid var(--line); }
li { border-bottom:1px solid var(--line); }
.main { display:flex; align-items:center; gap:14px; min-width:0; padding:16px 4px; }
.main:hover strong { color:var(--accent); }
.badge { flex:none; display:grid; place-items:center; width:38px; height:38px; border-radius:11px; background:var(--accent-soft); color:var(--accent); font-weight:600; font-size:16px; }
.text { flex:1; display:flex; flex-direction:column; gap:3px; min-width:0; }
.text strong { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; transition:color .2s; }
.text small { color:var(--faint); font-size:12.5px; }
.desc { color:var(--muted); font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.usage { flex:none; display:grid; gap:5px; width:150px; text-align:right; }
.usage small { color:var(--faint); font-size:12px; }
.bar { height:5px; border-radius:3px; background:var(--bg-tint); overflow:hidden; }
.bar span { display:block; height:100%; border-radius:inherit; background:var(--accent); }
.empty { padding:32px 0; }
.empty-state { display:grid; justify-items:center; gap:12px; padding:56px 16px; color:var(--muted); font-size:14px; text-align:center; }
.empty-state svg { width:40px; height:40px; fill:none; stroke:var(--faint); stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; }
.create { display:grid; gap:14px; margin-top:14px; }
.actions { display:flex; justify-content:flex-end; gap:8px; }
@media (max-width:760px) {
  h2 { font-size:22px; }
  header { flex-direction:column; }
  .usage { display:none; }
}
</style>
