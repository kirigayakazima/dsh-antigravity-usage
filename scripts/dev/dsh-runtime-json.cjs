// 读 app.asar 里的 desktop-runtime.json（必须用 Electron 当 Node 跑）。
//   $env:ELECTRON_RUN_AS_NODE=1
//   & "D:\Software\DSH\DeepSeek Harness.exe" scripts\dev\dsh-runtime-json.cjs <json路径> [关键字]
const fs = require('node:fs')

const file = process.argv[2]
const needle = (process.argv[3] || '').toLowerCase()

const raw = fs.readFileSync(file, 'utf8')
const j = JSON.parse(raw)
console.log('顶层键:', Object.keys(j).join(', '))
console.log('文件大小:', raw.length)

function show(label, v, depth) {
  const s = JSON.stringify(v, null, 2)
  console.log(`\n=== ${label} ===`)
  console.log(s.length > 2500 ? s.slice(0, 2500) + '\n…' : s)
}

for (const k of Object.keys(j)) {
  const v = j[k]
  if (Array.isArray(v)) {
    console.log(`\n[${k}] 数组，${v.length} 项`)
    if (v.length > 0) show(`[${k}][0]`, v[0], 1)
    if (v.length > 1) show(`[${k}][1]`, v[1], 1)
  } else if (v !== null && typeof v === 'object') {
    console.log(`\n[${k}] 对象，键: ${Object.keys(v).join(', ')}`)
    const s = JSON.stringify(v, null, 2)
    if (s.length < 3000) show(`[${k}]`, v, 1)
  } else {
    console.log(`\n[${k}] = ${JSON.stringify(v)}`)
  }
}

if (needle !== '') {
  console.log('\n\n=== 含 "' + needle + '" 的行 ===')
  const lines = raw.split('\n')
  let n = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].toLowerCase().includes(needle)) continue
    n += 1
    if (n > 60) break
    console.log(`  L${i + 1}: ${lines[i].trim().slice(0, 220)}`)
  }
  console.log(`共 ${n > 60 ? '60+' : n} 行`)
}
