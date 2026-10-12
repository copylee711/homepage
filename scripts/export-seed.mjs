// 显式的一次性内容导出，不属于构建流程。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import ts from 'typescript'
const source = await readFile(new URL('../src/site.config.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } })
const { site } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'))
const directory = new URL('../backend/seed/', import.meta.url)
await mkdir(directory, { recursive: true })
await writeFile(new URL('site.json', directory), JSON.stringify(site, null, 2) + '\n')
await writeFile(new URL('repos.json', directory), await readFile(new URL('../src/data/repos.json', import.meta.url)))
console.log('已导出初始内容；seed 命令只在数据库尚未初始化时导入。')
