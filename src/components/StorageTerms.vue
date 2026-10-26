<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { formatTime, termsApi } from '../drive'
import type { StorageTermsDocument } from '../drive'

// view：已同意后只读查看；否则显示同意表单，同意后通知父组件刷新账户功能。
const props = defineProps<{ view?: boolean }>()
const emit = defineEmits<{ agreed: [] }>()
const terms = ref<StorageTermsDocument>()
const checked = ref(false)
const busy = ref(false)
const error = ref('')

onMounted(async () => {
  try { terms.value = await termsApi.get() }
  catch (err) { error.value = err instanceof Error ? err.message : '协议读取失败' }
})

async function accept() {
  if (!terms.value || !checked.value) return
  busy.value = true
  error.value = ''
  try {
    await termsApi.accept(terms.value.version)
    emit('agreed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : '提交失败，请重试'
  } finally { busy.value = false }
}
</script>

<template>
  <section class="terms" :class="{ view: props.view }" :aria-label="terms?.title ?? '使用协议'">
    <header v-if="!props.view">
      <p class="eyebrow">开始使用前</p>
      <h2>{{ terms?.title ?? '云盘与图床使用协议' }}</h2>
      <p class="lead">管理员已为你开通云盘或图床。请先阅读并同意以下协议，同意后即可开始使用。</p>
    </header>
    <div v-if="!props.view" class="notice" role="note">
      <strong>请勿上传违法违规内容。</strong>
      发现或接到举报违法违规内容时，管理员有权不经通知删除相关文件、图片与分享链接，关闭你的云盘或图床功能，直至封禁账户。
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template v-if="terms">
      <div class="body" tabindex="0">
        <p class="meta">版本 {{ terms.version }}<template v-if="terms.accepted_at"> · 你已于 {{ formatTime(Date.parse(terms.accepted_at) / 1000) }} 同意</template></p>
        <section v-for="section in terms.sections" :key="section.heading">
          <h3>{{ section.heading }}</h3>
          <p v-for="(text, index) in section.paragraphs" :key="index">{{ text }}</p>
        </section>
      </div>
      <div v-if="!props.view" class="accept">
        <label class="check"><input v-model="checked" type="checkbox"><span>我已阅读并同意《{{ terms.title }}》，承诺不上传、不分享违法违规内容</span></label>
        <button class="primary" type="button" :disabled="!checked || busy" @click="accept">{{ busy ? '正在提交…' : '同意并开始使用' }}</button>
      </div>
    </template>
    <p v-else-if="!error" class="muted">正在读取协议…</p>
  </section>
</template>

<style scoped>
.terms { max-width:760px; margin:0 auto; padding:32px clamp(20px,4vw,40px) 28px; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); box-shadow:0 30px 60px -44px rgba(17,24,39,.35); }
.terms.view { max-width:none; margin:0; padding:0; border:0; box-shadow:none; background:none; }
.eyebrow { margin:0; font-size:11px; color:var(--faint); letter-spacing:.14em; text-transform:uppercase; }
h2 { margin:8px 0 0; font-size:26px; letter-spacing:-.02em; }
.lead { margin:10px 0 0; color:var(--muted); font-size:14px; line-height:1.7; }
.notice { margin-top:20px; padding:12px 16px; border-left:3px solid #d15c5c; border-radius:10px; background:rgba(209,92,92,.07); color:var(--text-2); font-size:13px; line-height:1.75; }
.notice strong { color:#d15c5c; font-weight:600; }
.body { max-height:min(52vh,520px); margin-top:20px; padding:4px 18px 18px 0; overflow:auto; overscroll-behavior:contain; }
.view .body { max-height:none; margin-top:0; padding:0; overflow:visible; overscroll-behavior:auto; }
.body:focus-visible { outline:2px solid var(--accent); outline-offset:4px; border-radius:6px; }
.meta { margin:0 0 4px; color:var(--faint); font-size:12px; }
h3 { margin:20px 0 6px; font-size:15px; letter-spacing:-.01em; }
.body p:not(.meta) { margin:6px 0 0; color:var(--text-2); font-size:13.5px; line-height:1.8; }
.accept { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:14px 20px; margin-top:20px; padding-top:20px; border-top:1px solid var(--line); }
.check { display:flex; align-items:flex-start; gap:9px; flex:1 1 320px; color:var(--text-2); font-size:13px; line-height:1.6; cursor:pointer; }
.check input { margin-top:3px; }
.primary { padding:10px 20px; border:1px solid var(--btn-bg); border-radius:10px; background:var(--btn-bg); color:var(--btn-fg); font:500 14px var(--font); cursor:pointer; transition:opacity .2s,box-shadow .2s; }
.primary:hover:not(:disabled) { box-shadow:0 8px 20px -10px color-mix(in srgb,var(--btn-bg) 70%,transparent); }
.primary:disabled { opacity:.45; cursor:default; }
.error { margin-top:14px; padding:10px 14px; border-radius:10px; background:rgba(209,92,92,.08); color:#d15c5c; font-size:13px; }
.muted { margin-top:16px; color:var(--muted); font-size:13px; }
@media (max-width:520px) { .primary { width:100%; } }
</style>
