// 笔记与文章中的公式：后端输出 TeX 原文，这里用 KaTeX 渲染。仅含公式的页面加载本入口。
import katex from 'katex'
import 'katex/dist/katex.min.css'

for (const el of document.querySelectorAll<HTMLElement>('.prose .math')) {
  const tex = el.textContent ?? ''
  try {
    katex.render(tex.trim(), el, { displayMode: el.classList.contains('block'), throwOnError: false, strict: 'ignore' })
  } catch {
    el.textContent = tex
  }
}
