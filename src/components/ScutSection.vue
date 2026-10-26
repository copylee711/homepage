<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { markRead, noticeUnread, reloadScut, scut, scutStatus, unread } from '../scut'
import { vReveal } from '../composables/useReveal'
import AnimatedSelect from './AnimatedSelect.vue'
import PageHeading from './PageHeading.vue'

const props = defineProps<{ full?: boolean }>()
const source = ref('')
const column = ref('')
const query = ref('')
const searchInput = ref<HTMLInputElement>()
function clearQuery() { query.value = ''; searchInput.value?.focus() }
const onlyUnread = ref(false)
const order = ref('desc')
const page = ref(1)
const activeColumns = computed(() => scut.value?.columns.filter((c) => !source.value || c.source === source.value) ?? [])
const sourceOptions = computed(() => [{ value: '', label: '全部来源' }, ...(scut.value?.sources ?? []).map(s => ({ value:s.id, label:s.name }))])
const columnOptions = computed(() => [{ value: '', label: '全部栏目' }, ...activeColumns.value.map(c => ({ value:c.id, label:labels([c.id]) }))])
function cardPointer(event: PointerEvent) {
  const card = (event.target as HTMLElement).closest('a')
  if (!card) return
  const rect = card.getBoundingClientRect()
  card.style.setProperty('--mx', `${event.clientX - rect.left}px`)
  card.style.setProperty('--my', `${event.clientY - rect.top}px`)
}
const filtered = computed(() => {
  const ids = new Set(activeColumns.value.filter((c) => !column.value || c.id === column.value).map((c) => c.id))
  const items = (scut.value?.items ?? []).filter((item) =>
    item.columns.some((id) => ids.has(id)) && item.title.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()) &&
    (!onlyUnread.value || noticeUnread(item)))
  return items.sort((a, b) => {
    // Unknown publication dates always follow dated rows.
    if (!a.published_at || !b.published_at) return Number(!a.published_at) - Number(!b.published_at)
    const comparison = a.published_at.localeCompare(b.published_at) || a.first_seen.localeCompare(b.first_seen) || a.id.localeCompare(b.id)
    return order.value === 'asc' ? comparison : -comparison
  })
})
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 20)))
const shown = computed(() => props.full ? filtered.value.slice((page.value - 1) * 20, page.value * 20) : unread.value.slice(0, 8))
const initialized = computed(() => scut.value?.columns.filter((c) => c.initialized).length ?? 0)
const failures = computed(() => scut.value?.columns.filter((c) => c.last_error).length ?? 0)
watch(source, () => { column.value = '' })
watch([source, column, query, onlyUnread, order], () => { page.value = 1 })
watch(pages, (count) => { page.value = Math.min(page.value, count) })
const labels = (ids: string[]) => ids.map((id) => {
  const c = scut.value?.columns.find((entry) => entry.id === id)
  const s = scut.value?.sources.find((entry) => entry.id === c?.source)
  return c ? `${s?.name ?? ''} / ${c.name}` : id
}).join(' · ')
const time = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未成功检查'
</script>

<template>
  <section id="scut" class="section scut-section" :class="{ full }">
    <PageHeading v-if="full" title="SCUT" label="Campus bulletin">校内消息，集中查阅。<span>只索引标题与链接，内容以官网为准。</span></PageHeading>
    <div class="container">
      <div v-if="!full" v-reveal class="scut-heading">
        <div><p class="label">Campus bulletin</p><component :is="full ? 'h1' : 'h2'" class="section-title"><span>SCUT</span></component></div>
        <a v-if="!full" class="all-link" href="/scut">查看全部通知 <span aria-hidden="true">↗</span></a>
        <a v-else class="all-link" href="/">返回主页 ↗</a>
      </div>
      <div v-reveal class="scut-intro"><p v-if="!full">校内消息，集中查阅。<span>只索引标题与链接，内容以官网为准。</span></p><p v-else class="label">Explore campus</p><p class="unread-count"><strong>{{ unread.length }}</strong> 条未读</p></div>
      <div v-reveal="120" class="school-links" aria-label="学校官网友链" @pointermove="cardPointer">
        <a href="https://www.scut.edu.cn/" target="_blank" rel="noopener noreferrer"><span>01</span> 华南理工大学 <small>scut.edu.cn ↗</small></a>
        <a href="https://www2.scut.edu.cn/math/" target="_blank" rel="noopener noreferrer"><span>02</span> 数学学院 <small>学院官网 ↗</small></a>
        <a href="https://jw.scut.edu.cn/zhinan/cms/index.do" target="_blank" rel="noopener noreferrer"><span>03</span> 本科生院 <small>教务通知 ↗</small></a>
      </div>
      <div v-if="full" class="filters">
        <AnimatedSelect v-model="source" label="来源" :options="sourceOptions" />
        <AnimatedSelect v-model="column" label="栏目" :options="columnOptions" />
        <div class="search"><label for="scut-query">搜索标题</label><div class="search-control"><input id="scut-query" ref="searchInput" v-model="query" type="search" placeholder="考试、奖学金、学术报告…" /><button v-if="query" class="search-clear" type="button" aria-label="清除搜索" @click="clearQuery">×</button></div></div>
        <AnimatedSelect v-model="order" label="日期排序" :options="[{value:'desc',label:'最新在前'},{value:'asc',label:'最早在前'}]" />
      </div>
      <div class="list-toolbar">
        <template v-if="full"><label class="checkbox"><input v-model="onlyUnread" type="checkbox" />仅看未读</label><span role="status" aria-live="polite">{{ filtered.length }} 条结果</span><button :disabled="!filtered.length" @click="markRead(filtered.map((item) => item.id))">当前筛选全部已读</button></template>
        <span v-else>最新未读通知</span>
        <button class="refresh" @click="reloadScut">刷新索引</button>
      </div>
      <p v-if="scutStatus.error" class="notice-message" role="status">{{ scut ? '暂时无法检查更新，正在显示已加载索引。' : '通知索引暂时不可用。' }} {{ scutStatus.error }}</p>
      <p v-if="scutStatus.storageError" class="notice-message" role="status">{{ scutStatus.storageError }}</p>
      <ul class="notice-list" aria-label="SCUT 通知列表">
        <li v-for="item in shown" :key="item.id" :class="{ unread: noticeUnread(item) }">
          <div class="notice-main"><a :href="item.url" target="_blank" rel="noopener noreferrer" @click="markRead([item.id])"><span v-if="noticeUnread(item)" class="unread-dot" aria-label="未读"></span>{{ item.title }}<span class="jump" aria-hidden="true">↗</span></a><p>{{ labels(item.columns) }}</p></div>
          <div class="notice-meta"><time :datetime="item.published_at ?? undefined">{{ item.published_at ?? '日期未知' }}</time><button @click="markRead([item.id], noticeUnread(item))">{{ noticeUnread(item) ? '标记已读' : '恢复未读' }}</button></div>
        </li>
      </ul>
      <p v-if="!shown.length" class="empty" role="status">{{ scutStatus.loading ? '正在加载通知索引…' : !scut?.items.length ? '还没有可用的通知索引，请查看下方采集状态。' : full ? '没有符合筛选条件的通知。' : '当前没有未读通知，全部通知仍可在完整列表查看。' }}</p>
      <nav v-if="full && pages > 1" class="pagination" aria-label="通知分页"><button :disabled="page <= 1" @click="page--">上一页</button><span>{{ page }} / {{ pages }}</span><button :disabled="page >= pages" @click="page++">下一页</button></nav>
      <details class="sync-status" :open="full ? true : undefined">
        <summary>采集状态 · {{ scut?.sync_enabled === false ? '自动采集已停用' : '每 10 分钟检查' }}<span v-if="scut"> · {{ initialized }}/{{ scut.columns.length }} 栏目初始化完成<span v-if="failures"> · {{ failures }} 个栏目更新失败</span></span></summary>
        <p>初次索引近一年，历史分页在后台分批补齐；之后保留采集记录。更新时间均为北京时间。{{ failures ? '更新失败的栏目继续显示旧索引，请前往官网核对。' : '此处展示已采集范围与检查时间。' }}</p>
        <ul><li v-for="c in scut?.columns" :key="c.id"><a :href="c.url" target="_blank" rel="noopener noreferrer">{{ labels([c.id]) }} ↗</a><span>{{ time(c.last_success) }}</span><span v-if="!c.initialized">初始化 {{ c.pages_scanned }} / {{ c.total_pages ?? '?' }} 页</span><span v-else-if="c.scan_started">历史复查 {{ c.pages_scanned }} / {{ c.total_pages ?? '?' }} 页</span><span v-if="c.last_error" class="sync-error">{{ c.last_error }}</span></li></ul>
      </details>
    </div>
  </section>
</template>

<style scoped>
.full { padding-top:0; min-height:90vh; }
.scut-heading,.scut-intro,.list-toolbar,.pagination { display:flex; align-items:center; justify-content:space-between; gap:20px; }
.scut-heading .label { margin-bottom:12px; }
.scut-heading .section-title { margin:0; }
.scut-heading h1 { font-size:clamp(2rem,4vw,3rem); }
.section-title span { color:var(--accent); }
.all-link { color:var(--accent); font-size:14px; white-space:nowrap; }
.scut-intro { margin:24px 0; color:var(--text-2); font-size:14px; }
.scut-intro p:first-child span { display:block; color:var(--muted); margin-top:4px; }
.unread-count { white-space:nowrap; color:var(--muted); }
.unread-count strong { font-size:32px; color:var(--text); font-weight:500; margin-right:6px; }
.school-links { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-bottom:28px; }
.school-links a { position:relative; overflow:hidden; border:1px solid var(--line); border-radius:var(--radius-sm); padding:24px; background:var(--surface); transition:border-color .3s,transform .4s var(--ease),box-shadow .4s; }
.school-links a::before { content:''; position:absolute; inset:0; background-image:linear-gradient(var(--grid-line) 1px,transparent 1px),linear-gradient(90deg,var(--grid-line) 1px,transparent 1px); background-size:28px 28px; mask-image:radial-gradient(180px circle at var(--mx,50%) var(--my,50%),#000,transparent); opacity:0; pointer-events:none; transition:opacity .4s; }
.school-links a:hover { border-color:var(--line-strong); transform:translateY(-3px); box-shadow:0 12px 24px -18px #0003; }
.school-links a:hover::before { opacity:1; }
.school-links span { color:var(--accent); font-family:var(--font-mono); font-size:12px; margin-right:10px; }
.school-links small { display:block; color:var(--muted); margin:8px 0 0 26px; }
.filters { display:grid; grid-template-columns:1fr 1.6fr 1.6fr 1fr; gap:12px; margin-bottom:20px; }
.filters label { min-width:0; font-size:12px; color:var(--muted); }
.search label { display:block; }
.search-control { position:relative; }
.filters .search input { padding-right:38px; min-height:48px; }
.search input::-webkit-search-cancel-button { appearance:none; }
.search-clear { position:absolute; right:8px; top:5px; width:32px; height:36px; color:var(--muted); font-size:22px; border-radius:8px; }
.search-clear:hover { background:var(--accent-soft); color:var(--accent); }
.filters input { display:block; width:100%; margin-top:8px; border:1px solid var(--line); border-radius:var(--radius-sm); color:var(--text); background:var(--surface); padding:13px 16px; font:14px var(--font); transition:border-color .3s,box-shadow .3s; }
.filters input:focus { border-color:var(--field-focus-border); box-shadow:var(--field-focus-shadow); outline:0; }
.filters { position:relative; z-index:2; }
.list-toolbar { justify-content:flex-start; flex-wrap:wrap; gap:16px; font-size:13px; color:var(--muted); padding-bottom:14px; border-bottom:1px solid var(--line-strong); }
.checkbox { display:flex; align-items:center; gap:6px; color:var(--text-2); }
.checkbox input { appearance:none; width:17px; height:17px; border:1px solid var(--line-strong); border-radius:5px; margin:0; cursor:pointer; transition:background .25s,border-color .25s; }
.checkbox input:checked { background:var(--accent); border-color:var(--accent); }
.checkbox input:checked::after { content:''; display:block; width:5px; height:9px; border:solid white; border-width:0 2px 2px 0; transform:translate(5px,1px) rotate(45deg); }
button { border:0; background:none; color:var(--accent); font:inherit; cursor:pointer; padding:4px 0; }
button:disabled { opacity:.45; cursor:default; }
.refresh { margin-left:auto; }
.notice-list { list-style:none; padding:0; margin:0; }
.notice-list li { display:flex; gap:24px; justify-content:space-between; padding:24px 0; border-bottom:1px solid var(--line); transition:opacity .3s,background .3s; }
@media(hover:hover) { .notice-list:hover li { opacity:.5; } .notice-list li:hover { opacity:1; } .notice-list li:hover .jump { color:var(--accent); transform:translate(3px,-3px); } }
.notice-main { min-width:0; }
.notice-main a { font-size:15px; line-height:1.8; overflow-wrap:anywhere; }
.notice-main a:hover { color:var(--accent); }
.notice-main p { margin-top:6px; font-size:12px; color:var(--muted); }
.unread .notice-main a { font-weight:600; }
.unread-dot { display:inline-block; width:6px; height:6px; background:var(--accent); border-radius:50%; margin:0 8px 2px 0; }
.jump { display:inline-block; margin-left:8px; color:var(--faint); font-size:13px; transition:transform .4s var(--ease),color .3s; }
.notice-meta { display:flex; flex-direction:column; align-items:flex-end; flex-shrink:0; font-size:12px; gap:6px; }
.notice-meta time { color:var(--muted); font-family:var(--font-mono); font-size:12px; }
.notice-meta button { color:var(--muted); }
.notice-meta button:hover { color:var(--accent); }
.empty { padding:40px 0; color:var(--muted); font-size:14px; }
.notice-message { padding:12px; background:var(--accent-soft); margin-top:12px; font-size:13px; }
.pagination { justify-content:center; margin-top:24px; font-size:14px; }
.sync-status { margin-top:28px; color:var(--muted); font-size:12px; }
.sync-status summary { cursor:pointer; padding:8px 0; }
.sync-status p { margin:8px 0 16px; }
.sync-status ul { list-style:none; margin:0; padding:0; }
.sync-status li { display:flex; flex-wrap:wrap; gap:8px 20px; border-top:1px solid var(--line); padding:10px 0; }
.sync-status li a { color:var(--text-2); min-width:240px; }
.sync-error { color:var(--text); }
@media(max-width:760px) { .filters { grid-template-columns:1fr 1fr; } .school-links { gap:8px; } .school-links a { padding:14px 12px; font-size:13px; } .school-links span { display:none; } .school-links small { margin-left:0; font-size:11px; } }
@media(max-width:480px) { .scut-heading { gap:12px; } .scut-heading .section-title { font-size:24px; } .scut-heading .all-link { font-size:12px; } .school-links { grid-template-columns:1fr; } .school-links a { display:flex; justify-content:space-between; align-items:center; } .school-links small { margin:0; } .notice-list li { flex-direction:column; gap:10px; } .notice-meta { flex-direction:row; justify-content:space-between; } .scut-intro { gap:12px; } .scut-intro p:first-child span { font-size:12px; } .sync-status li a { min-width:100%; } .full { padding-top:0; } }
</style>
