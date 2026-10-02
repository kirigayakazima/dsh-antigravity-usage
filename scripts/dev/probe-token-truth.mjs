// 判定 1.9.10.1 到底是「token 数」还是「字节/字符数」（开发用，只读）。
// 判据：拿同一会话里 step_payload 的累计字节数去比。
//   若 1.9.10.1 ≈ 累计字节 → 它是字节数
//   若 1.9.10.1 ≈ 累计字节 / 4 → 它是 token 数（英文约 4 字节/token）
// 用法: node scripts/probe-token-truth.mjs
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function readVarint(b, i) {
  let r = 0
  let s = 0
  while (i < b.length) {
    const x = b[i]
    i += 1
    r += (x & 0x7f) * Math.pow(2, s)
    if ((x & 0x80) === 0) return [r, i]
    s += 7
  }
  throw new Error('v')
}

function varints(b, depth = 0, path = '', out = new Map()) {
  let i = 0
  while (i < b.length) {
    let key
    try {
      ;[key, i] = readVarint(b, i)
    } catch {
      break
    }
    const field = Math.floor(key / 8)
    const wire = key % 8
    const p = path === '' ? String(field) : path + '.' + field
    try {
      if (wire === 0) {
        let v
        ;[v, i] = readVarint(b, i)
        if (!out.has(p)) out.set(p, [])
        out.get(p).push(v)
      } else if (wire === 2) {
        let len
        ;[len, i] = readVarint(b, i)
        const chunk = b.subarray(i, i + len)
        i += len
        if (depth < 4) varints(chunk, depth + 1, p, out)
      } else if (wire === 5) i += 4
      else if (wire === 1) i += 8
      else break
    } catch {
      break
    }
  }
  return out
}

const gem = join(homedir(), '.gemini')
const dirs = ['antigravity', 'antigravity-cli'].map((n) => join(gem, n, 'conversations')).filter(existsSync)

for (const d of dirs) {
  const files = readdirSync(d)
    .filter((n) => n.endsWith('.db'))
    .map((n) => ({ n, p: join(d, n), t: statSync(join(d, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  if (files.length === 0) continue

  const { DatabaseSync } = await import('node:sqlite')
  const f = files[0]
  const db = new DatabaseSync(f.p, { readOnly: true })

  // 每一步的 step_payload 字节数（按 idx）
  const stepBytes = new Map()
  for (const r of db.prepare('SELECT idx, length(step_payload) AS n FROM steps').all()) {
    stepBytes.set(r.idx, r.n === null ? 0 : r.n)
  }

  const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx LIMIT 14').all()
  console.log('\n' + '='.repeat(104))
  console.log(`${f.n}   （对比 1.9.10.1 与累计 step_payload 字节数）`)
  console.log('='.repeat(104))
  console.log('genIdx | 1.9.10.1 | 累计payload字节 | 字节/计数 | 计数/字节 | 该步payload')
  let cum = 0
  for (const r of rows) {
    const buf = Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data)
    const vi = varints(buf)
    const v = (vi.get('1.9.10.1') || [null])[0]
    // 累计到这一步为止的所有 payload
    for (const [idx, n] of stepBytes) if (idx <= r.idx) cum += 0 // 下面单独重算
    let c = 0
    for (const [idx, n] of stepBytes) if (idx <= r.idx) c += n
    const own = stepBytes.get(r.idx) ?? 0
    console.log(
      String(r.idx).padStart(6) + ' | ' +
      String(v).padStart(8) + ' | ' +
      String(c).padStart(15) + ' | ' +
      (v === null || v === undefined || v === 0 ? '-' : (c / v).toFixed(2)).padStart(9) + ' | ' +
      (v === null || v === undefined || c === 0 ? '-' : (v / c).toFixed(4)).padStart(9) + ' | ' +
      String(own).padStart(11),
    )
  }
  db.close()
}
