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

const sections = [{ id: 'storage', label: '云盘与图床', short: '存储' }, { id: 'iris', label: 'Iris 执行与配额', short: 'Iris' }, { id: 'models', label: '共享模型', short: '模型' }, { id: 'defaults', label: '初始配额', short: '默认' }] as const
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
            <span class="label-full">{{ item.label }}</span>
            <span class="label-short">{{ item.short }}</span>
          </button>
        </nav>
        <label v-if="section !== 'defaults' && section !== 'models'" class="account-search">查找用户
          <input v-model="query" type="search" placeholder="昵称或邮箱" maxlength="160">
        </label>
      </div>
      <p v-if="error" class="console-note is-error" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="console-note" role="status">{{ notice }}</p>
      <Transition name="panel" appear><AdminStorage v-if="visited.has('storage')" v-show="section === 'storage'" :api="api" :query="search" :defaults="storageDefaults"
        @notify="notify" @fail="fail" /></Transition>
      <Transition name="panel" appear><IrisPermissions v-if="visited.has('iris')" v-show="section === 'iris'" :api="api" :query="search"
        @notify="notify" @fail="fail" /></Transition>
      <Transition name="panel" appear><IrisModels v-if="visited.has('models')" v-show="section === 'models'" :api="api" /></Transition>
      <Transition name="panel" appear><QuotaDefaults v-if="visited.has('defaults')" v-show="section === 'defaults'" :api="api" @storage-saved="storageDefaults = $event" /></Transition>
    </div>
  </div>
</template>

<style scoped>
.permissions-content { min-height:36vh; padding-bottom:72px; }
.console-toolbar { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; padding-bottom:16px; margin-bottom:22px; border-bottom:1px solid var(--line); }
.segments { display:flex; gap:2px; padding:3px; border-radius:12px; background:var(--accent-soft); }
.admin-panel .segments button { border:0; border-radius:9px; background:none; color:var(--muted); font-size:13px; padding:7px 14px; }
.admin-panel .segments button:hover:not([aria-pressed="true"]) { color:var(--text); }
.admin-panel .segments button[aria-pressed="true"] { background:var(--surface); color:var(--text); box-shadow:0 1px 6px color-mix(in srgb,var(--text) 9%,transparent); }
.label-short { display:none; }
.account-search { flex-direction:row !important; align-items:center; gap:10px !important; width:min(100%, 280px); white-space:nowrap; color:var(--muted) !important; font-weight:400 !important; }
.admin-panel .account-search input { padding:7px 11px; font-size:13px; }
.console-note { margin:-10px 0 16px; border-left:2px solid var(--accent); padding:7px 12px; background:var(--accent-soft); font-size:13px; overflow-wrap:anywhere; animation:note-in .28s cubic-bezier(.22,.75,.24,1); }
@keyframes note-in { from { opacity:0; transform:translateY(-4px); } }
.panel-enter-active { transition:opacity .28s cubic-bezier(.22,.75,.24,1), transform .28s cubic-bezier(.22,.75,.24,1); }
.panel-enter-from { opacity:0; transform:translateY(6px); }
.console-note.is-error { border-color:currentColor; color:var(--text); background:var(--bg-tint); }
@media (max-width:600px) {
  .permissions-content { padding-bottom:40px; }
  .console-toolbar { align-items:stretch; flex-direction:column; }
  .segments button { flex:1; padding-inline:8px; }
  .label-full { display:none; }
  .label-short { display:inline; }
  .account-search { width:100%; }
}
</style>

<style>
/* 控制台内统一使用紧凑表单尺寸，与 AnimatedSelect 对齐。 */
.console .admin-panel .section-head { margin-bottom:16px; align-items:flex-start; }
.console .admin-panel label { font-size:12px; gap:5px; }
.console .admin-panel input:not([type=checkbox]):not([type=radio]) { padding:7px 11px; font-size:13px; border-radius:9px; }
.console .admin-panel .select-field label { margin-bottom:5px; font-size:12px; font-weight:500; color:var(--text-2); }
.console .admin-panel .select-field .select-trigger { min-height:36px; padding:0 11px; border-color:var(--field-line); border-radius:9px; background:var(--bg); font-size:13px; }

</style>
