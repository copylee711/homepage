/** 深渊骑士的雪碧图：异步加载，未加载完成时渲染器退回程序化绘制。 */
import manifest from './art/manifest.json'

export type SheetName = keyof typeof manifest
interface Meta { fw: number; fh: number; cols: number; count: number; ax?: number; ay?: number; ref?: number; boxes?: (number[] | null)[]; pins?: Record<string, number[]> }

const urls = import.meta.glob('./art/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const images = new Map<SheetName, HTMLImageElement>()
const silhouettes = new Map<SheetName, HTMLCanvasElement>()
let loading: Promise<void> | undefined
/** 每有一张表加载完成就递增，用于让缓存的房间背景重绘 */
export let artVersion = 0

export const heroUrl = urls['./art/hero.webp']

export function loadArt(onProgress?: (done: number, total: number) => void) {
  if (loading) return loading
  const names = Object.keys(manifest) as SheetName[]
  let done = 0
  loading = Promise.all(names.map(name => new Promise<void>(resolve => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => { images.set(name, img); artVersion++; onProgress?.(++done, names.length); resolve() }
    img.onerror = () => { onProgress?.(++done, names.length); resolve() }
    img.src = urls[`./art/${name}.webp`]
  }))).then(() => {})
  return loading
}

export const has = (name: SheetName) => images.has(name)
export const meta = (name: SheetName) => manifest[name] as Meta

/** 白色剪影版本，用于受击闪白。 */
function silhouette(name: SheetName) {
  let canvas = silhouettes.get(name)
  if (canvas) return canvas
  const img = images.get(name)!
  canvas = document.createElement('canvas')
  canvas.width = img.width; canvas.height = img.height
  const g = canvas.getContext('2d')!
  g.drawImage(img, 0, 0)
  g.globalCompositeOperation = 'source-in'
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, img.width, img.height)
  silhouettes.set(name, canvas)
  return canvas
}

export interface DrawOptions {
  /** 参考帧内容的世界高度；整张表按同一比例缩放 */
  height: number
  flip?: boolean
  rotate?: number
  alpha?: number
  /** sheet：表的统一锚点；center/bottom：该帧内容的中心或底部中心；grip：握把（左侧 22%）；head：弹头（右侧 72%） */
  anchor?: 'sheet' | 'center' | 'bottom' | 'grip' | 'head' | 'pin'
  /** 让该帧内容高度等于此值（世界单位），优先于 height */
  fit?: number
  /** 用另一帧的内容框计算锚点与缩放，让同一动画的各帧保持对齐 */
  anchorFrom?: number
  flash?: number
  scaleX?: number
  scaleY?: number
}

/** 在 (x, y) 处绘制某帧，返回是否成功绘制。 */
export function drawFrame(ctx: CanvasRenderingContext2D, name: SheetName, index: number, x: number, y: number, o: DrawOptions) {
  const img = images.get(name)
  if (!img) return false
  const m = meta(name)
  const box = m.boxes?.[o.anchorFrom ?? index]
  const k = o.fit && box ? o.fit / (box[3] - box[1]) : o.height / (m.ref ?? m.fh)
  const sx = (index % m.cols) * m.fw, sy = Math.floor(index / m.cols) * m.fh
  let ax = m.ax ?? m.fw / 2, ay = m.ay ?? m.fh / 2
  const pin = m.pins?.[index]
  if (o.anchor === 'pin' && pin) { ax = pin[0]; ay = pin[1] }
  else if (o.anchor && o.anchor !== 'sheet' && box) {
    const w = box[2] - box[0]
    ax = o.anchor === 'grip' ? box[0] + w * 0.22 : o.anchor === 'head' ? box[0] + w * 0.72 : (box[0] + box[2]) / 2
    ay = o.anchor === 'bottom' ? box[3] : (box[1] + box[3]) / 2
  }
  ctx.save()
  ctx.translate(x, y)
  if (o.rotate) ctx.rotate(o.rotate)
  ctx.scale((o.flip ? -k : k) * (o.scaleX ?? 1), k * (o.scaleY ?? 1))
  if (o.alpha !== undefined) ctx.globalAlpha *= o.alpha
  ctx.drawImage(img, sx, sy, m.fw, m.fh, -ax, -ay, m.fw, m.fh)
  if (o.flash && o.flash > 0) {
    // 半透明白色叠加，连续受击时也能看清本体
    ctx.globalAlpha *= Math.min(0.62, o.flash * 0.7)
    ctx.drawImage(silhouette(name), sx, sy, m.fw, m.fh, -ax, -ay, m.fw, m.fh)
  }
  ctx.restore()
  return true
}

/** 绘制图块表中的一格，铺满指定矩形。 */
export function drawTile(ctx: CanvasRenderingContext2D, name: SheetName, index: number, x: number, y: number, w: number, h: number) {
  const img = images.get(name)
  if (!img) return false
  const m = meta(name)
  ctx.drawImage(img, (index % m.cols) * m.fw, Math.floor(index / m.cols) * m.fh, m.fw, m.fh, x, y, w, h)
  return true
}

/** 取出某格为独立画布（可再加遮罩）。 */
export function cellCanvas(name: SheetName, index: number, size: number) {
  const img = images.get(name)
  if (!img) return null
  const m = meta(name)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  canvas.getContext('2d')!.drawImage(img, (index % m.cols) * m.fw, Math.floor(index / m.cols) * m.fh, m.fw, m.fh, 0, 0, size, size)
  return canvas
}
