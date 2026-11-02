import { watch, onBeforeUnmount, nextTick, type Ref } from 'vue';

export function useDialogFocus(root: Ref<HTMLElement | null>) {
  let previous: HTMLElement | null = null;
  const controls = () => Array.from(root.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') || []).filter(el => el.getClientRects().length);
  function keydown(event: KeyboardEvent) {
    if (!root.value || event.key !== 'Tab') return;
    if (document.querySelector('.iris-modal') && !root.value.classList.contains('iris-modal')) return;
    const items = controls();
    if (!items.length) { event.preventDefault(); root.value.focus(); return; }
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || !root.value.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !root.value.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
  function restore() {
    document.removeEventListener('keydown', keydown);
    if (previous?.isConnected) previous.focus();
    previous = null;
  }
  watch(root, async value => {
    if (!value) { restore(); return; }
    previous = document.activeElement as HTMLElement;
    document.addEventListener('keydown', keydown);
    await nextTick();
    const target = value.querySelector<HTMLElement>('input') || controls()[0] || value;
    target.focus();
  }, { flush: 'post' });
  onBeforeUnmount(restore);
}
