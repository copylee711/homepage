<script setup lang="ts">
import { ref, onMounted, computed, onBeforeUnmount, watch } from 'vue';
import { get, post } from '../../services/api';
import { markdownFromZip, parseSkillMarkdown, slugSkillId, type ImportedSkill } from '../../services/skill-import';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';

const session = useSession(), ui = useUi();
const config = ref<any>(null), loading = ref(true), saving = ref(false), error = ref(''), stats = ref<any>(null), compacting = ref(false), testing = ref(''), shown = ref<Record<string, boolean>>({});
const savedConfig = ref('');
const dirty = computed(() => !!config.value && JSON.stringify(config.value) !== savedConfig.value);
const fileInput = ref<HTMLInputElement | null>(null);
type SkillDraft = ImportedSkill & { originalId: string | null };
type McpDraft = { id: string; name: string; url: string; token: string; enabled: boolean; useProxy: boolean; clearToken: boolean; hasToken: boolean; tools: any[]; isNew: boolean };
const skillEditor = ref<SkillDraft | null>(null);
const mcpEditor = ref<McpDraft | null>(null);
const editorError = ref('');

async function leave() {
  if (saving.value || testing.value || compacting.value) return false;
  return !dirty.value || await ui.confirm({ title: '放弃未保存的能力配置？', message: 'MCP、Skill 或上下文配置尚未保存。', confirmText: '放弃修改', cancelText: '继续编辑', danger: true });
}
function beforeUnload(e: BeforeUnloadEvent) { if (dirty.value) { e.preventDefault(); e.returnValue = ''; } }
const disabled = computed(() => saving.value || session.busy || compacting.value || !!testing.value);
async function load() {
  loading.value = true;
  try { config.value = await get('/api/features'); savedConfig.value = JSON.stringify(config.value); error.value = ''; }
  catch (e: any) { error.value = e.message; }
  finally { loading.value = false; }
}
onMounted(() => { ui.dialogGuard = leave; window.addEventListener('beforeunload', beforeUnload); void load(); });
onBeforeUnmount(() => { if (ui.dialogGuard === leave) ui.dialogGuard = null; window.removeEventListener('beforeunload', beforeUnload); });
async function save() {
  saving.value = true; error.value = '';
  try {
    config.value = await post('/api/features/save', { config: config.value });
    savedConfig.value = JSON.stringify(config.value);
    ui.toast('能力配置已保存，下次任务加载', { tone: 'success' });
    return true;
  } catch (e: any) { error.value = e.message; return false; }
  finally { saving.value = false; }
}
function openSkill(skill?: any) {
  editorError.value = '';
  skillEditor.value = skill
    ? { id: skill.id, description: skill.description || '', content: skill.content || '', enabled: skill.enabled !== false, originalId: skill.id }
    : { id: '', description: '', content: '', enabled: true, originalId: null };
}
function openMcp(server?: any) {
  editorError.value = '';
  mcpEditor.value = server
    ? { id: server.id, name: server.name || '', url: server.url || '', token: server.token || '', enabled: server.enabled === true, useProxy: server.useProxy === true, clearToken: false, hasToken: !!server.hasToken, tools: server.tools || [], isNew: false }
    : { id: 'mcp-' + crypto.randomUUID().slice(0, 8), name: '', url: '', token: '', enabled: false, useProxy: false, clearToken: false, hasToken: false, tools: [], isNew: true };
}
function closeEditors() { skillEditor.value = null; mcpEditor.value = null; editorError.value = ''; }
function trapEscape(e: KeyboardEvent) {
  if (e.key !== 'Escape' || ui.modal) return;
  e.preventDefault();
  e.stopPropagation();
  closeEditors();
}
watch([skillEditor, mcpEditor], ([skill, mcp]) => {
  document.removeEventListener('keydown', trapEscape, true);
  if (skill || mcp) document.addEventListener('keydown', trapEscape, true);
});
onBeforeUnmount(() => document.removeEventListener('keydown', trapEscape, true));

function commitSkill() {
  const draft = skillEditor.value;
  if (!draft || !config.value) return;
  const id = slugSkillId(draft.id);
  if (!/^[a-z0-9-]{1,30}$/.test(id)) { editorError.value = '标识需为 1–30 位小写字母、数字或连字符'; return; }
  const description = draft.description.replace(/\s+/g, ' ').trim().slice(0, 300);
  const content = draft.content.trim().slice(0, 8000);
  if (!description || !content) { editorError.value = '请填写技能说明和 Markdown 内容'; return; }
  const list = config.value.customSkills as any[];
  if (list.some(s => s.id === id && s.id !== draft.originalId)) { editorError.value = '已有同名技能'; return; }
  if (!draft.originalId && list.length >= 8) { editorError.value = '个人技能最多 8 个'; return; }
  const next = { id, description, content, enabled: draft.enabled !== false };
  if (draft.originalId) {
    const index = list.findIndex(s => s.id === draft.originalId);
    if (index >= 0) list.splice(index, 1, next);
    else list.push(next);
  } else list.push(next);
  closeEditors();
}
function commitMcp() {
  const draft = mcpEditor.value;
  if (!draft || !config.value) return;
  const name = draft.name.replace(/\s+/g, ' ').trim().slice(0, 60);
  const url = draft.url.trim();
  if (!name || !url) { editorError.value = '请填写名称和 HTTPS 端点'; return; }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('https');
  } catch { editorError.value = '端点需为公开 HTTPS 地址'; return; }
  const list = config.value.mcpServers as any[];
  if (draft.isNew && list.length >= 8) { editorError.value = 'MCP 服务最多 8 个'; return; }
  const next = {
    id: draft.id, name, url, token: draft.token, enabled: draft.enabled === true,
    useProxy: draft.useProxy === true, clearToken: draft.clearToken === true,
    hasToken: draft.hasToken, tools: draft.tools || [],
  };
  const index = list.findIndex(s => s.id === draft.id);
  if (index >= 0) list.splice(index, 1, { ...list[index], ...next });
  else list.push(next);
  closeEditors();
}
function uniqueId(base: string) {
  const used = new Set((config.value?.customSkills || []).map((s: any) => s.id));
  let id = slugSkillId(base);
  if (!used.has(id)) return id;
  for (let n = 2; n < 100; n++) {
    const next = (id.slice(0, 27) + '-' + n).slice(0, 30);
    if (!used.has(next)) return next;
  }
  return id;
}
function addImported(skills: ImportedSkill[]) {
  const room = 8 - config.value.customSkills.length;
  const accepted = skills.filter(s => s.content).slice(0, Math.max(0, room));
  for (const skill of accepted) {
    skill.id = uniqueId(skill.id);
    config.value.customSkills.push(skill);
  }
  const skipped = skills.length - accepted.length;
  if (!accepted.length) ui.toast(room <= 0 ? '个人技能已达 8 个' : '没有可导入的 Markdown 内容', { tone: 'info' });
  else ui.toast(skipped ? `已加入 ${accepted.length} 个技能，${skipped} 个因上限或空内容跳过。请保存能力配置。` : `已加入 ${accepted.length} 个技能，请保存能力配置。`, { tone: 'success' });
}
async function onImport(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !config.value) return;
  try {
    if (/\.zip$/i.test(file.name)) {
      addImported((await markdownFromZip(await file.arrayBuffer())).map(item => parseSkillMarkdown(item.text, item.name)));
      return;
    }
    const skill = parseSkillMarkdown(await file.text(), file.name);
    if (!skill.content) { ui.toast('Markdown 内容为空', { tone: 'info' }); return; }
    skill.id = uniqueId(skill.id);
    openSkill(skill);
    if (skillEditor.value) skillEditor.value.originalId = null;
  } catch (e: any) {
    ui.toast(e.message || '无法读取该文件', { tone: 'error' });
  }
}
async function test(server: any) {
  if (!await save()) return;
  testing.value = server.id;
  try { config.value = await post('/api/features/mcp/test', { id: server.id }); savedConfig.value = JSON.stringify(config.value); ui.toast('MCP 已连接并读取工具列表', { tone: 'success' }); }
  catch (e: any) { error.value = e.message; }
  finally { testing.value = ''; }
}
async function remove(kind: 'mcpServers' | 'customSkills', id: string) {
  if (!await ui.confirm({ title: '移除配置', message: '保存后将移除这项配置及其凭据。', confirmText: '移除', danger: true })) return;
  config.value[kind] = config.value[kind].filter((s: any) => s.id !== id);
}
async function context() {
  if (!session.currentChat) return;
  try { stats.value = await get('/api/context/stats?chat=' + encodeURIComponent(session.currentChat.id)); }
  catch (e: any) { error.value = e.message; }
}
async function compact() {
  if (!session.currentChat || !await ui.confirm({ title: '压缩当前对话上下文', message: '将调用模型整理摘要，减少后续上下文用量。原始记录仍保存在服务端；压缩后暂不支持回退此对话。', confirmText: '开始压缩' })) return;
  compacting.value = true; error.value = '';
  try {
    const result = await post('/api/context/compact', { thread: session.currentChat.id });
    await context();
    ui.toast(result.skipped ? result.reason : '上下文已压缩', { tone: result.skipped ? 'info' : 'success' });
  } catch (e: any) { error.value = e.message; }
  finally { compacting.value = false; }
}
</script>

<template>
  <div class="settings-pad capabilities-settings">
    <h3>内置能力与扩展</h3>
    <p class="question-hint">上下文管理、问答、计划、记忆与后台任务由 Iris 原生提供。Skill 使用 Pi 的 Markdown 加载协议；MCP 通过经过校验的远程 HTTPS 连接，结果回到现有工具卡片和审批流程。配置修改需等待当前任务结束。</p>
    <p v-if="loading" role="status">正在读取配置…</p>
    <template v-else-if="config">
      <h4>上下文管理</h4>
      <label class="capability-check"><input v-model="config.autoCompaction" type="checkbox" :disabled="disabled" /> 接近上下文窗口上限时自动压缩（默认开启）</label>
      <div class="background-actions">
        <button type="button" class="btn btn-quiet" :disabled="!session.currentChat || compacting" @click="context">查看当前上下文用量</button>
        <button type="button" class="btn btn-quiet" :disabled="!session.currentChat || disabled" @click="compact">{{ compacting ? '压缩中…' : '压缩当前对话' }}</button>
      </div>
      <p v-if="!session.currentChat" class="question-hint">打开已有对话后可查看用量和手动压缩。</p>
      <p v-if="stats" class="question-hint">累计 {{ stats.tokens?.total || 0 }} tokens · {{ stats.totalMessages || 0 }} 条原始消息 · {{ stats.toolCalls || 0 }} 次工具调用<span v-if="stats.contextUsage"> · 当前约 {{ Math.round(stats.contextUsage.percent || 0) }}%（{{ stats.contextUsage.tokens }} / {{ stats.contextUsage.contextWindow }}）</span></p>

      <h4>内置 Skill</h4>
      <label v-for="skill in config.builtinSkills" :key="skill.id" class="capability-skill">
        <input v-model="config.skills" :value="skill.id" type="checkbox" :disabled="disabled" />
        <span><strong>{{ skill.name }}</strong><small>{{ skill.description }}</small></span>
      </label>

      <h4>个人 Skill</h4>
      <p class="question-hint">可粘贴、导入 Markdown，或从 zip 中提取 Markdown。仅保存文本，不执行其中的宿主脚本。每个技能最多 8000 字，最多 8 个。保存能力配置后生效。</p>
      <section v-for="skill in config.customSkills" :key="skill.id" class="capability-row">
        <label class="capability-check"><input v-model="skill.enabled" type="checkbox" :disabled="disabled" /><span>{{ skill.id }}</span></label>
        <p class="question-hint">{{ skill.description }}</p>
        <div class="background-actions">
          <button type="button" class="btn btn-quiet btn-sm" :disabled="disabled" @click="openSkill(skill)">编辑</button>
          <button type="button" class="btn btn-quiet btn-sm" :disabled="disabled" @click="remove('customSkills', skill.id)">移除</button>
        </div>
      </section>
      <div class="background-actions">
        <button type="button" class="btn btn-quiet" :disabled="disabled || config.customSkills.length >= 8" @click="openSkill()">添加个人 Skill</button>
        <button type="button" class="btn btn-quiet" :disabled="disabled || config.customSkills.length >= 8" @click="fileInput?.click()">导入 Markdown / Zip</button>
        <input ref="fileInput" class="capability-file" type="file" accept=".md,.markdown,.zip,text/markdown,application/zip" :disabled="disabled" @change="onImport" />
      </div>

      <h4>远程 MCP</h4>
      <p class="question-hint">支持 Streamable HTTP 的 JSON / SSE 响应与 Bearer Token。先保存并测试，读取工具列表后启用。暂不执行宿主 stdio 程序或终端插件 UI；OAuth 服务需提供可用 Token。</p>
      <section v-for="server in config.mcpServers" :key="server.id" class="capability-row">
        <label class="capability-check"><input v-model="server.enabled" type="checkbox" :disabled="disabled" /><span>{{ server.name }}</span></label>
        <p class="question-hint">{{ server.url }}</p>
        <p class="question-hint">已发现 {{ server.tools?.length || 0 }} 个工具：{{ (server.tools || []).map((t: any) => t.name).join('、') || '尚未测试' }}</p>
        <div class="background-actions">
          <button type="button" class="btn btn-quiet btn-sm" :disabled="disabled" @click="openMcp(server)">编辑</button>
          <button type="button" class="btn btn-quiet btn-sm" :disabled="disabled" @click="test(server)">{{ testing === server.id ? '连接中…' : '保存并测试' }}</button>
          <button type="button" class="btn btn-quiet btn-sm" :disabled="disabled" @click="remove('mcpServers', server.id)">移除</button>
        </div>
      </section>
      <button type="button" class="btn btn-quiet" :disabled="disabled || config.mcpServers.length >= 8" @click="openMcp()">添加远程 MCP</button>
      <div class="approval-actions"><button type="button" class="btn btn-solid" :disabled="disabled" @click="save">{{ saving ? '保存中…' : '保存能力配置' }}</button></div>
    </template>
    <p v-if="error" class="status-error" role="alert">{{ error }} <button v-if="!config" type="button" class="btn btn-quiet" @click="load">重试</button></p>

    <teleport to="body">
      <div v-if="skillEditor" class="cap-editor-backdrop" @click.self="closeEditors">
        <form class="dialog" role="dialog" aria-modal="true" aria-label="个人 Skill" @submit.prevent="commitSkill">
          <div class="dialog-heading"><div><h2>{{ skillEditor.originalId ? '编辑个人 Skill' : '添加个人 Skill' }}</h2><p>只保存 Markdown 文本。标识会用作文件名。</p></div></div>
          <div class="dialog-body">
            <label class="field"><span class="field-label">标识</span><input v-model="skillEditor.id" maxlength="30" placeholder="my-skill" :disabled="disabled" /></label>
            <label class="field"><span class="field-label">技能说明</span><input v-model="skillEditor.description" maxlength="300" :disabled="disabled" /></label>
            <label class="field"><span class="field-label">Markdown 内容</span><textarea v-model="skillEditor.content" rows="8" maxlength="8000" :disabled="disabled"></textarea></label>
            <label class="capability-check"><input v-model="skillEditor.enabled" type="checkbox" :disabled="disabled" /> 启用</label>
            <p v-if="editorError" class="status-error" role="alert">{{ editorError }}</p>
            <div class="dialog-actions">
              <button type="button" class="btn btn-quiet" @click="closeEditors">取消</button>
              <button type="submit" class="btn btn-solid" :disabled="disabled">加入列表</button>
            </div>
          </div>
        </form>
      </div>
      <div v-if="mcpEditor" class="cap-editor-backdrop" @click.self="closeEditors">
        <form class="dialog" role="dialog" aria-modal="true" aria-label="远程 MCP" @submit.prevent="commitMcp">
          <div class="dialog-heading"><div><h2>{{ mcpEditor.isNew ? '添加远程 MCP' : '编辑远程 MCP' }}</h2><p>公开 HTTPS 端点。Token 留空则保持已保存的值。</p></div></div>
          <div class="dialog-body">
            <label class="field"><span class="field-label">名称</span><input v-model="mcpEditor.name" maxlength="60" :disabled="disabled" /></label>
            <label class="field"><span class="field-label">公开 HTTPS MCP 端点</span><input v-model="mcpEditor.url" type="url" placeholder="https://example.com/mcp" :disabled="disabled" /></label>
            <label class="field"><span class="field-label">Bearer Token（{{ mcpEditor.hasToken ? '已保存，留空保持' : '可选' }}）</span>
              <span class="search-key"><input v-model="mcpEditor.token" :type="shown[mcpEditor.id] ? 'text' : 'password'" autocomplete="new-password" :disabled="disabled" /><button type="button" class="btn btn-quiet" @click="shown[mcpEditor.id] = !shown[mcpEditor.id]">{{ shown[mcpEditor.id] ? '隐藏' : '显示' }}</button></span>
            </label>
            <label class="capability-check"><input v-model="mcpEditor.enabled" type="checkbox" :disabled="disabled" /> 启用</label>
            <label class="capability-check"><input v-model="mcpEditor.useProxy" type="checkbox" :disabled="disabled" /> 使用服务器代理</label>
            <label v-if="mcpEditor.hasToken" class="capability-check"><input v-model="mcpEditor.clearToken" type="checkbox" :disabled="disabled" /> 清除已保存 Token</label>
            <p v-if="editorError" class="status-error" role="alert">{{ editorError }}</p>
            <div class="dialog-actions">
              <button type="button" class="btn btn-quiet" @click="closeEditors">取消</button>
              <button type="submit" class="btn btn-solid" :disabled="disabled">加入列表</button>
            </div>
          </div>
        </form>
      </div>
    </teleport>
  </div>
</template>

<style>
.capabilities-settings h4 { margin: 22px 0 8px; }
.capability-check { display: flex; align-items: center; gap: 8px; margin: 8px 0; font-size: 13px; line-height: 16px; }
.capability-check input { flex: none; margin: 0; }
.capability-skill {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}
.capability-skill input { flex: none; margin: 1px 0 0; }
.capability-skill > span { min-width: 0; }
.capability-skill strong { display: block; font-size: 13px; line-height: 18px; font-weight: 620; }
.capability-skill small { display: block; margin-top: 2px; color: var(--muted); font-size: 12px; line-height: 1.45; }
.capability-row { margin: 10px 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
.capability-row .question-hint { margin: 2px 0 0; }
.capability-file { display: none; }
.cap-editor-backdrop { position: fixed; inset: 0; z-index: 210; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(12, 13, 18, 0.48); }
.cap-editor-backdrop .dialog { width: min(560px, 100%); animation: dialog-in var(--fast) var(--ease); }
.cap-editor-backdrop textarea { width: 100%; min-height: 160px; padding: 8px 12px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--surface-2); color: var(--text); resize: vertical; }
</style>
