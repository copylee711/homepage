<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import Icon from './Icon.vue';
import { fileToBase64 } from '../services/files';
import ModelMenu from './ModelMenu.vue';
import DropMenu from './DropMenu.vue';
import type { MenuItem } from './DropMenu.vue';
import { useSession, type PermissionScope } from '../stores/session';
import { useWorkspace } from '../stores/workspace';
import { useUi } from '../stores/ui';
import { post } from '../services/api';
import { formatBytes } from '../services/format';

const session = useSession();
const ws = useWorkspace();
const ui = useUi();
const text = ref('');
const area = ref<HTMLTextAreaElement | null>(null);
const chipEl = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const modelOpen = ref(false);
const uploading = ref(false);
const dragOver = ref(false);

const isNewSession = computed(() => !session.currentChat);
const projectMenu = ref<{ anchor: HTMLElement; items: MenuItem[] } | null>(null);
const branchMenu = ref<{ anchor: HTMLElement; items: MenuItem[] } | null>(null);
const permissionMenu = ref<{ anchor: HTMLElement; items: MenuItem[] } | null>(null);

const gitInfo = ref<{ isGit: boolean; branch: string; branches: string[] }>({
  isGit: false,
  branch: '',
  branches: [],
});
const gitLoading = ref(false);

async function refreshGitStatus() {
  if (!session.canExecute) return;
  const pid = session.currentProjectId;
  try {
    const res = await session.getGitStatus(pid);
    gitInfo.value = res;
  } catch {
    gitInfo.value = { isGit: false, branch: '', branches: [] };
  }
}

watch(() => session.currentProjectId, () => {
  void refreshGitStatus();
}, { immediate: true });

watch(() => session.chatId, () => {
  void refreshGitStatus();
});

const workspaceRefs = computed(() => session.workspaceRefs || []);
const textQuotes = computed(() => session.textQuotes || []);

const canSend = computed(() => !session.stopping && session.canExecute && (text.value.trim().length > 0 || workspaceRefs.value.length > 0 || textQuotes.value.length > 0));
const placeholder = computed(() => {
  if (!session.canExecute) return '此账户尚未获得 Iris 执行权限';
  if (session.busy) return '补充要求，发送后在下一个处理点接收…';
  if (textQuotes.value.length > 0) return '描述针对引用内容的要求，或直接发送…';
  if (workspaceRefs.value.length > 0) return '描述针对引用文件的要求，或直接发送…';
  return '描述任务，或直接粘贴图片、拖入文件…';
});
const stateText = computed(() => session.busy ? (session.stopping ? '正在停止任务…' : 'Iris 正在处理任务…') : (session.canExecute ? '' : '尚未开通执行权限'));
const effortLabel = computed(() => ({ off: '', low: '低', medium: '中', high: '高', max: '极高' }[ui.thinkingLevel] || ''));

const currentScope = computed(() => session.currentChatPermission.scope || 'project_only');
const executionMode = computed(() => session.currentChatPermission.execution || 'ask');
const executionLabel = computed(() => executionMode.value === 'auto' ? '自动执行' : executionMode.value === 'edit' ? '允许编辑' : '需要审批');

function autosize() {
  const el = area.value; if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 260) + 'px';
}
function onInput() { autosize(); }

async function submit() {
  if (!canSend.value) return;
  const value = text.value;
  if (session.busy) {
    try { await session.steer(value); text.value = ''; await nextTick(); autosize(); }
    catch(e: any) { ui.toast(e.message || '补充指令失败', { tone: 'error' }); }
    return;
  }
  text.value = '';
  await nextTick(); autosize();
  await session.send(value);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Backspace' && !text.value) {
    if (session.workspaceRefs && session.workspaceRefs.length > 0) {
      session.workspaceRefs.pop();
      return;
    }
    if (session.textQuotes && session.textQuotes.length > 0) {
      session.textQuotes.pop();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
}

function pathDir(p: string) {
  const parts = (p || '').split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

function isImage(name: string) {
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name || '');
}

function onChipClick(r: any) {
  if (r.previewUrl || isImage(r.name) || r.type === 'image') {
    ui.openLightbox({
      url: r.previewUrl || ('/api/files/download?path=' + encodeURIComponent(r.path) + '&inline=1'),
      name: r.name,
      size: r.size,
    });
  }
}


function triggerUpload() {
  if (!session.canExecute || uploading.value) return;
  fileInput.value?.click();
}

async function uploadFiles(files: File[]) {
  if (!files || !files.length || !session.canExecute) return;
  uploading.value = true;
  let count = 0;
  for (const file of files) {
    if (file.size > 15 * 1024 * 1024) {
      ui.toast(`文件 ${file.name} 超过 15MB 上限`, { tone: 'error' });
      continue;
    }
    try {
      const base64 = await fileToBase64(file);
      const isImg = isImage(file.name) || file.type.startsWith('image/');
      let safeName = file.name.replace(/[^\w\.\-一-龥]/g, '_');
      if (safeName.startsWith('image.') || safeName === 'image.png') {
        safeName = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.png`;
      }
      const targetPath = `${session.currentProjectId}/uploads/${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}_${safeName}`;

      await post('/api/files/upload', {
        path: targetPath,
        content: base64,
        encoding: 'base64',
        overwrite: false,
      });

      session.addWorkspaceRef({
        path: targetPath,
        name: file.name,
        type: isImg ? 'image' : 'file',
        size: file.size,
        previewUrl: isImg ? URL.createObjectURL(file) : undefined,
        base64: isImg ? base64 : undefined,
        mimeType: isImg ? (file.type || 'image/png') : undefined,
      });
      count++;
    } catch (err: any) {
      ui.toast(`上传 ${file.name} 失败: ${err.message || '网络错误'}`, { tone: 'error' });
    }
  }
  uploading.value = false;
  if (count > 0) {
    ui.toast(count === 1 ? '附件已上传到工作区' : `已上传 ${count} 个附件到工作区`, { tone: 'success' });
  }
}

function onFilesSelected(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files && input.files.length) {
    uploadFiles(Array.from(input.files));
    input.value = '';
  }
}

async function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items || !items.length) return;
  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length > 0) {
    await uploadFiles(files);
    // If only image/file was pasted (no text), prevent default paste
    if (!e.clipboardData.getData('text/plain')) {
      e.preventDefault();
    }
  }
}

function onDrop(e: DragEvent) {
  dragOver.value = false;
  if (e.dataTransfer?.files && e.dataTransfer.files.length) {
    uploadFiles(Array.from(e.dataTransfer.files));
  }
}

function buildProjectMenuItems(anchor: HTMLElement): MenuItem[] {
  const currentPid = session.currentProjectId;
  const isNew = isNewSession.value;
  const items: MenuItem[] = [];

  if (isNew) {
    items.push({ header: '主项目空间 (会话开启后不可变更)' });
    for (const p of session.projects) {
      items.push({
        icon: p.id === currentPid ? 'check' : 'folder',
        label: p.name + (p.id !== p.name && p.id !== 'default' ? ` (${p.id})` : ''),
        action: () => {
          session.newChatProjectId = p.id;
          session.lastProjectId = p.id;
          try { localStorage.setItem('iris-last-project', p.id); } catch {}
          ws.setTerminalCwd(`/workspace/${p.id}`);
          ui.toast(`已将新任务主空间设为“${p.name}”`, { tone: 'info', duration: 1500 });
        },
      });
    }
  } else {
    items.push({
      header: `主项目空间：${session.currentProject?.name || currentPid} (已锁定)`,
    });
  }

  // Subordinate project spaces management (按需添加，右侧切换权限开关 只读/读写)
  const otherProjects = session.projects.filter(p => p.id !== currentPid);
  if (otherProjects.length > 0) {
    items.push({ divider: true });
    items.push({ header: '从属空间授权' });
    const curPerm = session.currentChatPermission;
    const extra = curPerm.extraProjects || {};
    const addedProjects = otherProjects.filter(p => extra[p.id] === 'read' || extra[p.id] === 'write');
    const unaddedProjects = otherProjects.filter(p => !extra[p.id]);

    for (const p of addedProjects) {
      items.push({
        type: 'subordinate',
        disabled: session.busy || currentScope.value === 'full',
        icon: 'folder',
        label: p.name,
        permission: extra[p.id] as 'read' | 'write',
        onSetPermission: (perm: 'read' | 'write') => setSubordinatePermission(p.id, p.name, perm, anchor),
        onRemove: () => removeSubordinate(p.id, p.name, anchor),
      });
    }

    if (unaddedProjects.length > 0) {
      items.push({
        icon: 'plus',
        label: '添加从属项目…',
        disabled: session.busy || currentScope.value === 'full',
        action: () => ui.openDialog('add-subordinate'),
      });
    }
  }

  items.push({ divider: true });
  items.push({
    icon: currentScope.value === 'full' ? 'check' : 'folder',
    label: currentScope.value === 'full' ? '已授权整个 /workspace（点击收回）' : '授权整个 /workspace…',
    disabled: session.busy,
    action: async () => {
      if (currentScope.value === 'full') { await setScope('project_only'); return; }
      const ok = await ui.confirm({ title: '授权整个工作区', message: 'Agent 将能访问你工作区内的所有项目与根目录文件；工具执行仍遵循下方审批模式。', confirmText: '授予访问' });
      if (ok) await setScope('full');
    },
  });
  items.push({
    icon: 'plus',
    label: '新建项目空间',
    action: handleCreateProject,
  });
  return items;
}

function openProjectMenu(e: MouseEvent) {
  const anchor = e.currentTarget as HTMLElement;
  openProjectMenuWithAnchor(anchor);
}

function openProjectMenuWithAnchor(anchor: HTMLElement) {
  projectMenu.value = { anchor, items: buildProjectMenuItems(anchor) };
}

async function setSubordinatePermission(targetProjectId: string, projectName: string, perm: 'read' | 'write', anchor?: HTMLElement) {
  if (session.busy || currentScope.value === 'full') return;
  const curPerm = { ...session.currentChatPermission };
  const extra = { ...(curPerm.extraProjects || {}) };
  if (extra[targetProjectId] === perm) return;
  extra[targetProjectId] = perm;
  const nextPerm = {
    ...curPerm,
    scope: curPerm.scope === 'project_only' ? 'scoped' as PermissionScope : curPerm.scope,
    extraProjects: extra,
  };
  try {
    if (session.chatId && !isNewSession.value) {
      await session.setChatPermission(session.chatId, nextPerm);
    } else {
      session.newChatPermission = nextPerm;
    }
    ui.toast(`已将“${projectName}”权限设为${perm === 'write' ? '读写' : '只读'}`, { tone: 'info', duration: 1500 });
  } catch (err: any) {
    ui.toast(err.message || '更新权限失败', { tone: 'error' });
  }
  if (anchor) {
    openProjectMenuWithAnchor(anchor);
  }
}

async function removeSubordinate(targetProjectId: string, projectName: string, anchor?: HTMLElement) {
  if (session.busy || currentScope.value === 'full') return;
  const curPerm = { ...session.currentChatPermission };
  const extra = { ...(curPerm.extraProjects || {}) };
  delete extra[targetProjectId];
  const nextPerm = {
    ...curPerm,
    extraProjects: extra,
  };
  try {
    if (session.chatId && !isNewSession.value) {
      await session.setChatPermission(session.chatId, nextPerm);
    } else {
      session.newChatPermission = nextPerm;
    }
    ui.toast(`已移除从属空间“${projectName}”授权`, { tone: 'info', duration: 1500 });
  } catch (err: any) {
    ui.toast(err.message || '移除失败', { tone: 'error' });
  }
  if (anchor) {
    openProjectMenuWithAnchor(anchor);
  }
}

function openBranchMenu(e: MouseEvent) {
  if (!gitInfo.value.isGit) return;
  const currentBranch = gitInfo.value.branch;
  const items: MenuItem[] = [
    { header: `Git 分支 (${currentBranch || 'HEAD'})` },
    ...gitInfo.value.branches.map(b => ({
      icon: b === currentBranch ? 'check' : 'git-branch',
      label: b,
      action: () => checkoutBranch(b),
    })),
    { divider: true },
    {
      icon: 'rotate-ccw',
      label: '刷新分支状态',
      action: refreshGitStatus,
    },
  ];
  branchMenu.value = { anchor: e.currentTarget as HTMLElement, items };
}

async function checkoutBranch(targetBranch: string) {
  if (targetBranch === gitInfo.value.branch) return;
  gitLoading.value = true;
  try {
    await session.checkoutGitBranch(targetBranch, session.currentProjectId);
    ui.toast(`已切换至分支 ${targetBranch}`, { tone: 'success' });
    await refreshGitStatus();
  } catch (err: any) {
    ui.toast(err.message || '切换分支失败', { tone: 'error' });
  } finally {
    gitLoading.value = false;
  }
}

function openPermissionMenu(e: MouseEvent) {
  const items: MenuItem[] = [
    { header: '工具执行方式（不改变项目范围）' },
    {
      icon: executionMode.value === 'ask' ? 'check' : 'shield',
      label: '需要审批 · 读取自动放行，修改与命令询问',
      action: () => setExecution('ask'),
    },
    { icon: executionMode.value === 'edit' ? 'check' : 'edit', label: '允许编辑 · 文件修改自动，Bash 需审批', action: () => setExecution('edit') },
    {
      icon: executionMode.value === 'auto' ? 'check' : 'play',
      label: '自动执行 · 在已授权范围内运行',
      action: () => setExecution('auto'),
    },
  ];
  permissionMenu.value = { anchor: e.currentTarget as HTMLElement, items };
}
async function setExecution(execution: 'ask' | 'edit' | 'auto') {
  if (execution === executionMode.value) return;
  if (execution === 'auto' && !await ui.confirm({ title: '启用自动执行', message: '后续工具调用将在已选项目范围内直接执行，不再逐次询问。你仍可随时停止任务。', confirmText: '启用自动执行' })) return;
  const next = { ...session.currentChatPermission, execution };
  try {
    if (session.chatId && (!isNewSession.value || session.busy)) await session.setChatPermission(session.chatId, next);
    else session.newChatPermission = next;
    ui.toast(execution === 'auto' ? '已启用自动执行' : execution === 'edit' ? '已允许文件编辑，Bash 仍需审批' : '已启用风险操作审批', { tone: 'success' });
  } catch (error: any) { ui.toast(error.message || '更新执行方式失败', { tone: 'error' }); }
}

async function setScope(scope: PermissionScope) {
  if (session.busy || scope === currentScope.value) return;
  const nextPerm = {
    ...session.currentChatPermission,
    scope,
  };
  try {
    if (session.chatId && !isNewSession.value) {
      await session.setChatPermission(session.chatId, nextPerm);
    } else {
      session.newChatPermission = nextPerm;
    }
    const nameMap: Record<string, string> = {
      project_only: '项目内编辑',
      scoped: '受限授权',
      full: '完全权限',
    };
    ui.toast(`已切换为“${nameMap[scope]}”`, { tone: 'info', duration: 1500 });
  } catch (err: any) {
    ui.toast(err.message || '更新权限失败', { tone: 'error' });
  }
}

async function handleCreateProject() {
  const nameOrId = await ui.prompt({
    title: '新建项目空间',
    message: '输入项目标识（字母、数字、短横线、中文，1–40 字符）',
    placeholder: '例如 app-backend 或 数据分析',
    confirmText: '创建项目',
  });
  if (!nameOrId?.trim()) return;
  const clean = nameOrId.trim();
  try {
    const created = await session.createProject(clean, clean);
    if (isNewSession.value) {
      session.newChatProjectId = created.id;
      session.lastProjectId = created.id;
      try { localStorage.setItem('iris-last-project', created.id); } catch {}
      ws.setTerminalCwd(`/workspace/${created.id}`);
    }
    ui.toast(`已创建项目空间“${created.name}”`, { tone: 'success' });
  } catch (err: any) {
    ui.toast(err.message || '创建项目空间失败', { tone: 'error' });
  }
}

// Watch draft text from rewind
watch(() => session.draftText, (val) => {
  if (val !== undefined && val !== null && val !== '') {
    text.value = val;
    session.draftText = '';
    nextTick(() => {
      autosize();
      area.value?.focus();
    });
  }
});
</script>

<template>
  <footer class="composer-area" :class="{ 'is-welcome': session.isEmpty }">
    <form novalidate
      class="composer"
      :class="{ 'is-disabled': !session.canExecute, 'is-dragover': dragOver }"
      @submit.prevent="submit"
      @dragover.prevent="dragOver = true"
      @dragleave="dragOver = false"
      @drop.prevent="onDrop"
    >
      <!-- Hidden file input for attachment upload -->
      <input
        ref="fileInput"
        type="file"
        multiple
        class="composer-hidden-input"
        aria-hidden="true"
        tabindex="-1"
        @change="onFilesSelected"
      />

      <!-- ZCode-style persistent protrusion tab bar -->
      <div v-if="session.canExecute" class="composer-project-tab-bar">
        <button
          type="button"
          class="composer-project-tab-btn"
          :title="isNewSession
            ? ('当前任务主空间：' + (session.currentProject?.name || '默认项目') + '（点击切换主空间或管理从属空间）')
            : ('当前任务主空间：' + (session.currentProject?.name || '默认项目') + '（已锁定 · 点击管理从属空间权限）')"
          @click="openProjectMenu"
        >
          <Icon name="folder" :size="13" />
          <span class="composer-project-tab-name">{{ session.currentProject?.name || '默认项目' }}{{ currentScope === 'full' ? ' · 全工作区' : '' }}</span>
          <Icon name="chevron-down" :size="11" class="composer-project-tab-arrow" />
        </button>

        <!-- Git branch tab pill (when primary project space is a git repo) -->
        <button
          v-if="gitInfo.isGit"
          type="button"
          class="composer-project-tab-btn composer-git-tab-btn"
          :class="{ 'is-loading': gitLoading }"
          :title="'当前 Git 分支：' + (gitInfo.branch || 'HEAD') + '（点击切换分支）'"
          @click="openBranchMenu"
        >
          <Icon name="git-branch" :size="12" />
          <span class="composer-project-tab-name">{{ gitInfo.branch || 'detached' }}</span>
          <Icon name="chevron-down" :size="11" class="composer-project-tab-arrow" />
        </button>

        <button
          type="button"
          class="composer-project-tab-add"
          title="新建项目空间"
          aria-label="新建项目空间"
          @click="handleCreateProject"
        >
          <Icon name="plus" :size="13" />
        </button>
      </div>

      <!-- GPT-style quoted text cards -->
      <div v-if="textQuotes.length" class="composer-quotes">
        <div
          v-for="q in textQuotes"
          :key="q.id"
          class="composer-quote-card"
        >
          <div class="composer-quote-text">{{ q.text }}</div>
          <div class="composer-quote-meta">
            <span class="composer-quote-icon"><Icon name="message" :size="11" /></span>
            <span class="composer-quote-source">{{ q.source || '引用内容' }}</span>
          </div>
          <button
            type="button"
            class="composer-quote-remove"
            aria-label="移除引用"
            title="移除"
            @click.stop="session.removeTextQuote(q.id)"
          >
            <Icon name="x" :size="11" />
          </button>
        </div>
      </div>

      <!-- Referenced & uploaded workspace files pills with image thumbnail -->
      <div v-if="workspaceRefs.length" class="composer-chips">
        <div
          v-for="r in workspaceRefs"
          :key="r.path"
          class="composer-chip"
          :class="{ 'is-image': isImage(r.name) || r.type === 'image' || r.previewUrl }"
          :title="(isImage(r.name) || r.type === 'image' || r.previewUrl) ? '点击放大预览 · /workspace/' + r.path : '/workspace/' + r.path"
          @click="onChipClick(r)"
        >
          <span class="composer-chip-icon">
            <img v-if="r.previewUrl" :src="r.previewUrl" class="composer-chip-thumb" alt="" />
            <Icon v-else :name="isImage(r.name) ? 'image' : (r.type === 'dir' ? 'folder' : 'file')" :size="12" />
          </span>
          <span class="composer-chip-name">{{ r.name }}</span>
          <span v-if="r.size" class="composer-chip-size">{{ formatBytes(r.size) }}</span>
          <span v-else-if="pathDir(r.path)" class="composer-chip-dir">{{ pathDir(r.path) }}</span>
          <button
            type="button"
            class="composer-chip-remove"
            aria-label="移除附件"
            title="移除"
            @click.stop="session.removeWorkspaceRef(r.path)"
          >
            <Icon name="x" :size="11" />
          </button>
        </div>
      </div>

      <textarea style="resize: none"
        ref="area"
        v-model="text"
        rows="1"
        maxlength="20000"
        :placeholder="placeholder"
        :disabled="!session.canExecute"
        aria-label="给 Iris 的任务"
        @input="onInput"
        @keydown="onKeydown"
        @paste="onPaste"
      ></textarea>

      <div class="composer-bar">
        <!-- Revamped '+' button: Upload attachments / photos / PDF / docs directly to workspace -->
        <button
          type="button"
          class="composer-icon-btn"
          :class="{ 'is-uploading': uploading }"
          aria-label="上传附件"
          title="上传附件 (支持图片、PDF、Word文档等)"
          :disabled="uploading"
          @click="triggerUpload"
        >
          <span v-if="uploading" class="composer-upload-spin" aria-hidden="true"></span>
          <Icon v-else name="plus" :size="18" />
        </button>

        <!-- Simplified Permission Chip: pops up a lightweight DropMenu to switch permission scopes -->
        <button
          v-if="session.canExecute"
          type="button"
          class="composer-project-chip"
          :title="'工具执行方式：' + executionLabel"
          @click="openPermissionMenu"
        >
          <Icon :name="executionMode === 'auto' ? 'play' : 'shield'" :size="12" />
          <span class="composer-project-label">{{ executionLabel }}</span>
          <Icon name="chevron-down" :size="10" class="composer-project-arrow" />
        </button>

        <span class="composer-spacer"></span>
        <span v-if="text.length > 16000" class="composer-count">{{ text.length }} / 20000</span>
        <button ref="chipEl" type="button" class="model-chip" title="切换模型与思考强度" @click="modelOpen = !modelOpen">
          <span class="model-chip-label">{{ session.modelLabel }}</span>
          <span v-if="effortLabel" class="model-chip-effort">{{ effortLabel }}</span>
          <Icon name="chevron-down" :size="12" />
        </button>
        <button
          v-if="session.busy"
          type="button"
          class="stop"
          :class="{ 'is-stopping': session.stopping }"
          :disabled="session.stopping"
          aria-label="停止任务"
          title="停止任务"
          @click="session.stop()"
        >
          <span class="stop-square" aria-hidden="true"></span>
        </button>
        <button v-if="!session.busy || text.trim()" type="submit" class="send" :disabled="!canSend" :aria-label="session.busy ? '补充指令' : '发送任务'" :title="session.busy ? '补充指令' : '发送任务'"><Icon name="arrow-up" :size="17" /></button>
      </div>
    </form>
    <ModelMenu v-if="modelOpen && chipEl" :anchor="chipEl" @close="modelOpen = false" />
    <DropMenu v-if="projectMenu" :anchor="projectMenu.anchor" :items="projectMenu.items" label="项目空间选项" @close="projectMenu = null" />
    <DropMenu v-if="branchMenu" :anchor="branchMenu.anchor" :items="branchMenu.items" label="Git 分支" @close="branchMenu = null" />
    <DropMenu v-if="permissionMenu" :anchor="permissionMenu.anchor" :items="permissionMenu.items" label="Agent 权限" up @close="permissionMenu = null" />
  </footer>
</template>

<style>
.composer-area { flex: none; padding: 6px clamp(16px, 4vw, 40px) max(10px, env(safe-area-inset-bottom)); background: linear-gradient(to top, var(--bg) 70%, transparent); transition: padding-bottom 350ms var(--ease); }
.composer-area.is-welcome { padding-bottom: clamp(60px, calc(50dvh - 145px), 320px); }
@media (max-width: 860px) {
  .composer-area.is-welcome { padding-bottom: max(20px, calc(50dvh - 142px)); }
}
.composer {
  position: relative;
  max-width: 760px;
  margin: 0 auto;
  padding: 11px 13px 9px 17px;
  border: 1px solid var(--line-2);
  border-radius: 24px;
  background: var(--surface);
  box-shadow: var(--shadow);
  transition: border-color var(--fast), box-shadow var(--fast), background-color var(--fast);
}
.composer:focus-within { border-color: var(--line-focus); }
.composer.is-dragover { border-color: var(--accent); background: var(--accent-softer); box-shadow: 0 0 0 3px var(--accent-soft); }
.composer-hidden-input { display: none; }

/* ZCode-style project tab protrusion (only on new session page) */
.composer-project-tab-bar {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 12px;
  display: flex;
  align-items: center;
  gap: 5px;
  z-index: 3;
  pointer-events: auto;
  animation: comp-tab-in 160ms var(--ease);
}
@keyframes comp-tab-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
.composer-project-tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px 0 8px;
  border-radius: 8px;
  border: 1px solid var(--line-2);
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  transition: background-color var(--fast), border-color var(--fast), color var(--fast), transform var(--fast);
  max-width: 260px;
}
.composer-project-tab-btn:hover {
  background: color-mix(in srgb, var(--text) 4%, var(--surface));
  border-color: var(--line-strong);
  color: var(--text);
}
.composer-project-tab-btn:active {
  transform: scale(0.98);
}
.composer-project-tab-btn svg {
  flex: none;
  color: var(--muted);
  transition: color var(--fast);
}
.composer-project-tab-btn:hover svg {
  color: var(--text);
}
.composer-project-tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.composer-project-tab-arrow {
  opacity: 0.65;
  margin-left: -1px;
}
.composer-project-tab-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: 1px solid var(--line-2);
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  transition: background-color var(--fast), border-color var(--fast), color var(--fast), transform var(--fast);
}
.composer-project-tab-add:hover {
  background: color-mix(in srgb, var(--text) 4%, var(--surface));
  border-color: var(--line-strong);
  color: var(--text);
}
.composer-project-tab-add:active {
  transform: scale(0.96);
}

.composer-quotes { display: flex; flex-wrap: wrap; align-items: stretch; gap: 7px; padding: 2px 1px 8px; animation: comp-chips-in 160ms var(--ease); }
.composer-quote-card {
  position: relative;
  flex: 0 1 250px;
  max-width: 320px;
  min-width: 140px;
  padding: 8px 24px 7px 11px;
  border-radius: 12px;
  border: 1px solid var(--line-2);
  background: color-mix(in srgb, var(--surface) 65%, var(--sidebar));
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
  transition: border-color var(--fast), background-color var(--fast);
}
.composer-quote-card:hover { border-color: var(--line-strong); }
.composer-quote-text {
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-line;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.composer-quote-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 5px;
  color: var(--muted);
  font-size: 11px;
  user-select: none;
}
.composer-quote-icon { display: grid; place-items: center; color: var(--faint); }
.composer-quote-source { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.composer-quote-remove {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--faint);
  transition: background-color var(--fast), color var(--fast);
}
.composer-quote-remove:hover {
  background: color-mix(in srgb, var(--text) 10%, transparent);
  color: var(--text);
}

.composer-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; padding: 1px 1px 7px; animation: comp-chips-in 160ms var(--ease); }
@keyframes comp-chips-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
.composer-chip { display: inline-flex; align-items: center; gap: 5px; max-width: 260px; height: 26px; padding: 0 5px 0 8px; border-radius: 8px; border: 1px solid var(--line-2); background: color-mix(in srgb, var(--surface) 60%, var(--sidebar)); color: var(--text-2); font-size: 12px; font-weight: 520; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03); transition: border-color var(--fast), background-color var(--fast); }
.composer-chip:hover { border-color: var(--line-strong); color: var(--text); }
.composer-chip.is-image { cursor: pointer; }
.composer-chip.is-image:hover { border-color: var(--line-focus); }
.composer-chip-icon { flex: none; display: grid; place-items: center; color: var(--muted); }
.composer-chip-thumb { width: 18px; height: 18px; object-fit: cover; border-radius: 4px; }
.composer-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer-chip-size { flex: none; color: var(--faint); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.composer-chip-dir { flex: none; color: var(--faint); font-size: 10.5px; }
.composer-chip-remove { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 17px; height: 17px; margin-left: 2px; border-radius: 5px; color: var(--faint); transition: background-color var(--fast), color var(--fast); }
.composer-chip-remove:hover { background: color-mix(in srgb, var(--text) 10%, transparent); color: var(--text); }

.composer textarea { display: block; width: 100%; min-height: 28px; max-height: 260px; padding: 2px 1px; border: 0; outline: 0; resize: none; overflow-y: auto; background: transparent; color: var(--text); font-size: 15px; line-height: 1.65; }
.composer textarea::placeholder { color: var(--muted); }
.composer textarea:disabled { opacity: 0.6; }
.composer-bar { display: flex; align-items: center; gap: 8px; min-height: 36px; margin-top: 6px; }
.composer-spacer { flex: 1; }
.composer-icon-btn { width: 32px; height: 32px; flex: none; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); transition: background-color var(--fast), color var(--fast), border-color var(--fast); }
.composer-icon-btn:hover { background: color-mix(in srgb, var(--text) 5%, transparent); color: var(--text); border-color: var(--line-2); }
.composer-icon-btn.is-uploading { pointer-events: none; opacity: 0.7; }
.composer-upload-spin { width: 14px; height: 14px; border: 1.8px solid var(--muted); border-top-color: transparent; border-radius: 50%; animation: comp-spin 0.65s linear infinite; }
@keyframes comp-spin { to { transform: rotate(360deg); } }

.composer-project-chip {
  height: 30px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text-2);
  font-size: 11.5px;
  font-weight: 520;
  cursor: pointer;
  transition: border-color var(--fast), background-color var(--fast), color var(--fast);
  flex: none;
}
.composer-project-chip:hover {
  border-color: var(--line-2);
  background: color-mix(in srgb, var(--text) 4%, transparent);
  color: var(--text);
}
.composer-project-label {
  white-space: nowrap;
}
.composer-project-arrow {
  opacity: 0.6;
  margin-left: -2px;
}
.composer-git-tab-btn {
  max-width: 200px;
}
.composer-git-tab-btn.is-loading {
  opacity: 0.6;
  pointer-events: none;
}
@media (max-width: 640px) {
  .composer-project-tab-bar {
    left: 8px;
    bottom: calc(100% + 6px);
  }
  .composer-project-tab-btn {
    max-width: 170px;
    height: 25px;
    padding: 0 8px 0 7px;
    font-size: 11px;
  }
  .composer-project-tab-add {
    width: 25px;
    height: 25px;
  }
  .composer-project-chip {
    width: 32px;
    height: 32px;
    padding: 0;
    justify-content: center;
  }
  .composer-project-chip svg {
    width: 15px;
    height: 15px;
  }
  .composer-project-label,
  .composer-project-arrow {
    display: none;
  }
}

.composer-count { flex: none; color: var(--faint); font-size: 10px; font-variant-numeric: tabular-nums; }
.model-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 256px; height: 30px; padding: 0 9px 0 10px; overflow: hidden; border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--text-2); font-size: 11.5px; font-weight: 520; transition: border-color var(--fast), background-color var(--fast); }
.model-chip:hover { border-color: var(--line-2); background: color-mix(in srgb, var(--text) 4%, transparent); }
.model-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-chip-effort { flex: none; padding: 1px 5.5px; border-radius: 5px; background: color-mix(in srgb, var(--text) 5.5%, transparent); color: var(--muted); font-size: 10px; font-weight: 600; line-height: 1.35; }
.model-chip svg { color: var(--faint); }
.send { flex: none; width: 36px; height: 36px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--ink); color: var(--surface); transition: transform var(--fast), opacity var(--fast), filter var(--fast); }
.send:hover:not(:disabled) { filter: brightness(1.12); }
.send:active:not(:disabled) { transform: scale(0.94); }
.send:disabled { opacity: 0.25; }
.stop {
  flex: none;
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow-sm);
  transition: transform var(--fast), background-color var(--fast), border-color var(--fast), opacity var(--fast);
}
.stop:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 8%, var(--surface));
  border-color: color-mix(in srgb, var(--danger) 40%, var(--line-strong));
  color: var(--danger);
  transform: scale(1.04);
}
.stop:active:not(:disabled) {
  transform: scale(0.94);
}
.stop.is-stopping {
  opacity: 0.5;
  pointer-events: none;
}
.stop-square {
  width: 11px;
  height: 11px;
  border-radius: 2.5px;
  background: currentColor;
}
</style>
