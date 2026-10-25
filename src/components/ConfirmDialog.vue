<script setup lang="ts">
import { ref, watch } from 'vue'
import { AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogOverlay, AlertDialogPortal, AlertDialogRoot, AlertDialogTitle } from 'reka-ui'
import { confirmRequest, type ConfirmRequest } from '../composables/useConfirm'

// 全局唯一的确认框，配合 confirmDialog() 使用。关闭动画期间保留上一次的文案。
const open = ref(false)
const shown = ref<ConfirmRequest>()
watch(confirmRequest, request => { if (request) { shown.value = request; open.value = true } })

function decide(ok: boolean) {
  const request = confirmRequest.value
  if (!request) return
  confirmRequest.value = undefined
  open.value = false
  request.resolve(ok)
}
// 在捕获阶段截下 Esc，避免同时关掉下面的云盘对话框等其他监听 Esc 的界面。
function onKey(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.stopPropagation(); event.preventDefault()
  decide(false)
}
watch(open, value => value ? addEventListener('keydown', onKey, true) : removeEventListener('keydown', onKey, true))
</script>

<template>
  <AlertDialogRoot :open="open" @update:open="value => { if (!value) decide(false) }">
    <AlertDialogPortal>
      <AlertDialogOverlay class="confirm-overlay" />
      <AlertDialogContent class="confirm-dialog">
        <AlertDialogTitle class="confirm-title">{{ shown?.title }}</AlertDialogTitle>
        <AlertDialogDescription v-if="shown?.message" class="confirm-message">{{ shown.message }}</AlertDialogDescription>
        <div class="confirm-actions">
          <AlertDialogCancel class="confirm-btn">{{ shown?.cancelText ?? '取消' }}</AlertDialogCancel>
          <button type="button" class="confirm-btn" :class="shown?.danger ? 'danger' : 'primary'" @click="decide(true)">{{ shown?.confirmText ?? '确定' }}</button>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>

<style>
.confirm-overlay { position:fixed; inset:0; z-index:80; background:rgba(12,13,16,.45); -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px); }
.confirm-dialog { position:fixed; z-index:81; left:50%; top:50%; transform:translate(-50%,-50%); width:min(420px,calc(100vw - 40px)); max-height:calc(100vh - 40px); overflow:auto; padding:26px 28px 24px; border:1px solid var(--line); border-radius:var(--radius); background:var(--bg); color:var(--text); font-family:var(--font); box-shadow:0 30px 60px -20px rgba(0,0,0,.35); outline:none; }
.confirm-title { margin:0; font-size:19px; font-weight:600; line-height:1.4; letter-spacing:-.01em; overflow-wrap:anywhere; }
.confirm-message { margin:10px 0 0; color:var(--text-2); font-size:14px; line-height:1.75; overflow-wrap:anywhere; }
.confirm-actions { display:flex; justify-content:flex-end; gap:10px; margin-top:24px; }
.confirm-btn { min-width:84px; padding:9px 18px; border:1px solid color-mix(in srgb,var(--line-strong) 55%,transparent); border-radius:10px; background:var(--surface); color:var(--text); font:inherit; font-size:14px; font-weight:500; cursor:pointer; transition:border-color .2s,color .2s,background .2s,filter .2s; }
.confirm-btn:hover { border-color:var(--accent); color:var(--accent); }
.confirm-btn:focus-visible { outline:none; box-shadow:0 0 0 4px var(--accent-soft); border-color:var(--accent); }
.confirm-btn.primary { border-color:var(--btn-bg); background:var(--btn-bg); color:var(--btn-fg); }
.confirm-btn.danger { border-color:#d15c5c; background:#d15c5c; color:#fff; }
.confirm-btn.primary:hover { border-color:var(--btn-bg); color:var(--btn-fg); filter:brightness(1.12); }
.confirm-btn.danger:hover { border-color:#d15c5c; color:#fff; filter:brightness(1.08); }
.confirm-btn.danger:focus-visible { box-shadow:0 0 0 4px rgba(209,92,92,.25); }
.confirm-overlay[data-state=open] { animation:confirm-fade .2s ease; }
.confirm-overlay[data-state=closed] { animation:confirm-fade .15s ease reverse; }
.confirm-dialog[data-state=open] { animation:confirm-rise .28s var(--ease); }
.confirm-dialog[data-state=closed] { animation:confirm-rise .15s ease reverse; }
/* 手机上改为从底部弹出的面板，按钮等宽铺满，便于单手点按。 */
@media (max-width:760px) {
  .confirm-dialog { top:auto; bottom:0; left:0; width:100%; max-height:88vh; transform:none; padding:10px 20px calc(20px + env(safe-area-inset-bottom)); border-bottom:0; border-radius:22px 22px 0 0; }
  .confirm-dialog::before { content:''; display:block; width:36px; height:4px; margin:0 auto 16px; border-radius:2px; background:var(--line-strong); }
  .confirm-title { font-size:18px; }
  .confirm-actions { margin-top:22px; }
  .confirm-btn { flex:1; padding:12px 16px; font-size:15px; }
  .confirm-dialog[data-state=open] { animation:confirm-sheet .32s var(--ease); }
  .confirm-dialog[data-state=closed] { animation:confirm-sheet .2s ease reverse; }
}
@keyframes confirm-fade { from { opacity:0; } }
@keyframes confirm-rise { from { opacity:0; transform:translate(-50%,calc(-50% + 12px)) scale(.98); } }
@keyframes confirm-sheet { from { transform:translateY(100%); } }
@media (prefers-reduced-motion: reduce) { .confirm-overlay,.confirm-dialog { animation:none !important; } }
</style>
