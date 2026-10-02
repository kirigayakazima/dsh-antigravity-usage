// 在 app.asar 内部递归搜索文件内容（开发用）。
// 必须用 Electron 以 Node 模式运行（asar 路径只有 Electron 的 fs 能读）：
//   $env:ELECTRON_RUN_AS_NODE=1
//   & "D:\Software\DSH\DeepSeek Harness.exe" scripts\asarsearch.cjs <base> <pattern> [ext]
const fs = require('fs')
const path = require('path')

const base = process.argv[2]
const pattern = process.argv[3]
const ext = process.argv[4] === undefined ? '.js' : process.argv[4]
const re = new RegExp(pattern)

let files = 0
let hits = 0
const SKIP = new Set(['node_modules/.pnpm', '.git', 'locales', 'out'])

function walk(dir, depth) {
  if (depth > 12) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue
      walk(full, depth + 1)
    } else if (e.name.endsWith(ext)) {
      files += 1
      let txt
      try {
        if (fs.statSync(full).size > 4 * 1024 * 1024) continue
        txt = fs.readFileSync(full, 'utf8')
      } catch {
        continue
      }
      const lines = txt.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        if (re.test(lines[i])) {
          hits += 1
          if (hits <= 80) {
            const rel = full.slice(base.length)
            console.log(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`)
          }
        }
      }
    }
  }
}

walk(base, 0)
console.log(`\n--- 扫描 ${files} 个 ${ext} 文件，命中 ${hits} 行 ---`)
