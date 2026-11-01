import { defineStore } from 'pinia';

export type Tone = 'info' | 'success' | 'warning' | 'error';
export interface Toast { id: number; message: string; tone: Tone; action?: { label: string; run: () => void } | null; }

function readLS(key: string, fallback: string) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function readNum(key: string, fallback: number) { const v = Number(readLS(key, '')); return Number.isFinite(v) && v > 0 ? v : fallback; }

let toastSeq = 0;

/** Cross-cutting UI state: theme, panel widths & visibility, toasts, which
    dialog/command-palette is open. Components bind to this. */
export const useUi = defineStore('ui', {
  state: () => ({
    theme: (document.documentElement.dataset.theme as 'light' | 'dark') || 'light',
    sidebarOpen: readLS('iris-sidebar', 'open') !== 'closed',
    sidebarW: readNum('iris-sidebar-w', 268),
    workspaceOpen: readLS('iris-workspace', 'closed') === 'open',
    workspaceW: readNum('iris-workspace-w', 360),
    mobileDrawer: null as null | 'sidebar' | 'workspace',
    toasts: [] as Toast[],
    dialog: null as null | string,   // 'provider' | 'grants' | 'webread' | 'shortcuts' | 'packages' | 'toolchains' | 'settings'
    commandOpen: false,
    context: null as null | { x: number; y: number; items: any[] },
  }),
  actions: {
    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = this.theme;
      try { localStorage.setItem('iris-theme', this.theme); } catch {}
    },
    setSidebarOpen(open: boolean) { this.sidebarOpen = open; try { localStorage.setItem('iris-sidebar', open ? 'open' : 'closed'); } catch {} },
    setSidebarW(w: number) { this.sidebarW = Math.max(220, Math.min(420, Math.round(w))); try { localStorage.setItem('iris-sidebar-w', String(this.sidebarW)); } catch {} },
    setWorkspaceOpen(open: boolean) { this.workspaceOpen = open; try { localStorage.setItem('iris-workspace', open ? 'open' : 'closed'); } catch {} },
    setWorkspaceW(w: number) { this.workspaceW = Math.max(280, Math.min(640, Math.round(w))); try { localStorage.setItem('iris-workspace-w', String(this.workspaceW)); } catch {} },
    toast(message: string, opts: { tone?: Tone; action?: Toast['action']; duration?: number } = {}) {
      const id = ++toastSeq;
      const item: Toast = { id, message, tone: opts.tone || 'info', action: opts.action || null };
      this.toasts.push(item);
      const remove = () => { this.toasts = this.toasts.filter(t => t.id !== id); };
      setTimeout(remove, opts.duration || 4800);
      return id;
    },
    dismissToast(id: number) { this.toasts = this.toasts.filter(t => t.id !== id); },
    openDialog(name: string) { this.dialog = name; },
    closeDialog() { this.dialog = null; },
    openCommand() { this.commandOpen = true; },
    closeCommand() { this.commandOpen = false; },
    openContext(event: MouseEvent, items: any[]) {
      const usable = (items || []).filter(Boolean);
      if (!usable.length) return;
      event.preventDefault();
      this.context = { x: event.clientX, y: event.clientY, items: usable };
    },
    closeContext() { this.context = null; },
  },
});
