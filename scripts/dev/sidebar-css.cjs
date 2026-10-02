// 从 asar 内的 JS 里抽出 sidebar 布局相关 CSS（开发用排查）。
//   $env:ELECTRON_RUN_AS_NODE=1
//   & "D:\Software\DSH\DeepSeek Harness.exe" scripts\sidebar-css.cjs
const fs = require('fs')

const file = 'D:/Software/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js'
const src = fs.readFileSync(file, 'utf8')

const start = src.indexOf('const css = ')
const from = src.indexOf('"', start) + 1
const to = src.indexOf('";', from)
const css = src.slice(from, to)
console.log('CSS 总长 =', css.length)

const wanted = /footArea|footerActions|settingsArea/
const blocks = css.split('}')
let shown = 0
for (const b of blocks) {
  const t = b.trim()
  if (t === '' || !wanted.test(t)) continue
  console.log('\n' + t + '}')
  shown += 1
  if (shown > 24) break
}
