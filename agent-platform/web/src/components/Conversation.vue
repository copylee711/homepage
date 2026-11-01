<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import Icon from './Icon.vue';
import Message from './Message.vue';
import BlockList from './BlockList.vue';
import WelcomeHero from './WelcomeHero.vue';
import { useSession } from '../stores/session';

const session = useSession();
const scroller = ref<HTMLElement | null>(null);
const follow = ref(true);
const showJump = ref(false);

// Build the display list: user/assistant messages, with toolResult messages
// folded into a lookup so tool cards show their results.
const display = computed(() => {
  const items: any[] = [];
  const toolResults: Record<string, any> = {};
  for (const m of session.messages) {
    if (m.role === 'toolResult') { toolResults[m.toolCallId] = { isError: m.isError === true, text: typeof m.content === 'string' ? m.content : '' }; }
  }
  for (const m of session.messages) {
    if (m.role === 'user' || m.role === 'assistant') items.push({ m, toolResults });
  }
  return items;
});

function nearBottom() {
  const el = scroller.value; if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}
function onScroll() { follow.value = nearBottom(); showJump.value = !follow.value && session.messages.length > 0; }
function toBottom(smooth = true) {
  const el = scroller.value; if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}
function autoFollow() { if (follow.value) nextTick(() => toBottom(false)); }

watch(() => session.messages.length, autoFollow);
watch(() => session.live && JSON.stringify(session.live.blocks.map((b: any) => b.text?.length || b.state)), autoFollow);
watch(() => session.chatId, () => { follow.value = true; nextTick(() => toBottom(false)); });
onMounted(() => nextTick(() => toBottom(false)));
</script>

<template>
  <div class="stage">
    <div class="conversation" ref="scroller" tabindex="0" aria-label="对话内容" @scroll.passive="onScroll">
      <WelcomeHero v-if="session.isEmpty && !session.loadingChat" />
      <div v-else class="messages">
        <div v-if="session.loadingChat" class="conversation-state"><span class="spinner"></span><span>正在读取对话…</span></div>
        <Message v-for="(it, i) in display" :key="i" :message="it.m" :tool-results="it.toolResults" />
        <!-- live streaming assistant -->
        <article v-if="session.live" class="message message-assistant">
          <div class="message-avatar"><Icon name="iris" :size="18" /></div>
          <div class="message-inner">
            <div class="message-meta"><strong class="message-author">Iris</strong></div>
            <div class="message-content"><BlockList :blocks="session.live.blocks" :streaming="true" /></div>
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
    <button v-if="showJump" class="jump-latest" @click="toBottom()"><Icon name="arrow-down" :size="15" /><span>回到最新</span></button>
  </div>
</template>

<style>
.stage { position: relative; min-height: 0; flex: 1; display: flex; overflow: hidden; }
.conversation { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 0 clamp(16px, 4vw, 40px); scroll-behavior: smooth; overscroll-behavior: contain; }
.messages { width: 100%; max-width: 760px; margin: 0 auto; padding: 30px 0 44px; display: flex; flex-direction: column; gap: 30px; }
.conversation-state { padding: 40px 0; display: flex; align-items: center; justify-content: center; gap: 9px; color: var(--muted); font-size: 12.5px; }
.message-status { min-height: 18px; display: flex; align-items: center; gap: 8px; margin-top: 9px; color: var(--muted); font-size: 11.5px; }
.message-status.is-error { color: var(--danger); }
.status-error { color: var(--danger); }
.working-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); animation: breathe 1.7s ease-in-out infinite; }
@keyframes breathe { 0%, 100% { opacity: 1; box-shadow: 0 0 0 3px var(--accent-soft); } 50% { opacity: 0.5; box-shadow: 0 0 0 6px transparent; } }
.jump-latest { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border: 1px solid var(--line-2); border-radius: 999px; background: var(--surface); color: var(--text-2); font-size: 12px; box-shadow: var(--shadow-lg); }
.jump-latest:hover { border-color: var(--line-strong); color: var(--text); }
</style>
