import type { Directive } from 'vue'

let observer: IntersectionObserver | undefined

function getObserver() {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('is-visible')
        observer!.unobserve(entry.target)
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
  )
  return observer
}

/** 滚动进入视口时渐入。可传延迟毫秒数做错峰：v-reveal="120" */
export const vReveal: Directive<HTMLElement, number | undefined> = {
  mounted(el, { value }) {
    if (!('IntersectionObserver' in window)) return
    el.classList.add('reveal')
    if (value) el.style.setProperty('--reveal-delay', `${value}ms`)

    // 渐入结束后清掉类和延迟，避免影响元素自身的悬停过渡
    const done = (e: TransitionEvent) => {
      if (e.target !== el || e.propertyName !== 'opacity') return
      el.classList.remove('reveal', 'is-visible')
      el.style.removeProperty('--reveal-delay')
      el.removeEventListener('transitionend', done)
    }
    el.addEventListener('transitionend', done)

    getObserver().observe(el)
  },
  unmounted(el) {
    observer?.unobserve(el)
  },
}
