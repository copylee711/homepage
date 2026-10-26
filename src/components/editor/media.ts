import { Node, ResizableNodeView, mergeAttributes } from '@tiptap/core'
import Image from '@tiptap/extension-image'

/**
 * 可拖动缩放的图片与网络视频。
 *
 * 两者都是行内节点：Markdown 里的 <img>、<video> 属于行内 HTML，解析时只保留行内节点。
 * 设置过宽度的图片保存为 <img width>，否则仍是 ![]()；视频始终保存为 <video>。
 * 发布页的渲染白名单允许这些标签与 width 属性（backend/app/rendering.py）。
 */

const escape = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const width = (value: unknown) => {
  const number = Math.round(Number(value))
  return Number.isFinite(number) && number > 0 ? number : null
}
const RESIZE = { directions: ['left', 'right', 'bottom-left', 'bottom-right'] as const, preserveAspectRatio: true }

export const SizedImage = Image.extend({
  renderMarkdown: node => {
    const { src, alt, title } = node.attrs ?? {}
    const size = width(node.attrs?.width)
    if (size) return `<img src="${escape(src)}" alt="${escape(alt)}"${title ? ` title="${escape(title)}"` : ''} width="${size}">`
    return title ? `![${alt ?? ''}](${src ?? ''} "${title}")` : `![${alt ?? ''}](${src ?? ''})`
  },
}).configure({
  inline: true,
  resize: { enabled: true, directions: [...RESIZE.directions], minWidth: 48, minHeight: 32, alwaysPreserveAspectRatio: true },
})

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    video: { setVideo: (options: { src: string; width?: number }) => ReturnType }
  }
}

export const Video = Node.create({
  name: 'video',
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      width: { default: null, parseHTML: element => width(element.getAttribute('width')) },
    }
  },

  parseHTML() {
    return [
      { tag: 'video[src]' },
      { tag: 'video', getAttrs: element => {
        const source = (element as HTMLElement).querySelector('source[src]')
        return source ? { src: source.getAttribute('src') } : false
      } },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['video', mergeAttributes(HTMLAttributes, { controls: 'true', preload: 'metadata', playsinline: 'true' })]
  },

  renderMarkdown: node => {
    const size = width(node.attrs?.width)
    return `<video src="${escape(node.attrs?.src)}" controls${size ? ` width="${size}"` : ''}></video>`
  },

  addCommands() {
    return {
      setVideo: options => ({ commands }) => commands.insertContent({ type: this.name, attrs: options }),
    }
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const element = document.createElement('video')
      element.controls = true
      element.preload = 'metadata'
      element.playsInline = true
      element.src = node.attrs.src ?? ''
      if (node.attrs.width) element.style.width = `${node.attrs.width}px`
      return new ResizableNodeView({
        element,
        editor,
        node,
        getPos,
        onResize: (w, h) => { element.style.width = `${w}px`; element.style.height = `${h}px` },
        onCommit: w => {
          const pos = getPos()
          if (pos === undefined) return
          element.style.height = ''
          editor.chain().setNodeSelection(pos).updateAttributes(this.name, { width: Math.round(w) }).run()
        },
        onUpdate: updated => {
          if (updated.type !== node.type) return false
          if (element.getAttribute('src') !== updated.attrs.src) element.src = updated.attrs.src ?? ''
          element.style.width = updated.attrs.width ? `${updated.attrs.width}px` : ''
          return true
        },
        options: { directions: [...RESIZE.directions], min: { width: 120, height: 68 }, preserveAspectRatio: true },
      })
    }
  },
})
