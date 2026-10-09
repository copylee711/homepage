// 构建前拉取 GitHub 公开仓库，写入 src/data/repos.json。
// 拉取失败时保留已有的 JSON（已提交的缓存），不让构建失败。
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const USER = process.env.GITHUB_USER ?? 'copylee711'
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/data/repos.json')

async function fetchRepos() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `${USER}-homepage-build`,
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

  const res = await fetch(
    `https://api.github.com/users/${USER}/repos?type=owner&sort=pushed&per_page=100`,
    { headers, signal: AbortSignal.timeout(15_000) },
  )
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`)

  const repos = await res.json()
  return repos
    .filter((r) => !r.fork && !r.archived && !r.private)
    .map((r) => ({
      name: r.name,
      description: r.description ?? '',
      url: r.html_url,
      homepage: r.homepage || '',
      language: r.language ?? '',
      stars: r.stargazers_count,
      pushedAt: r.pushed_at,
    }))
}

try {
  const repos = await fetchRepos()
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(repos, null, 2) + '\n')
  console.log(`[fetch-repos] 已写入 ${repos.length} 个仓库`)
} catch (err) {
  if (existsSync(OUT)) {
    console.warn(`[fetch-repos] 拉取失败（${err.message}），沿用已有的 repos.json`)
  } else {
    await mkdir(dirname(OUT), { recursive: true })
    await writeFile(OUT, '[]\n')
    console.warn(`[fetch-repos] 拉取失败（${err.message}），且没有缓存，已写入空列表`)
  }
}
