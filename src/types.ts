/** scripts/fetch-repos.mjs 写入 src/data/repos.json 的单条记录 */
export interface Repo {
  name: string
  description: string
  url: string
  homepage: string
  language: string
  stars: number
  pushedAt: string
}
