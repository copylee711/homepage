<script setup lang="ts">
import { computed, ref } from 'vue'
import { fetchJson } from '../content'
import { vReveal } from '../composables/useReveal'
import AdminStorage from './AdminStorage.vue'
import IrisPermissions from './IrisPermissions.vue'
import PageHeading from './PageHeading.vue'
import IrisModels from './IrisModels.vue'
import QuotaDefaults from './QuotaDefaults.vue'
import '../styles/admin-panel.css'

const sections = [{ id: 'storage', label: '云盘与图床' }, { id: 'iris', label: 'Iris 执行与配额' }, { id: 'models', label: '共享模型' }, { id: 'defaults', label: '初始配额' }] as const
type Section = typeof sections[number]['id']
const requested = new URLSearchParams(location.search).get('section')
const section = ref<Section>(sections.find(item => item.id === requested)?.id ?? 'storage')
const visited = ref(new Set([section.value]))
const query = ref('')
const search = computed(() => query.value.trim().toLowerCase())
const storageDefaults = ref<{ quota_mb: number; max_image_mb: number }>()
const props = defineProps<{ csrf: string }>()
const error = ref(''), notice = ref('')
const sectionUrl = (value: Section) => value === 'storage' ? '/permissions' : '/permissions?section=' + value

function navigate(value: Section) {
  section.value = value
  visited.value.add(value)
  history.replaceState(null, '', sectionUrl(value))
  error.value = notice.value = ''
}
function fail(text: string) { error.value = text; notice.value = '' }
function notify(text: string) { notice.value = text; error.value = '' }

async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  try {
    return await fetchJson<T>(path, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrf },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: AbortSignal.timeout(path.endsWith('/iris/quota') && method === 'POST' ? 145000 : path.endsWith('/providers/test') || path.endsWith('/providers/models') ? 50000 : 20000),
    })
  } catch (err) {
    if ((err as { status?: number }).status === 401) {
      location.replace(sectionUrl(section.value))
    }
    if (err instanceof DOMException && err.name === 'TimeoutError' && method !== 'GET') {
      throw new Error('请求超时。请刷新查看最新设置，再决定是否重试。')
    }
    throw err
  }
}
</script>

<template>
  <PageHeading title="Permissions" label="Administrator workspace">
    全站权限控制台
    <span>为站点账户开通云盘与图床，管理 Iris 执行授权、共享模型与沙箱资源。</span>
  </PageHeading>
  <div class="container permissions-content">
    <div class="console" v-reveal>
      <div class="console-toolbar admin-panel">
        <nav class="segments" aria-label="权限类别">
          <button v-for="item in sections" :key="item.id" type="button"
            :aria-pressed="section === item.id" @click="navigate(item.id)">
            <span :class="{ 'iris-full': item.id === 'iris' }">{{ item.label }}</span>
            <span v-if="item.id === 'iris'" class="iris-short">Iris</span>
          </button>
        </nav>
        <label v-if="section !== 'defaults' && section !== 'models'" class="account-search">查找用户
          <input v-model="query" type="search" placeholder="昵称或邮箱" maxlength="160">
        </label>
      </div>
      <p v-if="error" class="console-note is-error" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="console-note" role="status">{{ notice }}</p>
      <AdminStorage v-if="visited.has('storage')" v-show="section === 'storage'" :api="api" :query="search" :defaults="storageDefaults"
        @notify="notify" @fail="fail" />
      <IrisPermissions v-if="visited.has('iris')" v-show="section === 'iris'" :api="api" :query="search"
        @notify="notify" @fail="fail" />
      <IrisModels v-if="visited.has('models')" v-show="section === 'models'" :api="api" />
      <QuotaDefaults v-if="visited.has('defaults')" v-show="section === 'defaults'" :api="api" @storage-saved="storageDefaults = $event" />
    </div>
  </div>
</template>

<style scoped>
.permissions-content { min-height:36vh; padding-bottom:72px; }
.console-toolbar { display:flex; flex-wrap:wrap; align-items:end; justify-content:space-between; gap:16px; padding-bottom:22px; margin-bottom:26px; border-bottom:1px solid var(--line); }
.segments { display:flex; gap:4px; padding:4px; border-radius:var(--radius-sm); background:var(--accent-soft); }
.segments button { border:0; background:none; color:var(--muted); font-size:14px; padding:10px 16px; }
.segments button[aria-pressed="true"] { background:var(--surface); color:var(--text); box-shadow:0 2px 8px color-mix(in srgb,var(--text) 9%,transparent); }
.iris-short { display:none; }
.account-search { width:min(100%, 240px); }
.console-note { margin:0 0 18px; border-left:2px solid var(--accent); padding:8px 14px; background:var(--accent-soft); overflow-wrap:anywhere; }
.console-note.is-error { border-color:currentColor; color:var(--text); background:var(--bg-tint); }
@media (max-width:600px) {
  .permissions-content { padding-bottom:40px; }
  .console-toolbar { align-items:stretch; flex-direction:column; }
  .segments button { flex:1; padding-inline:8px; }
  .iris-full { display:none; }
  .iris-short { display:inline; }
  .account-search { width:100%; }
}
</style>
