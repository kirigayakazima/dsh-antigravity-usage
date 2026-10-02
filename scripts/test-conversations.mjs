// antigravity-usage — 离线会话扫描测试（开发用）。
// 用法: node scripts/test-conversations.mjs
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanConversations } from '../lib/conversations.js'

let failed = 0
function check(label, ok, extra) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || extra === undefined ? '' : '  → ' + extra}`)
  if (!ok) failed += 1
}

const dataDir = mkdtempSync(join(tmpdir(), 'au-conv-'))
const t0 = Date.now()
const r = await scanConversations({ dataDir, log: (m) => console.log('  [log]', m) })
const dt = Date.now() - t0

console.log(`扫描耗时 ${dt}ms`)
console.log('\n=== 数据目录 ===')
for (const s of r.stores) {
  console.log(`  ${s.ok ? '✅' : '❌'} ${s.label.padEnd(16)} sessions=${s.sessions}  ${s.error ?? ''}`)
}

console.log('\n=== 总计 ===')
console.log(' ', JSON.stringify(r.totals))

console.log('\n=== 按模型（前 10）===')
for (const m of r.byModel.slice(0, 10)) {
  console.log(`  ${m.model.padEnd(28)} sessions=${String(m.sessions).padStart(3)}  genCalls=${m.genCalls}`)
}

console.log('\n=== 按工作区（前 8）===')
for (const w of r.byWorkspace.slice(0, 8)) {
  console.log(`  ${String(w.sessions).padStart(3)} 会话  ${String(w.steps).padStart(5)} 步  ${w.workspace}`)
}

console.log('\n=== 按日（最近 10 天）===')
for (const d of r.byDay.slice(-10)) {
  console.log(`  ${d.date}  sessions=${String(d.sessions).padStart(3)}  steps=${String(d.steps).padStart(5)}  genCalls=${d.genCalls}`)
}

console.log('\n=== 会话（前 8）===')
for (const c of r.conversations.slice(0, 8)) {
  console.log(`  ${String(c.steps).padStart(4)}步 ${String(c.genCalls).padStart(3)}生成  in=${String(c.tokens.input).padStart(9)} out=${String(c.tokens.output).padStart(8)} cache=${String(c.tokens.cacheRead).padStart(10)}  ${(c.title || c.preview || '(无标题)').slice(0, 22)}`)
}

// ================= 断言 =================
console.log('\n=== 断言 ===')
const T = r.totals.tokens
check('会话数 > 0', r.totals.sessions > 0, String(r.totals.sessions))
check('生成次数 > 0', r.totals.genCalls > 0, String(r.totals.genCalls))
check('输入 token > 0（protobuf 字段号解码正确）', T.input > 0, String(T.input))
check('输出 token > 0', T.output > 0, String(T.output))
check('缓存命中读取 > 0', T.cacheRead > 0, String(T.cacheRead))
check('思考 + 回复 = 输出', T.thinking + T.response === T.output, `${T.thinking}+${T.response} vs ${T.output}`)
check('token 与生成次数同量级（没把常量当 token）', T.input / Math.max(1, r.totals.genCalls) > 100, String(Math.round(T.input / Math.max(1, r.totals.genCalls))))
check('按模型带 tokens', (r.byModel[0] ?? {}).tokens !== undefined)
check('按日带 tokens', (r.byDay[0] ?? {}).tokens !== undefined)
check('没有解码错误', (r.conversations.every((c) => c.errors === undefined || c.errors.length === 0)), 
  (r.conversations.flatMap((c) => c.errors ?? [])[0] ?? ''))

// 缓存版本守卫：把缓存里的 v 抹掉（模拟旧版本缓存），再扫一次，token 仍必须正确
console.log('\n=== 回归：旧版本缓存不得让 token 变 0 ===')
const cacheFile = join(dataDir, 'conversations-cache.json')
if (!existsSync(cacheFile)) {
  check('存在扫描缓存文件', false)
} else {
  const raw = JSON.parse(readFileSync(cacheFile, 'utf8'))
  const keys = Object.keys(raw)
  check('缓存里有条目', keys.length > 0, String(keys.length))
  for (const k of keys) delete raw[k].v   // 抹掉版本号 = 旧缓存
  writeFileSync(cacheFile, JSON.stringify(raw), 'utf8')
  const r2 = await scanConversations({ dataDir })
  check('旧缓存被忽略后 token 仍然正确',
    r2.totals.tokens.input === T.input && r2.totals.tokens.cacheRead === T.cacheRead,
    `in=${r2.totals.tokens.input} cache=${r2.totals.tokens.cacheRead}`)
  // 命中缓存（同版本）时也必须带 token
  const r3 = await scanConversations({ dataDir })
  check('命中新缓存时 token 仍正确', r3.totals.tokens.input === T.input, String(r3.totals.tokens.input))
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
