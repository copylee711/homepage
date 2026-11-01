<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import BaseDialog from './BaseDialog.vue';
import Icon from '../Icon.vue';
import { get, post } from '../../services/api';
import { useUi } from '../../stores/ui';
import { useSession } from '../../stores/session';

const ui = useUi();
const session = useSession();
const configs = ref<any>(null);
const editingId = ref<string>('');
const busy = ref(false);
const status = ref('');
const statusTone = ref('');
const showKey = ref(false);
const form = ref({ id: '', name: '', api: 'openai-completions', baseUrl: '', model: '', proxy: false, apiKey: '' });

const presets = computed(() => (configs.value?.presets || []).filter((p: any) => !(configs.value?.providers || []).some((s: any) => s.id === p.id)));

function fill(v: any) {
  editingId.value = v.id;
  form.value = { id: v.id === 'custom' ? '' : (v.id || ''), name: v.name || '', api: v.api || 'openai-completions', baseUrl: v.baseUrl || '', model: v.model || '', proxy: v.proxy === true, apiKey: '' };
  status.value = ''; statusTone.value = '';
}
function select(id: string) {
  const v = configs.value.providers.find((p: any) => p.id === id) || configs.value.presets.find((p: any) => p.id === id) || { id: 'custom', name: '自定义供应商', api: 'openai-completions', baseUrl: '', model: '', proxy: false };
  fill(v);
}
function newProvider() { fill({ id: 'custom', name: '自定义供应商', api: 'openai-completions', baseUrl: '', model: '', proxy: false }); }

async function act(save: boolean) {
  if (busy.value) return; busy.value = true;
  status.value = save ? '正在保存…' : '正在测试模型调用…'; statusTone.value = '';
  try {
    const result = await post(save ? '/api/providers/save' : '/api/providers/test', { config: { ...form.value } });
    if (save) { configs.value = result; const active = result.providers.find((p: any) => p.id === result.active); if (active) fill(active); status.value = '已保存，后续任务使用此配置。'; statusTone.value = 'is-success'; session.refreshIdentity(); }
    else { status.value = (result.detail || '测试完成') + ' · ' + (result.route || '') + (result.latency ? ' · ' + result.latency + ' ms' : ''); statusTone.value = result.ok ? 'is-success' : 'is-error'; }
  } catch (e: any) { status.value = e.message; statusTone.value = 'is-error'; }
  finally { busy.value = false; }
}
async function activate(id: string) {
  try { await session.activateModel(id); if (configs.value) configs.value.active = id; ui.toast('已切换当前模型', { tone: 'success' }); }
  catch (e: any) { ui.toast(e.message, { tone: 'error' }); }
}

onMounted(async () => {
  try { configs.value = await get('/api/providers'); const a = configs.value.providers.find((p: any) => p.id === configs.value.active) || configs.value.providers[0] || { id: 'custom', name: '自定义供应商', api: 'openai-completions', baseUrl: '', model: '', proxy: false }; fill(a); }
  catch (e: any) { ui.toast(e.message, { tone: 'error' }); }
});
</script>

<template>
  <BaseDialog title="模型与供应商" subtitle="管理已保存的供应商，切换当前使用的模型，或接入兼容 API。" wide>
    <div class="provider-layout">
      <aside class="provider-rail">
        <div class="provider-rail-head"><span>供应商</span><button class="icon-button small" aria-label="新建供应商" title="新建" @click="newProvider"><Icon name="plus" :size="16" /></button></div>
        <div class="provider-saved">
          <button v-for="p in (configs?.providers || [])" :key="p.id" class="provider-pill" :class="{ 'is-editing': editingId === p.id, 'is-active': configs.active === p.id }" @click="select(p.id)">
            <span class="p-dot"></span>
            <span class="p-body"><span class="p-name">{{ p.name }}</span><span class="p-model">{{ p.model }}</span></span>
            <span v-if="configs.active === p.id" class="p-badge">使用中</span>
            <button v-else class="p-activate" title="设为当前" @click.stop="activate(p.id)"><Icon name="check" :size="13" /></button>
          </button>
        </div>
        <template v-if="presets.length">
          <div class="provider-rail-sub">可选预设</div>
          <div class="provider-saved provider-presets">
            <button v-for="p in presets" :key="p.id" class="provider-pill" :class="{ 'is-editing': editingId === p.id }" @click="select(p.id)">
              <span class="p-dot"></span><span class="p-body"><span class="p-name">{{ p.name }}</span><span class="p-model">{{ p.model }}</span></span>
            </button>
          </div>
        </template>
      </aside>
      <form class="provider-editor" @submit.prevent="act(true)">
        <div class="field-grid">
          <label class="field"><span class="field-label">配置标识</span><input v-model="form.id" maxlength="40" placeholder="my-provider" autocomplete="off" spellcheck="false"></label>
          <label class="field"><span class="field-label">显示名称</span><input v-model="form.name" maxlength="60" autocomplete="off"></label>
        </div>
        <label class="field"><span class="field-label">API 协议</span>
          <select v-model="form.api">
            <option value="openai-completions">OpenAI Chat Completions 兼容</option>
            <option value="openai-responses">OpenAI Responses</option>
            <option value="anthropic-messages">Anthropic Messages</option>
            <option value="google-generative-ai">Google Gemini</option>
          </select>
        </label>
        <label class="field"><span class="field-label">API 地址</span><input v-model="form.baseUrl" type="url" inputmode="url" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false"></label>
        <label class="field"><span class="field-label">模型 ID</span><input v-model="form.model" maxlength="160" placeholder="填写供应商提供的模型 ID" autocomplete="off" spellcheck="false"></label>
        <div class="field"><label class="field-label">API 密钥</label>
          <div class="key-row">
            <input v-model="form.apiKey" :type="showKey ? 'text' : 'password'" maxlength="1024" placeholder="填写新密钥，留空保留已保存的密钥" autocomplete="new-password" spellcheck="false">
            <button type="button" class="btn btn-quiet" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button>
          </div>
          <p class="hint">密钥仅保存在服务端，不会回显，也不会写入浏览器存储。</p>
        </div>
        <label class="check"><input v-model="form.proxy" type="checkbox"><span>通过 xa 的 Mihomo 代理连接</span></label>
        <p v-if="status" class="provider-status" :class="statusTone">{{ status }}</p>
        <div class="dialog-actions">
          <button type="button" class="btn btn-quiet" :disabled="busy" @click="act(false)">测试连接</button>
          <button type="submit" class="btn btn-solid" :disabled="busy">保存并使用</button>
        </div>
      </form>
    </div>
  </BaseDialog>
</template>

<style>
.provider-layout { display: grid; grid-template-columns: 214px minmax(0, 1fr); gap: 0; margin: -18px -21px -20px; }
.provider-rail { display: flex; flex-direction: column; gap: 4px; padding: 15px 12px; border-right: 1px solid var(--line); background: var(--surface-2); overflow-y: auto; }
.provider-rail-head { display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: 10.5px; font-weight: 650; letter-spacing: 0.03em; text-transform: uppercase; padding: 0 2px 2px; }
.provider-rail-head .icon-button { width: 29px; height: 29px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-2); }
.provider-rail-head .icon-button:hover { background: color-mix(in srgb, var(--text) 7%, transparent); }
.provider-rail-sub { margin-top: 12px; padding: 0 2px 2px; color: var(--faint); font-size: 10px; font-weight: 650; letter-spacing: 0.03em; text-transform: uppercase; }
.provider-saved { display: flex; flex-direction: column; gap: 3px; }
.provider-pill { display: flex; align-items: center; gap: 9px; padding: 9px 10px; border-radius: 11px; border: 1px solid transparent; color: var(--text-2); text-align: left; transition: background-color var(--fast), border-color var(--fast); }
.provider-pill:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.provider-pill.is-editing { border-color: var(--line-strong); background: var(--surface); }
.provider-pill.is-active { background: var(--accent-soft); color: var(--text); }
.provider-pill .p-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--line-strong); }
.provider-pill.is-active .p-dot { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.provider-pill .p-body { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.provider-pill .p-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 560; }
.provider-pill .p-model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9.5px; color: var(--muted); font-family: var(--font-mono); }
.provider-pill .p-badge { flex: none; font-size: 9px; color: var(--ok); font-weight: 700; }
.provider-pill .p-activate { flex: none; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; color: var(--muted); opacity: 0; }
.provider-pill:hover .p-activate { opacity: 1; }
.provider-pill .p-activate:hover { background: color-mix(in srgb, var(--text) 10%, transparent); color: var(--text); }
.provider-presets .provider-pill { color: var(--muted); }
.provider-editor { padding: 18px 20px; overflow-y: auto; }
.key-row { display: flex; align-items: stretch; gap: 8px; }
.key-row input { flex: 1; min-width: 0; }
.key-row .btn { flex: none; }
.check { display: flex; align-items: flex-start; gap: 9px; margin-top: 15px; color: var(--text-2); font-size: 13px; line-height: 1.5; cursor: pointer; }
.check input { flex: none; width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--accent); }
@media (max-width: 720px) { .provider-layout { grid-template-columns: minmax(0, 1fr); } .provider-rail { border-right: 0; border-bottom: 1px solid var(--line); max-height: 180px; } }
</style>
