<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { docsApi } from '../../docs'
import MenuSelect from '../MenuSelect.vue'

// 图片去处设置：不传 docId 时是用户的默认设置，传入时是所有者为这篇文档指定的去处。
const props = defineProps<{ docId?: string }>()
const emit = defineEmits<{ close: []; saved: [target: string] }>()

type Target = 'inherit' | 'builtin' | 'site' | 'custom'
interface Custom { name: string; url: string; field: string; headers: Record<string, string>; form: Record<string, string>; url_path: string }

const open = ref(true)
const target = ref<Target>('builtin')
const siteAvailable = ref(true)
const custom = ref<Custom>({ name: '', url: '', field: 'file', headers: {}, form: {}, url_path: 'data.url' })
const headersText = ref(''), formText = ref('')
const preset = ref('')
const busy = ref(false), error = ref(''), notice = ref(''), testUrl = ref('')
const endpoint = computed(() => props.docId ? `/${props.docId}/image-settings` : '-settings/images')

// 常见图床的填写方式；令牌等需要用户自己填入。
const PRESETS: Record<string, Partial<Custom> & { headersText?: string; formText?: string; hint: string }> = {
  smms: { name: 'SM.MS', url: 'https://sm.ms/api/v2/upload', field: 'smfile', url_path: 'data.url', headersText: 'Authorization: 你的 API Token', hint: '在 sm.ms 的 Dashboard → API Token 获取令牌。' },
  lsky: { name: '兰空图床', url: 'https://你的域名/api/v1/upload', field: 'file', url_path: 'data.links.url', headersText: 'Authorization: Bearer 你的令牌\nAccept: application/json', hint: '兰空图床 2.x：在“接口”页面生成令牌。' },
  chevereto: { name: 'Chevereto', url: 'https://你的域名/api/1/upload', field: 'source', url_path: 'image.url', formText: 'key=你的 API Key', hint: '在 Chevereto 后台的 API 设置中获取 Key。' },
  imgbb: { name: 'ImgBB', url: 'https://api.imgbb.com/1/upload', field: 'image', url_path: 'data.url', formText: 'key=你的 API Key', hint: '在 api.imgbb.com 获取 API Key。' },
  easyimage: { name: 'EasyImage', url: 'https://你的域名/api/index.php', field: 'image', url_path: 'url', formText: 'token=你的 Token', hint: '在 EasyImage 后台的 API 设置中获取 Token。' },
}
const presetOptions = [{ value: '', label: '手动填写' }, ...Object.entries(PRESETS).map(([value, item]) => ({ value, label: item.name ?? value }))]
const presetHint = computed(() => PRESETS[preset.value]?.hint ?? '')

const choices = computed(() => [
  ...(props.docId ? [{ value: 'inherit' as const, title: '跟随上传者', text: '每位编辑者的图片按他自己的默认设置存放。' }] : []),
  { value: 'builtin' as const, title: '文档内置存储', text: '存在文档里，随文档一起删除。单张 10 MiB，每篇文档 200 MiB。' },
  { value: 'site' as const, title: '本站图床', text: props.docId ? '存入你的图床，计入你的配额；其他编辑者上传的图片也计入你的配额。' : '存入你在本站的图床，计入图床配额，可在账户页统一管理。' },
  { value: 'custom' as const, title: '第三方图床', text: props.docId ? '使用你配置的图床，其他编辑者上传时也用你的配置，但看不到令牌。' : '上传到其他站点的图床，由服务器代为上传，令牌不会暴露给协作者。' },
])

const toLines = (data: Record<string, string>, sep: string) => Object.entries(data).map(([key, value]) => `${key}${sep}${value}`).join('\n')
function fromLines(text: string, sep: string) {
  const data: Record<string, string> = {}
  for (const line of text.split('\n').map(item => item.trim()).filter(Boolean)) {
    const index = line.indexOf(sep)
    if (index <= 0) throw new Error(`“${line}”缺少 ${sep.trim()}`)
    data[line.slice(0, index).trim()] = line.slice(index + sep.length).trim()
  }
  return data
}

function applyPreset(value: string) {
  preset.value = value
  const item = PRESETS[value]
  if (!item) return
  Object.assign(custom.value, { name: item.name, url: item.url, field: item.field, url_path: item.url_path })
  headersText.value = item.headersText ?? ''
  formText.value = item.formText ?? ''
}

function body() {
  if (target.value !== 'custom') return { target: target.value }
  return { target: target.value, custom: { ...custom.value, headers: fromLines(headersText.value, ':'), form: fromLines(formText.value, '=') } }
}

async function work<T>(task: () => Promise<T>) {
  busy.value = true; error.value = ''; notice.value = ''
  try { return await task() }
  catch (err) { error.value = err instanceof Error ? err.message : '操作失败' }
  finally { busy.value = false }
}

async function load() {
  const data = await work(() => docsApi<{ target: Target; custom: Custom | null; site_available?: boolean }>(endpoint.value))
  if (!data) return
  target.value = data.target
  if (data.site_available !== undefined) siteAvailable.value = data.site_available
  if (data.custom) {
    custom.value = { ...custom.value, ...data.custom }
    headersText.value = toLines(data.custom.headers ?? {}, ': ')
    formText.value = toLines(data.custom.form ?? {}, '=')
  }
}

async function test() {
  testUrl.value = ''
  const result = await work(() => docsApi<{ url: string }>('-settings/images/test', 'POST', body()))
  if (result) { testUrl.value = result.url; notice.value = '上传成功，图床配置可用。' }
}

async function save() {
  const result = await work(() => docsApi<{ target: string }>(endpoint.value, 'PUT', body()))
  if (result) { emit('saved', result.target); open.value = false; emit('close') }
}

onMounted(load)
</script>

<template>
  <DialogRoot :open="open" @update:open="value => { if (!value) emit('close') }">
    <DialogPortal>
      <DialogOverlay class="confirm-overlay" />
      <DialogContent class="image-settings">
        <div class="head">
          <DialogTitle class="confirm-title">{{ docId ? '这篇文档的图片存储' : '图片存储' }}</DialogTitle>
          <DialogClose class="close" aria-label="关闭">×</DialogClose>
        </div>
        <DialogDescription class="d-muted desc">{{ docId ? '粘贴、拖入或插入的图片保存到哪里。只影响之后上传的图片。' : '你在文档里粘贴、拖入或插入的图片默认保存到哪里。所有者可以为单篇文档另行指定。' }}</DialogDescription>

        <div class="choices" role="radiogroup">
          <button v-for="choice in choices" :key="choice.value" type="button" role="radio" class="choice" :class="{ on: target === choice.value }" :aria-checked="target === choice.value" :disabled="choice.value === 'site' && !siteAvailable" @click="target = choice.value">
            <strong>{{ choice.title }}</strong>
            <span>{{ choice.value === 'site' && !siteAvailable ? '本站图床尚未为你开通，可以在账户页的“反馈”中申请。' : choice.text }}</span>
          </button>
        </div>

        <section v-if="target === 'custom'" class="custom">
          <div class="row">
            <label class="grow">常用图床<MenuSelect :model-value="preset" :options="presetOptions" label="常用图床" @update:model-value="applyPreset" /></label>
            <label class="grow">名称<input v-model="custom.name" class="d-input" maxlength="40" placeholder="便于自己辨认"></label>
          </div>
          <p v-if="presetHint" class="d-muted hint">{{ presetHint }}</p>
          <label>上传地址<input v-model="custom.url" class="d-input" placeholder="https://example.com/api/upload" spellcheck="false"></label>
          <div class="row">
            <label class="grow">文件字段名<input v-model="custom.field" class="d-input mono" placeholder="file" spellcheck="false"></label>
            <label class="grow">返回的图片地址路径<input v-model="custom.url_path" class="d-input mono" placeholder="data.url" spellcheck="false"></label>
          </div>
          <label>请求头<span class="d-muted">每行一个，如 Authorization: Bearer 令牌</span><textarea v-model="headersText" class="d-input mono" rows="2" spellcheck="false" /></label>
          <label>额外表单字段<span class="d-muted">每行一个，如 key=值</span><textarea v-model="formText" class="d-input mono" rows="2" spellcheck="false" /></label>
          <p class="d-muted hint">已保存的令牌只显示末尾几位；不修改就会沿用原值。上传由服务器代为发送，不能指向内网地址。</p>
          <div class="test">
            <button class="d-btn" type="button" :disabled="busy || !custom.url" @click="test">测试上传</button>
            <a v-if="testUrl" :href="testUrl" target="_blank" rel="noopener" class="mono">{{ testUrl }}</a>
          </div>
        </section>

        <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
        <p v-else-if="notice" class="d-note ok" role="status">{{ notice }}</p>
        <div class="actions">
          <DialogClose class="d-btn">取消</DialogClose>
          <button class="d-btn primary" type="button" :disabled="busy" @click="save">保存</button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style>
.image-settings { position:fixed; z-index:81; left:50%; top:50%; transform:translate(-50%,-50%); width:min(600px,calc(100vw - 32px)); max-height:calc(100vh - 48px); overflow:auto; padding:24px 26px; border:1px solid var(--line); border-radius:var(--radius); background:var(--bg); color:var(--text); font-family:var(--font); box-shadow:0 30px 60px -20px rgba(0,0,0,.35); outline:none; }
.image-settings[data-state=open] { animation:confirm-rise .28s var(--ease); }
.image-settings .head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.image-settings .close { border:0; background:none; color:var(--muted); font-size:24px; line-height:1; cursor:pointer; }
.image-settings .desc { margin:6px 0 16px; font-size:13px; line-height:1.7; }
.image-settings .choices { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
.image-settings .choice { display:flex; flex-direction:column; gap:4px; padding:12px 14px; border:1px solid var(--line); border-radius:12px; background:var(--surface); color:var(--text); font:inherit; text-align:left; cursor:pointer; transition:border-color .2s,box-shadow .2s,background .2s; }
.image-settings .choice strong { font-size:14px; font-weight:600; }
.image-settings .choice span { color:var(--muted); font-size:12.5px; line-height:1.6; }
.image-settings .choice:hover:not(:disabled) { border-color:var(--line-strong); }
.image-settings .choice.on { border-color:var(--accent); background:var(--accent-soft); box-shadow:inset 0 0 0 1px var(--accent); }
.image-settings .choice:disabled { opacity:.55; cursor:default; }
.image-settings .custom { display:grid; gap:12px; margin-top:18px; padding-top:16px; border-top:1px solid var(--line); }
.image-settings label { display:grid; gap:6px; color:var(--text-2); font-size:13px; }
.image-settings label > .d-muted { font-size:12px; }
.image-settings .row { display:flex; gap:10px; }
.image-settings .grow { flex:1; min-width:0; }
.image-settings .menu-select { width:100%; }
.image-settings .mono { font-family:var(--font-mono); font-size:13px; }
.image-settings textarea { resize:vertical; }
.image-settings .hint { margin:0; font-size:12px; line-height:1.6; }
.image-settings .test { display:flex; align-items:center; gap:12px; min-width:0; }
.image-settings .test a { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--accent); font-size:12px; }
.image-settings .d-note { margin-top:14px; }
.image-settings .actions { display:flex; justify-content:flex-end; gap:10px; margin-top:20px; }
@media (max-width:760px) {
  .image-settings { top:auto; bottom:0; left:0; width:100%; max-height:92vh; transform:none; padding:18px 18px calc(20px + env(safe-area-inset-bottom)); border-radius:22px 22px 0 0; }
  .image-settings[data-state=open] { animation:confirm-sheet .32s var(--ease); }
  .image-settings .choices { grid-template-columns:1fr; }
  .image-settings .row { flex-direction:column; }
}
</style>
