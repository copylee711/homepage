<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
// @ts-ignore - JS module with no types
import { renderMarkdown } from '../services/markdown.js';
import { bindWidgetFrame, runWidget } from '../services/widgets.js';
import { streamingMarkdown } from '../services/stream-markdown.js';
import { copyText } from '../services/clipboard';
import { useWorkspace } from '../stores/workspace';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';

const props = defineProps<{ source: string; sources?: boolean; fresh?: boolean; streaming?: boolean; citations?:any[] }>();
const host = ref<HTMLElement | null>(null);

let writer: ReturnType<typeof streamingMarkdown> | undefined;

function render() {
  const el = host.value;
  if (!el) return;
  const toggles = Array.from(el.querySelectorAll<HTMLElement>('[data-table-wrap]'));
  const nowrap = toggles.map(button => button.getAttribute('aria-pressed') === 'false');
  const focused = toggles.indexOf(document.activeElement as HTMLElement);
  const options={sources:props.sources,project:useSession().currentProjectId,citations:props.citations};
  if (props.streaming) { writer ||= streamingMarkdown(el,document,options); writer(props.source || '', true,options); }
  else { writer = undefined; el.replaceChildren(renderMarkdown(props.source || '', document, options)); }
  el.querySelectorAll<HTMLElement>('[data-table-wrap]').forEach((button, index) => {
    if (nowrap[index]) setTableWrap(button, false);
    if (index === focused && button !== toggles[index]) button.focus({ preventScroll: true });
  });
}

function setTableWrap(button: HTMLElement, wrap: boolean) {
  button.setAttribute('aria-pressed', String(wrap));
  button.closest('.md-table-wrap')?.classList.toggle('is-nowrap', !wrap);
}

// Delegate copy-code buttons and workspace file links produced by the renderer.
function onClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const widgetAction=target.closest<HTMLElement>('[data-widget-action]');
  if(widgetAction){const wrap=widgetAction.closest<HTMLElement>('[data-widget-source]');if(wrap){let frame=wrap.querySelector('iframe');if(!frame){frame=document.createElement('iframe');frame.title='交互组件';frame.style.height='120px';bindWidgetFrame(frame);wrap.querySelector('.status-error')?.remove();wrap.append(frame);}void runWidget(frame,wrap.dataset.widgetSource||'');}return;}
  const image=target.closest<HTMLElement>('[data-image-preview]');
  if(image){event.preventDefault();useUi().openLightbox({url:image.dataset.imagePreview||'',name:image.querySelector('img')?.alt||'图片预览'});return;}

  // Click on workspace deliverable file reference
  const wsTarget = target.closest('[data-ws-file]') as HTMLElement | null;
  if (wsTarget) {
    const filePath = wsTarget.getAttribute('data-ws-file');
    if (filePath) {
      event.preventDefault();
      event.stopPropagation();
      const proj = useSession().currentProjectId;
      void useWorkspace().locateAndOpenFile(filePath, proj);
      return;
    }
  }

  const wrapToggle = target.closest<HTMLElement>('[data-table-wrap]');
  if (wrapToggle) {
    setTableWrap(wrapToggle, wrapToggle.getAttribute('aria-pressed') !== 'true');
    return;
  }

  const btn = target.closest('[data-copy-code]') as HTMLElement | null;
  if (!btn) return;
  const code = btn.closest('.code-block')?.querySelector('pre code') as HTMLElement | null;
  copyText(code?.textContent || '').then(ok => {
    btn.textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => { btn.textContent = '复制'; }, 1500);
  });
}

onMounted(render);
watch(() => [props.source, props.streaming,props.citations], render);
</script>

<template>
  <div class="md" ref="host" :class="{ 'is-fresh': fresh }" @click="onClick"></div>

</template>
<style>
.md-image{display:inline-flex;max-width:100%;margin:8px 0;border-radius:12px;overflow:hidden;vertical-align:middle;background:var(--surface-2);min-height:48px;}
.md-image img{display:block;max-width:100%;width:auto;max-height:440px;object-fit:contain;}
.md-image.is-failed{padding:14px;color:var(--muted);font-size:13px;}
.md-stream-tail{display:contents;}
.md-widget{margin:18px 0;border:1px solid var(--line);border-radius:16px;overflow:hidden;background:var(--surface);}
.md-widget-pending{border-style:dashed;background:color-mix(in srgb,var(--surface) 68%,transparent);}
.md-widget-pending .md-widget-head{border-bottom:0;padding:14px 16px;color:var(--muted);font-size:12.5px;font-weight:520;}
.md-widget-pending .md-widget-head strong{margin-right:0;font-weight:520;color:var(--muted);}
.md-widget-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);font-size:13px}.md-widget-head strong{margin-right:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.md-widget iframe{display:block;width:100%;height:120px;border:0;overflow:hidden;background:var(--surface)}
@media(max-width:640px){
  .md-widget{margin:10px 0;border:0;border-radius:0;background:transparent;overflow:visible;}
  .md-widget-head{padding:0 0 6px;border-bottom:0;background:transparent;}
  .md-widget iframe{border-radius:12px;}
  .md-widget-pending{border:1px dashed var(--line);border-radius:12px;background:color-mix(in srgb,var(--surface) 68%,transparent);overflow:hidden;}
}
</style>
