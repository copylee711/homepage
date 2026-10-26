<script setup lang="ts">
import { formatTime } from '../drive'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { accountApi, csrfToken } from '../account'
import type { FeedbackItem } from '../account'
import { cancelEmailCaptcha, postWithCaptcha, refreshEmailCaptcha, verifyEmailCaptcha } from '../email-captcha'
import type { EmailCaptchaConfig } from '../email-captcha'

const props = defineProps<{ captcha?: EmailCaptchaConfig }>()
const categories = [['suggestion', '建议'], ['bug', '问题'], ['other', '其他']] as const
const statusLabel: Record<FeedbackItem['status'], string> = { new: '已提交', read: '已读', done: '已处理' }
const category = ref<FeedbackItem['category']>('suggestion')
const content = ref('')
const items = ref<FeedbackItem[]>([])
const busy = ref(false), error = ref(''), message = ref('')
const lifetime = new AbortController()

const time = (value: number) => formatTime(value)

async function load() {
  items.value = (await accountApi<{ items: FeedbackItem[] }>('/feedback')).items
}

async function submit() {
  if (busy.value) return
  busy.value = true; error.value = ''; message.value = ''
  try {
    if (content.value.trim().length < 5) throw new Error('内容太短了，请多写几个字')
    const token = props.captcha ? await verifyEmailCaptcha(props.captcha, lifetime.signal) : ''
    const item = await postWithCaptcha<FeedbackItem>('/api/account/feedback',
      { category: category.value, content: content.value, page: document.referrer.slice(0, 300) }, token, csrfToken())
    items.value = [item, ...items.value]
    content.value = ''
    message.value = '已收到，谢谢你的反馈！站长回复后会显示在下方。'
  } catch (err) {
    error.value = err instanceof Error ? err.message : '提交失败'
  } finally {
    busy.value = false
    refreshEmailCaptcha()
  }
}

onMounted(() => { load().catch(() => {}) })
onBeforeUnmount(() => { lifetime.abort(); cancelEmailCaptcha() })
</script>

<template>
  <div class="feedback-panel">
    <form class="compose" @submit.prevent="submit">
      <h3>给站长提建议</h3>
      <p>发现问题、想要的功能或任何想法都可以写在这里，只有站长能看到。</p>
      <fieldset :disabled="busy">
        <div class="kinds" role="radiogroup" aria-label="反馈类型">
          <button v-for="[value, label] in categories" :key="value" type="button" role="radio" :aria-checked="category === value" :class="{ active: category === value }" @click="category = value">{{ label }}</button>
        </div>
        <label>内容<textarea v-model="content" maxlength="2000" rows="6" required placeholder="请尽量具体，例如在哪个页面、做了什么、期望是什么。"></textarea></label>
        <div class="row">
          <span class="count">{{ content.length }} / 2000</span>
          <button class="send" type="submit">{{ busy ? '正在验证并提交…' : '提交反馈' }}</button>
        </div>
      </fieldset>
      <p v-if="error" class="note error" role="alert">{{ error }}</p>
      <p v-if="message" class="note ok" role="status">{{ message }}</p>
    </form>

    <section v-if="items.length" class="history" aria-label="我的反馈">
      <h3>我的反馈</h3>
      <article v-for="item in items" :key="item.id" class="item">
        <header>
          <span class="tag">{{ categories.find(([v]) => v === item.category)?.[1] }}</span>
          <time>{{ time(item.created_at) }}</time>
          <span class="status" :class="item.status">{{ statusLabel[item.status] }}</span>
        </header>
        <p class="body">{{ item.content }}</p>
        <div v-if="item.reply" class="reply">
          <strong>站长回复</strong><time v-if="item.replied_at">{{ time(item.replied_at) }}</time>
          <p>{{ item.reply }}</p>
        </div>
      </article>
    </section>
  </div>
</template>

<style scoped>
.feedback-panel { display:grid; gap:24px; margin-top:24px; max-width:640px; }
fieldset { border:0; margin:0; padding:0; min-width:0; }
.compose { padding:24px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); }
h3 { font-size:16px; }
.compose > p { margin-top:6px; color:var(--muted); font-size:13px; }
.kinds { display:inline-flex; gap:4px; margin-top:18px; padding:4px; border-radius:10px; background:var(--bg-tint); }
.kinds button { padding:7px 14px; border:0; border-radius:8px; background:none; color:var(--muted); font:inherit; font-size:13px; cursor:pointer; transition:background .25s,color .25s; }
.kinds button.active { background:var(--surface); color:var(--text); box-shadow:0 2px 8px -4px rgba(17,24,39,.25); }
label { display:flex; flex-direction:column; gap:8px; margin-top:16px; font-size:13px; color:var(--text-2); }
textarea { width:100%; padding:12px 14px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); color:var(--text); font:15px/1.7 var(--font); resize:vertical; transition:border-color .3s,box-shadow .3s; }
textarea:focus { outline:0; border-color:var(--field-focus-border); box-shadow:var(--field-focus-shadow); }
.row { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:14px; }
.count { color:var(--faint); font:12px var(--font-mono); }
.send { padding:11px 22px; border:0; border-radius:10px; background:var(--btn-bg); color:var(--btn-fg); font:inherit; font-weight:500; cursor:pointer; }
.send:disabled,fieldset:disabled .send { opacity:.5; cursor:default; }
.note { margin-top:14px; padding:10px 14px; border-radius:10px; font-size:13px; }
.note.error { color:#d15c5c; background:rgba(209,92,92,.08); }
.note.ok { color:var(--accent); background:var(--accent-soft); }
.history { display:grid; gap:12px; }
.item { padding:18px 20px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); }
.item header { display:flex; align-items:center; gap:10px; font-size:12px; }
.tag { color:var(--accent); font-family:var(--font-mono); }
.item time { color:var(--faint); font-family:var(--font-mono); }
.status { margin-left:auto; padding:2px 8px; border:1px solid var(--line); border-radius:999px; color:var(--muted); }
.status.done { border-color:var(--accent); color:var(--accent); }
.body { margin-top:10px; white-space:pre-wrap; overflow-wrap:anywhere; font-size:14px; line-height:1.75; }
.reply { margin-top:14px; padding:12px 14px; border-left:2px solid var(--accent); border-radius:0 10px 10px 0; background:var(--accent-soft); font-size:13px; }
.reply strong { color:var(--accent); }
.reply time { margin-left:8px; color:var(--faint); font:12px var(--font-mono); }
.reply p { margin-top:6px; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--text-2); line-height:1.7; }
</style>
