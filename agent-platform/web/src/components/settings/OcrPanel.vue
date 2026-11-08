<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { get, post } from '../../services/api';
import { useUi } from '../../stores/ui';

type OcrSettings = { online: boolean; mineruConfigured: boolean; paddleConfigured: boolean };
const providers = [
  { name: 'MinerU', key: 'mineruKey', status: 'mineruConfigured' },
  { name: 'PaddleOCR AI Studio', key: 'paddleKey', status: 'paddleConfigured' },
] as const;

const ui = useUi();
const saved = ref<OcrSettings | null>(null);
const online = ref(false);
const tokens = ref({ mineruKey: '', paddleKey: '' });
const remove = ref({ mineruKey: false, paddleKey: false });
const pending = ref(false);
const error = ref('');
const dirty = computed(() => !!saved.value && (
  online.value !== saved.value.online || providers.some(({ key }) => tokens.value[key].trim() || remove.value[key])
));

function apply(settings: OcrSettings) {
  saved.value = settings;
  online.value = settings.online;
  tokens.value = { mineruKey: '', paddleKey: '' };
  remove.value = { mineruKey: false, paddleKey: false };
}

async function load() {
  pending.value = true;
  error.value = '';
  try { apply(await get('/api/ocr/settings')); }
  catch (e) { error.value = (e as Error).message; }
  finally { pending.value = false; }
}

async function save() {
  if (!dirty.value || pending.value) return;
  pending.value = true;
  error.value = '';
  try {
    const payload: Record<string, string | boolean> = { online: online.value };
    for (const { key } of providers) {
      if (remove.value[key]) payload[key] = '';
      else if (tokens.value[key].trim()) payload[key] = tokens.value[key].trim();
    }
    apply(await post('/api/ocr/settings/save', payload));
    ui.toast('扫描件识别设置已保存', { tone: 'success' });
  } catch (e) { error.value = (e as Error).message; }
  finally { pending.value = false; }
}

async function leave() {
  if (pending.value && saved.value) return false;
  return !dirty.value || await ui.confirm({
    title: '放弃未保存的识别设置？',
    message: '本次修改的在线识别选项和 Token 尚未保存。',
    confirmText: '放弃修改',
    cancelText: '继续编辑',
    danger: true,
  });
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) event.preventDefault(); }
onMounted(() => {
  ui.dialogGuard = leave;
  window.addEventListener('beforeunload', beforeUnload);
  void load();
});
onBeforeUnmount(() => {
  if (ui.dialogGuard === leave) ui.dialogGuard = null;
  window.removeEventListener('beforeunload', beforeUnload);
});
</script>

<template>
  <div class="settings-pad">
    <h3>扫描件识别</h3>
    <p>支持 PDF、PNG 和 JPEG。识别结果以 Markdown 保存到当前项目。</p>
    <p v-if="pending && !saved" role="status">正在读取识别设置…</p>
    <p v-if="error" class="status-error" role="alert">
      {{ error }}
      <button v-if="!saved" type="button" class="btn btn-quiet" @click="load">重试</button>
    </p>
    <form v-if="saved" class="ocr-form" :aria-busy="pending" @submit.prevent="save">
      <div>
        <label>
          <input v-model="online" type="checkbox" :disabled="pending" aria-describedby="ocr-online-description" />
          允许使用在线 OCR
        </label>
        <p id="ocr-online-description">
          开启后，选中的文件页会发送给 MinerU 或 PaddleOCR。优先使用已配置的 Token，随后尝试 MinerU 免密接口。
          关闭在线识别或在线服务不可用时，由沙箱内的 Tesseract 识别。
        </p>
      </div>
      <div v-for="provider in providers" :key="provider.key">
        <label class="field">
          <span class="field-label">{{ provider.name }} Token（{{ saved[provider.status] ? '已配置，留空保留' : '可选' }}）</span>
          <input v-model="tokens[provider.key]" type="password" autocomplete="new-password"
            spellcheck="false" maxlength="2048" :disabled="pending || remove[provider.key]" />
        </label>
        <label v-if="saved[provider.status]">
          <input v-model="remove[provider.key]" type="checkbox" :disabled="pending" />
          保存时清除 {{ provider.name }} Token
        </label>
      </div>
      <div>
        <button type="submit" class="btn btn-solid" :disabled="pending || !dirty">
          {{ pending ? '保存中…' : '保存识别设置' }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.ocr-form { display: grid; gap: 1rem; margin-top: 1rem; }
.ocr-form p { margin: .4rem 0 0; }
</style>
