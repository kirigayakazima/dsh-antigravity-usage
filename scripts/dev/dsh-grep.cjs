// 在 app.asar 内部递归搜索关键字（开发用）。
// 必须用 Electron 当 Node 跑，普通 Node 读不了 asar 里的“目录”：
//   $env:ELECTRON_RUN_AS_NODE=1
//   & "D:\Software\DSH\DeepSeek Harness.exe" scripts\dev\dsh-grep.cjs <asar内目录> <关键字> [选项]
// 选项: --ext=.js,.json  --max=30  --ctx=0  --len=200  --files
const fs = require('node:fs')
const path = require('node:path')

const root = process.argv[2]
let needle = (process.argv[3] || '').toLowerCase()
let optArgs = process.argv.slice(4)
// PowerShell 会把空字符串参数丢掉，于是选项会跑到 needle 的位置上
if (needle.startsWith('--')) {
  optArgs = [needle, ...optArgs]
  needle = ''
}
const opts = { ext: ['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.yml', '.yaml'], max: 30, ctx: 0, len: 200, filesOnly: false }
for (const a of optArgs) {
  if (a === '--files') opts.filesOnly = true
  else if (a.startsWith('--ext=')) opts.ext = a.slice(6).split(',')
  else if (a.startsWith('--max=')) opts.max = Number(a.slice(6))
  else if (a.startsWith('--ctx=')) opts.ctx = Number(a.slice(6))
  else if (a.startsWith('--len=')) opts.len = Number(a.slice(6))
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'types'])

function walk(dir, depth, out) {
  if (depth > 12) return
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    const p = path.join(dir, n)
    let st
    try {
      st = fs.statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (SKIP.has(n)) continue
      walk(p, depth + 1, out)
    } else {
      if (st.size > 12 * 1024 * 1024) continue
      out.push({ p, size: st.size })
    }
  }
}

const files = []
walk(root, 0, files)
console.log(`目录 ${root}: ${files.length} 个文件`)

if (opts.filesOnly) {
  for (const f of files) console.log('  ' + f.p + '  (' + f.size + 'b)')
  process.exit(0)
}

let hits = 0
const perFile = new Map()
for (const f of files) {
  const ext = path.extname(f.p).toLowerCase()
  if (!opts.ext.includes(ext)) continue
  let text
  try {
    text = fs.readFileSync(f.p, 'utf8')
  } catch {
    continue
  }
  if (needle !== '' && !text.toLowerCase().includes(needle)) continue
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (needle !== '' && !lines[i].toLowerCase().includes(needle)) continue
    hits += 1
    perFile.set(f.p, (perFile.get(f.p) || 0) + 1)
    if (hits <= opts.max) {
      console.log(`\n----- ${f.p}:${i + 1} -----`)
      const from = Math.max(0, i - opts.ctx)
      const to = Math.min(lines.length, i + opts.ctx + 1)
      for (let k = from; k < to; k += 1) {
        const mark = k === i ? '>>' : '  '
        console.log(mark + ' ' + lines[k].trim().slice(0, opts.len))
      }
    }
  }
}
console.log(`\n共 ${hits} 处命中，分布在 ${perFile.size} 个文件`)
if (perFile.size > 0 && hits > opts.max) {
  console.log('命中文件（按次数）:')
  for (const [p, n] of [...perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${String(n).padStart(5)}  ${p}`)
  }
}
