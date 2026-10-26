<script setup lang="ts">
/**
 * 所见即所得的 Markdown 编辑器：输入 Markdown 语法即时变成格式（类似 Typora），也可以切到源码模式。
 *
 * 两种用法：
 * - 普通模式：v-model 绑定 Markdown 字符串，用于文章与笔记。只有用户真正编辑后才回写，打开不改动原文。
 * - 协作模式：传入 collab（Yjs 文档与 y-websocket 连接），内容由 Yjs 同步，显示其他人的光标。
 */
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { Editor, EditorContent, Extension, InputRule, VueNodeViewRenderer } from '@tiptap/vue-3'
import { NodeSelection, Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Schema } from '@tiptap/pm/model'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { BubbleMenu } from '@tiptap/vue-3/menus'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Embed, LegacyEmbed, SizedImage, Video } from './media'
import { normalizeEmbed, parseVideoInput } from './embeds'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import { Placeholder } from '@tiptap/extensions'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { common, createLowlight } from 'lowlight'
import katex from 'katex'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import latex from 'highlight.js/lib/languages/latex'
import matlab from 'highlight.js/lib/languages/matlab'
import nginx from 'highlight.js/lib/languages/nginx'
import powershell from 'highlight.js/lib/languages/powershell'
import { confirmDialog, promptDialog } from '../../composables/useConfirm'
import type * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import 'katex/dist/katex.min.css'
import CodeBlockView from './CodeBlockView.vue'
import './editor.css'

/** 协作模式的参数；不带 provider 时只显示这份 Yjs 文档（如查看历史版本）。 */
export interface CollabOptions { doc: Y.Doc; provider?: WebsocketProvider; user?: { name: string; color: string } }

const props = withDefaults(defineProps<{
  modelValue?: string
  collab?: CollabOptions
  editable?: boolean
  placeholder?: string
  /** 粘贴或拖入图片时上传，返回图片地址；不提供则只能插入图片链接。 */
  upload?: (file: File) => Promise<string>
}>(), { modelValue: '', editable: true, placeholder: '输入 / 插入内容，或直接用 Markdown 语法书写…' })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const lowlight = createLowlight(common)
// 语言选择里有、但 lowlight 常用集没有的语法，单独注册。
lowlight.register({ dockerfile, latex, matlab, nginx, powershell })
const source = ref(false)
const sourceText = ref('')
const notice = ref('')
const slash = ref<{ query: string; from: number; left: number; top: number; index: number } | null>(null)

// 可视化编辑无法原样保留的语法：原始 HTML、脚注与引用式链接，以及夹在文字中间的 $$行内公式$$
// （编辑器会把它拆成独立的公式块）。遇到时默认进入源码模式，避免保存时改变原文。
const LOSSY = /<\/?[a-zA-Z][\w-]*(\s[^>]*)?>|^\[\^?[^\]]+\]:\s|[^\s$][^\S\n]*\$\$[^$\n]+\$\$/m
function lossy(markdown: string) {
  // <img>、<video>（含 <source>）编辑器能原样保留，不算可能丢失的内容。
  // 白名单里的视频站 <iframe> 同样能保留，其他 iframe 仍按可能丢失处理。
  const media = /<\/?(?:img|video|source)\b[^>]*>|<iframe\b[^>]*\ssrc=["']([^"']+)["'][^>]*>\s*<\/iframe>/gi
  markdown = markdown.replace(media, (tag, src?: string) => (src && !normalizeEmbed(src) ? tag : ''))
  return LOSSY.test(markdown.replace(/```[\s\S]*?```|`[^`\n]*`/g, ''))
}

// 贴近 Typora 的输入习惯：$公式$ 即时变成行内公式（首尾不能是空格，避免把“$5 到 $6”当成公式），
// 一行只写 ```语言 后按回车开始代码块；常用格式都有与 Typora 相同的快捷键。
// 浏览器占用的组合键（Ctrl+T、Ctrl+1–6 等）改用 Tiptap 自带的 Ctrl+Alt 版本。
// 行内公式 $…$：左右的 $ 紧挨内容（不能是空格），前面不是 $、反斜杠或字母数字。
const INLINE_MATH = /(?:^|[^$\\\w])\$([^\s$￼](?:[^$\n￼]*[^\s$￼])?)\$(?!\$)/g
// 行内代码 `…`：前后不是反引号（避免误伤 ``` 代码块围栏）。
const INLINE_CODE = /(?:^|[^`])`([^`\n\uFFFC]+)`(?!`)/g
// Markdown \u94FE\u63A5 [\u6587\u5B57](\u5730\u5740)\uFF1B\u524D\u9762\u662F ! \u7684\u662F\u56FE\u7247\uFF0C\u4E0D\u5904\u7406\u3002
const INLINE_LINK = /(?:^|[^!\\])\[([^\]\n\uFFFC]*)\]\(([^)\s\uFFFC]+)\)/g
// \u6CA1\u5199\u534F\u8BAE\u7684\u5730\u5740\uFF08\u5982 github.com\uFF09\u8865\u4E0A https://\uFF1B\u7AD9\u5185\u8DEF\u5F84\u3001\u951A\u70B9\u4E0E mailto: \u7B49\u4FDD\u6301\u539F\u6837\u3002
const fullHref = (url: string) => (/^([a-z][\w+.-]*:|\/|#)/i.test(url) ? url : `https://${url}`)
// \u94FE\u63A5\u6587\u5B57\u4E3A\u7A7A\u65F6\u663E\u793A\u5730\u5740\u672C\u8EAB\u3002
const linkText = (schema: Schema, text: string, url: string) =>
  schema.text(text || url, [schema.marks.link.create({ href: fullHref(url) })])
const TypingHabits = Extension.create({
  name: 'typingHabits',
  addInputRules() {
    return [new InputRule({
      find: /(?:^|[^$\\\w])\$([^\s$](?:[^$\n]*[^\s$])?)\$$/,
      handler: ({ state, range, match }) => {
        const start = range.from + match[0].indexOf('$')
        state.tr.replaceWith(start, range.to, state.schema.nodes.inlineMath.create({ latex: match[1] }))
      },
    }), new InputRule({
      // [文字](地址) 敲下右括号时变成链接；![…](…) 是图片，由图片扩展处理。
      find: /(?:^|[^!\\])\[([^\]\n]*)\]\(([^)\s]+)\)$/,
      handler: ({ state, range, match }) => {
        const start = range.from + match[0].indexOf('[')
        state.tr.replaceWith(start, range.to, linkText(state.schema, match[1], match[2]))
      },
    })]
  },
  addKeyboardShortcuts() {
    return {
      'Mod-m': () => newMath('block'),
      'Mod-Shift-m': () => newMath('block'),
      'Mod-Shift-e': () => newMath('inline'),
      'Mod-Shift-k': ({ editor: current }) => current.chain().focus().toggleCodeBlock().run(),
      'Mod-Shift-q': ({ editor: current }) => current.chain().focus().toggleBlockquote().run(),
      'Mod-Shift-[': ({ editor: current }) => current.chain().focus().toggleOrderedList().run(),
      'Mod-Shift-]': ({ editor: current }) => current.chain().focus().toggleBulletList().run(),
      'Mod-Shift-x': ({ editor: current }) => current.chain().focus().toggleTaskList().run(),
      'Mod-Shift-`': ({ editor: current }) => current.chain().focus().toggleCode().run(),
      'Mod-Alt-t': ({ editor: current }) => current.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      'Mod-k': () => { void setLink(); return true },
      'Mod-/': () => { void toggleSource(); return true },
      Enter: ({ editor: current }) => {
        const { $from, empty } = current.state.selection
        if (!empty || $from.parent.type.name !== 'paragraph' || $from.parentOffset !== $from.parent.content.size) return false
        const fence = /^```([\w+#-]*)$/.exec($from.parent.textContent)
        if (!fence) return false
        return current.chain().deleteRange({ from: $from.start(), to: $from.end() }).setCodeBlock({ language: fence[1] || null } as never).run()
      },
    }
  },
  // 输入规则只在敲下最后一个字符时触发。两处补救：
  // 1. 中文输入法（即使在英文模式）的字符经 composition 上屏，Tiptap 在 compositionend 后立即重跑规则，
  //    这时 ProseMirror 可能还没把文字读进文档；稍后再把最后一个字符当作刚输入的，重跑一次。
  // 2. 先打一对符号再回去填、粘贴等情况，像 Typora 一样：光标离开一段完整的 $公式$ 或 `代码` 后转换。
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        handleDOMEvents: {
          compositionend: view => {
            setTimeout(() => {
              const { $head, empty } = view.state.selection
              if (!empty || view.composing || !$head.parent.isTextblock || $head.parentOffset < 1) return
              const text = $head.parent.textBetween($head.parentOffset - 1, $head.parentOffset, undefined, '￼')
              if (!text || text === '￼') return
              view.dispatch(view.state.tr.setMeta('applyInputRules', { from: $head.pos - 1, text }))
            }, 40)
            return false
          },
        },
      },
      appendTransaction: (transactions, previous, state) => {
        if (!transactions.some(tr => tr.docChanged || tr.selectionSet)) return null
        // 其他协作者同步过来的改动由对方自己转换，这里只处理本地操作，避免两边重复转换。
        if (transactions.some(tr => tr.getMeta(ySyncPluginKey)?.isChangeOrigin)) return null
        const head = state.selection.head
        const blocks = new Set<number>()
        for (const pos of [previous.selection.head, head]) {
          if (pos > state.doc.content.size) continue
          const $pos = state.doc.resolve(pos)
          if ($pos.parent.isTextblock && !$pos.parent.type.spec.code) blocks.add($pos.before())
        }
        const code = state.schema.marks.code
        const found: { from: number; to: number; node: ReturnType<typeof state.schema.text> }[] = []
        const overlaps = (from: number, to: number) => found.some(item => from < item.to && to > item.from)
        for (const before of blocks) {
          const block = state.doc.nodeAt(before)
          if (!block?.isTextblock) continue
          const text = block.textBetween(0, block.content.size, undefined, '￼')
          // 整段只有一段 <iframe>/<video>/<img> 代码（手打或早先粘贴的）时，光标离开后变成对应的媒体。
          const media = block.type.name === 'paragraph' && !(head > before && head < before + block.nodeSize)
            ? mediaFromHtml(text) : null
          if (media) {
            // 嵌入块替换整个段落；图片、视频是行内节点，替换段落里的文字。
            const whole = media.type === 'videoEmbed'
            found.push({ from: whole ? before : before + 1, to: whole ? before + block.nodeSize : before + block.nodeSize - 1,
                         node: state.schema.nodeFromJSON(media) as ReturnType<typeof state.schema.text> })
            continue
          }
          // 先找行内代码：反引号里的 $ 不算公式。
          for (const [pattern, mark, make] of [
            [INLINE_CODE, '`', (match: RegExpMatchArray) => state.schema.text(match[1], [code.create()])],
            [INLINE_LINK, '[', (match: RegExpMatchArray) => linkText(state.schema, match[1], match[2])],
            [INLINE_MATH, '$', (match: RegExpMatchArray) => state.schema.nodes.inlineMath.create({ latex: match[1] })],
          ] as const) {
            for (const match of text.matchAll(pattern)) {
              const from = before + 1 + match.index + match[0].indexOf(mark)
              const to = before + 1 + match.index + match[0].length
              if ((head >= from && head <= to) || overlaps(from, to)) continue
              if (state.doc.rangeHasMark(from, to, code)) continue
              found.push({ from, to, node: make(match) as ReturnType<typeof state.schema.text> })
            }
          }
        }
        if (!found.length) return null
        const tr = state.tr
        for (const item of found.sort((a, b) => b.from - a.from)) tr.replaceWith(item.from, item.to, item.node)
        return tr
      },
    }), new Plugin({
      // 拖选文字时，浏览器只给文字画选中背景；选区里的视频、图片、公式另外加上标记，看得出它们也被选中了。
      props: {
        decorations: state => {
          const { selection } = state
          if (selection.empty || selection instanceof NodeSelection) return null
          const marks: Decoration[] = []
          state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
            if (SELECTABLE_MEDIA.has(node.type.name)) marks.push(Decoration.node(pos, pos + node.nodeSize, { class: 'in-selection' }))
          })
          return marks.length ? DecorationSet.create(state.doc, marks) : null
        },
      },
    })]
  },
})
const SELECTABLE_MEDIA = new Set(['videoEmbed', 'embed', 'image', 'video', 'inlineMath', 'blockMath'])

let emitTimer = 0
const editor = shallowRef<Editor>()

// 手机上编辑时，工具栏停靠在软键盘正上方；触屏不显示选中浮动菜单，以免和系统的复制粘贴菜单打架。
const touch = matchMedia('(pointer: coarse)').matches
const narrow = matchMedia('(max-width: 760px)')
const phone = ref(narrow.matches)
const focused = ref(false)
const keyboard = ref(0)
const docked = computed(() => phone.value && focused.value && !source.value)
function onNarrow(event: MediaQueryListEvent) { phone.value = event.matches }
function onViewport() {
  const view = window.visualViewport
  keyboard.value = view ? Math.max(0, innerHeight - view.height - view.offsetTop) : 0
}
narrow.addEventListener('change', onNarrow)
window.visualViewport?.addEventListener('resize', onViewport)
window.visualViewport?.addEventListener('scroll', onViewport)
let blurTimer = 0

function build() {
  const collab = props.collab
  editor.value = new Editor({
    editable: props.editable,
    ...(collab ? {} : { content: props.modelValue, contentType: 'markdown' as const }),
    extensions: [
      StarterKit.configure({ underline: false, codeBlock: false, link: { openOnClick: false, autolink: true }, ...(collab ? { undoRedo: false } : {}) }),
      Markdown,
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      SizedImage,
      Video,
      Embed,
      LegacyEmbed,
      CodeBlockLowlight.extend({ addNodeView: () => VueNodeViewRenderer(CodeBlockView) }).configure({ lowlight, defaultLanguage: null }),
      // 分开配置：Mathematics 会把同一份 katexOptions 给行内与块级，块级公式就不是 displayMode 了。
      InlineMath.configure({ katexOptions: { throwOnError: false }, onClick: (node, pos) => editMath('inline', pos, node.attrs.latex) }),
      BlockMath.configure({ katexOptions: { throwOnError: false, displayMode: true }, onClick: (node, pos) => editMath('block', pos, node.attrs.latex) }),
      Placeholder.configure({ placeholder: props.placeholder }),
      TypingHabits,
      ...(collab ? [
        Collaboration.configure({ document: collab.doc }),
        ...(collab.provider ? [CollaborationCaret.configure({ provider: collab.provider, user: collab.user })] : []),
      ] : []),
    ],
    editorProps: {
      attributes: { class: 'prose md-content', spellcheck: 'false' },
      handleKeyDown: (_, event) => slashKey(event),
      handlePaste: (_, event) => pasteImages(event.clipboardData?.files) || pasteMedia(event.clipboardData?.getData('text/plain')),
      handleDrop: (_, event) => pasteImages((event as DragEvent).dataTransfer?.files),
      // 与 Typora 一样：编辑时 Ctrl/⌘+点击打开链接，只读时直接点击打开。
      handleClick: (view, _, event) => {
        const anchor = (event.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
        if (!anchor || !(event.ctrlKey || event.metaKey || !view.editable)) return false
        window.open(anchor.href, '_blank', 'noopener')
        return true
      },
    },
    onCreate: () => measure(),
    onUpdate: ({ editor: current }) => {
      updateSlash()
      clearTimeout(measureTimer)
      measureTimer = window.setTimeout(measure, 200)
      if (props.collab) return
      clearTimeout(emitTimer)
      emitTimer = window.setTimeout(() => emit('update:modelValue', current.getMarkdown()), 120)
    },
    onSelectionUpdate: () => updateSlash(),
    onFocus: () => { clearTimeout(blurTimer); focused.value = true; onViewport() },
    // 点工具栏时编辑区会短暂失焦，稍等再收起停靠的工具栏。
    onBlur: () => { blurTimer = window.setTimeout(() => { focused.value = false }, 150) },
  })
}

// 大纲与字数：中日韩文字每个算一字，其余按空白分隔的词计数（与 Typora 的统计方式接近）。
export interface Heading { level: number; text: string; pos: number }
const headings = ref<Heading[]>([])
const words = ref(0)
let measureTimer = 0
function measure() {
  const current = editor.value
  if (!current) return
  const list: Heading[] = []
  current.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') list.push({ level: node.attrs.level, text: node.textContent, pos })
    return node.isBlock
  })
  headings.value = list
  const text = current.state.doc.textBetween(0, current.state.doc.content.size, ' ', ' ')
  const cjk = text.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g)?.length ?? 0
  const latin = text.replace(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9_'’.-]+/g)?.length ?? 0
  words.value = cjk + latin
}

function jumpTo(pos: number) {
  const current = editor.value
  if (!current) return
  current.chain().focus().setTextSelection(pos + 1).run()
  ;(current.view.nodeDOM(pos) as HTMLElement | null)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

build()
// 正文里的 $ 也要转义，否则发布后“$5 到 $6”会被当成公式；默认只转义 \ ` * _ [ ] ~。
const manager = (editor.value as unknown as { markdown?: { escapeMarkdownSyntax: (text: string) => string } }).markdown
if (manager) manager.escapeMarkdownSyntax = text => text.replace(/([\\`*_[\]~$])/g, '\\$1')
if (!props.collab && lossy(props.modelValue)) {
  source.value = true
  sourceText.value = props.modelValue
  notice.value = '这篇内容含有 HTML、脚注或引用式链接，可视化编辑可能无法完整保留，已切换到源码模式。'
}

// 外部替换内容（如导入 .md 文件）时同步到编辑器；自己发出的更新不会触发重设。
watch(() => props.modelValue, value => {
  if (props.collab || !editor.value) return
  if (source.value) { if (value !== sourceText.value) sourceText.value = value; return }
  if (value !== editor.value.getMarkdown()) editor.value.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
})
watch(() => props.editable, value => editor.value?.setEditable(value))

onBeforeUnmount(() => {
  clearTimeout(emitTimer); clearTimeout(blurTimer); clearTimeout(measureTimer); editor.value?.destroy()
  narrow.removeEventListener('change', onNarrow)
  window.visualViewport?.removeEventListener('resize', onViewport)
  window.visualViewport?.removeEventListener('scroll', onViewport)
})

async function toggleSource() {
  const current = editor.value
  if (!current) return
  if (!source.value) {
    sourceText.value = props.collab ? current.getMarkdown() : (props.modelValue || current.getMarkdown())
    source.value = true
    await nextTick()
    sourceField.value?.focus()
    return
  }
  if (lossy(sourceText.value) && !await confirmDialog({ title: '切换到可视化编辑？', message: '内容含有 HTML、脚注或引用式链接，切换后这部分可能丢失。', confirmText: '仍要切换', danger: true })) return
  current.commands.setContent(sourceText.value, { contentType: 'markdown', emitUpdate: !!props.collab })
  source.value = false
  notice.value = ''
  await nextTick()
  current.commands.focus()
}

// 源码模式里同样用 Ctrl/⌘ + / 切回（Vue 的按键修饰符没有 slash，这里直接判断按键）。
const sourceField = ref<HTMLTextAreaElement>()
function sourceKey(event: KeyboardEvent) {
  if (event.key === '/' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    void toggleSource()
  }
}

function onSource() {
  if (!props.collab) emit('update:modelValue', sourceText.value)
}

defineExpose({
  getMarkdown: () => (source.value ? sourceText.value : editor.value?.getMarkdown() ?? ''),
  getJSON: () => editor.value?.getJSON(),
  setJSON: (content: object) => editor.value?.commands.setContent(content),
  insertMarkdown: (markdown: string) => {
    if (source.value) { sourceText.value += markdown; onSource(); return }
    editor.value?.chain().focus().insertContent(markdown, { contentType: 'markdown' }).run()
  },
  headings,
  words,
  jumpTo,
  editor,
})

// —— 工具栏 ——

const active = (name: string, attrs?: Record<string, unknown>) => editor.value?.isActive(name, attrs) ?? false
const run = () => editor.value!.chain().focus()
const inTable = computed(() => active('table'))

// 与 Typora 一致：没选中文字时把地址作为链接文字插入；选中文字时给它加链接；光标在链接里时修改或移除。
async function setLink() {
  const current = editor.value
  if (!current) return
  const inLink = current.isActive('link')
  const empty = current.state.selection.empty
  const previous = inLink ? current.getAttributes('link').href as string : ''
  const url = await promptDialog({
    title: inLink ? '编辑链接' : '插入链接',
    message: inLink ? '留空则移除链接。' : empty ? '没有选中文字时，链接地址会作为文字插入。' : undefined,
    value: previous, input: { placeholder: 'https://…' }, confirmText: '确定',
  })
  if (url === null) return
  if (!url) { if (inLink) run().extendMarkRange('link').unsetLink().run(); return }
  const href = fullHref(url)
  if (inLink) run().extendMarkRange('link').setLink({ href }).run()
  else if (empty) run().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href } }] }).run()
  else run().setLink({ href }).run()
}

async function insertVideo() {
  const input = await promptDialog({
    title: '插入视频',
    message: '粘贴视频页面链接或嵌入代码（哔哩哔哩、YouTube、Vimeo、腾讯视频、优酷），也可以是 .mp4、.webm 等视频文件地址。插入后可拖动边缘调整大小。',
    input: { placeholder: 'https://www.bilibili.com/video/BV… 或 <iframe src="…">', multiline: true },
    confirmText: '插入',
  })
  if (!input) return
  const target = parseVideoInput(input)
  if (!target) { notice.value = '没有识别出视频：请粘贴上述视频站的链接或嵌入代码，或以 .mp4、.webm 结尾的视频文件地址。'; return }
  notice.value = ''
  if (target.kind === 'embed') run().setEmbed({ src: target.src }).run()
  else run().setVideo({ src: target.src }).run()
}

async function insertImage() {
  if (props.upload) {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'image/*'
    input.onchange = () => pasteImages(input.files)
    input.click()
    return
  }
  const url = await promptDialog({ title: '插入图片', input: { placeholder: '粘贴图片地址 https://…' }, confirmText: '插入' })
  if (url) run().setImage({ src: url }).run()
}

// 粘贴（或整段写成）一段 <iframe>、<video>、<img> 代码时，按 Typora 的做法直接显示为对应的媒体。
const htmlAttr = (attrs: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs)?.[1] ?? ''
function mediaFromHtml(raw: string): Record<string, unknown> | null {
  const text = raw.trim()
  if (/^<iframe\b[\s\S]*<\/iframe>$/i.test(text)) {
    const target = parseVideoInput(text)
    return target?.kind === 'embed' ? { type: 'videoEmbed', attrs: { src: target.src } } : null
  }
  const video = /^<video\b([^>]*)>([\s\S]*?)<\/video>$/i.exec(text)
  if (video) {
    const src = htmlAttr(video[1], 'src') || htmlAttr(/<source\b([^>]*)>/i.exec(video[2])?.[1] ?? '', 'src')
    if (!/^https?:\/\//.test(src)) return null
    return { type: 'video', attrs: { src, width: Number.parseInt(htmlAttr(video[1], 'width'), 10) || null } }
  }
  const image = /^<img\b([^>]*?)\/?>$/i.exec(text)
  if (image) {
    const src = htmlAttr(image[1], 'src')
    if (!src || /^javascript:/i.test(src)) return null
    return { type: 'image', attrs: { src, alt: htmlAttr(image[1], 'alt') || null, width: Number.parseInt(htmlAttr(image[1], 'width'), 10) || null } }
  }
  return null
}

function pasteMedia(text?: string) {
  const media = text ? mediaFromHtml(text) : null
  if (!media || !editor.value?.isEditable) return false
  run().insertContent(media).run()
  return true
}

function pasteImages(files?: FileList | null) {
  const images = [...(files ?? [])].filter(file => file.type.startsWith('image/'))
  if (!images.length || !props.upload || !editor.value?.isEditable) return false
  void (async () => {
    for (const [i, file] of images.entries()) {
      notice.value = images.length > 1 ? `正在上传图片（${i + 1}/${images.length}）…` : '正在上传图片…'
      try {
        run().setImage({ src: await props.upload!(file), alt: file.name.replace(/\.[^.]+$/, '') }).run()
        notice.value = ''
      } catch (err) {
        notice.value = `图片上传失败：${err instanceof Error ? err.message : '请稍后再试'}`
        return
      }
    }
  })()
  return true
}

// —— 公式：插入后直接进入公式编辑框，边输入边预览（类似 Typora 的公式块） ——

type MathKind = 'inline' | 'block'
const math = ref<{ kind: MathKind; pos: number; latex: string; fresh: boolean; left: number; top: number } | null>(null)
const mathField = ref<HTMLTextAreaElement>()
const mathPreview = computed(() => {
  if (!math.value?.latex.trim()) return ''
  return katex.renderToString(math.value.latex, { displayMode: math.value.kind === 'block', throwOnError: false })
})
const nodeName = (kind: MathKind) => kind === 'block' ? 'blockMath' : 'inlineMath'

function insertMath(block = false) { newMath(block ? 'block' : 'inline') }

function newMath(kind: MathKind) {
  const current = editor.value
  if (!current?.isEditable) return false
  const from = current.state.selection.from
  current.chain().focus().insertContent({ type: nodeName(kind), attrs: { latex: '' } }).run()
  let found = -1
  current.state.doc.nodesBetween(Math.max(0, from - 2), Math.min(current.state.doc.content.size, from + 4), (node, pos) => {
    if (node.type.name === nodeName(kind)) found = pos
  })
  if (found >= 0) editMath(kind, found, '', true)
  return true
}

async function editMath(kind: MathKind, pos: number, latex: string, fresh = false) {
  const current = editor.value
  if (!current?.isEditable) return
  const dom = current.view.nodeDOM(pos) as HTMLElement | null
  const box = current.view.dom.closest('.md-editor')!.getBoundingClientRect()
  const rect = dom?.getBoundingClientRect() ?? current.view.coordsAtPos(pos) as unknown as DOMRect
  math.value = { kind, pos, latex, fresh, left: Math.max(0, Math.min(rect.left - box.left, box.width - 340)), top: rect.bottom - box.top + 8 }
  await nextTick()
  mathField.value?.focus()
  mathField.value?.select()
}

function finishMath(save: boolean) {
  const state = math.value
  const current = editor.value
  if (!state || !current) return
  math.value = null
  const node = current.state.doc.nodeAt(state.pos)
  if (!node || node.type.name !== nodeName(state.kind)) return
  const latex = state.latex.trim()
  if ((save && !latex) || (!save && state.fresh && !node.attrs.latex)) {
    current.chain().focus().deleteRange({ from: state.pos, to: state.pos + node.nodeSize }).run()
    return
  }
  if (save) {
    if (state.kind === 'block') current.commands.updateBlockMath({ pos: state.pos, latex })
    else current.commands.updateInlineMath({ pos: state.pos, latex })
  }
  // 光标落到公式后面，接着输入正文。
  current.chain().focus().setTextSelection(state.pos + current.state.doc.nodeAt(state.pos)!.nodeSize).run()
}

function mathKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); finishMath(false) }
  // 行内公式回车完成；公式块里回车换行，Ctrl+Enter 或 Shift+Enter 完成。
  else if (event.key === 'Enter' && (math.value?.kind === 'inline' || event.ctrlKey || event.metaKey || event.shiftKey)) {
    event.preventDefault(); finishMath(true)
  }
}

// —— 斜杠菜单：在空段落开头输入 / 呼出 ——

type Command = { id: string; label: string; hint: string; keys: string; action: () => void }
const commands: Command[] = [
  { id: 'p', label: '正文', hint: '普通段落', keys: 'text zw', action: () => run().setParagraph().run() },
  { id: 'h1', label: '一级标题', hint: '#', keys: 'h1 heading bt', action: () => run().setHeading({ level: 1 }).run() },
  { id: 'h2', label: '二级标题', hint: '##', keys: 'h2 heading bt', action: () => run().setHeading({ level: 2 }).run() },
  { id: 'h3', label: '三级标题', hint: '###', keys: 'h3 heading bt', action: () => run().setHeading({ level: 3 }).run() },
  { id: 'ul', label: '无序列表', hint: '-', keys: 'bullet list lb', action: () => run().toggleBulletList().run() },
  { id: 'ol', label: '有序列表', hint: '1.', keys: 'ordered number list lb', action: () => run().toggleOrderedList().run() },
  { id: 'task', label: '待办清单', hint: '[ ]', keys: 'todo task check db', action: () => run().toggleTaskList().run() },
  { id: 'quote', label: '引用', hint: '>', keys: 'quote yy', action: () => run().toggleBlockquote().run() },
  { id: 'code', label: '代码块', hint: '```', keys: 'code dm', action: () => run().toggleCodeBlock().run() },
  { id: 'table', label: '表格', hint: '3 × 3', keys: 'table bg', action: () => run().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'math', label: '公式', hint: '$$', keys: 'math latex gs', action: () => insertMath(true) },
  { id: 'image', label: '图片', hint: props.upload ? '上传' : '链接', keys: 'image picture tp', action: () => insertImage() },
  { id: 'video', label: '视频', hint: '链接', keys: 'video movie sp', action: () => insertVideo() },
  { id: 'hr', label: '分割线', hint: '---', keys: 'divider hr line fgx', action: () => run().setHorizontalRule().run() },
]
const slashItems = computed(() => {
  const query = slash.value?.query.toLowerCase() ?? ''
  return commands.filter(item => !query || item.label.includes(query) || item.keys.includes(query))
})

const SLASH_HEIGHT = 320

function updateSlash() {
  const current = editor.value
  if (!current || !current.isEditable) { slash.value = null; return }
  const { $from, empty } = current.state.selection
  const text = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const match = empty && $from.parent.type.name === 'paragraph' ? /^\/([^\s/]{0,12})$/.exec(text) : null
  if (!match) { slash.value = null; return }
  const coords = current.view.coordsAtPos($from.pos)
  const box = current.view.dom.closest('.md-editor')!.getBoundingClientRect()
  // 下方放不下时（光标靠近屏幕底部或贴着软键盘），菜单改到光标上方。
  const height = Math.min(SLASH_HEIGHT, slashItems.value.length * 42 + 12)
  const bottom = (window.visualViewport?.height ?? innerHeight) - keyboard.value
  const above = coords.bottom + 6 + height > bottom && coords.top - 6 - height > 0
  slash.value = { query: match[1], from: $from.pos - text.length,
                  left: Math.max(0, Math.min(coords.left - box.left, box.width - 230)),
                  top: above ? coords.top - box.top - 6 - height : coords.bottom - box.top + 6,
                  index: slash.value?.query === match[1] ? slash.value.index : 0 }
}

function pick(item: Command) {
  const state = slash.value
  if (!state) return
  editor.value!.chain().focus().deleteRange({ from: state.from, to: editor.value!.state.selection.from }).run()
  slash.value = null
  item.action()
}

function slashKey(event: KeyboardEvent) {
  const state = slash.value
  if (!state || !slashItems.value.length) return false
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const count = slashItems.value.length
    state.index = (state.index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
    void nextTick(() => document.querySelector('.md-slash button.on')?.scrollIntoView({ block: 'nearest' }))
    return true
  }
  if (event.key === 'Enter' || event.key === 'Tab') { pick(slashItems.value[state.index]); return true }
  if (event.key === 'Escape') { slash.value = null; return true }
  return false
}
</script>

<template>
  <div class="md-editor" :class="{ 'is-source': source, 'is-readonly': !editable, 'is-docked': docked }">
    <div v-if="editable && editor" class="md-toolbar" :class="{ docked }" :style="docked ? { bottom: `${keyboard}px` } : undefined" role="toolbar" aria-label="格式" @mousedown="event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault() }">
      <template v-if="!source">
        <button v-if="!collab" type="button" title="撤销 (Ctrl+Z)" :disabled="!editor.can().undo()" @click="run().undo().run()"><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg></button>
        <button v-if="!collab" type="button" title="重做 (Ctrl+Shift+Z)" :disabled="!editor.can().redo()" @click="run().redo().run()"><svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg></button>
        <span v-if="!collab" class="sep" />
        <button type="button" class="text" :class="{ on: active('heading', { level: 1 }) }" title="一级标题 (Ctrl+Alt+1)" @click="run().toggleHeading({ level: 1 }).run()">H1</button>
        <button type="button" class="text" :class="{ on: active('heading', { level: 2 }) }" title="二级标题 (Ctrl+Alt+2)" @click="run().toggleHeading({ level: 2 }).run()">H2</button>
        <button type="button" class="text" :class="{ on: active('heading', { level: 3 }) }" title="三级标题 (Ctrl+Alt+3)" @click="run().toggleHeading({ level: 3 }).run()">H3</button>
        <span class="sep" />
        <button type="button" :class="{ on: active('bold') }" title="加粗 (Ctrl+B)" @click="run().toggleBold().run()"><svg viewBox="0 0 24 24"><path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" /></svg></button>
        <button type="button" :class="{ on: active('italic') }" title="斜体 (Ctrl+I)" @click="run().toggleItalic().run()"><svg viewBox="0 0 24 24"><path d="M10 5h8M6 19h8M14 5l-4 14" /></svg></button>
        <button type="button" :class="{ on: active('strike') }" title="删除线 (Ctrl+Shift+S)" @click="run().toggleStrike().run()"><svg viewBox="0 0 24 24"><path d="M5 12h14M16 7.5C15.4 5.9 13.9 5 12 5c-2.5 0-4 1.3-4 3 0 1.4.9 2.4 3 3M8 16.5c.6 1.6 2.1 2.5 4 2.5 2.5 0 4-1.3 4-3 0-.6-.2-1.2-.5-1.6" /></svg></button>
        <button type="button" :class="{ on: active('code') }" title="行内代码 (Ctrl+Shift+`)" @click="run().toggleCode().run()"><svg viewBox="0 0 24 24"><path d="m9 8-4 4 4 4M15 8l4 4-4 4" /></svg></button>
        <button type="button" :class="{ on: active('link') }" title="链接 (Ctrl+K)" @click="setLink"><svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg></button>
        <span class="sep" />
        <button type="button" :class="{ on: active('bulletList') }" title="无序列表 (Ctrl+Shift+])" @click="run().toggleBulletList().run()"><svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" /></svg></button>
        <button type="button" :class="{ on: active('orderedList') }" title="有序列表 (Ctrl+Shift+[)" @click="run().toggleOrderedList().run()"><svg viewBox="0 0 24 24"><path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1V9M4 14.5c0-.8.7-1.5 1.5-1.5S7 13.6 7 14.4c0 1.1-3 2.1-3 3.6h3" /></svg></button>
        <button type="button" :class="{ on: active('taskList') }" title="待办清单 (Ctrl+Shift+X)" @click="run().toggleTaskList().run()"><svg viewBox="0 0 24 24"><path d="M4 5h5v5H4zM5.5 7.5l1 1 1.5-2M4 14h5v5H4zM12 7.5h8M12 16.5h8" /></svg></button>
        <button type="button" :class="{ on: active('blockquote') }" title="引用 (Ctrl+Shift+Q)" @click="run().toggleBlockquote().run()"><svg viewBox="0 0 24 24"><path d="M5 6v12M10 8h9M10 12h9M10 16h6" /></svg></button>
        <button type="button" :class="{ on: active('codeBlock') }" title="代码块 (Ctrl+Shift+K)" @click="run().toggleCodeBlock().run()"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM9 10l-2 2 2 2M15 10l2 2-2 2" /></svg></button>
        <span class="sep" />
        <button type="button" title="表格 (Ctrl+Alt+T)" @click="run().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM4 10h16M4 14.5h16M10 5v14" /></svg></button>
        <button type="button" title="公式块 (Ctrl+M)；行内公式 Ctrl+Shift+E 或输入 $公式$" @click="insertMath(true)"><svg viewBox="0 0 24 24"><path d="M17 5H7l5 7-5 7h10" /></svg></button>
        <button type="button" title="图片（可粘贴或拖入）" @click="insertImage"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9h.01" /></svg></button>
        <button type="button" title="视频（网络地址）" @click="insertVideo"><svg viewBox="0 0 24 24"><path d="M4 6h11v12H4zM15 10l5-3v10l-5-3" /></svg></button>
        <button type="button" title="分割线" @click="run().setHorizontalRule().run()"><svg viewBox="0 0 24 24"><path d="M4 12h16" /></svg></button>
        <template v-if="inTable">
          <span class="sep" />
          <button type="button" class="text" title="在下方插入行" @click="run().addRowAfter().run()">+行</button>
          <button type="button" class="text" title="在右侧插入列" @click="run().addColumnAfter().run()">+列</button>
          <button type="button" class="text" title="删除所在行" @click="run().deleteRow().run()">−行</button>
          <button type="button" class="text" title="删除所在列" @click="run().deleteColumn().run()">−列</button>
          <button type="button" class="text danger" title="删除表格" @click="run().deleteTable().run()">删表</button>
        </template>
      </template>
      <span class="grow" />
      <button type="button" class="text mode" :class="{ on: source }" :title="source ? '回到可视化编辑 (Ctrl+/)' : '查看与编辑 Markdown 源码 (Ctrl+/)'" @click="toggleSource">{{ source ? '可视化' : 'Markdown' }}</button>
    </div>
    <p v-if="notice" class="md-notice">{{ notice }}</p>

    <textarea v-if="source" ref="sourceField" v-model="sourceText" class="md-source" spellcheck="false" :readonly="!editable" @input="onSource" @keydown="sourceKey" />
    <template v-else>
      <EditorContent :editor="editor" class="md-body" />
      <BubbleMenu v-if="editor && editable && !touch" :editor="editor" class="md-bubble" :should-show="({ editor: e, state }) => !state.selection.empty && !e.isActive('codeBlock') && !e.isActive('image')">
        <button type="button" :class="{ on: active('bold') }" @click="run().toggleBold().run()"><b>B</b></button>
        <button type="button" :class="{ on: active('italic') }" @click="run().toggleItalic().run()"><i>I</i></button>
        <button type="button" :class="{ on: active('strike') }" @click="run().toggleStrike().run()"><s>S</s></button>
        <button type="button" :class="{ on: active('code') }" @click="run().toggleCode().run()"><code>&lt;/&gt;</code></button>
        <button type="button" :class="{ on: active('link') }" @click="setLink">链接</button>
      </BubbleMenu>
      <div v-if="slash && slashItems.length" class="md-slash" :style="{ left: `${slash.left}px`, top: `${slash.top}px` }" role="listbox">
        <button v-for="(item, i) in slashItems" :key="item.id" type="button" role="option" :aria-selected="i === slash.index" :class="{ on: i === slash.index }" @mousedown.prevent="pick(item)" @mouseenter="slash.index = i">
          <span>{{ item.label }}</span><kbd>{{ item.hint }}</kbd>
        </button>
      </div>
      <div v-if="math" class="md-math" :style="{ left: `${math.left}px`, top: `${math.top}px` }">
        <textarea ref="mathField" v-model="math.latex" :rows="math.kind === 'block' ? 3 : 1" spellcheck="false" placeholder="输入 LaTeX，例如 rac{a}{b}" @keydown="mathKey" @blur="finishMath(true)" />
        <div v-if="mathPreview" class="preview" v-html="mathPreview" />
        <p>{{ math.kind === 'block' ? 'Ctrl+Enter 完成' : 'Enter 完成' }} · Esc 取消</p>
      </div>
    </template>
  </div>
</template>
