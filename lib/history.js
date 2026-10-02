// antigravity-usage — 本地历史累积。
//
// 反重力的官方接口只给「当前剩余额度」这一个瞬时值，没有任何历史。
// 所以我们自己按固定间隔采样，把每次读数追加成 JSONL 落盘，用它反推消耗：
//
//   - 相邻两次采样里 remainingFraction **下降** → 记入消耗（消耗 ∝ token 成本）
//   - remainingFraction **上升** → 说明窗口滚动恢复或已重置，记入恢复事件，不计消耗
//
// 样本行格式（刻意保持紧凑，长期累积也不会太大）：
//   {"t":1760000000000,"p":2810,"c":{"pa":500,"pm":50000,"fa":100,"fm":150000},
//    "b":{"gemini-weekly":0.8357,"gemini-5h":1,"3p-weekly":1,"3p-5h":1}}
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DAY_MS = 86400000
const EPSILON = 1e-6

function rangeMs(range) {
  if (range === '24h') return DAY_MS
  if (range === '7d') return 7 * DAY_MS
  if (range === '30d') return 30 * DAY_MS
  return Number.POSITIVE_INFINITY
}

function localMidnight(now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function dayKey(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function parseLine(line) {
  const s = line.trim()
  if (s === '') return null
  try {
    const o = JSON.parse(s)
    if (typeof o !== 'object' || o === null) return null
    if (typeof o.t !== 'number' || !Number.isFinite(o.t)) return null
    if (typeof o.b !== 'object' || o.b === null) return null
    return o
  } catch {
    return null
  }
}

export class HistoryStore {
  constructor(dir, retainDays) {
    this.dir = dir
    this.file = join(dir, 'history.jsonl')
    this.lastKnownFile = join(dir, 'last-known.json')
    this.retainDays = retainDays
    this.samples = []
    this.writeChain = Promise.resolve()
    this.dirtySinceCompact = 0
    this.lastError = null
  }

  /** 上一次成功采到的快照（持久化，重启后仍可显示「上次已知额度」）。 */
  loadLastKnown() {
    try {
      if (!existsSync(this.lastKnownFile)) return null
      const o = JSON.parse(readFileSync(this.lastKnownFile, 'utf8'))
      if (o === null || typeof o !== 'object' || o.ok !== true) return null
      return o
    } catch {
      return null
    }
  }

  saveLastKnown(snap) {
    if (snap === null || snap === undefined || snap.ok !== true) return
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.lastKnownFile, JSON.stringify(snap), 'utf8')
    } catch {
      /* 写不了不影响主流程 */
    }
  }

  get size() {
    return this.samples.length
  }

  get error() {
    return this.lastError
  }

  get firstAt() {
    return this.samples.length > 0 ? this.samples[0].t : null
  }

  get lastAt() {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1].t : null
  }

  /** 最后一条采样（用于在没有 last-known.json 时合成「上次已知额度」）。 */
  lastSample() {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1] : null
  }

  /** 读盘 + 加载到内存。 */
  load() {
    try {
      mkdirSync(this.dir, { recursive: true })
      if (!existsSync(this.file)) return
      const txt = readFileSync(this.file, 'utf8')
      const out = []
      for (const line of txt.split('\n')) {
        const s = parseLine(line)
        if (s !== null) out.push(s)
      }
      out.sort((a, b) => a.t - b.t)
      this.samples = this.prune(out)
      this.lastError = null
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
      this.samples = []
    }
  }

  prune(list) {
    const cut = Date.now() - this.retainDays * DAY_MS
    return list.filter((s) => s.t >= cut)
  }

  /** 追加一条采样（来自成功快照）。 */
  append(snap) {
    if (!snap || snap.ok !== true) return
    const buckets = {}
    for (const g of snap.groups) for (const b of g.buckets) buckets[b.id] = b.remainingFraction
    if (Object.keys(buckets).length === 0) return

    const credits = snap.credits === null || snap.credits === undefined
      ? undefined
      : { pa: snap.credits.promptAvailable, pm: snap.credits.promptMonthly, fa: snap.credits.flowAvailable, fm: snap.credits.flowMonthly }

    const last = this.samples.length > 0 ? this.samples[this.samples.length - 1] : null
    // 同一采样点（间隔 < 2s）就地合并，避免重启/手动刷新时写重复行
    if (last !== null && snap.ts - last.t < 2000) {
      last.t = snap.ts
      last.b = buckets
      if (snap.port !== null && snap.port !== undefined) last.p = snap.port
      if (credits !== undefined) last.c = credits
      this.scheduleRewrite()
      return
    }

    const sample = { t: snap.ts, b: buckets }
    if (snap.port !== null && snap.port !== undefined) sample.p = snap.port
    if (credits !== undefined) sample.c = credits
    this.samples.push(sample)
    this.samples = this.prune(this.samples)
    this.appendLine(sample)
  }

  appendLine(sample) {
    this.dirtySinceCompact += 1
    this.writeChain = this.writeChain
      .then(() => {
        mkdirSync(this.dir, { recursive: true })
        appendFileSync(this.file, JSON.stringify(sample) + '\n', 'utf8')
        this.lastError = null
      })
      .catch((e) => {
        this.lastError = e instanceof Error ? e.message : String(e)
      })
    if (this.dirtySinceCompact > 500) void this.compact()
  }

  scheduleRewrite() {
    this.writeChain = this.writeChain
      .then(() => this.writeAllNow())
      .catch((e) => {
        this.lastError = e instanceof Error ? e.message : String(e)
      })
  }

  writeAllNow() {
    mkdirSync(this.dir, { recursive: true })
    const body = this.samples.map((s) => JSON.stringify(s)).join('\n')
    writeFileSync(this.file, body === '' ? '' : body + '\n', 'utf8')
  }

  /** 把内存里（已裁剪）的样本整体重写回磁盘，丢掉超期行与坏行。 */
  async compact() {
    this.dirtySinceCompact = 0
    this.writeChain = this.writeChain.then(() => {
      try {
        this.samples = this.prune(this.samples)
        if (existsSync(this.file) && statSync(this.file).size > 0) {
          renameSync(this.file, this.file + '.bak')
        }
        this.writeAllNow()
        this.lastError = null
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e)
      }
    })
    await this.writeChain
  }

  /** 按范围聚合：采样序列 + 每个桶的消耗/恢复统计。 */
  query(range, maxPoints) {
    const now = Date.now()
    const span = rangeMs(range)
    const from = span === Number.POSITIVE_INFINITY ? Number.NEGATIVE_INFINITY : now - span
    const win = this.samples.filter((s) => s.t >= from)

    // ---- 消耗统计（用全量样本，保证 7d/30d 数字完整） ----
    const ids = new Set()
    for (const s of this.samples) for (const k of Object.keys(s.b)) ids.add(k)

    const midnight = localMidnight(now)
    const usage = new Map()
    for (const id of ids) {
      usage.set(id, {
        id,
        consumed: 0,
        recovered: 0,
        consumedToday: 0,
        consumed24h: 0,
        consumed7d: 0,
        resets: 0,
        lastResetAt: null,
      })
    }

    for (let i = 1; i < this.samples.length; i += 1) {
      const prev = this.samples[i - 1]
      const cur = this.samples[i]
      const dt = cur.t - prev.t
      for (const id of ids) {
        const a = prev.b[id]
        const b = cur.b[id]
        if (typeof a !== 'number' || typeof b !== 'number') continue
        const u = usage.get(id)
        if (u === undefined) continue
        const delta = a - b
        if (delta > EPSILON) {
          u.consumed += delta
          if (cur.t >= midnight) u.consumedToday += delta
          if (cur.t >= now - DAY_MS) u.consumed24h += delta
          if (cur.t >= now - 7 * DAY_MS) u.consumed7d += delta
        } else if (delta < -EPSILON) {
          // 剩余量回升：窗口滚动恢复 / 周期重置
          u.recovered += -delta
          // 只有跳变明显才计为一次「重置」，避免滚动窗口的碎步恢复刷屏
          if (-delta >= 0.05 && dt < 12 * 3600 * 1000) {
            u.resets += 1
            u.lastResetAt = cur.t
          }
        }
      }
    }

    // ---- 降采样给图表用 ----
    const points = []
    if (win.length > 0) {
      const step = Math.max(1, Math.ceil(win.length / Math.max(2, maxPoints)))
      for (let i = 0; i < win.length; i += step) {
        const slice = win.slice(i, i + step)
        const values = {}
        for (const id of ids) {
          let sum = 0
          let n = 0
          for (const s of slice) {
            const v = s.b[id]
            if (typeof v === 'number') {
              sum += v
              n += 1
            }
          }
          if (n > 0) values[id] = sum / n
        }
        points.push({ t: slice[0].t, values })
      }
      const lastSample = win[win.length - 1]
      if (points.length === 0 || points[points.length - 1].t !== lastSample.t) {
        const values = {}
        for (const id of ids) {
          const v = lastSample.b[id]
          if (typeof v === 'number') values[id] = v
        }
        points.push({ t: lastSample.t, values })
      }
    }

    return {
      range,
      points,
      buckets: Array.from(usage.values()),
      sampleCount: win.length,
      firstAt: this.firstAt,
      lastAt: this.lastAt,
    }
  }

  /**
   * 逐日 / 逐月汇总 + 重置事件。
   * 全部由相邻样本的差值推得：下降记消耗、明显上升记一次重置。
   */
  aggregate() {
    const dayMap = new Map()
    const monthMap = new Map()
    const resets = []

    const ensure = (map, key, extra) => {
      let x = map.get(key)
      if (x === undefined) {
        x = { key, consumed: 0, recovered: 0, resets: 0, byBucket: {}, ...extra }
        map.set(key, x)
      }
      return x
    }
    const bump = (node, id, field, amount) => {
      let b = node.byBucket[id]
      if (b === undefined) {
        b = { id, consumed: 0, recovered: 0, resets: 0 }
        node.byBucket[id] = b
      }
      b[field] += amount
    }

    for (let i = 1; i < this.samples.length; i += 1) {
      const prev = this.samples[i - 1]
      const cur = this.samples[i]
      const dt = cur.t - prev.t
      const date = dayKey(cur.t)
      const month = date.slice(0, 7)
      const day = ensure(dayMap, date, { date, samples: 0 })
      const mon = ensure(monthMap, month, { month })
      day.samples += 1

      const ids = new Set([...Object.keys(prev.b), ...Object.keys(cur.b)])
      for (const id of ids) {
        const a = prev.b[id]
        const b = cur.b[id]
        if (typeof a !== 'number' || typeof b !== 'number') continue
        const delta = a - b
        if (delta > EPSILON) {
          day.consumed += delta
          mon.consumed += delta
          bump(day, id, 'consumed', delta)
          bump(mon, id, 'consumed', delta)
        } else if (delta < -EPSILON) {
          const rec = -delta
          day.recovered += rec
          mon.recovered += rec
          bump(day, id, 'recovered', rec)
          bump(mon, id, 'recovered', rec)
          if (rec >= 0.05 && dt < 12 * 3600 * 1000) {
            day.resets += 1
            mon.resets += 1
            bump(day, id, 'resets', 1)
            bump(mon, id, 'resets', 1)
            resets.push({ at: cur.t, date, bucketId: id, from: a, to: b, jump: rec })
          }
        }
      }
    }

    const flatten = (map, keyName) =>
      Array.from(map.values())
        .map((x) => ({
          [keyName]: x.key,
          consumed: x.consumed,
          recovered: x.recovered,
          resets: x.resets,
          ...(x.samples !== undefined ? { samples: x.samples } : {}),
          byBucket: Object.values(x.byBucket),
        }))
        .sort((p, q) => (p[keyName] < q[keyName] ? -1 : 1))

    const daily = flatten(dayMap, 'date')
    const monthly = flatten(monthMap, 'month')
    resets.sort((p, q) => q.at - p.at)

    return {
      daily,
      monthly,
      resets: resets.slice(0, 200),
      totalResets: resets.length,
      firstAt: this.firstAt,
      lastAt: this.lastAt,
      sampleCount: this.samples.length,
    }
  }
}
