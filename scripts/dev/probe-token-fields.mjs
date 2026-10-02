// 追查 gen_metadata 里那些「量级像 token、每条都变」的整数字段（开发用，只读）。
// 判据：真正的 token 计数会随会话变长而单调增长（输入），输出则忽大忽小。
// 用法: node scripts/probe-token-fields.mjs
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
  throw new Error('varint overflow')
}

/** 只收集 varint 字段，返回 path -> value（浅树） */
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

function strings(b, depth = 0, path = '', out = []) {
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
      } else if (wire === 2) {
        let len
        ;[len, i] = readVarint(b, i)
        const chunk = b.subarray(i, i + len)
        i += len
        let isText = false
        try {
          const s = chunk.toString('utf8')
          isText = s.length > 0 && s.length < 120 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(s)
        } catch {
          /* binary */
        }
        if (isText) out.push({ p, v: chunk.toString('utf8') })
        else if (depth < 4) strings(chunk, depth + 1, p, out)
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
  const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx LIMIT 26').all()
  console.log('\n' + '='.repeat(100))
  console.log(`${d}  →  ${f.n}   gen_metadata ${rows.length} 条`)
  console.log('='.repeat(100))

  const WATCH = ['1.4.1', '1.4.2', '1.4.3', '1.4.5', '1.4.6', '1.4.9', '1.4.10', '1.9.10.1', '1.9.10.4', '1.11.2', '1.12.2', '1.12.1', '1.11.1']
  console.log('idx  | ' + WATCH.map((w) => w.padStart(11)).join(' ') + ' | model')
  for (const r of rows) {
    const buf = Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data)
    const vi = varints(buf)
    const st = strings(buf)
    const model = (st.find((x) => x.p === '1.19') || {}).v ?? '?'
    const cells = WATCH.map((w) => {
      const arr = vi.get(w)
      return arr === undefined ? '-' : String(arr[0])
    })
    console.log(String(r.idx).padStart(4) + ' | ' + cells.map((c) => c.padStart(11)).join(' ') + ' | ' + model)
  }
  db.close()
}

// 顺带看看 annotations / implicit 这些小文件里有没有用量
console.log('\n' + '='.repeat(100))
console.log('annotations / implicit 小文件内容')
for (const sub of ['annotations', 'implicit']) {
  const dir = join(gem, 'antigravity', sub)
  if (!existsSync(dir)) continue
  const names = readdirSync(dir).slice(0, 3)
  for (const n of names) {
    const p = join(dir, n)
    try {
      console.log(`\n  ${sub}/${n}  (${statSync(p).size}b)`)
      console.log('    ' + readFileSync(p, 'utf8').replace(/\n/g, ' ').slice(0, 300))
    } catch (e) {
      console.log('    读取失败', e.message)
    }
  }
}
