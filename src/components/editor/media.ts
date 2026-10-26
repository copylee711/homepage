import { InputRule, Node, ResizableNodeView, mergeAttributes } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import { normalizeEmbed, providerOf } from './embeds'

/**
 * 可拖动缩放的图片、网络视频与视频站嵌入。
 *
 * 图片与视频是行内节点：Markdown 里的 <img>、<video> 属于行内 HTML，解析时只保留行内节点；
 * 视频站嵌入的 <iframe> 是块级 HTML，做成块节点。
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
  // 自带的输入规则在生成图片后会把最后敲的“)”再插回去，这里换成自己的：![说明](地址 "标题")。
  addInputRules() {
    return [new InputRule({
      find: /(?:^|[^\\])!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/,
      handler: ({ state, range, match }) => {
        const start = range.from + match[0].indexOf('!')
        state.tr.replaceWith(start, range.to, this.type.create({ alt: match[1] || null, src: match[2], title: match[3] || null }))
      },
    })]
  },
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

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    embed: { setEmbed: (options: { src: string; width?: number }) => ReturnType }
  }
}

/**
 * 视频站播放器（哔哩哔哩、YouTube 等）的 <iframe> 嵌入。默认铺满正文宽度、16:9，可拖动缩放；
 * 保存为 <iframe src width height>，高度按 16:9 由宽度算出。
 */
export const Embed = Node.create({
  name: 'videoEmbed',
  // <iframe> 在 Markdown 里是块级 HTML，嵌入块独占一段；做成行内节点时，前后会多出一行，光标高度异常。
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      width: { default: null, parseHTML: element => width(element.getAttribute('width')) },
    }
  },

  parseHTML() {
    return [{ tag: 'iframe[src]', getAttrs: element => {
      const target = normalizeEmbed((element as HTMLElement).getAttribute('src') ?? '')
      return target ? { src: target.src } : false
    } }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['iframe', mergeAttributes(HTMLAttributes, { frameborder: '0', allowfullscreen: 'true' })]
  },

  renderMarkdown: node => {
    const size = width(node.attrs?.width)
    const dimensions = size ? ` width="${size}" height="${Math.round(size * 9 / 16)}"` : ''
    return `<iframe src="${escape(node.attrs?.src)}"${dimensions} frameborder="0" allowfullscreen></iframe>`
  },

  addCommands() {
    return {
      setEmbed: options => ({ commands }) => commands.insertContent({ type: this.name, attrs: options }),
    }
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const box = document.createElement('div')
      box.className = 'embed-box'
      const tab = document.createElement('div')
      tab.className = 'embed-tab'
      tab.contentEditable = 'false'
      tab.textContent = providerOf(node.attrs.src ?? '')
      tab.title = '点这里选中，可拖动或按 Delete 删除'
      // 播放器里的点击交给视频本身；点标签选中整个嵌入块。
      tab.addEventListener('mousedown', event => {
        event.preventDefault()
        const pos = getPos()
        if (pos !== undefined) editor.chain().focus().setNodeSelection(pos).run()
      })
      const frame = document.createElement('iframe')
      frame.src = node.attrs.src ?? ''
      frame.allowFullscreen = true
      frame.setAttribute('allow', 'fullscreen; picture-in-picture; encrypted-media')
      frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin')
      frame.setAttribute('loading', 'lazy')
      box.append(tab, frame)
      if (node.attrs.width) box.style.width = `${node.attrs.width}px`
      return new ResizableNodeView({
        element: box,
        editor,
        node,
        getPos,
        // 高度由 16:9 的播放器决定；拖动时 ResizableNodeView 会写入高度，这里随时清掉。
        onResize: w => { box.style.width = `${w}px`; box.style.height = '' },
        onCommit: w => {
          box.style.height = ''
          const pos = getPos()
          if (pos === undefined) return
          editor.chain().setNodeSelection(pos).updateAttributes(this.name, { width: Math.round(w) }).run()
        },
        onUpdate: updated => {
          if (updated.type !== node.type) return false
          if (frame.getAttribute('src') !== updated.attrs.src) frame.src = updated.attrs.src ?? ''
          box.style.width = updated.attrs.width ? `${updated.attrs.width}px` : ''
          box.style.height = ''
          return true
        },
        options: { directions: [...RESIZE.directions], min: { width: 200, height: 112 }, preserveAspectRatio: true },
      })
    }
  },
})

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

/**
 * 早期版本把嵌入做成了段落里的行内节点（名为 embed）。协作文档的 Yjs 数据按节点名保存，
 * 直接改成块节点会让旧文档里的这些段落不符合结构而被丢弃，所以保留这个旧节点用来显示与保存，
 * 新插入的都是块节点 videoEmbed。
 */
export const LegacyEmbed = Embed.extend({
  name: 'embed',
  group: 'inline',
  inline: true,
  parseHTML: () => [],
  addCommands: () => ({}),
})
