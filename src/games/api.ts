import { account, accountApi } from '../account'
import { fetchJson } from '../content'

export type GameId = 'watermelon' | 'sheep' | 'dungeon'
export interface GameBest { best: number; detail: number; plays: number }
export interface RankRow { rank: number; name: string; avatar: string; best: number; detail: number }
export interface Board { items: RankRow[]; me: (GameBest & { rank: number }) | null }

export const games: { id: GameId; title: string; name: string; text: string; unit: string }[] = [
  { id: 'watermelon', title: 'Watermelon', name: '合成大西瓜', text: '拖动落点，让两个相同的水果撞在一起，合成更大的水果，看看最后能不能合出大西瓜。', unit: '分' },
  { id: 'sheep', title: 'Triple', name: '羊了个羊', text: '卡片层层叠放，凑齐 3 张相同的就会消除。槽位只有 7 格，放满就输了。', unit: '关' },
  { id: 'dungeon', title: 'Abyss Knight', name: '深渊骑士', text: '俯视角地牢闯关：随机房间、十余种武器与宝物、三位首领轮番登场。手机横屏、电脑键鼠都能玩。', unit: '分' },
]

const key = (game: GameId) => `copylee-game-${game}`

/** 本地最高分：未登录时也能看到自己的纪录。 */
export function localBest(game: GameId): GameBest | null {
  try { return JSON.parse(localStorage.getItem(key(game)) ?? 'null') } catch { return null }
}

function better(game: GameId, a: GameBest | null, score: number, duration: number) {
  if (!a) return true
  return score > a.best || (game === 'sheep' && score === a.best && duration < a.detail)
}

/** 记录一局成绩；登录时同步到服务器，返回是否刷新了纪录。floor 为地牢到达的层数。 */
export async function submitScore(game: GameId, score: number, duration: number, floor = 0): Promise<{ improved: boolean; synced: boolean; error?: string }> {
  const local = localBest(game)
  const improved = better(game, local, score, duration)
  const detail = game === 'dungeon' ? floor : duration
  const next = improved ? { best: score, detail, plays: (local?.plays ?? 0) + 1 } : { ...local!, plays: local!.plays + 1 }
  try { localStorage.setItem(key(game), JSON.stringify(next)) } catch { /* 隐私模式下不保存 */ }
  if (!account.value) return { improved, synced: false }
  try {
    const result = await accountApi<{ improved: boolean }>(`/games/${game}`, 'POST', { score, duration, floor })
    return { improved: improved || result.improved, synced: true }
  } catch (err) {
    return { improved, synced: false, error: err instanceof Error ? err.message : '成绩同步失败' }
  }
}

export const loadBoard = (game: GameId) => fetchJson<Board>(`/api/games/${game}/leaderboard`, { credentials: 'same-origin' })
export const loadMine = () => accountApi<Record<GameId, GameBest | null>>('/games')

export function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60), s = seconds % 60
  return m ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`
}
