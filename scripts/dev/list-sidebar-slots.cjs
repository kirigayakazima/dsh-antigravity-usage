// 列出 DSH 客户端槽位目录里所有 sidebar.* 槽位（开发用排查）。
//   $env:ELECTRON_RUN_AS_NODE=1
//   & "D:\Software\DSH\DeepSeek Harness.exe" scripts\list-sidebar-slots.cjs [前缀]
const fs = require('fs')

const file = 'D:/Software/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js'
const t = fs.readFileSync(file, 'utf8')
const prefix = process.argv[2] === undefined ? 'sidebar' : process.argv[2]

// 槽位对象里 key / kind / scope / summary 彼此相邻，逐行扫描拼装
const lines = t.split('\n')
const rows = []
let cur = null
for (let i = 0; i < lines.length; i += 1) {
  const l = lines[i].trim()
  let m = /^key:\s*"([^"]+)"/.exec(l)
  if (m !== null) {
    if (cur !== null && cur.key !== undefined) rows.push(cur)
    cur = { key: m[1], at: i + 1 }
    continue
  }
  if (cur === null) continue
  m = /^kind:\s*"([^"]+)"/.exec(l)
  if (m !== null) { cur.kind = m[1]; continue }
  m = /^scope:\s*"([^"]+)"/.exec(l)
  if (m !== null) { cur.scope = m[1]; continue }
  m = /^summary:\s*"([^"]*)"/.exec(l)
  if (m !== null) { cur.summary = m[1]; continue }
  m = /^occupants:\s*\[(.*)\]?/.exec(l)
  if (m !== null) {
    cur.occupants = m[1].replace(/[\[\]"]/g, '').split(',').map((s) => s.trim()).filter((s) => s !== '' && s !== ']')
    continue
  }
  m = /^declaredBy:\s*"([^"]*)"/.exec(l)
  if (m !== null) { cur.declaredBy = m[1]; continue }
}
if (cur !== null && cur.key !== undefined) rows.push(cur)

const hits = rows.filter((r) => r.key.startsWith(prefix))
console.log(`共 ${rows.length} 个槽位，匹配 "${prefix}" 的 ${hits.length} 个：\n`)
for (const r of hits) {
  console.log(`${r.key}   [kind=${r.kind ?? '?'} scope=${r.scope ?? '?'}]`)
  if (r.summary !== undefined) console.log(`    ${r.summary.slice(0, 150)}`)
  if (r.declaredBy !== undefined) console.log(`    declaredBy: ${r.declaredBy.slice(0, 110)}`)
  if (r.occupants !== undefined && r.occupants.length > 0) console.log(`    occupants: ${r.occupants.join(' | ').slice(0, 150)}`)
  console.log('')
}
