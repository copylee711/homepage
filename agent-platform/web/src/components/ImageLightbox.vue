<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { formatBytes } from '../services/format';

const props = defineProps<{
  item: { url: string; name?: string; size?: number };
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const scale = ref(1);

function zoomIn() { scale.value = Math.min(scale.value * 1.25, 4); }
function zoomOut() { scale.value = Math.max(scale.value / 1.25, 0.25); }
function resetZoom() { scale.value = 1; }

function download() {
  const a = document.createElement('a');
  a.href = props.item.url;
  a.download = props.item.name || 'image.png';
  a.click();
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}

onMounted(() => document.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true));
</script>

<template>
  <teleport to="body">
    <div class="iris-lightbox-backdrop" role="dialog" aria-modal="true" :aria-label="item.name || '图片预览'" @click.self="emit('close')">
      <header class="iris-lightbox-bar" @click.stop>
        <div class="iris-lightbox-meta">
          <span class="iris-lightbox-name">{{ item.name || '图片预览' }}</span>
          <span v-if="item.size" class="iris-lightbox-size">{{ formatBytes(item.size) }}</span>
        </div>
        <div class="iris-lightbox-actions">
          <button type="button" class="lightbox-btn" title="缩小" aria-label="缩小" @click="zoomOut">
            <Icon name="zoom-out" :size="16" />
          </button>
          <button type="button" class="lightbox-btn" title="实际尺寸 (100%)" aria-label="重置缩放" @click="resetZoom">
            <span class="lightbox-zoom-text">{{ Math.round(scale * 100) }}%</span>
          </button>
          <button type="button" class="lightbox-btn" title="放大" aria-label="放大" @click="zoomIn">
            <Icon name="zoom-in" :size="16" />
          </button>
          <button type="button" class="lightbox-btn" title="下载图片" aria-label="下载图片" @click="download">
            <Icon name="download" :size="16" />
          </button>
          <button type="button" class="lightbox-btn is-close" title="关闭 (Esc)" aria-label="关闭" @click="emit('close')">
            <Icon name="x" :size="18" />
          </button>
        </div>
      </header>

      <div class="iris-lightbox-content" @click.self="emit('close')">
        <div class="iris-lightbox-img-wrap" :style="{ transform: `scale(${scale})` }">
          <img :src="item.url" :alt="item.name || '预览图片'" class="iris-lightbox-img" referrerpolicy="no-referrer" />
        </div>
      </div>
    </div>
  </teleport>
</template>

<style>
.iris-lightbox-backdrop {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  flex-direction: column;
  background: rgba(8, 9, 12, 0.88);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  animation: lightbox-fade 180ms cubic-bezier(0.16, 1, 0.3, 1);
  user-select: none;
}
@keyframes lightbox-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.iris-lightbox-bar {
  flex: none;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  background: rgba(18, 19, 24, 0.6);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  color: #fff;
}
.iris-lightbox-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.iris-lightbox-name {
  font-size: 14px;
  font-weight: 560;
  color: #f4f4f5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 400px;
}
.iris-lightbox-size {
  font-size: 12px;
  color: #a1a1aa;
  font-variant-numeric: tabular-nums;
}

.iris-lightbox-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.lightbox-btn {
  height: 32px;
  min-width: 32px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: #e4e4e7;
  border: 1px solid rgba(255, 255, 255, 0.08);
  cursor: pointer;
  transition: background-color var(--fast), color var(--fast), transform var(--fast);
}
.lightbox-btn:hover {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
}
.lightbox-btn:active {
  transform: scale(0.96);
}
.lightbox-zoom-text {
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.lightbox-btn.is-close {
  margin-left: 6px;
  background: rgba(255, 255, 255, 0.12);
}
.lightbox-btn.is-close:hover {
  background: rgba(239, 68, 68, 0.85);
  color: #fff;
  border-color: transparent;
}

.iris-lightbox-content {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: 24px;
}
.iris-lightbox-img-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  border-radius: 8px;
  overflow: hidden;
  background-image:
    linear-gradient(45deg, #1f2024 25%, transparent 25%),
    linear-gradient(-45deg, #1f2024 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #1f2024 75%),
    linear-gradient(-45deg, transparent 75%, #1f2024 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0px;
  background-color: #141518;
}
.iris-lightbox-img {
  max-width: min(88vw, 1400px);
  max-height: min(82vh, 900px);
  object-fit: contain;
  display: block;
}
@media (max-width: 860px) {
  .iris-lightbox-backdrop { backdrop-filter: none; -webkit-backdrop-filter: none; }
}
</style>
