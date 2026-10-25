<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { account, accountChecked, features, loadAccount } from '../../account'
import { accountUrl, driveApi, formatSize, isMobile, mainSite } from '../../drive'
import type { DriveOverview } from '../../drive'
import '../../styles/drive.css'
import DriveFiles from './DriveFiles.vue'
import DriveSettings from './DriveSettings.vue'
import DriveTopBar from './DriveTopBar.vue'
import DriveShares from './DriveShares.vue'
import StorageTerms from '../StorageTerms.vue'

type Section = 'files' | 'shares' | 'settings'
const section = ref<Section>((() => {
  const value = new URLSearchParams(location.search).get('view')
  return value === 'shares' || value === 'settings' ? value : 'files'
})())
const overview = ref<DriveOverview>()
const error = ref('')
const feedbackUrl = `${mainSite}/account?tab=feedback`
const loginUrl = accountUrl()
const storage = computed(() => overview.value?.storage)
const percent = computed(() => storage.value?.quota ? Math.min(100, storage.value.used / storage.value.quota * 100) : 0)
const nav: { id: Section; label: string; short: string; icon: string }[] = [
  { id: 'files', label: '全部文件', short: '文件', icon: 'M3.5 6.5a1 1 0 0 1 1-1h4.6l2 2h8.4a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1Z' },
  { id: 'shares', label: '我的分享', short: '分享', icon: 'M8.5 13.5 15.5 17.5M15.5 6.5l-7 4M18 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM6 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm12 6.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z' },
  { id: 'settings', label: '连接与凭据', short: '我的', icon: 'M15 7a4 4 0 1 1-3.9 4.9L4 19v-3h2v-2h2l1.1-1.1A4 4 0 0 1 15 7Zm1.5 2.5h.01' },
]

async function refresh() {
  try { overview.value = await driveApi<DriveOverview>('') }
  catch (err) { error.value = err instanceof Error ? err.message : '读取失败' }
}
function go(next: Section) {
  section.value = next
  const url = next === 'files' ? location.pathname : `${location.pathname}?view=${next}`
  history.replaceState(null, '', url)
}

onMounted(async () => {
  document.title = 'Cloud · Copy Lee'
  await loadAccount()
  if (account.value && features.value.drive && features.value.terms) await refresh()
})
</script>

<template>
  <div class="drive-shell">
    <DriveTopBar />

    <main v-if="!accountChecked" class="state"><p class="d-muted">正在读取账户…</p></main>
    <main v-else-if="!account" class="state">
      <div class="state-card">
        <h1>登录后使用云盘</h1>
        <p>云盘使用站点账户登录，开通后可在网页、SFTP 与 WebDAV 中访问同一份文件。</p>
        <a class="d-btn primary" :href="loginUrl">登录</a>
      </div>
    </main>
    <main v-else-if="!features.drive" class="state">
      <div class="state-card">
        <h1>云盘尚未开通</h1>
        <p>云盘目前只向受邀用户开放。如需开通，可以在账户页的“反馈”中告诉站长。</p>
        <a class="d-btn" :href="feedbackUrl">去反馈</a>
      </div>
    </main>
    <main v-else-if="!features.terms" class="terms-page">
      <StorageTerms @agreed="async () => { await loadAccount(true); await refresh() }" />
    </main>
    <div v-else class="layout">
      <aside class="side">
        <nav aria-label="云盘">
          <button v-for="item in nav" :key="item.id" type="button" :class="{ active: section === item.id }" :aria-current="section === item.id ? 'page' : undefined" @click="go(item.id)"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="item.icon" /></svg>{{ item.label }}</button>
        </nav>
        <div v-if="storage" class="usage">
          <div class="bar" role="progressbar" :aria-valuenow="Math.round(percent)" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${percent}%` }" /></div>
          <p><strong>{{ formatSize(storage.used) }}</strong> / {{ storage.quota === null ? '不限' : formatSize(storage.quota) }}</p>
          <p class="d-muted">含图床 {{ formatSize(storage.images_used) }}</p>
          <p v-for="mount in (overview?.mounts ?? []).filter(m => m.quota > 0)" :key="mount.id" class="d-muted">{{ mount.path }}：{{ formatSize(mount.used) }} / {{ formatSize(mount.quota) }}</p>
        </div>
        <p v-if="error" class="d-note error">{{ error }}</p>
      </aside>
      <main class="content">
        <section v-if="isMobile && section === 'settings' && storage" class="m-usage" aria-label="存储用量">
          <div class="m-usage-head"><span>已用</span><strong>{{ formatSize(storage.used) }}</strong><span>/ {{ storage.quota === null ? '不限' : formatSize(storage.quota) }}</span></div>
          <div class="bar" role="progressbar" :aria-valuenow="Math.round(percent)" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${percent}%` }" /></div>
          <p class="d-muted">云盘 {{ formatSize(storage.drive_used) }} · 图床 {{ formatSize(storage.images_used) }}<template v-for="mount in (overview?.mounts ?? []).filter(m => m.quota > 0)" :key="mount.id"> · {{ mount.path }} {{ formatSize(mount.used) }} / {{ formatSize(mount.quota) }}</template></p>
        </section>
        <DriveFiles v-if="section === 'files'" @changed="refresh" />
        <DriveShares v-else-if="section === 'shares'" />
        <DriveSettings v-else-if="overview?.account" :account="overview.account" @changed="refresh" />
      </main>
      <nav v-if="isMobile" class="tabbar" aria-label="云盘">
        <button v-for="item in nav" :key="item.id" type="button" :class="{ active: section === item.id }" :aria-current="section === item.id ? 'page' : undefined" @click="go(item.id)"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="item.icon" /></svg>{{ item.short }}</button>
      </nav>
    </div>
  </div>
</template>

<style scoped>
.drive-shell { min-height:calc(100vh - 120px); }
.state { display:grid; place-items:center; min-height:60vh; padding:24px; }
.state-card { max-width:440px; padding:36px; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); text-align:center; box-shadow:0 30px 60px -40px rgba(17,24,39,.35); }
.state-card h1 { font-size:26px; letter-spacing:-.02em; }
.state-card p { margin:10px 0 22px; color:var(--muted); font-size:14px; line-height:1.7; }
.terms-page { padding:clamp(24px,5vw,56px) 16px 64px; }
.layout { display:grid; grid-template-columns:220px minmax(0,1fr); max-width:1440px; margin:0 auto; }
.side { position:sticky; top:var(--header-h); align-self:start; height:calc(100vh - var(--header-h)); padding:24px 14px; border-right:1px solid var(--line); overflow:auto; }
.side nav { display:grid; gap:2px; }
.side nav button { display:flex; align-items:center; gap:11px; padding:10px 12px; border:0; border-radius:10px; background:none; color:var(--text-2); font:14px var(--font); text-align:left; cursor:pointer; transition:background .2s,color .2s; }
.side nav button:hover { background:color-mix(in srgb,var(--text) 4%,transparent); color:var(--text); }
.side nav button.active { background:var(--accent-soft); color:var(--accent); font-weight:500; }
.side svg { width:18px; height:18px; flex:none; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.usage { margin:28px 6px 0; font-size:13px; }
.usage .bar { height:6px; border-radius:999px; background:var(--bg-tint); overflow:hidden; }
.usage .bar span { display:block; height:100%; background:var(--accent); border-radius:inherit; }
.usage p { margin-top:8px; }
.usage p.d-muted { margin-top:4px; font-size:12px; }
.content { min-width:0; padding:28px clamp(16px,3vw,40px) 64px; }
@media (max-width:860px) {
  .layout { grid-template-columns:1fr; }
  .side { position:static; height:auto; padding:12px 16px 0; border-right:0; }
  .side nav { display:flex; overflow:auto; }
  .side nav button { white-space:nowrap; }
  .usage { display:none; }
}
/* 手机：侧栏改为底部标签栏，“我的”里显示用量。 */
@media (max-width:760px) {
  .side { display:none; }
  .content { padding:16px 16px calc(96px + env(safe-area-inset-bottom)); }
  .terms-page { padding:16px 12px 40px; }
}
.tabbar { position:fixed; left:0; right:0; bottom:0; z-index:40; display:grid; grid-template-columns:repeat(3,1fr); padding:4px 0 env(safe-area-inset-bottom); border-top:1px solid var(--line); background:color-mix(in srgb,var(--bg) 92%,transparent); -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px); }
.tabbar button { position:relative; display:flex; flex-direction:column; align-items:center; gap:3px; padding:8px 0 7px; border:0; background:none; color:var(--muted); font:12px var(--font); cursor:pointer; -webkit-tap-highlight-color:transparent; }
.tabbar button.active { color:var(--accent); font-weight:500; }
.tabbar svg { width:23px; height:23px; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.tabbar button.active svg { fill:var(--accent-soft); }
.m-usage { margin-bottom:20px; padding:18px 18px 16px; border:1px solid var(--line); border-radius:16px; background:var(--surface); }
.m-usage-head { display:flex; align-items:baseline; gap:6px; color:var(--muted); font-size:13px; }
.m-usage-head strong { color:var(--text); font-size:22px; }
.m-usage .bar { height:6px; margin:12px 0 10px; border-radius:999px; background:var(--bg-tint); overflow:hidden; }
.m-usage .bar span { display:block; height:100%; border-radius:inherit; background:var(--accent); }
.m-usage p { margin:0; font-size:12px; line-height:1.6; }
</style>
