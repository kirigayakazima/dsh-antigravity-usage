// antigravity-usage — 历史累积算法测试（开发用，合成数据，不碰真实接口）。
// 用法: node scripts/test-history.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HistoryStore } from '../lib/history.js'

const DAY = 86400000
const dir = mkdtempSync(join(tmpdir(), 'au-hist-'))
let failed = 0

function check(label, actual, expected) {
  const ok = typeof expected === 'number'
    ? Math.abs(actual - expected) < 1e-6
    : actual === expected
  console.log(`  ${ok ? '✅' : '❌'} ${label}: ${actual}${ok ? '' : '  (期望 ' + expected + ')'}`)
  if (!ok) failed += 1
}

function fakeSnap(ts, buckets, port = 2810) {
  return {
    ok: true,
    ts,
    port,
    credits: { promptAvailable: 500, promptMonthly: 50000, flowAvailable: 100, flowMonthly: 150000 },
    groups: [{
      name: 'Gemini Models',
      buckets: Object.keys(buckets).map((id) => ({ id, remainingFraction: buckets[id] })),
    }],
  }
}

const now = Date.now()
const store = new HistoryStore(dir, 180)

console.log('=== 场景：消耗 + 重置 + 恢复 ===')
// t0 剩 100% → t1 剩 80%（消耗 20%）→ t2 剩 60%（消耗 20%）→ t3 重置回 100%
store.append(fakeSnap(now - 4 * 3600000, { 'gemini-weekly': 1.0 }))
store.append(fakeSnap(now - 3 * 3600000, { 'gemini-weekly': 0.8 }))
store.append(fakeSnap(now - 2 * 3600000, { 'gemini-weekly': 0.6 }))
store.append(fakeSnap(now - 1 * 3600000, { 'gemini-weekly': 1.0 }))

const q = store.query('24h', 400)
const b = q.buckets[0]
check('采样点数', q.points.length, 4)
check('累计消耗', Number(b.consumed.toFixed(4)), 0.4)
check('24h 消耗', Number(b.consumed24h.toFixed(4)), 0.4)
check('恢复量', Number(b.recovered.toFixed(4)), 0.4)
check('重置次数', b.resets, 1)
check('重置时间戳', b.lastResetAt, now - 1 * 3600000)

console.log('\n=== 场景：滚动恢复（碎步上升）不计为重置 ===')
const dir2 = mkdtempSync(join(tmpdir(), 'au-hist2-'))
const s2 = new HistoryStore(dir2, 180)
s2.append(fakeSnap(now - 3000000, { 'b': 0.50 }))
s2.append(fakeSnap(now - 2400000, { 'b': 0.51 })) // +1%，不算重置
s2.append(fakeSnap(now - 1800000, { 'b': 0.62 })) // +11% 但 <5% 阈值？11% 会算重置
const q2 = s2.query('24h', 400).buckets[0]
check('无消耗（只上升）', Number(q2.consumed.toFixed(4)), 0)
check('恢复累计', Number(q2.recovered.toFixed(4)), 0.12)
check('重置计数', q2.resets, 1)

console.log('\n=== 场景：落盘 + 重新加载 ===')
const dir3 = mkdtempSync(join(tmpdir(), 'au-hist3-'))
const s3 = new HistoryStore(dir3, 180)
s3.append(fakeSnap(now - 7200000, { 'x': 1.0 }))
s3.append(fakeSnap(now - 3600000, { 'x': 0.75 }))
await s3.compact()
const s3b = new HistoryStore(dir3, 180)
s3b.load()
check('重载后样本数', s3b.size, 2)
const q3 = s3b.query('24h', 400).buckets[0]
check('重载后消耗', Number(q3.consumed.toFixed(4)), 0.25)

console.log('\n=== 场景：裁剪超期数据 ===')
const dir4 = mkdtempSync(join(tmpdir(), 'au-hist4-'))
const s4 = new HistoryStore(dir4, 7) // 只留 7 天
s4.append(fakeSnap(now - 30 * DAY, { 'y': 0.5 }))
s4.append(fakeSnap(now - DAY, { 'y': 0.9 }))
check('30 天前的样本被裁掉', s4.size, 1)

console.log('\n=== 场景：同一采样点合并（间隔 <2s）===')
const dir5 = mkdtempSync(join(tmpdir(), 'au-hist5-'))
const s5 = new HistoryStore(dir5, 180)
s5.append(fakeSnap(now - 1000, { 'z': 0.9 }))
s5.append(fakeSnap(now, { 'z': 0.8 }))
check('合并为 1 条', s5.size, 1)
const q5 = s5.query('24h', 400)
check('合并后无消耗记录（同一时刻）', q5.buckets[0].consumed, 0)

console.log('\n=== 场景：逐日/逐月汇总 + 重置事件 ===')
const dir6 = mkdtempSync(join(tmpdir(), 'au-hist6-'))
const s6 = new HistoryStore(dir6, 180)
// 前天：100 → 70（消耗 30）
s6.append(fakeSnap(now - 2 * DAY, { 'w': 1.0 }))
s6.append(fakeSnap(now - 2 * DAY + 3600000, { 'w': 0.7 }))
// 昨天：0.7 → 0.5（消耗 20），随后重置回 1.0
s6.append(fakeSnap(now - 1 * DAY, { 'w': 0.7 }))
s6.append(fakeSnap(now - 1 * DAY + 3600000, { 'w': 0.5 }))
s6.append(fakeSnap(now - 1 * DAY + 7200000, { 'w': 1.0 }))
// 今天：1.0 → 0.9（消耗 10）
s6.append(fakeSnap(now - 1800000, { 'w': 1.0 }))
s6.append(fakeSnap(now, { 'w': 0.9 }))

const agg = s6.aggregate()
check('逐日条目数', agg.daily.length, 3)
check('前天消耗', Number(agg.daily[0].consumed.toFixed(4)), 0.3)
check('昨天消耗', Number(agg.daily[1].consumed.toFixed(4)), 0.2)
check('昨天重置次数', agg.daily[1].resets, 1)
check('今天消耗', Number(agg.daily[2].consumed.toFixed(4)), 0.1)
check('总消耗', Number(agg.daily.reduce((a, d) => a + d.consumed, 0).toFixed(4)), 0.6)
check('逐月条目数', agg.monthly.length >= 1, true)
check('重置事件条数', agg.totalResets, 1)
check('重置事件有桶名', agg.resets[0].bucketId, 'w')
check('重置事件 jump', Number(agg.resets[0].jump.toFixed(4)), 0.5)

console.log('\n=== 场景：lastKnown 持久化 ===')
const dir7 = mkdtempSync(join(tmpdir(), 'au-hist7-'))
const s7 = new HistoryStore(dir7, 180)
check('初始 lastKnown 为 null', s7.loadLastKnown(), null)
const good = fakeSnap(now, { 'k': 0.42 })
s7.append(good)
s7.saveLastKnown(good)
const reloaded = new HistoryStore(dir7, 180).loadLastKnown()
check('重载后 lastKnown 非空', reloaded !== null && reloaded.ok === true, true)
check('重载后额度一致', reloaded.groups[0].buckets[0].remainingFraction, 0.42)
check('失败快照不覆盖 lastKnown', (() => {
  const s = new HistoryStore(dir7, 180)
  s.saveLastKnown({ ok: false, ts: Date.now() })
  return s.loadLastKnown().groups[0].buckets[0].remainingFraction
})(), 0.42)

for (const d of [dir, dir2, dir3, dir4, dir5, dir6, dir7]) {
  try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
