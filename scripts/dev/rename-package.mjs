// 把 @dsh-external/<x> 统一改成 dsh-<x>（源码侧改名，开发用）
//   node scripts/dev/rename-package.mjs
// 逐文件精确替换并打印改动数，避免漏改；不碰 node_modules / .git。
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOTS = [
  'D:/CodePackage/DSPlug/antigravity-usage',
  'D:/CodePackage/DSPlug/gemini-web2api-monitor',
]
const TEXT = new Set(['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.ts', '.tsx', '.sh'])

const PAIRS = [
  ['dsh-antigravity-usage', 'dsh-antigravity-usage'],
  ['dsh-gemini-web2api-monitor', 'dsh-gemini-web2api-monitor'],
]

let files = 0
let hits = 0

function walk(dir) {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.git') continue
    const p = join(dir, n)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(p)
      continue
    }
    if (!TEXT.has(extname(n))) continue
    let src
    try {
      src = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    let out = src
    const found = []
    for (const [from, to] of PAIRS) {
      if (!out.includes(from)) continue
      const n0 = out.split(from).length - 1
      found.push(`${from} -> ${to} ×${n0}`)
      hits += n0
      out = out.split(from).join(to)
    }
    if (out !== src) {
      writeFileSync(p, out, 'utf8')
      files += 1
      console.log(`  改 ${p}`)
      for (const f of found) console.log(`       ${f}`)
    }
  }
}

for (const r of ROOTS) {
  console.log(`\n=== ${r} ===`)
  walk(r)
}
console.log(`\n共改动 ${files} 个文件，替换 ${hits} 处`)
