/**
 * 视频嵌入：把用户粘贴的页面链接、<iframe> 嵌入代码或视频文件地址，转成可以放进文档的内容。
 *
 * 只允许知名视频站的播放器地址（与 backend/app/rendering.py 的白名单一致），
 * 避免文档里嵌入任意网页（钓鱼页面、挖矿脚本等）。
 */

export interface EmbedTarget { kind: 'embed'; src: string; provider: string }
export interface VideoTarget { kind: 'video'; src: string }

const PROVIDERS: { name: string; prefix: string }[] = [
  { name: '哔哩哔哩', prefix: 'https://player.bilibili.com/player.html' },
  { name: 'YouTube', prefix: 'https://www.youtube-nocookie.com/embed/' },
  { name: 'YouTube', prefix: 'https://www.youtube.com/embed/' },
  { name: 'Vimeo', prefix: 'https://player.vimeo.com/video/' },
  { name: '腾讯视频', prefix: 'https://v.qq.com/txp/iframe/player.html' },
  { name: '优酷', prefix: 'https://player.youku.com/embed/' },
]

/** 规范化播放器地址；不在白名单内返回 null。哔哩哔哩默认会自动播放，这里关掉。 */
export function normalizeEmbed(raw: string): EmbedTarget | null {
  let src = raw.trim().replace(/&amp;/g, '&')
  if (src.startsWith('//')) src = `https:${src}`
  src = src.replace(/^http:\/\//, 'https://')
  const provider = PROVIDERS.find(item => src.startsWith(item.prefix))
  if (!provider) return null
  if (provider.prefix.includes('bilibili')) {
    const url = new URL(src)
    url.searchParams.set('isOutside', 'true')
    if (!url.searchParams.has('autoplay')) url.searchParams.set('autoplay', '0')
    src = url.toString()
  }
  return { kind: 'embed', src, provider: provider.name }
}

export function providerOf(src: string) {
  return PROVIDERS.find(item => src.startsWith(item.prefix))?.name ?? '视频'
}

/** 解析用户输入：嵌入代码、视频站页面链接或视频文件地址。 */
export function parseVideoInput(input: string): EmbedTarget | VideoTarget | null {
  const text = input.trim()
  const fromCode = /<iframe[^>]*\ssrc=["']([^"']+)["']/i.exec(text)
  if (fromCode) return normalizeEmbed(fromCode[1])
  let url: URL
  try { url = new URL(text.startsWith('//') ? `https:${text}` : text) } catch { return null }
  if (!/^https?:$/.test(url.protocol)) return null
  if (/\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(url.pathname)) return { kind: 'video', src: url.toString() }
  const host = url.hostname.replace(/^(www|m)\./, '')
  const direct = normalizeEmbed(url.toString())
  if (direct) return direct
  if (host === 'bilibili.com') {
    const bv = /\/video\/(BV[0-9A-Za-z]+)/.exec(url.pathname)?.[1]
    const av = /\/video\/av(\d+)/i.exec(url.pathname)?.[1]
    if (!bv && !av) return null
    const page = url.searchParams.get('p') ?? '1'
    return normalizeEmbed(`https://player.bilibili.com/player.html?${bv ? `bvid=${bv}` : `aid=${av}`}&p=${page}`)
  }
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') {
    const id = host === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') ?? /\/(?:shorts|live|embed)\/([\w-]+)/.exec(url.pathname)?.[1]
    if (!id || !/^[\w-]{6,20}$/.test(id)) return null
    const start = Number.parseInt(url.searchParams.get('t') ?? url.searchParams.get('start') ?? '', 10)
    return normalizeEmbed(`https://www.youtube-nocookie.com/embed/${id}${start > 0 ? `?start=${start}` : ''}`)
  }
  if (host === 'vimeo.com') {
    const id = /^\/(\d+)/.exec(url.pathname)?.[1]
    return id ? normalizeEmbed(`https://player.vimeo.com/video/${id}`) : null
  }
  if (host === 'v.qq.com') {
    const vid = /\/([0-9a-z]{11})\.html$/i.exec(url.pathname)?.[1] ?? url.searchParams.get('vid')
    return vid ? normalizeEmbed(`https://v.qq.com/txp/iframe/player.html?vid=${vid}`) : null
  }
  if (host === 'v.youku.com') {
    const id = /id_([0-9A-Za-z=]+)\.html/.exec(url.pathname)?.[1]
    return id ? normalizeEmbed(`https://player.youku.com/embed/${id}`) : null
  }
  return null
}
