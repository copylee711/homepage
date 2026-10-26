import { InputRule, Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { shallowRef } from 'vue'
import FileRefView from './FileRefView.vue'

/**
 * 团队文档里引用团队文件：[[文件名]] 显示为文件卡片，![[图.png]] 直接嵌入图片。
 *
 * Markdown 里保存为 [[目标]]：团队里文件名唯一时只写文件名，有同名文件时写完整路径（以 / 开头）。
 * 文件列表由打开文档的页面提供（fileRefs）；不属于团队的文档里没有列表，卡片按原文显示。
 */

export interface RefFile { path: string; name: string; size: number; dir: boolean }
export interface FileRefContext {
  files: RefFile[]
  /** 点击卡片：预览或下载 */
  open: (file: RefFile) => void
  /** 嵌入图片用的地址 */
  url: (file: RefFile) => string
}

export const fileRefs = shallowRef<FileRefContext | null>(null)

const byDepth = (a: RefFile, b: RefFile) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path)

/** 按 [[目标]] 找文件：以 / 开头按路径，否则按文件名（同名时取路径最短的一个）。 */
export function resolveRef(target: string, files = fileRefs.value?.files ?? []): RefFile | undefined {
  const value = target.trim()
  if (value.startsWith('/')) return files.find(file => !file.dir && file.path === value)
  return files.filter(file => !file.dir && file.name === value).sort(byDepth)[0]
}

/** 插入引用时写入的目标：文件名唯一就只写名字，否则写完整路径。 */
export function refTarget(file: RefFile, files = fileRefs.value?.files ?? []) {
  return files.filter(item => !item.dir && item.name === file.name).length > 1 ? file.path : file.name
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i
export const isImage = (name: string) => IMAGE.test(name)

const PATTERN = /^(!?)\[\[([^[\]\n]{1,300})\]\]/

export const FileRef = Node.create({
  name: 'fileRef',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      target: { default: '' },
      embed: { default: false },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-file-ref]', getAttrs: element => ({
      target: (element as HTMLElement).getAttribute('data-file-ref') ?? '',
      embed: (element as HTMLElement).hasAttribute('data-embed'),
    }) }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const attrs = { 'data-file-ref': node.attrs.target, ...(node.attrs.embed ? { 'data-embed': '' } : {}) }
    return ['span', mergeAttributes(HTMLAttributes, attrs), `${node.attrs.embed ? '!' : ''}[[${node.attrs.target}]]`]
  },

  renderText: ({ node }) => `${node.attrs.embed ? '!' : ''}[[${node.attrs.target}]]`,

  markdownTokenizer: {
    name: 'fileRef',
    level: 'inline',
    start: (src: string) => src.search(/!?\[\[/),
    tokenize: (src: string) => {
      const match = PATTERN.exec(src)
      if (!match) return undefined
      return { type: 'fileRef', raw: match[0], target: match[2]!.trim(), embed: match[1] === '!' }
    },
  },

  parseMarkdown: (token, helpers) => helpers.createNode('fileRef', { target: token.target, embed: !!token.embed }),

  renderMarkdown: node => `${node.attrs?.embed ? '!' : ''}[[${node.attrs?.target ?? ''}]]`,

  addInputRules() {
    return [new InputRule({
      find: /(!?)\[\[([^[\]\n]{1,300})\]\]$/,
      handler: ({ state, range, match }) => {
        state.tr.replaceWith(range.from, range.to, this.type.create({ target: match[2]!.trim(), embed: match[1] === '!' }))
      },
    })]
  },

  addNodeView() {
    return VueNodeViewRenderer(FileRefView)
  },
})
