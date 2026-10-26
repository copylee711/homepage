/** 按扩展名判断文件类型：决定图标与能否在线预览。 */
export type FileKind = 'folder' | 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'archive' | 'doc' | 'file'

const groups: Record<Exclude<FileKind, 'folder' | 'file'>, string[]> = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico'],
  video: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'],
  audio: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus'],
  pdf: ['pdf'],
  text: ['txt', 'md', 'markdown', 'log', 'csv', 'json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'html', 'css', 'js', 'ts', 'vue', 'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'bat', 'ps1', 'sql', 'tex', 'bib', 'prop'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'apk', 'exe', 'msi', 'dmg', 'iso'],
  doc: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'epub'],
}

export function kindOf(name: string, dir = false): FileKind {
  if (dir) return 'folder'
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  for (const [kind, extensions] of Object.entries(groups)) if (extensions.includes(extension)) return kind as FileKind
  return 'file'
}

/** 24×24 描边图标路径。 */
export const kindIcons: Record<FileKind, string> = {
  folder: 'M3.5 6.5a1 1 0 0 1 1-1h4.6l2 2h8.4a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1Z',
  image: 'M4 5h16v14H4Zm0 11 4.5-4.5 4 4 2.5-2.5L20 18M15 9.5h.01',
  video: 'M4 6h12v12H4Zm12 4 4-2.5v9L16 14',
  audio: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm10-2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  pdf: 'M6 3h9l4 4v14H6Zm9 0v4h4M9 13h6m-6 4h4',
  text: 'M6 3h9l4 4v14H6Zm9 0v4h4M9 11h6m-6 3h6m-6 3h3',
  archive: 'M5 4h14v16H5Zm6 0v2h2v2h-2v2h2v2h-2m0 2h2v3h-2Z',
  doc: 'M6 3h9l4 4v14H6Zm9 0v4h4M9 12l1.5 5 1.5-4 1.5 4L15 12',
  file: 'M6 3h9l4 4v14H6Zm9 0v4h4',
}

// 没有扩展名或扩展名不在列表里、但通常是文本的文件。
const TEXT_NAMES = new Set(['makefile', 'dockerfile', 'license', 'readme', 'changelog', 'procfile', 'gemfile', 'cmakelists.txt'])
const TEXT_EXTRA = ['jsx', 'tsx', 'mjs', 'cjs', 'scss', 'less', 'r', 'm', 'jl', 'kt', 'swift', 'rb', 'php', 'lua', 'pl', 'hpp', 'cc', 'cs', 'env', 'cfg', 'properties', 'gradle', 'lock', 'svg', 'rst', 'org', 'tsv', 'ipynb', 'gitignore', 'gitattributes', 'editorconfig']

/** 能在团队里在线编辑的文本文件：常见代码与文本扩展名、.gitignore 这类点文件和 Makefile 等。 */
export function isTextName(name: string) {
  const lower = name.toLowerCase()
  if (kindOf(lower) === 'text' || TEXT_NAMES.has(lower)) return true
  const extension = lower.includes('.') ? lower.split('.').pop()! : ''
  return (lower.startsWith('.') && !lower.slice(1).includes('.')) || TEXT_EXTRA.includes(extension)
}

export const previewable = (kind: FileKind) => ['image', 'video', 'audio', 'pdf', 'text'].includes(kind)

/** 拆出扩展名（不含点），用于截断时保留后缀；以点开头或过长的后缀不算。 */
export function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || name.length - dot > 10) return [name, '']
  return [name.slice(0, dot), name.slice(dot)]
}

// 按显示宽度计数：全角字符约占两个半角字符。
const units = (text: string) => [...text].reduce((sum, char) => sum + (/[⺀-￿]/.test(char) ? 2 : 1), 0)

/** 超出预算时从中间省略，保留开头、结尾几个字与扩展名，例如「2026年全国大学生…初赛通知.pdf」。 */
export function middleTrim(name: string, budget: number): string {
  if (units(name) <= budget) return name
  const [stem, ext] = splitName(name)
  const chars = [...stem]
  let tail = ''
  for (let i = chars.length - 1; i >= 0 && units(tail) < 6; i--) tail = chars[i] + tail
  let head = ''
  for (const char of chars) {
    if (units(head + char) + units(tail) + units(ext) + 2 > budget) break
    head += char
  }
  return `${head}…${tail}${ext}`
}
