import { defineStore } from 'pinia';
import { get, post } from '../services/api';

function decodePreview(value: any): { text: string; binary: boolean } {
  try {
    const bytes = Uint8Array.from(atob(value.data || value.content || ''), c => c.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return { text, binary: text.includes('\u0000') };
  } catch { return { text: '', binary: true }; }
}
function normalize(p: string) { return String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); }

export const useWorkspace = defineStore('workspace', {
  state: () => ({
    path: '',
    entries: [] as any[],
    loading: false,
    error: '',
    selected: null as string | null,
    preview: null as null | { name: string; meta: string; text: string; note: string; binary: boolean },
    snapshots: new Map<string, any>(),
    previewSeq: 0,
  }),
  actions: {
    async load(path = '', fresh = false) {
      const cached = this.snapshots.get(path);
      if (cached) { this.apply(cached); } else { this.loading = true; }
      this.error = '';
      try {
        const value = await get('/api/files?path=' + encodeURIComponent(normalize(path)) + (fresh ? '&fresh=1' : ''));
        this.snapshots.set(path, value);
        this.apply(value);
      } catch (e: any) { this.error = e.message || '无法读取工作区'; }
      finally { this.loading = false; }
    },
    apply(value: any) {
      this.path = normalize(value.path);
      this.entries = (Array.isArray(value.entries) ? value.entries : []).map((e: any) => ({ ...e, path: normalize(e.path) })).filter((e: any) => e.path);
    },
    navigate(path: string) { this.preview = null; this.selected = null; void this.load(normalize(path)); },
    async previewFile(path: string) {
      const seq = ++this.previewSeq;
      path = normalize(path);
      this.selected = path;
      this.preview = { name: path.split('/').pop() || path, meta: '正在读取…', text: '', note: '', binary: false };
      try {
        const value = await get('/api/files/preview?path=' + encodeURIComponent(path) + '&limit=' + (64 * 1024));
        if (seq !== this.previewSeq) return;
        const { text, binary } = decodePreview(value);
        this.preview = {
          name: path.split('/').pop() || path,
          meta: (value.size != null ? value.size + ' B' : '') + (value.truncated ? ' · 预览已截断' : ''),
          text: binary ? '' : text, binary,
          note: binary ? '这是二进制或非 UTF-8 文件，无法预览。' : (value.truncated ? '仅预览前 64 KiB。' : ''),
        };
      } catch (e: any) {
        if (seq !== this.previewSeq) return;
        this.preview = { name: path.split('/').pop() || path, meta: e.message, text: '', note: '无法预览此文件。', binary: false };
      }
    },
    closePreview() { this.previewSeq++; this.selected = null; this.preview = null; },
    async upload(name: string, content: string, overwrite: boolean) {
      const target = (this.path ? this.path + '/' : '') + name.replace(/[\\/\u0000-\u001f\u007f]/g, '-');
      await post('/api/files/upload', { path: target, content, overwrite });
      this.snapshots.clear();
      await this.load(this.path);
    },
  },
});
