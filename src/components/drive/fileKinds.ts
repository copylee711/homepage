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

export const previewable = (kind: FileKind) => ['image', 'video', 'audio', 'pdf', 'text'].includes(kind)
