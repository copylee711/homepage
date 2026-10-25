import { ref } from 'vue'

/** 用 WebAudio 合成的简短音效，不加载任何音频文件。 */
const KEY = 'copylee-game-muted'
export const muted = ref(read())
let ctx: AudioContext | undefined

function read() {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

export function toggleMute() {
  muted.value = !muted.value
  try { localStorage.setItem(KEY, muted.value ? '1' : '0') } catch { /* 忽略 */ }
}

function tone(freq: number, duration: number, type: OscillatorType = 'sine', gain = 0.15, slide = 0, delay = 0) {
  if (muted.value) return
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') ctx.resume()
    const start = ctx.currentTime + delay
    const osc = ctx.createOscillator(), amp = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq, start)
    if (slide) osc.frequency.exponentialRampToValueAtTime(freq * slide, start + duration)
    amp.gain.setValueAtTime(gain, start)
    amp.gain.exponentialRampToValueAtTime(0.001, start + duration)
    osc.connect(amp).connect(ctx.destination)
    osc.start(start)
    osc.stop(start + duration)
  } catch { /* 浏览器不支持时静默 */ }
}

export const sfx = {
  drop: () => tone(220, 0.12, 'triangle', 0.12, 0.6),
  tap: () => tone(660, 0.06, 'triangle', 0.08),
  merge: (level: number) => { tone(330 * 2 ** (level / 12), 0.18, 'sine', 0.16, 1.5); tone(495 * 2 ** (level / 12), 0.2, 'triangle', 0.08, 1.2, 0.05) },
  clear: () => { tone(523, 0.1, 'triangle', 0.12); tone(659, 0.1, 'triangle', 0.12, 1, 0.07); tone(784, 0.16, 'triangle', 0.12, 1, 0.14) },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 'triangle', 0.12, 1, i * 0.1)),
  lose: () => tone(300, 0.5, 'sawtooth', 0.06, 0.4),
}
