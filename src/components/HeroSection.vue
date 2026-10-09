<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { site } from '../site.config'
import AppIcon from './AppIcon.vue'
import HeroMark from './HeroMark.vue'

const hero = ref<HTMLElement>()
const glow = ref<HTMLElement>()

// 指针视差：目标值跟随指针，当前值逐帧缓动过去，写进 CSS 变量由样式消费
let frame = 0
const target = { x: 0, y: 0 }
const current = { x: 0, y: 0 }

function tick() {
  current.x += (target.x - current.x) * 0.08
  current.y += (target.y - current.y) * 0.08
  hero.value?.style.setProperty('--px', current.x.toFixed(4))
  hero.value?.style.setProperty('--py', current.y.toFixed(4))

  const settled = Math.abs(target.x - current.x) < 0.001 && Math.abs(target.y - current.y) < 0.001
  frame = settled ? 0 : requestAnimationFrame(tick)
}

function onPointerMove(e: PointerEvent) {
  const el = hero.value
  if (!el || e.pointerType === 'touch') return
  const rect = el.getBoundingClientRect()
  target.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
  target.y = ((e.clientY - rect.top) / rect.height) * 2 - 1
  frame ||= requestAnimationFrame(tick)

  // 网格高光直接跟手，不做缓动
  if (glow.value) {
    const g = glow.value.getBoundingClientRect()
    glow.value.style.setProperty('--gx', `${e.clientX - g.left}px`)
    glow.value.style.setProperty('--gy', `${e.clientY - g.top}px`)
  }
  el.classList.add('is-pointing')
}

function onPointerLeave() {
  target.x = 0
  target.y = 0
  frame ||= requestAnimationFrame(tick)
  hero.value?.classList.remove('is-pointing')
}

onMounted(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  hero.value?.addEventListener('pointermove', onPointerMove)
  hero.value?.addEventListener('pointerleave', onPointerLeave)
})

onBeforeUnmount(() => cancelAnimationFrame(frame))
</script>

<template>
  <section id="top" ref="hero" class="hero">
    <div class="art" aria-hidden="true">
      <div class="art-scroll">
        <div class="grid-lines" />
        <div ref="glow" class="grid-lines grid-glow" />
        <div class="tilt">
          <HeroMark class="mark" />
        </div>
        <div class="front">
          <span class="rule rule-v" />
          <span class="rule rule-h" />
          <span class="node node-a" />
          <span class="node node-b" />
          <span class="node node-c" />
        </div>
      </div>
    </div>

    <div class="container">
      <div class="copy">
        <p class="greeting rise" style="--i: 0">{{ site.greeting }}</p>
        <h1 class="title" :aria-label="site.name">
          <span class="line" aria-hidden="true">
            <span
              v-for="(char, i) in site.name"
              :key="i"
              class="char"
              :style="{ '--c': i }"
              >{{ char }}</span
            >
          </span>
        </h1>
        <p class="roles rise" style="--i: 3">
          <template v-for="(role, i) in site.roles" :key="role">
            <span v-if="i" class="sep">·</span>{{ role }}
          </template>
        </p>
        <p class="intro rise" style="--i: 4">{{ site.intro }}</p>
        <div class="actions rise" style="--i: 5">
          <a class="btn primary" :href="site.notes" target="_blank" rel="noopener">
            Explore Notes
            <AppIcon class="arrow" name="arrow" />
          </a>
          <a class="btn" href="#projects">View Projects</a>
        </div>
      </div>
    </div>

    <a class="cue" href="#portals" aria-label="向下滚动">
      <span />
    </a>
  </section>
</template>

<style scoped>
.hero {
  --px: 0;
  --py: 0;
  position: relative;
  display: flex;
  align-items: center;
  min-height: min(92svh, 820px);
  padding-top: var(--header-h);
  overflow: hidden;
  background: linear-gradient(120deg, var(--bg) 35%, var(--bg-tint));
}

/* 底部渐隐到页面底色，避免首屏的淡蓝渐变与下方内容之间出现一条硬边 */
.hero::after {
  content: '';
  position: absolute;
  inset: auto 0 0;
  height: 38%;
  background: linear-gradient(transparent, var(--bg));
  pointer-events: none;
}

.copy {
  position: relative;
  z-index: 1;
  max-width: 560px;
}

.greeting {
  color: var(--faint);
  font-size: clamp(1.05rem, 2vw, 1.3rem);
  letter-spacing: 0.08em;
}

.title {
  margin-top: 8px;
  font-size: clamp(3.25rem, 9vw, 5.75rem);
  font-weight: 800;
  line-height: 1.05;
  letter-spacing: -0.035em;
}

/* 标题逐字从遮罩下方升起；上下留出余量，避免裁掉 y、p 的下伸部 */
.line {
  display: block;
  margin-block: -0.1em -0.18em;
  padding-block: 0.1em 0.18em;
  overflow: hidden;
  white-space: pre;
}

.char {
  display: inline-block;
  animation: char-up 1s var(--ease) both;
  animation-delay: calc(var(--c) * 45ms + 160ms);
}

@keyframes char-up {
  from {
    transform: translateY(115%) rotate(6deg);
  }
}

.roles {
  margin-top: 16px;
  color: var(--muted);
  font-size: clamp(1.1rem, 2.4vw, 1.5rem);
  letter-spacing: 0.01em;
}

.sep {
  margin-inline: 0.7em;
  color: var(--faint);
}

.intro {
  margin-top: 28px;
  max-width: 22em;
  color: var(--text-2);
  font-size: clamp(1.05rem, 2vw, 1.25rem);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 40px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 13px 26px;
  border-radius: 10px;
  background: var(--surface);
  box-shadow:
    0 0 0 1px var(--line),
    0 4px 14px -6px rgba(17, 24, 39, 0.16);
  font-size: 16px;
  font-weight: 500;
  transition:
    transform 0.3s var(--ease),
    box-shadow 0.3s var(--ease);
}

.btn:hover {
  transform: translateY(-2px);
  box-shadow:
    0 0 0 1px var(--line),
    0 12px 24px -10px rgba(17, 24, 39, 0.28);
}

.btn:active {
  transform: translateY(0);
}

.btn.primary {
  background: var(--btn-bg);
  color: var(--btn-fg);
}

.arrow {
  width: 18px;
  height: 18px;
  transform: rotate(45deg);
  transition: transform 0.4s var(--ease);
}

.btn:hover .arrow {
  transform: rotate(45deg) translate(2px, -2px);
}

/* 底部的滚动提示：一条细线，蓝点沿线下落 */
.cue {
  position: absolute;
  bottom: 28px;
  left: 50%;
  z-index: 1;
  width: 21px;
  height: 52px;
  margin-left: -10px;
  animation: fade 1s ease 2.6s backwards;
}

.cue::before {
  content: '';
  position: absolute;
  inset: 0 10px;
  background: linear-gradient(var(--line-strong), transparent);
}

.cue span {
  position: absolute;
  top: 0;
  left: 8px;
  width: 5px;
  height: 5px;
  border-radius: 1px;
  background: var(--accent);
  animation: cue-drop 2.4s cubic-bezier(0.65, 0, 0.2, 1) 3s infinite;
}

@keyframes cue-drop {
  0% {
    opacity: 0;
    transform: translateY(0);
  }
  20% {
    opacity: 1;
  }
  80%,
  100% {
    opacity: 0;
    transform: translateY(44px);
  }
}

@media (max-height: 640px) {
  .cue {
    display: none;
  }
}

/* 其余文案逐行入场 */
.rise {
  animation: rise 1s var(--ease) both;
  animation-delay: calc(var(--i) * 110ms + 80ms);
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(26px);
  }
}

/* 右侧装饰：字标 + 网格 + 蓝色节点，分三层做指针视差 */
.art {
  position: absolute;
  top: 50%;
  right: max(var(--gutter), calc((100vw - var(--content)) / 2));
  width: min(44vw, 460px);
  aspect-ratio: 1;
  translate: 0 -46%;
  pointer-events: none;
}

.art-scroll {
  position: absolute;
  inset: 0;
}

/* 向下滚动时整组装饰上移并淡出 */
@supports (animation-timeline: scroll()) {
  .art-scroll {
    animation: art-out linear both;
    animation-timeline: scroll(root);
    animation-range: 0 70vh;
  }

  @keyframes art-out {
    to {
      opacity: 0;
      transform: translateY(-70px) scale(0.94);
    }
  }
}

.grid-lines {
  position: absolute;
  inset: -22%;
  background-image:
    linear-gradient(var(--grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
  background-size: 64px 64px;
  -webkit-mask-image: radial-gradient(closest-side, #000 20%, transparent);
  mask-image: radial-gradient(closest-side, #000 20%, transparent);
  translate: calc(var(--px) * -6px) calc(var(--py) * -6px);
  animation: fade 1.8s ease 0.2s both;
}

/* 指针附近的网格线提亮 */
.grid-glow {
  --grid-line: var(--accent);
  -webkit-mask-image: radial-gradient(170px circle at var(--gx, 50%) var(--gy, 50%), #000, transparent);
  mask-image: radial-gradient(170px circle at var(--gx, 50%) var(--gy, 50%), #000, transparent);
  opacity: 0;
  animation: none;
  transition: opacity 0.5s ease;
}

.is-pointing .grid-glow {
  opacity: 0.55;
}

@keyframes fade {
  from {
    opacity: 0;
  }
}

.tilt {
  position: absolute;
  inset: 12% 6% auto;
  transform: perspective(900px) rotateY(calc(var(--px) * 7deg)) rotateX(calc(var(--py) * -7deg));
  translate: calc(var(--px) * 10px) calc(var(--py) * 10px);
}

.mark {
  display: block;
  width: 100%;
  color: var(--mark);
  animation: float 9s ease-in-out 2.4s infinite alternate;
}

@keyframes float {
  to {
    transform: translate3d(0, -10px, 0);
  }
}

.front {
  position: absolute;
  inset: 0;
  translate: calc(var(--px) * 22px) calc(var(--py) * 22px);
}

.rule {
  position: absolute;
}

.rule-v {
  top: -10%;
  bottom: -10%;
  left: 68%;
  width: 1px;
  background: linear-gradient(transparent, var(--accent) 30%, transparent 75%);
  opacity: 0.5;
  transform-origin: top;
  animation: grow-y 1.4s var(--ease) 1.5s backwards;
}

.rule-h {
  right: -10%;
  left: -10%;
  top: 86%;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent) 35%, transparent 80%);
  opacity: 0.3;
  transform-origin: left;
  animation: grow-x 1.4s var(--ease) 1.7s backwards;
}

@keyframes grow-y {
  from {
    transform: scaleY(0);
  }
}

@keyframes grow-x {
  from {
    transform: scaleX(0);
  }
}

.node {
  position: absolute;
  width: 9px;
  height: 9px;
  margin: -4px 0 0 -4px;
  border-radius: 2px;
  background: var(--accent);
  box-shadow: 0 0 0 5px var(--accent-soft);
  animation:
    pop 0.7s var(--ease) backwards,
    pulse 3.6s ease-in-out 3s infinite;
}

.node-a {
  top: 10%;
  left: 68%;
  animation-delay: 2s, 3s;
}

.node-b {
  top: 86%;
  left: 30%;
  animation-delay: 2.2s, 4.2s;
}

.node-c {
  top: 16%;
  left: 14%;
  opacity: 0.35;
  animation-delay: 2.4s, 5.4s;
}

@keyframes pop {
  from {
    opacity: 0;
    transform: scale(0);
  }
}

@keyframes pulse {
  50% {
    box-shadow: 0 0 0 10px transparent;
  }
}

@media (max-width: 859px) {
  .art {
    top: auto;
    right: -14%;
    bottom: -6%;
    width: 72vw;
    translate: none;
    opacity: 0.5;
  }
}
</style>
