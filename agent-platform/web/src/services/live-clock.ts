import { ref, watch } from 'vue';

const now = ref(Date.now());
let subscribers = 0;
let ticker: ReturnType<typeof setInterval>;

export function useLiveClock(active: () => boolean) {
  watch(active, (enabled, _previous, onCleanup) => {
    if (!enabled) return;
    now.value = Date.now();
    if (subscribers++ === 0) ticker = setInterval(() => { now.value = Date.now(); }, 100);
    onCleanup(() => {
      if (--subscribers === 0) clearInterval(ticker);
    });
  }, { immediate: true });
  return now;
}
