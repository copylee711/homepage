import { defineStore } from 'pinia';

export type Tone = 'info' | 'success' | 'warning' | 'error';
export type SettingsTab = 'general' | 'providers' | 'grants' | 'packages' | 'toolchains' | 'archived' | 'shortcuts';
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';
export interface Toast { id: number; message: string; tone: Tone; action?: { label: string; run: () => void } | null; }

export interface LightboxState {
  url: string;
  name?: string;
  size?: number;
}

export interface ModalState {
  kind: 'confirm' | 'prompt';
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  maxLength?: number;
  resolve: (value: any) => void;
}

const VALID_THINKING: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];

function readLS(key: string, fallback: string) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function readNum(key: string, fallback: number) { const v = Number(readLS(key, '')); return Number.isFinite(v) && v > 0 ? v : fallback; }
function readThinking(): ThinkingLevel {
  const v = readLS('iris-thinking', 'medium') as ThinkingLevel;
  return VALID_THINKING.includes(v) ? v : 'medium';
}

let toastSeq = 0;
let themeTimer: ReturnType<typeof setTimeout> | null = null;

export const useUi = defineStore('ui', {
  state: () => ({
    theme: (document.documentElement.dataset.theme as 'light' | 'dark') || 'light',
    thinkingLevel: readThinking() as ThinkingLevel,
    sidebarOpen: readLS('iris-sidebar', 'open') !== 'closed',
    sidebarW: readNum('iris-sidebar-w', 264),
    workspaceOpen: readLS('iris-workspace', 'closed') === 'open',
    workspaceW: readNum('iris-workspace-w', 380),
    workspaceDual: readLS('iris-workspace-dual', 'off') === 'on',
    chatDensity: (readLS('iris-chat-density', 'cozy') as 'cozy' | 'compact'),
    chatGroupByDate: readLS('iris-chat-group', 'on') !== 'off',
    mobileDrawer: null as null | 'sidebar' | 'workspace',
    toasts: [] as Toast[],
    dialog: null as null | string,
    settingsTab: 'general' as SettingsTab,
    commandOpen: false,
    context: null as null | { x: number; y: number; items: any[] },
    modal: null as ModalState | null,
    lightbox: null as LightboxState | null,
  }),
  actions: {
    setTheme(next: 'light' | 'dark', event?: MouseEvent) {
      if (this.theme === next) return;
      const root = document.documentElement;
      const apply = () => {
        this.theme = next;
        root.dataset.theme = next;
        try { localStorage.setItem('iris-theme', next); } catch {}
      };
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      const startVT = (document as any).startViewTransition?.bind(document);
      if (startVT && !reduce) {
        const x = event?.clientX ?? Math.round(window.innerWidth - 68);
        const y = event?.clientY ?? 29;
        const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
        root.classList.add('vt-theme');
        try {
          const vt = startVT(() => { apply(); });
          vt.ready?.then(() => {
            root.animate(
              { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${Math.ceil(endRadius)}px at ${x}px ${y}px)`] },
              { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
            );
          }).catch(() => {});
          vt.finished?.finally(() => root.classList.remove('vt-theme'));
          return;
        } catch {
          root.classList.remove('vt-theme');
        }
      }
      if (!reduce) {
        if (themeTimer) clearTimeout(themeTimer);
        root.classList.add('theme-transitioning');
        themeTimer = setTimeout(() => { root.classList.remove('theme-transitioning'); themeTimer = null; }, 340);
      }
      apply();
    },
    toggleTheme(event?: MouseEvent) {
      this.setTheme(this.theme === 'dark' ? 'light' : 'dark', event);
    },
    setThinkingLevel(level: ThinkingLevel) {
      if (!VALID_THINKING.includes(level)) return;
      this.thinkingLevel = level;
      try { localStorage.setItem('iris-thinking', level); } catch {}
    },
    setSidebarOpen(open: boolean) { this.sidebarOpen = open; try { localStorage.setItem('iris-sidebar', open ? 'open' : 'closed'); } catch {} },
    setSidebarW(w: number) { this.sidebarW = Math.max(220, Math.min(420, Math.round(w))); try { localStorage.setItem('iris-sidebar-w', String(this.sidebarW)); } catch {} },
    setWorkspaceOpen(open: boolean) { this.workspaceOpen = open; try { localStorage.setItem('iris-workspace', open ? 'open' : 'closed'); } catch {} },
    setWorkspaceW(w: number) {
      const max = this.workspaceDual ? 920 : 680;
      const min = this.workspaceDual ? 520 : 300;
      this.workspaceW = Math.max(min, Math.min(max, Math.round(w)));
      try { localStorage.setItem('iris-workspace-w', String(this.workspaceW)); } catch {}
    },
    setWorkspaceDual(dual: boolean) {
      this.workspaceDual = dual;
      try { localStorage.setItem('iris-workspace-dual', dual ? 'on' : 'off'); } catch {}
      if (dual && this.workspaceW < 560) this.setWorkspaceW(620);
      else if (!dual && this.workspaceW > 520) this.setWorkspaceW(380);
    },
    setChatDensity(density: 'cozy' | 'compact') {
      this.chatDensity = density;
      try { localStorage.setItem('iris-chat-density', density); } catch {}
    },
    toggleChatDensity() {
      this.setChatDensity(this.chatDensity === 'compact' ? 'cozy' : 'compact');
    },
    setChatGroupByDate(on: boolean) {
      this.chatGroupByDate = on;
      try { localStorage.setItem('iris-chat-group', on ? 'on' : 'off'); } catch {}
    },
    toggleChatGroupByDate() {
      this.setChatGroupByDate(!this.chatGroupByDate);
    },
    toast(message: string, opts: { tone?: Tone; action?: Toast['action']; duration?: number } = {}) {
      const id = ++toastSeq;
      const item: Toast = { id, message, tone: opts.tone || 'info', action: opts.action || null };
      this.toasts.push(item);
      const remove = () => { this.toasts = this.toasts.filter(t => t.id !== id); };
      setTimeout(remove, opts.duration || 4800);
      return id;
    },
    dismissToast(id: number) { this.toasts = this.toasts.filter(t => t.id !== id); },
    openSettings(tab: SettingsTab = 'general') { this.settingsTab = tab; this.dialog = 'settings'; },
    openDialog(name: string) {
      const tabMap: Record<string, SettingsTab> = {
        provider: 'providers', providers: 'providers', grants: 'grants',
        packages: 'packages', toolchains: 'toolchains', archived: 'archived', shortcuts: 'shortcuts',
      };
      if (tabMap[name]) { this.openSettings(tabMap[name]); return; }
      this.dialog = name;
    },
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
    confirm(opts: string | { title: string; message?: string; confirmText?: string; cancelText?: string; danger?: boolean }): Promise<boolean> {
      if (this.modal) this.modal.resolve(this.modal.kind === 'confirm' ? false : null);
      const normalized = typeof opts === 'string' ? { title: '确认操作', message: opts } : opts;
      return new Promise<boolean>((resolve) => {
        this.modal = { kind: 'confirm', ...normalized, resolve };
      });
    },
    prompt(opts: { title: string; message?: string; defaultValue?: string; placeholder?: string; confirmText?: string; cancelText?: string; maxLength?: number }): Promise<string | null> {
      if (this.modal) this.modal.resolve(this.modal.kind === 'confirm' ? false : null);
      return new Promise<string | null>((resolve) => {
        this.modal = { kind: 'prompt', ...opts, resolve };
      });
    },
    resolveModal(value: any) {
      const cur = this.modal;
      this.modal = null;
      cur?.resolve(value);
    },
    openLightbox(opts: { url: string; name?: string; size?: number } | string) {
      if (typeof opts === 'string') this.lightbox = { url: opts };
      else this.lightbox = opts;
    },
    closeLightbox() {
      this.lightbox = null;
    },
  },
});
