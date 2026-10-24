/** 由标题生成固定链接：中文转为无声调拼音，其余保留字母和数字，以连字符连接。 */
const HAN = /[㐀-鿿]/

function tidy(text: string) {
  const slug = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  // 过长时在单词边界截断
  return slug.length <= 80 ? slug : slug.slice(0, 80).replace(/-[^-]*$/, '')
}

export async function postSlug(title: string): Promise<string> {
  const text = title.trim()
  if (!HAN.test(text)) return tidy(text)
  // 拼音词典较大，只在管理后台需要时按需加载。
  const { pinyin } = await import('pinyin-pro')
  return tidy(pinyin(text, { toneType: 'none', nonZh: 'consecutive' }))
}

/** 笔记地址允许中文，直接由标题整理得到。 */
export function noteSlug(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120)
}
