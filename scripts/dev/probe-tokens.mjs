// 反重力会话库里到底有没有 token / 缓存命中？—— 彻底解一遍（开发用，只读）。
// 用法: node scripts/probe-tokens.mjs
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const KEYWORDS = ['token', 'cache', 'usage', 'prompt', 'candidate', 'billing', 'credit', 'cost', 'thought', 'input', 'output']

async function openRo(path) {
  const { DatabaseSync } = await import('node:sqlite')
  return new DatabaseSync(path, { readOnly: true })
}

function tables(db) {
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  } catch {
    return []
  }
}

function cols(db, t) {
  try {
    return db.prepare(`PRAGMA table_info("${t}")`).all().map((r) => ({ name: r.name, type: r.type }))
  } catch {
    return []
  }
}

// ---------- 通用 protobuf wire 解码 ----------
function readVarint(b, i) {
  let r = 0
  let s = 0
  while (i < b.length) {
    const x = b[i]
    i += 1
    r += (x & 0x7f) * Math.pow(2, s)
    if ((x & 0x80) === 0) return [r, i]
    s += 7
    if (s > 63) break
  }
  throw new Error('varint overflow')
}

function decode(b, depth = 0, path = '', out = []) {
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
        out.push({ p, t: 'varint', v })
      } else if (wire === 2) {
        let len
        ;[len, i] = readVarint(b, i)
        const chunk = b.subarray(i, i + len)
        i += len
        let str = null
        try {
          const s = chunk.toString('utf8')
          if (s.length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) str = s
        } catch {
          /* not text */
        }
        if (str !== null) {
          out.push({ p, t: 'str', v: str.length > 80 ? str.slice(0, 80) + '…' : str })
        } else {
          out.push({ p, t: 'msg', v: 'len=' + len })
          if (depth < 5) decode(chunk, depth + 1, p, out)
        }
      } else if (wire === 5) {
        const v = b.readFloatLE(i)
        i += 4
        out.push({ p, t: 'f32', v })
      } else if (wire === 1) {
        const v = b.readDoubleLE(i)
        i += 8
        out.push({ p, t: 'f64', v })
      } else {
        break
      }
    } catch {
      break
    }
  }
  return out
}

function bump(map, text) {
  const low = text.toLowerCase()
  for (const k of KEYWORDS) {
    if (low.includes(k)) map.set(k, (map.get(k) ?? 0) + 1)
  }
}

// ---------- 1. 会话清单里的 raw_summary ----------
const gem = join(homedir(), '.gemini')
const stores = ['antigravity', 'antigravity-cli', 'antigravity-ide'].map((n) => join(gem, n))

for (const store of stores) {
  const sumPath = join(store, 'conversation_summaries.db')
  if (!existsSync(sumPath)) continue
  console.log('\n' + '='.repeat(90))
  console.log('会话清单:', sumPath)
  const db = await openRo(sumPath)
  const tc = cols(db, 'conversation_summaries')
  console.log('列:', tc.map((c) => c.name).join(', '))
  const rows = db.prepare('SELECT * FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 3').all()
  for (const r of rows) {
    console.log('\n--- 会话', r.conversation_id, '| steps =', r.step_count)
    const raw = r.raw_summary
    if (raw === null || raw === undefined) {
      console.log('   raw_summary: 空')
      continue
    }
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    console.log('   raw_summary: ' + buf.length + ' 字节')
    const fields = decode(buf)
    for (const f of fields) console.log(`     ${f.p.padEnd(16)} ${f.t.padEnd(7)} ${String(f.v).slice(0, 100)}`)
    const hits = new Map()
    bump(hits, buf.toString('latin1'))
    if (hits.size > 0) console.log('   关键字命中:', JSON.stringify(Object.fromEntries(hits)))
  }
  db.close()
}

// ---------- 2. 会话库里的各张表 + gen_metadata ----------
const convDirs = []
for (const store of stores) {
  const d = join(store, 'conversations')
  if (existsSync(d)) convDirs.push({ d, label: store.split(/[\\/]/).pop() })
}

for (const { d, label } of convDirs) {
  const files = readdirSync(d)
    .filter((n) => n.endsWith('.db'))
    .map((n) => ({ n, p: join(d, n), t: statSync(join(d, n)).mtimeMs, s: statSync(join(d, n)).size }))
    .sort((a, b) => b.t - a.t)
  if (files.length === 0) continue
  const f = files[0]
  console.log('\n' + '='.repeat(90))
  console.log(`最新会话库 (${label}): ${f.n}  ${f.s} 字节  ${new Date(f.t).toLocaleString('zh-CN')}`)
  const db = await openRo(f.p)
  for (const t of tables(db)) {
    const c = cols(db, t)
    let cnt = 0
    try {
      cnt = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n
    } catch {
      /* ignore */
    }
    console.log(`\n  表 ${t}  rows=${cnt}`)
    console.log('    ' + c.map((x) => `${x.name}:${x.type}`).join(', '))
  }

  // gen_metadata 全字段解一遍，并对比相邻两条找出「每次都在变的数字」
  try {
    const rows = db.prepare('SELECT idx, data, size FROM gen_metadata ORDER BY idx LIMIT 4').all()
    console.log('\n  --- gen_metadata 前几条（完整字段树）---')
    for (const r of rows) {
      const buf = Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data)
      console.log(`\n  [idx=${r.idx} size=${r.size} len=${buf.length}]`)
      const fields = decode(buf)
      for (const x of fields) console.log(`     ${x.p.padEnd(18)} ${x.t.padEnd(7)} ${String(x.v).slice(0, 110)}`)
    }
    // 全库关键字统计
    const hits = new Map()
    for (const r of db.prepare('SELECT data FROM gen_metadata LIMIT 60').all()) {
      const buf = Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data)
      bump(hits, buf.toString('latin1'))
    }
    console.log('\n  gen_metadata 关键字命中（前 60 条）:', JSON.stringify(Object.fromEntries(hits)))
  } catch (e) {
    console.log('  gen_metadata 读取失败:', e.message)
  }

  // steps 表的 blob 也扫一遍
  try {
    const hits = new Map()
    const rows = db.prepare('SELECT metadata, task_details, render_info FROM steps LIMIT 40').all()
    for (const r of rows) {
      for (const v of Object.values(r)) {
        if (v === null || v === undefined) continue
        const buf = Buffer.isBuffer(v) ? v : Buffer.from(v)
        bump(hits, buf.toString('latin1'))
      }
    }
    console.log('  steps 关键字命中（前 40 行）:', JSON.stringify(Object.fromEntries(hits)))
  } catch (e) {
    console.log('  steps 读取失败:', e.message)
  }

  db.close()
}
