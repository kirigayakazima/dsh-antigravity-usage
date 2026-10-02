// 升版本号（外科式只改 version 字段，不重排文件）。
//   node scripts/dev/bump-version.mjs <目录名或绝对路径> <新版本>
// 例: node scripts/dev/bump-version.mjs gemini-web2api-monitor 0.1.2
import { readFileSync, writeFileSync } from 'node:fs'

const [, , target, next] = process.argv
if (target === undefined || next === undefined) {
  console.error('用法: node scripts/dev/bump-version.mjs <包目录> <新版本>')
  process.exit(2)
}
const dir = target.includes('/') || target.includes('\\') ? target : 'D:/CodePackage/DSPlug/' + target
const file = dir.replace(/\/+$/, '') + '/package.json'
const raw = readFileSync(file, 'utf8')
const j = JSON.parse(raw)
const prev = j.version

const re = /("version"\s*:\s*")([^"]+)(")/
if (!re.test(raw)) {
  console.error('找不到 version 字段: ' + file)
  process.exit(1)
}
const out = raw.replace(re, (m, a, b, c) => a + next + c)
JSON.parse(out) // 替换后复核仍然合法
writeFileSync(file, out, 'utf8')

console.log(`  ${j.name}: ${prev} -> ${next}`)
console.log(`  name=${JSON.parse(readFileSync(file, 'utf8')).name}  private=${JSON.parse(readFileSync(file, 'utf8')).private}`)
