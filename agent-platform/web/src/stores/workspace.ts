import { defineStore } from 'pinia';
import { get, post, ApiError } from '../services/api';
import { formatBytes } from '../services/format';
import { useUi } from './ui';

export interface OpenFileTab {
  path: string;
  name: string;
  size: number;
  meta: string;
  text: string;
  draft: string;
  revision: string | null;
  binary: boolean;
  truncated: boolean;
  note: string;
  loading: boolean;
  editing: boolean;
  saving: boolean;
  isImage?: boolean;
  imageUrl?: string;
}

export function isImageFile(name: string) {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(name || '');
}

function imageMime(name: string) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    bmp: 'image/bmp', ico: 'image/x-icon',
  };
  return map[ext] || 'image/png';
}

function decodePreview(value: any): { text: string; binary: boolean } {
  try {
    const raw = value.data ?? value.content ?? '';
    const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: value.truncated === true });
    return { text, binary: text.includes('\u0000') };
  } catch {
    return { text: '', binary: true };
  }
}

export function normalizeWsPath(p: string) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

export interface TerminalLine {
  id: number;
  type: 'cmd' | 'output' | 'error' | 'info';
  text: string;
  cwd?: string;
  time: number;
}

let termLineSeq = 0;

export const FILES_TAB = '__files__';
export const TERMINAL_TAB = '__terminal__';

export const useWorkspace = defineStore('workspace', {
  state: () => ({
    path: '',
    allEntries: [] as any[],
    loading: false,
    error: '',
    selected: null as string | null,
    tabs: [] as OpenFileTab[],
    activeTab: FILES_TAB as string,
    terminalOpen: false,
    terminalCwd: '/workspace/default',
    terminalLoading: false,
    terminalLines: [] as TerminalLine[],
    terminalHistory: [] as string[],
    snapshots: new Map<string, any>(),
  }),
  getters: {
    entries(state): any[] {
      return useUi().showHiddenFiles ? state.allEntries : state.allEntries.filter(e => !String(e.name || '').startsWith('.'));
    },
    currentTab(state): OpenFileTab | null {
      return state.tabs.find(t => t.path === state.activeTab) || state.tabs[0] || null;
    },
  },
  actions: {
    async load(path = '', fresh = false) {
      path = normalizeWsPath(path);
      const cached = !fresh ? this.snapshots.get(path) : undefined;
      if (cached) this.apply(cached);
      else this.loading = true;
      this.error = '';
      try {
        const value = await get('/api/files?path=' + encodeURIComponent(path) + (fresh ? '&fresh=1' : ''));
        this.snapshots.set(path, value);
        while (this.snapshots.size > 24) {
          const first = this.snapshots.keys().next().value;
          if (first === undefined) break;
          this.snapshots.delete(first);
        }
        this.apply(value);
      } catch (e: any) {
        this.error = e.message || '无法读取工作区';
      } finally {
        this.loading = false;
      }
    },
    apply(value: any) {
      this.path = normalizeWsPath(value.path);
      this.allEntries = (Array.isArray(value.entries) ? value.entries : [])
        .map((e: any) => ({ ...e, path: normalizeWsPath(e.path) }))
        .filter((e: any) => e.path && !(this.path === '' && (e.name === 'lost+found' || e.path === 'lost+found')));
    },
    navigate(path: string) {
      this.activeTab = FILES_TAB;
      void this.load(normalizeWsPath(path));
    },
    async openFile(path: string, startEditing = false) {
      path = normalizeWsPath(path);
      if (!path) return;
      this.selected = path;
      let tab = this.tabs.find(t => t.path === path);
      if (tab && tab.draft !== tab.text) { this.activeTab = path; return; }
      if (!tab) {
        tab = {
          path,
          name: path.split('/').pop() || path,
          size: 0,
          meta: '正在读取…',
          text: '',
          draft: '',
          revision: null,
          binary: false,
          truncated: false,
          note: '',
          loading: true,
          editing: false,
          saving: false,
        };
        this.tabs.push(tab);
        if (this.tabs.length > 8) {
          const removable = this.tabs.findIndex(t => t.path !== path && t.draft === t.text);
          if (removable >= 0) this.tabs.splice(removable, 1);
        }
      }
      this.activeTab = path;
      await this.reloadTab(path, startEditing);
    },
    async reloadTab(path: string, startEditing = false) {
      const tab = this.tabs.find(t => t.path === path);
      if (!tab) return;
      tab.loading = true;
      tab.note = '';
      try {
        const value = await get('/api/files/preview?path=' + encodeURIComponent(path) + '&limit=' + (isImageFile(tab.name) ? '1048576' : '262144') + '&fresh=1');
        const current = this.tabs.find(t => t.path === path);
        if (!current) return;
        const isImg = isImageFile(current.name);
        const rawB64 = value.data || '';
        const { text, binary } = decodePreview(value);
        current.size = Number(value.size ?? (isImg && rawB64 ? Math.floor(rawB64.length * 0.75) : text.length));
        current.isImage = isImg && !value.truncated;
        current.binary = isImg ? value.truncated === true : binary;
        current.imageUrl = isImg ? (rawB64 ? `data:${imageMime(current.name)};base64,${rawB64}` : `/api/files/download?path=${encodeURIComponent(path)}&inline=1`) : undefined;
        current.truncated = value.truncated === true;
        current.revision = typeof value.revision === 'string' ? value.revision : null;
        current.text = binary ? '' : text;
        current.draft = current.text;
        current.meta = formatBytes(current.size) + (current.truncated ? ' · 已截断' : '');
        current.note = isImg
          ? (value.truncated ? '图片超过 1 MiB 预览上限，文件已保留在工作区。' : '')
          : binary
            ? '二进制或非 UTF-8 文件，无法直接预览文本。'
            : current.truncated
              ? '文件超过 256 KiB，仅展示前 256 KiB（只读）。'
              : '';
        if (startEditing && !binary && !isImg && !current.truncated) current.editing = true;
      } catch (e: any) {
        const current = this.tabs.find(t => t.path === path);
        if (!current) return;
        current.meta = e.message || '读取失败';
        current.note = '无法读取此文件。';
      } finally {
        const current = this.tabs.find(t => t.path === path);
        if (current) current.loading = false;
      }
    },
    async closeTab(path: string, force = false): Promise<boolean> {
      const idx = this.tabs.findIndex(t => t.path === path);
      if (idx < 0) return true;
      const tab = this.tabs[idx];
      if (!force && tab.editing && tab.draft !== tab.text) {
        const ok = await useUi().confirm({
          title: '放弃未保存更改',
          message: `文件“${tab.name}”有未保存的更改，确定放弃并关闭标签页？`,
          confirmText: '放弃并关闭',
          danger: true,
        });
        if (!ok) return false;
      }
      const nextIdx = this.tabs.findIndex(t => t.path === path);
      if (nextIdx >= 0) this.tabs.splice(nextIdx, 1);
      if (this.activeTab === path) {
        const next = this.tabs[nextIdx] || this.tabs[nextIdx - 1];
        this.activeTab = next ? next.path : FILES_TAB;
      }
      if (this.selected === path) this.selected = this.activeTab === FILES_TAB ? null : this.activeTab;
      return true;
    },
    async saveTab(path: string) {
      const tab = this.tabs.find(t => t.path === path);
      if (!tab || tab.saving) return;
      tab.saving = true;
      try {
        const res = await post('/api/files/upload', {
          path: tab.path,
          content: tab.draft,
          overwrite: true,
          revision: tab.revision || undefined,
        });
        tab.text = tab.draft;
        tab.size = new TextEncoder().encode(tab.draft).length;
        tab.meta = formatBytes(tab.size);
        if (res.revision) tab.revision = res.revision;
        this.snapshots.clear();
        void this.load(this.path, true);
      } finally {
        tab.saving = false;
      }
    },
    async upload(name: string, content: string, overwrite: boolean, encoding: 'utf8' | 'base64' = 'utf8', folder = this.path) {
      const clean = name.replace(/[\\/\u0000-\u001f\u007f]/g, '-');
      const target = (folder ? folder + '/' : '') + clean;
      try {
        await post('/api/files/upload', { path: target, content, encoding, overwrite });
      } catch (err: any) {
        if (!overwrite && err instanceof ApiError && err.status === 409) {
          const ok = await useUi().confirm({ title: '覆盖已存在文件', message: `文件“${clean}”已存在，是否覆盖？`, confirmText: '覆盖', danger: true });
          if (!ok) return false;
          await post('/api/files/upload', { path: target, content, encoding, overwrite: true });
        } else {
          throw err;
        }
      }
      this.snapshots.clear();
      await this.load(this.path, true);
      await this.openFile(target);
      return true;
    },
    async createFile(relPath: string) {
      const target = normalizeWsPath(relPath);
      if (!target) return;
      await post('/api/files/upload', { path: target, content: '', overwrite: false });
      this.snapshots.clear();
      await this.load(this.path, true);
      await this.openFile(target, true);
    },
    async createDir(relPath: string) {
      const target = normalizeWsPath(relPath);
      if (!target) return;
      await post('/api/files/manage', { action: 'mkdir', path: target });
      this.snapshots.clear();
      await this.load(this.path, true);
    },
    async renameEntry(oldPath: string, newPath: string) {
      const dest = normalizeWsPath(newPath);
      if (!dest || dest === oldPath) return;
      await post('/api/files/manage', { action: 'move', path: oldPath, destination: dest });
      const tab = this.tabs.find(t => t.path === oldPath);
      if (tab) {
        tab.path = dest;
        tab.name = dest.split('/').pop() || dest;
        if (this.activeTab === oldPath) this.activeTab = dest;
      }
      this.snapshots.clear();
      await this.load(this.path, true);
    },
    async deleteEntry(entryPath: string) {
      await post('/api/files/manage', { action: 'delete', path: entryPath });
      void this.closeTab(entryPath, true);
      this.snapshots.clear();
      await this.load(this.path, true);
    },
    async deleteEntries(paths: string[]) {
      const deleted: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];
      for (const p of paths) {
        try {
          await post('/api/files/manage', { action: 'delete', path: p });
          void this.closeTab(p, true);
          deleted.push(p);
        } catch (err: any) {
          failed.push({ path: p, error: err?.message || '删除失败' });
        }
      }
      this.snapshots.clear();
      await this.load(this.path, true);
      return { deleted, failed };
    },
    async execTerminal(command: string) {
      const cmd = String(command || '').trim();
      if (!cmd) return;
      if (!this.terminalHistory.includes(cmd)) {
        this.terminalHistory.push(cmd);
        if (this.terminalHistory.length > 100) this.terminalHistory.shift();
      }
      this.terminalLines.push({
        id: ++termLineSeq,
        type: 'cmd',
        text: cmd,
        cwd: this.terminalCwd,
        time: Date.now(),
      });
      if (cmd === 'clear') {
        this.terminalLines = [];
        return;
      }
      this.terminalLoading = true;
      try {
        const res = await post('/api/terminal/exec', {
          command: cmd,
          cwd: this.terminalCwd,
        });
        if (typeof res.cwd === 'string' && res.cwd) {
          this.terminalCwd = res.cwd;
        } else if (cmd.startsWith('cd ')) {
          // If response didn't explicitly give cwd, query pwd
          try {
            const check = await post('/api/terminal/exec', {
              command: 'pwd',
              cwd: this.terminalCwd,
            });
            if (check.output?.trim()) this.terminalCwd = check.output.trim();
          } catch {}
        }
        if (res.output) {
          this.terminalLines.push({
            id: ++termLineSeq,
            type: res.exitCode === 0 ? 'output' : 'error',
            text: res.output,
            time: Date.now(),
          });
        }
        // Invalidate snapshots if file-changing command was run
        if (/^(mkdir|touch|rm|mv|cp|git|npm|python|cat\s*>|echo\s*>)/.test(cmd)) {
          this.snapshots.clear();
          void this.load(this.path, true);
        }
      } catch (err: any) {
        this.terminalLines.push({
          id: ++termLineSeq,
          type: 'error',
          text: err.message || '命令执行失败\n',
          time: Date.now(),
        });
      } finally {
        this.terminalLoading = false;
      }
    },
    clearTerminal() {
      this.terminalLines = [];
    },
    setTerminalCwd(cwd: string) {
      this.terminalCwd = cwd || '/workspace';
    },
    async locateAndOpenFile(rawPath: string, preferredProject?: string) {
      if (!rawPath) return;
      let clean = String(rawPath).trim().replace(/^\/workspace\/?/, '').replace(/^\/+/, '');
      // Try opening directly
      try {
        await this.openFile(clean);
        useUi().setWorkspaceOpen(true);
        return;
      } catch {}
      // If not found and a preferredProject is set, try `${preferredProject}/${clean}`
      if (preferredProject && preferredProject !== 'default' && !clean.startsWith(preferredProject + '/')) {
        try {
          const projectPath = `${preferredProject}/${clean}`;
          await this.openFile(projectPath);
          useUi().setWorkspaceOpen(true);
          return;
        } catch {}
      }
      // If still not found, try `default/${clean}`
      if (!clean.startsWith('default/')) {
        try {
          const defPath = `default/${clean}`;
          await this.openFile(defPath);
          useUi().setWorkspaceOpen(true);
          return;
        } catch {}
      }
      // If failed, still open workspace and navigate to current folder
      useUi().setWorkspaceOpen(true);
    },
  },
});
