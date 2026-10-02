// 从 app.asar 里读取某个文件中包含关键字的上下文（开发用）。
//   $env:ELECTRON_RUN_AS_NODE=1
//   & "D:\Software\DSH\DeepSeek Harness.exe" scripts\asargrep.cjs <asar内文件> <关键字> [前后行数]
const fs = require('fs')

const file = process.argv[2]
const needle = process.argv[3]
const pad = Number(process.argv[4] === undefined ? 18 : process.argv[4])

const lines = fs.readFileSync(file, 'utf8').split('\n')
let n = 0
for (let i = 0; i < lines.length; i += 1) {
  if (lines[i].indexOf(needle) < 0) continue
  n += 1
  if (n > 4) break
  console.log(`\n===== 命中 @ 第 ${i + 1} 行 =====`)
  console.log(lines.slice(Math.max(0, i - pad), i + pad).join('\n'))
}
if (n === 0) console.log('未命中: ' + needle)
