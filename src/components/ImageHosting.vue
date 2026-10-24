<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { accountApi } from '../account'
import type { HostedImage, ImageLimits, ImageToken } from '../account'

const emit = defineEmits<{ enabled: [value: boolean] }>()
const limits = ref<ImageLimits>(), tokens = ref<ImageToken[]>([]), items = ref<HostedImage[]>([])
const total = ref(0), page = ref(1), pageSize = ref(40)
const busy = ref(false), error = ref(''), message = ref(''), dragging = ref(false)
const tokenName = ref('Typora'), freshToken = ref('')
const uploadUrl = ref('')

const percent = computed(() => limits.value?.quota ? Math.min(100, (limits.value.used / limits.value.quota) * 100) : 0)
const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`

async function run(work: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''; message.value = ''
  try { await work() } catch (err) { error.value = err instanceof Error ? err.message : '操作失败' }
  finally { busy.value = false }
}
async function load(target = page.value) {
  const data = await accountApi<{ limits: ImageLimits; tokens?: ImageToken[]; items?: HostedImage[]; total?: number; page?: number; page_size?: number; upload_url?: string }>(`/images?page=${target}`)
  uploadUrl.value = data.upload_url ?? ''
  limits.value = data.limits; tokens.value = data.tokens ?? []; items.value = data.items ?? []
  total.value = data.total ?? 0; page.value = data.page ?? 1; pageSize.value = data.page_size ?? 40
  emit('enabled', data.limits.enabled)
}
async function send(files: File[]) {
  const images = files.filter(file => file.type.startsWith('image/'))
  if (!images.length) return
  await run(async () => {
    let added = 0
    for (const file of images) {
      if (limits.value && file.size > limits.value.max_file) throw new Error(`${file.name} 超过单张 ${size(limits.value.max_file)} 的限制`)
      const result = await accountApi<HostedImage & { created: boolean }>('/images', 'POST', undefined, file)
      added += Number(result.created)
      if (images.length === 1) await copy(markdown(result), false)
    }
    await load(1)
    message.value = images.length === 1 ? (added ? '上传成功，Markdown 链接已复制。' : '这张图片已经上传过，已复制原有链接。') : `已上传 ${added} 张图片。`
  })
}
function pick(event: Event) {
  const input = event.target as HTMLInputElement
  void send([...(input.files ?? [])]); input.value = ''
}
function drop(event: DragEvent) { dragging.value = false; void send([...(event.dataTransfer?.files ?? [])]) }
function paste(event: ClipboardEvent) {
  const files = [...(event.clipboardData?.files ?? [])]
  if (files.length) { event.preventDefault(); void send(files) }
}
const markdown = (item: HostedImage) => `![](${item.url})`
async function copy(text: string, notify = true) {
  try { await navigator.clipboard.writeText(text); if (notify) message.value = '已复制到剪贴板。' }
  catch { if (notify) error.value = '复制失败，请手动选择文本复制' }
}
const remove = (item: HostedImage) => run(async () => {
  if (!confirm('删除后这张图片的链接将失效，引用它的文章会显示破图。确定删除吗？')) return
  await accountApi(`/images/${item.id}/remove`, 'POST')
  await load(items.value.length === 1 && page.value > 1 ? page.value - 1 : page.value)
  message.value = '图片已删除。'
})
const createToken = () => run(async () => {
  const result = await accountApi<ImageToken & { token: string }>('/images/tokens', 'POST', { name: tokenName.value })
  freshToken.value = result.token
  await load()
  message.value = '令牌已创建，请立即复制，它只会显示这一次。'
})
const revokeToken = (token: ImageToken) => run(async () => {
  if (!confirm(`撤销「${token.name}」后，使用它的客户端将无法继续上传。确定吗？`)) return
  await accountApi(`/images/tokens/${token.id}/remove`, 'POST')
  await load(); message.value = '令牌已撤销。'
})
const turn = (target: number) => run(() => load(target))

onMounted(() => { void load().catch(err => { error.value = err instanceof Error ? err.message : '图床加载失败' }) })
</script>

<template>
  <div class="hosting" @paste="paste">
    <p v-if="error" class="feedback error" role="alert">{{ error }}</p>
    <p v-if="message" class="feedback ok" role="status">{{ message }}</p>
    <template v-if="limits?.enabled">
      <section class="usage" aria-label="空间用量">
        <div class="usage-head"><strong>{{ size(limits.used) }}</strong><span>/ {{ limits.quota ? size(limits.quota) : '不限' }} · 单张不超过 {{ size(limits.max_file) }}</span></div>
        <div class="bar" role="progressbar" :aria-valuenow="Math.round(percent)" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${percent}%` }" :class="{ warn: percent > 90 }" /></div>
      </section>

      <label class="dropzone" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="drop">
        <input type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif" :disabled="busy" @change="pick">
        <strong>{{ busy ? '正在上传…' : '点击、拖入或粘贴图片' }}</strong>
        <span>支持 JPEG、PNG、WebP、GIF；单张上传后自动复制 Markdown 链接</span>
      </label>

      <ul v-if="items.length" class="grid">
        <li v-for="item in items" :key="item.id">
          <a :href="item.url" target="_blank" rel="noopener" class="thumb"><img :src="item.url" :alt="`图片 ${item.id}`" loading="lazy"></a>
          <div class="meta"><span>{{ item.width }}×{{ item.height }} · {{ size(item.size) }}</span><time>{{ item.created_at.slice(0, 10) }}</time></div>
          <div class="actions">
            <button type="button" @click="copy(markdown(item))">Markdown</button>
            <button type="button" @click="copy(item.url)">URL</button>
            <button type="button" class="del" :aria-label="`删除图片 ${item.id}`" @click="remove(item)">删除</button>
          </div>
        </li>
      </ul>
      <p v-else class="empty">还没有图片。上传第一张，或在 PicList 中配置下方的令牌。</p>
      <nav v-if="pages > 1" class="pager" aria-label="分页">
        <button type="button" :disabled="busy || page <= 1" @click="turn(page - 1)">上一页</button>
        <span>{{ page }} / {{ pages }}</span>
        <button type="button" :disabled="busy || page >= pages" @click="turn(page + 1)">下一页</button>
      </nav>

      <section class="card">
        <h3>上传令牌</h3>
        <p>在 PicList、Typora 等客户端里使用。每台设备单独创建一个，丢失时只撤销那一个。</p>
        <form class="token-form" @submit.prevent="createToken">
          <input v-model="tokenName" maxlength="40" aria-label="令牌名称" placeholder="例如：笔记本 Typora">
          <button class="ghost" type="submit" :disabled="busy">创建令牌</button>
        </form>
        <div v-if="freshToken" class="fresh">
          <code>{{ freshToken }}</code>
          <button class="ghost" type="button" @click="copy(freshToken)">复制</button>
          <button class="ghost" type="button" @click="freshToken = ''">我已保存</button>
        </div>
        <ul class="tokens">
          <li v-for="token in tokens" :key="token.id">
            <div><strong>{{ token.name }}</strong><span>创建于 {{ token.created_at.slice(0, 10) }} · {{ token.last_used ? `最近使用 ${token.last_used.slice(0, 10)}` : '尚未使用' }}</span></div>
            <button type="button" class="del" @click="revokeToken(token)">撤销</button>
          </li>
        </ul>
        <details>
          <summary>PicList 配置方法</summary>
          <p>图床选择“自定义 Web 图床”（advancedplist），填写：</p>
          <dl>
            <dt>API 地址</dt><dd><code>{{ uploadUrl }}</code></dd>
            <dt>请求方法</dt><dd><code>POST</code></dd>
            <dt>文件字段名</dt><dd><code>file</code></dd>
            <dt>请求头</dt><dd><code>{"Authorization": "Bearer 你的令牌"}</code></dd>
            <dt>返回 URL 路径</dt><dd><code>url</code></dd>
          </dl>
          <p>Typora：偏好设置 → 图像 → 上传服务选 PicList，再点击“验证图片上传选项”。</p>
        </details>
      </section>

      <section class="card">
        <h3>导出备份</h3>
        <p>下载全部图片的 zip，目录结构与图片地址一致，附带 manifest.json，可直接放进你的 GitHub 仓库。15 分钟内可导出一次。</p>
        <a class="ghost export" href="/api/account/images/export" download>导出全部图片</a>
      </section>
    </template>
    <p v-else-if="limits" class="empty">图床仅对受邀用户开放。如需使用，请联系站长开通。</p>
  </div>
</template>

<style scoped>
.hosting { margin-top:20px; display:grid; gap:20px; }
.feedback { margin:0; padding:12px 16px; border-radius:var(--radius-sm); font-size:14px; }
.feedback.error { color:#d15c5c; background:rgba(209,92,92,.08); }
.feedback.ok { color:var(--accent); background:var(--accent-soft); }
button { font:inherit; cursor:pointer; }
button:disabled { opacity:.5; cursor:default; }
.ghost { display:inline-block; padding:10px 16px; border:1px solid var(--line-strong); border-radius:10px; background:var(--surface); color:var(--text); font-size:13px; white-space:nowrap; transition:border-color .25s,color .25s; }
.ghost:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
.usage-head { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; }
.usage-head strong { font-size:22px; }
.usage-head span { color:var(--muted); font-size:13px; }
.bar { height:6px; margin-top:10px; border-radius:99px; background:var(--bg-tint); overflow:hidden; }
.bar i { display:block; height:100%; border-radius:inherit; background:var(--accent); transition:width .4s var(--ease); }
.bar i.warn { background:#d15c5c; }
.dropzone { position:relative; display:flex; flex-direction:column; align-items:center; gap:6px; padding:32px 16px; border:1.5px dashed var(--line-strong); border-radius:var(--radius-sm); background:var(--surface); text-align:center; cursor:pointer; transition:border-color .25s,background .25s; }
.dropzone:hover,.dropzone.dragging { border-color:var(--accent); background:var(--accent-soft); }
.dropzone input { position:absolute; inset:0; opacity:0; cursor:pointer; }
.dropzone span { color:var(--muted); font-size:13px; }
.grid { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:14px; }
.grid li { border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); overflow:hidden; }
.thumb { display:block; aspect-ratio:4/3; background:var(--bg-tint); }
.thumb img { width:100%; height:100%; object-fit:contain; }
.meta { display:flex; justify-content:space-between; gap:8px; padding:8px 10px 0; color:var(--muted); font:12px var(--font-mono); }
.actions { display:flex; gap:4px; padding:8px; }
.actions button { flex:1; padding:6px 4px; border:1px solid var(--line); border-radius:8px; background:none; color:var(--text-2); font-size:12px; transition:border-color .2s,color .2s; }
.actions button:hover { border-color:var(--accent); color:var(--accent); }
.del:hover { border-color:rgba(209,92,92,.5) !important; color:#d15c5c !important; }
.empty { margin:0; padding:24px 0; color:var(--muted); }
.pager { display:flex; justify-content:center; align-items:center; gap:14px; color:var(--muted); font-size:13px; }
.pager button { padding:6px 12px; border:1px solid var(--line); border-radius:8px; background:var(--surface); color:var(--text); }
.card { padding:24px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); }
.card h3 { font-size:16px; }
.card p { margin-top:6px; color:var(--muted); font-size:13px; line-height:1.7; }
.token-form { display:flex; gap:10px; margin-top:16px; }
.token-form input { flex:1; min-width:0; min-height:42px; padding:9px 12px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); color:var(--text); font:14px var(--font); }
.token-form input:focus { outline:0; border-color:var(--accent); box-shadow:0 0 0 4px var(--accent-soft); }
.fresh { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:12px; padding:12px; border-radius:var(--radius-sm); background:var(--accent-soft); }
.fresh code { flex:1 1 240px; overflow-wrap:anywhere; font:13px var(--font-mono); color:var(--text); }
.tokens { list-style:none; margin:12px 0 0; padding:0; }
.tokens li { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px 0; border-bottom:1px solid var(--line); }
.tokens span { display:block; margin-top:2px; color:var(--muted); font-size:12px; }
.tokens button { padding:6px 12px; border:1px solid var(--line); border-radius:8px; background:none; color:var(--text-2); font-size:12px; }
details { margin-top:16px; font-size:13px; }
summary { cursor:pointer; color:var(--accent); }
dl { display:grid; grid-template-columns:auto 1fr; gap:6px 14px; margin:10px 0 0; }
dt { color:var(--muted); }
dd { margin:0; overflow-wrap:anywhere; }
dd code { font:12px var(--font-mono); }
.export { margin-top:16px; text-decoration:none; }
@media (max-width: 520px) { .grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .token-form { flex-direction:column; } .card { padding:18px; } }
</style>
