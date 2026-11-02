<script setup lang="ts">
import { ref } from 'vue';
import { useSession } from '../stores/session';
const props = defineProps<{ request: any }>();
const session = useSession();
const selected = ref('');
const custom = ref('');
</script>
<template>
  <section class="user-question" aria-label="Iris 需要你的回答">
    <strong>{{ request.question.question }}</strong>
    <template v-if="request.state === 'pending'">
      <p class="question-hint">选择一个选项或填写自己的回答，提交后继续执行。</p>
      <div class="question-options" role="group" :aria-label="request.question.question">
        <button v-for="(option, i) in request.question.options" :key="i" type="button" class="question-option" :aria-pressed="selected === option.label" :disabled="request.saving" @click="selected = option.label; custom = ''">
          <span>{{ option.label }} <small v-if="option.recommended">推荐</small></span>
          <span v-if="option.description" class="question-hint">{{ option.description }}</span>
        </button>
      </div>
      <label :for="'answer-' + request.id" class="question-hint">自己的回答（可选）</label>
      <textarea :id="'answer-' + request.id" v-model="custom" maxlength="8000" rows="2" style="resize: none" :disabled="request.saving" @input="selected = ''"></textarea>
      <div class="approval-actions"><button type="button" class="btn btn-solid" :disabled="request.saving || (!selected && !custom.trim())" @click="session.answerQuestion(request.id, custom.trim() || selected)">{{ request.saving ? '提交中…' : '提交回答' }}</button></div>
    </template>
    <p v-else>{{ request.answer || '问题已结束，未提交回答' }}</p>
    <p v-if="request.error" class="status-error" role="alert">{{ request.error }}</p>
  </section>
</template>
<style>
.user-question { margin: 16px 0; padding: 16px; border: 1px solid var(--line-strong); background: var(--surface-2); border-radius: var(--radius-md); }
.user-question strong { font-size: 14px; }
.question-hint { display: block; font-size: 12px; color: var(--muted); margin: 6px 0; }
.question-options { display: grid; gap: 8px; margin: 12px 0; }
.question-option { padding: 10px 12px; text-align: left; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: var(--surface); }
.question-option[aria-pressed="true"] { border-color: var(--text); box-shadow: inset 0 0 0 1px var(--text); }
.question-option small { font-size: 11px; color: var(--muted); margin-left: 8px; }
.user-question textarea { width: 100%; padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: var(--radius-xs); background: var(--surface); }
</style>
