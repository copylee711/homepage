<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import Message from './Message.vue';
import BlockList from './BlockList.vue';
import UserQuestion from './UserQuestion.vue';
import { buildTranscript } from '../services/transcript.mjs';
import WelcomeHero from './WelcomeHero.vue';
import { textContent } from '../services/format';
import { useSession } from '../stores/session';

const session = useSession();
const scroller = ref<HTMLElement | null>(null);
const follow = ref(true);
const showJump = ref(false);

// Build the display list: user/assistant messages, with toolResult messages
// folded into a lookup so tool cards show their results.
const display = computed(() => buildTranscript(session.messages));
const userTurns = computed(() => display.value.flatMap((message:any,index:number) => message.role === 'user' ? [{index,label:String(message._rawPrompt || textContent(message.content) || '文件与引用消息').replace(/\s+/g,' ').slice(0,180)}] : []));
const activeTurn = ref(-1), flashTurn = ref(-1);
let flashTimer: ReturnType<typeof setTimeout> | undefined;
function updateActiveTurn() {
  const root=scroller.value;if(!root)return;
  const top=root.getBoundingClientRect().top+80;let current=userTurns.value[0]?.index??-1;
  for(const element of Array.from(root.querySelectorAll<HTMLElement>('[data-user-index]'))) { if(element.getBoundingClientRect().top<=top)current=Number(element.dataset.userIndex);else break; }
  activeTurn.value=nearBottom()?(userTurns.value.at(-1)?.index??current):current;
}
function jumpToTurn(index:number) {
  const root=scroller.value,target=root?.querySelector<HTMLElement>('[data-user-index="'+index+'"]');if(!root||!target)return;
  follow.value=false;showJump.value=true;activeTurn.value=index;flashTurn.value=index;
  root.scrollTo({top:root.scrollTop+target.getBoundingClientRect().top-root.getBoundingClientRect().top-16,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  if(flashTimer)clearTimeout(flashTimer);flashTimer=setTimeout(()=>{flashTurn.value=-1;},1800);
}
onBeforeUnmount(()=>{if(flashTimer)clearTimeout(flashTimer);});

function nearBottom() {
  const el = scroller.value; if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}
function onScroll() { follow.value = nearBottom(); showJump.value = !follow.value && session.messages.length > 0; updateActiveTurn(); }
function toBottom(smooth = true) {
  const el = scroller.value; if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}
let followFrame = 0;
function autoFollow() { if(followFrame)return; followFrame=requestAnimationFrame(()=>{followFrame=0;nextTick(() => { if (follow.value) toBottom(false); });}); }
onBeforeUnmount(()=>cancelAnimationFrame(followFrame));

watch(() => session.messages.length, autoFollow);
watch(() => session.live && JSON.stringify(session.live.blocks.map((b: any) => b.text?.length || b.state)), autoFollow);
watch(() => session.chatId, () => { follow.value = true; nextTick(() => toBottom(false)); });
onMounted(() => nextTick(() => toBottom(false)));
</script>

<template>
  <div class="stage">
    <div class="conversation" :class="{ 'is-empty': session.isEmpty && !session.loadingChat, 'is-unauthorized': session.booted && !session.canExecute }" ref="scroller" tabindex="0" aria-label="对话内容" @scroll.passive="onScroll">
      <WelcomeHero v-if="session.isEmpty && !session.loadingChat" />
      <div v-else class="messages">
        <div v-if="session.loadingChat" class="conversation-state"><span class="spinner"></span><span>正在读取对话…</span></div>
        <Message v-for="(it, i) in display" :key="i" :message="it" :data-user-index="it.role==='user'?i:undefined" :class="{'is-jump-target':flashTurn===i}" />
        <!-- live streaming assistant -->
        <article v-if="session.live" class="message message-assistant">
          <div class="message-avatar"><Icon name="iris" :size="18" /></div>
          <div class="message-inner">
            <div class="message-meta"><strong class="message-author">Iris</strong></div>
            <div class="message-content"><BlockList :blocks="session.live.blocks" :streaming="true" /></div>
            <UserQuestion v-for="question in session.live.questions" :key="question.id" :request="question" />
            <template v-for="approval in session.live.approvals" :key="approval.id">
              <section v-if="approval.state === 'pending'" class="tool-approval" :aria-label="approval.title" aria-live="polite">
                <div class="tool-approval-title">
                  <Icon name="shield" :size="14" />
                  <strong>{{ approval.title }}</strong>
                </div>
                <pre>{{ approval.message }}</pre>
                <p>允许后仅执行本次操作；5 分钟内未处理则自动取消。</p>
                <div class="approval-actions">
                  <button type="button" class="btn btn-quiet" :disabled="approval.saving" @click="session.resolveApproval(approval.id, false)">拒绝本次</button>
                  <button type="button" class="btn btn-solid" :disabled="approval.saving" @click="session.resolveApproval(approval.id, true)">允许本次</button>
                </div>
                <p v-if="approval.error" class="status-error" role="alert">{{ approval.error }}</p>
              </section>
              <div v-else class="tool-approval-resolved">
                <Icon :name="approval.state === 'allowed' ? 'check' : 'x'" :size="12" />
                <span>{{ approval.state === 'allowed' ? '已允许执行本次操作' : '已拒绝执行本次操作' }} · {{ approval.title }}</span>
              </div>
            </template>
            <div v-if="session.live.status || session.live.error || session.live.stopped" class="message-status" :class="{ 'is-error': session.live.error }">
              <span v-if="session.live.spinner && !session.live.error && !session.live.stopped" class="working-dot"></span>
              <span v-if="session.live.error" class="status-error">{{ session.live.error }}</span>
              <span v-else-if="session.live.stopped">已停止生成</span>
              <span v-else>{{ session.live.status }}</span>
            </div>
          </div>
        </article>
      </div>
    </div>
    <button v-if="showJump" type="button" class="jump-latest" aria-label="回到最新" title="回到最新" @click="toBottom()"><Icon name="arrow-down" :size="16" /></button>
  </div>
</template>

<style>
.stage { position: relative; min-height: 0; flex: 1; display: flex; overflow: hidden; }
.conversation { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable both-edges; padding: 0 clamp(16px, 4vw, 40px); scroll-behavior: auto; overscroll-behavior: contain; }
.conversation.is-unauthorized.is-empty { justify-content: center; }
.conversation.is-empty { display: flex; flex-direction: column; justify-content: flex-end; align-items: center; }
.messages { width: 100%; max-width: 760px; margin: 0 auto; padding: 30px 0 44px; display: flex; flex-direction: column; gap: 30px; }
.is-jump-target .user-bubble { box-shadow:0 0 0 2px var(--line-strong); }
@media(max-width:640px){.conversation{padding-right:30px;}}
.conversation-state { padding: 40px 0; display: flex; align-items: center; justify-content: center; gap: 9px; color: var(--muted); font-size: 12.5px; }
.message-status { min-height: 18px; display: flex; align-items: center; gap: 8px; margin-top: 9px; color: var(--muted); font-size: 11.5px; }
.message-status.is-error { color: var(--danger); }
.tool-approval { margin-top: 14px; padding: 14px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface-2); }
.tool-approval strong { font-size: 13px; }
.tool-approval pre { max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono); font-size: 12px; }
.tool-approval p { margin: 8px 0 0; color: var(--muted); font-size: 12px; }
.approval-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.status-error { color: var(--danger); }
.working-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); animation: breathe 1.7s ease-in-out infinite; }
@keyframes breathe { 0%, 100% { opacity: 1; box-shadow: 0 0 0 3px var(--accent-soft); } 50% { opacity: 0.5; box-shadow: 0 0 0 6px transparent; } }
.jump-latest { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); width: 36px; height: 36px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--line-2); border-radius: 50%; background: var(--surface); color: var(--text-2); box-shadow: var(--shadow-lg); transition: border-color var(--fast), color var(--fast), transform var(--fast); }
.jump-latest:hover { border-color: var(--line-strong); color: var(--text); transform: translateX(-50%) translateY(-1px); }
</style>
