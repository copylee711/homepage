import { ref } from 'vue'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'theme'

// 初始值由 index.html 里的内联脚本在首屏绘制前写到 <html data-theme>
const theme = ref<Theme>(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')

function apply(next: Theme) {
  theme.value = next
  document.documentElement.dataset.theme = next
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', next === 'dark' ? '#0c0d10' : '#fcfcfd')
}

function stored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

// 用户没有手动选过时，跟随系统切换
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!stored()) apply(e.matches ? 'dark' : 'light')
})

type TransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> }
}

export function useTheme() {
  /** 切换主题；浏览器支持时，新主题从点击位置以圆形扩散开（样式见 base.css） */
  const toggle = (e?: MouseEvent) => {
    const next = theme.value === 'dark' ? 'light' : 'dark'
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // 隐私模式下存不了就只在本次会话生效
    }

    const doc = document as TransitionDocument
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!doc.startViewTransition || reduced) {
      apply(next)
      return
    }

    const root = document.documentElement
    root.style.setProperty('--vt-x', `${e?.clientX ?? window.innerWidth}px`)
    root.style.setProperty('--vt-y', `${e?.clientY ?? 0}px`)
    // 过渡被跳过或中断时这两个 promise 会 reject，主题本身不受影响，忽略即可
    const transition = doc.startViewTransition(() => apply(next))
    transition.ready.catch(() => {})
    transition.finished.catch(() => {})
    // 过渡的回调要等下一帧；页面不在绘制（如窗口被遮挡）时兜底直接切换
    setTimeout(() => {
      if (theme.value !== next) apply(next)
    }, 400)
  }
  return { theme, toggle }
}
