/** 11 种水果：优先用手绘贴图，未加载时程序化绘制；预渲染到离屏画布后按需旋转贴图。 */
import manifest from './art/manifest.json'
import fruitsUrl from './art/fruits.webp'

const art = new Image()
let ready = false
art.onload = () => { ready = true; cache.clear() }
art.src = fruitsUrl

interface Style { name: string; base: string; dark: string; light: string }

export const FRUITS: Style[] = [
  { name: '葡萄', base: '#8e5bd6', dark: '#5b2fa3', light: '#c7a6ff' },
  { name: '樱桃', base: '#e8344e', dark: '#a4122a', light: '#ff8fa0' },
  { name: '橘子', base: '#ff9a1f', dark: '#e0650a', light: '#ffd08a' },
  { name: '柠檬', base: '#ffe14d', dark: '#e6b800', light: '#fff4b0' },
  { name: '猕猴桃', base: '#7fc241', dark: '#4f8a1f', light: '#c8f08f' },
  { name: '番茄', base: '#f2462e', dark: '#b52412', light: '#ff9b8a' },
  { name: '桃子', base: '#ffa3a8', dark: '#ec6b7b', light: '#ffe0d6' },
  { name: '菠萝', base: '#ffc93c', dark: '#d69200', light: '#ffeaa0' },
  { name: '椰子', base: '#a87444', dark: '#6d4521', light: '#f4ede0' },
  { name: '哈密瓜', base: '#d9e86a', dark: '#97ad2c', light: '#f6ffc0' },
  { name: '西瓜', base: '#3fae49', dark: '#1d6f2a', light: '#9be08f' },
]

const cache = new Map<string, HTMLCanvasElement>()

/** 取得某等级水果在指定像素半径下的贴图。 */
export function sprite(level: number, radius: number): HTMLCanvasElement {
  const px = Math.max(4, Math.round(radius))
  const key = `${level}:${px}`
  let canvas = cache.get(key)
  if (canvas) return canvas
  canvas = document.createElement('canvas')
  // 预留叶子和果柄伸出的空间
  const size = Math.ceil(px * 3)
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  g.translate(size / 2, size / 2)
  if (ready) drawArt(g, level, px)
  else draw(g, level, px)
  cache.set(key, canvas)
  return canvas
}

/** 贴图主体（按面积算的等效圆）与物理半径对齐，叶子和果柄可以伸出圆外 */
function drawArt(g: CanvasRenderingContext2D, level: number, r: number) {
  const { fw, cols, bodies } = manifest.fruits
  const [cx, cy, br] = bodies[level]
  const k = (r * 1.06) / br
  const sx = (level % cols) * fw, sy = Math.floor(level / cols) * fw
  g.drawImage(art, sx, sy, fw, fw, -cx * k, -cy * k, fw * k, fw * k)
}

/** 下一个水果的小图标 */
export function iconUrl(level: number) {
  const c = sprite(level, 18)
  return c.toDataURL()
}

function body(g: CanvasRenderingContext2D, r: number, s: Style) {
  const grad = g.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r)
  grad.addColorStop(0, s.light)
  grad.addColorStop(0.45, s.base)
  grad.addColorStop(1, s.dark)
  g.fillStyle = grad
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill()
}

function shine(g: CanvasRenderingContext2D, r: number) {
  g.fillStyle = 'rgba(255,255,255,.55)'
  g.beginPath(); g.ellipse(-r * 0.42, -r * 0.48, r * 0.22, r * 0.12, -0.7, 0, Math.PI * 2); g.fill()
}

function face(g: CanvasRenderingContext2D, r: number, dy = 0.1) {
  const e = Math.max(1.4, r * 0.09)
  g.fillStyle = '#2b1d14'
  g.beginPath(); g.arc(-r * 0.28, r * dy, e, 0, Math.PI * 2); g.arc(r * 0.28, r * dy, e, 0, Math.PI * 2); g.fill()
  g.strokeStyle = '#2b1d14'; g.lineWidth = Math.max(1, r * 0.06); g.lineCap = 'round'
  g.beginPath(); g.arc(0, r * (dy + 0.12), r * 0.14, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke()
  g.fillStyle = 'rgba(255,110,130,.35)'
  g.beginPath(); g.ellipse(-r * 0.46, r * (dy + 0.16), r * 0.11, r * 0.07, 0, 0, Math.PI * 2); g.ellipse(r * 0.46, r * (dy + 0.16), r * 0.11, r * 0.07, 0, 0, Math.PI * 2); g.fill()
}

function leaf(g: CanvasRenderingContext2D, r: number, angle = -0.5, color = '#4caf50') {
  g.save()
  g.rotate(angle)
  g.fillStyle = color
  g.beginPath()
  g.moveTo(0, -r * 0.92)
  g.quadraticCurveTo(r * 0.35, -r * 1.35, r * 0.62, -r * 1.05)
  g.quadraticCurveTo(r * 0.3, -r * 0.82, 0, -r * 0.92)
  g.fill()
  g.restore()
}

function stem(g: CanvasRenderingContext2D, r: number, len = 0.3) {
  g.strokeStyle = '#6b4a2b'; g.lineWidth = Math.max(1.5, r * 0.08); g.lineCap = 'round'
  g.beginPath(); g.moveTo(0, -r * 0.85); g.quadraticCurveTo(r * 0.05, -r * (0.95 + len / 2), r * 0.12, -r * (0.9 + len)); g.stroke()
}

function draw(g: CanvasRenderingContext2D, level: number, r: number) {
  const s = FRUITS[level]
  switch (level) {
    case 0: { // 葡萄：一串小圆珠
      const beads = [[-0.42, -0.2], [0.42, -0.2], [0, -0.32], [-0.22, 0.25], [0.22, 0.25], [0, 0.6]]
      for (const [x, y] of beads) {
        g.save(); g.translate(x * r, y * r * 0.9); body(g, r * 0.42, s); g.restore()
      }
      g.save(); g.translate(0, r * 0.05); face(g, r * 0.9, 0); g.restore()
      stem(g, r * 0.8)
      return
    }
    case 1: // 樱桃
      body(g, r, s); stem(g, r, 0.5); leaf(g, r, 0.4, '#3d9b45'); face(g, r); shine(g, r); return
    case 2: // 橘子：表面小点
      body(g, r, s)
      g.fillStyle = 'rgba(200,80,0,.18)'
      for (let i = 0; i < 14; i++) { const a = i * 2.4, d = r * (0.3 + (i % 3) * 0.2); g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d, r * 0.04, 0, 7); g.fill() }
      leaf(g, r); face(g, r); shine(g, r); return
    case 3: // 柠檬：椭圆
      g.save(); g.scale(1, 0.92); body(g, r, s); g.restore()
      g.fillStyle = s.dark
      g.beginPath(); g.ellipse(r * 0.98, 0, r * 0.1, r * 0.08, 0, 0, 7); g.ellipse(-r * 0.98, 0, r * 0.1, r * 0.08, 0, 0, 7); g.fill()
      face(g, r); shine(g, r); return
    case 4: { // 猕猴桃：切面
      g.fillStyle = '#7a5530'; g.beginPath(); g.arc(0, 0, r, 0, 7); g.fill()
      const grad = g.createRadialGradient(0, 0, r * 0.15, 0, 0, r * 0.9)
      grad.addColorStop(0, '#f4f8d8'); grad.addColorStop(0.3, s.light); grad.addColorStop(1, s.base)
      g.fillStyle = grad; g.beginPath(); g.arc(0, 0, r * 0.88, 0, 7); g.fill()
      g.fillStyle = '#2b1d14'
      for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; g.beginPath(); g.ellipse(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, r * 0.05, r * 0.025, a, 0, 7); g.fill() }
      g.fillStyle = '#fbfde8'; g.beginPath(); g.arc(0, 0, r * 0.22, 0, 7); g.fill()
      g.save(); g.translate(0, r * 0.05); face(g, r * 0.6, 0); g.restore()
      return
    }
    case 5: // 番茄：绿色萼片
      body(g, r, s)
      g.fillStyle = '#3a8f3a'
      for (let i = 0; i < 5; i++) { g.save(); g.rotate((i / 5) * Math.PI * 2); g.beginPath(); g.ellipse(0, -r * 0.82, r * 0.08, r * 0.22, 0, 0, 7); g.fill(); g.restore() }
      face(g, r, 0.18); shine(g, r); return
    case 6: // 桃子：中缝与叶
      body(g, r, s)
      g.strokeStyle = 'rgba(200,70,90,.35)'; g.lineWidth = r * 0.06
      g.beginPath(); g.moveTo(0, -r * 0.9); g.quadraticCurveTo(r * 0.3, -r * 0.2, 0, r * 0.5); g.stroke()
      leaf(g, r, -0.3, '#5fae4a'); face(g, r, 0.2); shine(g, r); return
    case 7: { // 菠萝：网格纹与叶冠
      g.fillStyle = '#3f9a3f'
      for (let i = -2; i <= 2; i++) { g.save(); g.rotate(i * 0.32); g.beginPath(); g.ellipse(0, -r * 1.05, r * 0.1, r * 0.32, 0, 0, 7); g.fill(); g.restore() }
      body(g, r, s)
      g.save(); g.beginPath(); g.arc(0, 0, r, 0, 7); g.clip()
      g.strokeStyle = 'rgba(160,100,0,.35)'; g.lineWidth = r * 0.04
      for (let i = -4; i <= 4; i++) { g.beginPath(); g.moveTo(i * r * 0.32 - r, -r); g.lineTo(i * r * 0.32 + r, r); g.moveTo(i * r * 0.32 + r, -r); g.lineTo(i * r * 0.32 - r, r); g.stroke() }
      g.restore(); face(g, r, 0.15); shine(g, r); return
    }
    case 8: { // 椰子：切开的白色果肉
      body(g, r, s)
      g.fillStyle = s.light; g.beginPath(); g.arc(0, r * 0.05, r * 0.78, 0, 7); g.fill()
      g.strokeStyle = 'rgba(0,0,0,.08)'; g.lineWidth = r * 0.05; g.stroke()
      face(g, r, 0.1); return
    }
    case 9: // 哈密瓜：网纹
      body(g, r, s)
      g.save(); g.beginPath(); g.arc(0, 0, r, 0, 7); g.clip()
      g.strokeStyle = 'rgba(255,255,240,.55)'; g.lineWidth = r * 0.025
      for (let i = 0; i < 18; i++) { const a = i * 1.7; g.beginPath(); g.arc(Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6, r * 0.45, a, a + 1.6); g.stroke() }
      g.restore(); stem(g, r, 0.2); face(g, r, 0.15); shine(g, r); return
    default: { // 西瓜：深色条纹
      body(g, r, s)
      g.save(); g.beginPath(); g.arc(0, 0, r, 0, 7); g.clip()
      g.fillStyle = s.dark
      for (let i = -3; i <= 3; i++) {
        g.beginPath(); g.moveTo(i * r * 0.32, -r)
        for (let y = -r; y <= r; y += r / 6) g.lineTo(i * r * 0.32 * Math.cos((y / r) * 1.1) + Math.sin(y / r * 9) * r * 0.04, y)
        g.lineTo(i * r * 0.32 + r * 0.1, r); g.lineTo(i * r * 0.32 + r * 0.12, -r); g.fill()
      }
      g.restore(); stem(g, r, 0.15); face(g, r, 0.12); shine(g, r)
    }
  }
}
