<script setup lang="ts">
import { computed } from 'vue'
import type { Portal } from '../site.config'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ portal: Portal }>()
const external = computed(() => /^https?:/.test(props.portal.href))

// 把指针位置写进 CSS 变量，供悬停时的网格高光使用
function onPointerMove(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  el.style.setProperty('--mx', `${e.clientX - rect.left}px`)
  el.style.setProperty('--my', `${e.clientY - rect.top}px`)
}
</script>

<template>
  <a
    class="portal"
    :href="portal.href"
    :target="external ? '_blank' : undefined"
    :rel="external ? 'noopener' : undefined"
    @pointermove="onPointerMove"
  >
    <!-- 右上角的线条几何图：进入视口时画出，悬停时各自动一下 -->
    <svg class="art" viewBox="0 0 120 120" aria-hidden="true">
      <!-- Cloud：同心轨道，节点沿轨道滑动 -->
      <template v-if="portal.icon === 'cloud'">
        <circle class="draw" cx="120" cy="0" r="44" pathLength="1" />
        <circle class="draw" cx="120" cy="0" r="72" pathLength="1" style="--d: 1" />
        <circle class="draw" cx="120" cy="0" r="100" pathLength="1" style="--d: 2" />
        <g class="orbit">
          <rect class="node" x="65.6" y="47.4" width="7" height="7" rx="1.5" />
        </g>
      </template>

      <!-- Notes：几行文字，最后一行继续往后写 -->
      <template v-else-if="portal.icon === 'note'">
        <path class="draw" d="M24 30H104" pathLength="1" />
        <path class="draw" d="M24 50H84" pathLength="1" style="--d: 1" />
        <path class="draw" d="M24 70H96" pathLength="1" style="--d: 2" />
        <path class="draw writing" d="M24 90H84" pathLength="1" style="--d: 3" />
        <rect class="node caret" x="60" y="86.5" width="7" height="7" rx="1.5" />
      </template>

      <!-- GitHub：主干与一条分出再合并的分支 -->
      <template v-else>
        <path class="draw" d="M36 8V112" pathLength="1" />
        <path class="draw" d="M36 34C36 54 82 46 82 66C82 86 36 80 36 98" pathLength="1" style="--d: 1" />
        <path class="hot" d="M36 34C36 54 82 46 82 66C82 86 36 80 36 98" pathLength="1" />
        <circle class="dot" cx="36" cy="34" r="3.5" />
        <circle class="dot" cx="36" cy="98" r="3.5" />
        <rect class="node" x="78.5" y="62.5" width="7" height="7" rx="1.5" />
      </template>
    </svg>

    <AppIcon class="icon" :name="portal.icon" />
    <h3 class="name">{{ portal.title }}</h3>
    <p class="desc">{{ portal.description }}</p>
    <span class="foot">
      <span class="hint">{{ portal.hint }}</span>
      <AppIcon class="arrow" name="arrow" />
    </span>
  </a>
</template>

<style scoped>
.portal {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 24px;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  transition:
    border-color 0.3s ease,
    transform 0.4s var(--ease);
}

/* 悬停时指针附近浮现的细网格，与首屏呼应 */
.portal::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(var(--grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
  background-size: 28px 28px;
  -webkit-mask-image: radial-gradient(180px circle at var(--mx, 50%) var(--my, 50%), #000, transparent);
  mask-image: radial-gradient(180px circle at var(--mx, 50%) var(--my, 50%), #000, transparent);
  opacity: 0;
  transition: opacity 0.4s ease;
  pointer-events: none;
}

.art {
  position: absolute;
  top: 0;
  right: 0;
  width: 132px;
  height: 132px;
  fill: none;
  stroke: var(--line-strong);
  stroke-width: 1.2;
  pointer-events: none;
}

/* 线条默认未画出，卡片进入视口（v-reveal 加上 has-revealed）后依次画出 */
.draw,
.hot {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  transition: stroke-dashoffset 1.3s cubic-bezier(0.65, 0, 0.2, 1);
  transition-delay: calc(var(--d, 0) * 130ms + 250ms);
}

.has-revealed .draw {
  stroke-dashoffset: 0;
}

.has-revealed .writing {
  stroke-dashoffset: 0.4;
}

.hot {
  stroke: var(--accent);
  stroke-width: 1.6;
  transition-delay: 0s;
  transition-duration: 0.9s;
}

.node {
  fill: var(--accent);
  stroke: none;
  opacity: 0;
  transition:
    opacity 0.5s ease 0.9s,
    transform 0.9s var(--ease);
}

.has-revealed .node {
  opacity: 1;
}

.dot {
  fill: var(--surface);
  opacity: 0;
  transition: opacity 0.5s ease 0.9s;
}

.has-revealed .dot {
  opacity: 1;
}

.orbit {
  transform-box: view-box;
  transform-origin: 100% 0;
  transition: transform 1.2s var(--ease);
}

.icon {
  position: relative;
  width: 24px;
  height: 24px;
}

.name {
  position: relative;
  margin-top: 40px;
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.desc {
  position: relative;
  margin-top: 4px;
  color: var(--muted);
  font-size: 15px;
}

.foot {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 20px;
}

.hint {
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

.arrow {
  flex: none;
  width: 18px;
  height: 18px;
  color: var(--faint);
  transition:
    transform 0.4s var(--ease),
    color 0.3s ease;
}

@media (hover: hover) {
  .portal:hover {
    border-color: var(--line-strong);
    transform: translateY(-2px);
  }

  .portal:hover::before {
    opacity: 1;
  }

  .portal:hover .arrow {
    color: var(--accent);
    transform: translate(2px, -2px);
  }

  .portal:hover .orbit {
    transform: rotate(-32deg);
  }

  .portal:hover .writing {
    stroke-dashoffset: 0;
    transition-delay: 0s;
    transition-duration: 0.9s;
  }

  .portal:hover .caret {
    transform: translateX(24px);
  }

  .portal:hover .hot {
    stroke-dashoffset: 0;
  }
}
</style>
