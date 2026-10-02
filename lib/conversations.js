// antigravity-usage — 反重力本地会话用量扫描（完全离线，只读）。
//
// 这一块**不依赖反重力在运行**：直接读它落在磁盘上的 SQLite。
//   ~/.gemini/antigravity/conversation_summaries.db   → 会话清单（标题/步数/工作区/时间）
//   ~/.gemini/antigravity/conversations/<id>.db       → 每个会话的 gen_metadata（模型、生成次数）
//   ~/.gemini/antigravity-cli/...                     → 同上（CLI 那一套）
//
// 全程只读：一律以 SQLITE_OPEN_READONLY 打开；万一只读打开失败（例如库需要恢复），
// 退化成「复制到临时目录再读副本」，绝不写反重力自己的目录。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const DAY_MS = 86400000

/**
 * 会话扫描缓存的**结构版本**。任何会改变缓存条目字段的改动都必须 +1，
 * 否则升级后会命中旧缓存、新字段一律读到 undefined（token 就这么变成全 0 过）。
 * v1 → v2：加入 token 用量（input/output/cacheRead/thinking/response）。
 */
const CACHE_VERSION = 2

/** 反重力的几套数据目录（label 只用于展示）。备份目录默认不扫。 */
export function storeDirs() {
  const home = homedir()
  const gem = join(home, '.gemini')
  return [
    { dir: join(gem, 'antigravity'), label: 'Antigravity' },
    { dir: join(gem, 'antigravity-cli'), label: 'Antigravity CLI' },
    { dir: join(gem, 'antigravity-ide'), label: 'Antigravity IDE' },
  ]
}

let sqliteModule // 懒加载并缓存
async function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule
  try {
    sqliteModule = await import('node:sqlite')
  } catch {
    sqliteModule = null
  }
  return sqliteModule
}

/** 以只读方式打开；失败则复制副本再打开。返回 { db, cleanup }。 */
async function openReadOnly(path) {
  const sqlite = await loadSqlite()
  if (sqlite === null) throw new Error('当前运行时没有 node:sqlite，无法读取本地会话库')

  try {
    return { db: new sqlite.DatabaseSync(path, { readOnly: true }), cleanup: () => {} }
  } catch (first) {
    // 只读打开失败（常见于库需要恢复 / 有热日志）→ 读副本，绝不碰原目录
    let tmp = null
    try {
      const base = join(tmpdir(), 'antigravity-usage-ro')
      mkdirSync(base, { recursive: true })
      tmp = join(base, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
      copyFileSync(path, tmp)
      const db = new sqlite.DatabaseSync(tmp, { readOnly: true })
      return {
        db,
        cleanup: () => {
          try {
            rmSync(tmp, { force: true })
          } catch {
            /* ignore */
          }
        },
      }
    } catch {
      throw first
    }
  }
}

function toText(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8')
  return String(v)
}

function toNum(v, fallback = 0) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

/** '2026-09-16 12:06:29.9138897+00:00' / ISO / epoch → epoch ms（失败返回 null） */
export function parseStamp(v) {
  const s = toText(v).trim()
  if (s === '') return null
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return n > 1e12 ? n : n * 1000
  }
  // SQLite 常见格式：'YYYY-MM-DD HH:MM:SS.fffffff+00:00' → 补成 ISO
  let iso = s.replace(' ', 'T')
  if (/[+-]\d{2}:\d{2}$/.test(iso) === false && /Z$/i.test(iso) === false) iso += 'Z'
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

function dayKey(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/** 从 gen_metadata 的 protobuf 字节里抠出模型名。 */
const MODEL_RE = /(gemini-[0-9][0-9a-z.\-]*|claude-[0-9][0-9a-z.\-]*|gpt-oss[0-9a-z.\-]*|models\/[a-z0-9.\-]+)/gi

/**
 * 一次生成对应一条 gen_metadata，而同一行里往往同时出现
 * `gemini-3.8-flash` 和 `gemini-3.8-flash-high`（一个是模型、一个是档位）。
 * 若两个都计，就会出现「两个模型次数几乎一样」的重复计数。
 * 所以每行只取一个：优先取「是其它候选前缀」的那个最短名字。
 */
function primaryModel(buf) {
  if (buf === null || buf === undefined) return null
  let text
  try {
    text = Buffer.isBuffer(buf) ? buf.toString('latin1') : Buffer.from(buf).toString('latin1')
  } catch {
    return null
  }
  const found = text.match(MODEL_RE)
  if (found === null) return null
  const uniq = Array.from(new Set(found.map((m) => m.toLowerCase().replace(/^models\//, ''))))
  if (uniq.length === 1) return uniq[0]
  const sorted = uniq.slice().sort((a, b) => a.length - b.length)
  for (const cand of sorted) {
    if (uniq.every((other) => other === cand || other.startsWith(cand))) return cand
  }
  return sorted[0]
}

/** protobuf varint 读取。 */
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

/**
 * 从 gen_metadata 的 protobuf 里解出 token 用量。
 *
 * 字段号是靠「语言服务器 GetCascadeTrajectory 返回的 modelUsage」逐项核对出来的
 * （同一会话、同一步，五项全等）：
 *   gen_metadata.1.4.2    = inputTokens
 *   gen_metadata.1.4.3    = outputTokens
 *   gen_metadata.1.4.5    = cacheReadTokens      ← 缓存命中读取
 *   gen_metadata.1.4.9    = thinkingOutputTokens
 *   gen_metadata.1.4.10   = responseOutputTokens
 *   gen_metadata.1.9.10.1 = estimatedTokensUsed（估算上下文）
 *   gen_metadata.1.9.10.4 = maxContextTokens
 *
 * 只按需下钻（1 → 4 与 1 → 9 → 10），不递归系统提示词那类大字段，所以很快。
 */
function decodeUsage(buf) {
  const out = { input: 0, output: 0, cacheRead: 0, thinking: 0, response: 0, estimated: 0, maxContext: 0 }
  const sub = (b, i) => {
    const [key, j] = readVarint(b, i)
    const field = Math.floor(key / 8)
    const wire = key % 8
    if (wire === 0) {
      const [v, k] = readVarint(b, j)
      return { field, wire, v, next: k }
    }
    if (wire === 2) {
      const [len, k] = readVarint(b, j)
      return { field, wire, chunk: b.subarray(k, k + len), next: k + len }
    }
    if (wire === 5) return { field, wire, next: j + 4 }
    if (wire === 1) return { field, wire, next: j + 8 }
    return null
  }

  let i = 0
  while (i < buf.length) {
    let r
    try {
      r = sub(buf, i)
    } catch {
      break
    }
    if (r === null) break
    i = r.next
    // 路径是 1.4.* / 1.9.10.*：顶层只认字段 1
    if (r.wire !== 2 || r.field !== 1) continue

    let k = 0
    while (k < r.chunk.length) {
      let q
      try {
        q = sub(r.chunk, k)
      } catch {
        break
      }
      if (q === null) break
      k = q.next
      if (q.wire !== 2) continue

      if (q.field === 4) {
        // 1.4.* = modelUsage
        let m = 0
        while (m < q.chunk.length) {
          let z
          try {
            z = sub(q.chunk, m)
          } catch {
            break
          }
          if (z === null) break
          m = z.next
          if (z.wire !== 0) continue
          if (z.field === 2) out.input = z.v
          else if (z.field === 3) out.output = z.v
          else if (z.field === 5) out.cacheRead = z.v
          else if (z.field === 9) out.thinking = z.v
          else if (z.field === 10) out.response = z.v
        }
      } else if (q.field === 9) {
        // 1.9.* → 1.9.10.* = {1: estimatedTokensUsed, 4: maxContextTokens}
        let m = 0
        while (m < q.chunk.length) {
          let z
          try {
            z = sub(q.chunk, m)
          } catch {
            break
          }
          if (z === null) break
          m = z.next
          if (z.wire !== 2 || z.field !== 10) continue
          let n = 0
          while (n < z.chunk.length) {
            let w
            try {
              w = sub(z.chunk, n)
            } catch {
              break
            }
            if (w === null) break
            n = w.next
            if (w.wire !== 0) continue
            if (w.field === 1) out.estimated = w.v
            else if (w.field === 4) out.maxContext = w.v
          }
        }
      }
    }
  }
  return out
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, thinking: 0, response: 0, genCalls: 0 }
}

function addTokens(into, u) {
  into.input += u.input
  into.output += u.output
  into.cacheRead += u.cacheRead
  into.thinking += u.thinking
  into.response += u.response
  into.genCalls += 1
}

/** 读一个会话 db 的 gen_metadata → 生成次数 + 模型分布 + token 用量。 */
async function readConversationDb(path) {
  const { db, cleanup } = await openReadOnly(path)
  try {
    const modelCounts = {}
    const modelTokens = {}
    const tokens = emptyTokens()
    const decodeErrors = []
    let maxContext = 0
    let genCalls = 0
    try {
      const rows = db.prepare('SELECT data FROM gen_metadata').all()
      genCalls = rows.length
      for (const r of rows) {
        const u = decodeUsage(r.data)
        addTokens(tokens, u)
        if (u.maxContext > maxContext) maxContext = u.maxContext
        const m = primaryModel(r.data)
        if (m === null) continue
        modelCounts[m] = (modelCounts[m] ?? 0) + 1
        let mt = modelTokens[m]
        if (mt === undefined) {
          mt = emptyTokens()
          modelTokens[m] = mt
        }
        addTokens(mt, u)
      }
    } catch (e) {
      // 不要静默：解码失败曾经把「readVarint 未定义」这种真 bug 藏了很久
      decodeErrors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (tokens.genCalls === 0 && genCalls > 0) {
      decodeErrors.push(`${path}: 读到 ${genCalls} 条 gen_metadata 但一条 token 都没解出来`)
    }
    return { genCalls, modelCounts, modelTokens, tokens, maxContext, models: Object.keys(modelCounts), errors: decodeErrors }
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    cleanup()
  }
}

function readSummaries(path) {
  return openReadOnly(path).then(({ db, cleanup }) => {
    try {
      const rows = db.prepare('SELECT * FROM conversation_summaries').all()
      return rows
    } finally {
      try {
        db.close()
      } catch {
        /* ignore */
      }
      cleanup()
    }
  })
}

/**
 * 扫描全部数据目录，返回离线用量。
 * @param {{ dataDir: string, maxConversationScan?: number, log?: (m: string) => void }} opts
 */
export async function scanConversations(opts) {
  const dataDir = opts.dataDir
  const log = opts.log ?? (() => {})
  const maxScan = opts.maxConversationScan ?? 60
  const cacheFile = join(dataDir, 'conversations-cache.json')

  let cache = {}
  try {
    if (existsSync(cacheFile)) cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
  } catch {
    cache = {}
  }

  const stores = []
  const byId = new Map()

  for (const store of storeDirs()) {
    const sumPath = join(store.dir, 'conversation_summaries.db')
    if (!existsSync(sumPath)) {
      stores.push({ label: store.label, dir: store.dir, ok: false, error: '没有 conversation_summaries.db', sessions: 0 })
      continue
    }
    let rows
    try {
      rows = await readSummaries(sumPath)
    } catch (e) {
      stores.push({ label: store.label, dir: store.dir, ok: false, error: String(e.message ?? e), sessions: 0 })
      continue
    }

    let count = 0
    for (const r of rows) {
      const id = toText(r.conversation_id)
      if (id === '') continue
      const modified = parseStamp(r.last_modified_time)
      const lastInput = parseStamp(r.last_user_input_time)
      let workspaces = []
      try {
        const w = JSON.parse(toText(r.workspace_uris) || '[]')
        if (Array.isArray(w)) workspaces = w.map((u) => decodeURIComponent(String(u).replace(/^file:\/\//, '')))
      } catch {
        /* ignore */
      }
      const entry = {
        id,
        title: toText(r.title),
        preview: toText(r.preview),
        steps: toNum(r.step_count),
        genCalls: 0,
        models: [],
        tokens: emptyTokens(),
        maxContext: 0,
        workspaces,
        lastModified: modified,
        lastInput,
        status: toText(r.status),
        store: store.label,
        appDataDir: toText(r.app_data_dir),
      }
      const prev = byId.get(id)
      // 同一个会话可能在多套目录里都有；保留信息更全的那份
      if (prev === undefined || (entry.lastModified ?? 0) > (prev.lastModified ?? 0)) byId.set(id, entry)
      count += 1
    }
    stores.push({ label: store.label, dir: store.dir, ok: true, error: null, sessions: count })
  }

  // ---- 逐个会话 db 取模型 / 生成次数（带 mtime 缓存）----
  const convDirs = []
  for (const store of storeDirs()) {
    const d = join(store.dir, 'conversations')
    if (existsSync(d)) convDirs.push({ dir: d, label: store.label })
  }

  const nextCache = {}
  let scanned = 0
  for (const entry of byId.values()) {
    if (scanned >= maxScan) break
    let found = null
    for (const cd of convDirs) {
      for (const cand of [join(cd.dir, entry.id + '.db'), join(cd.dir, entry.id + '.pb')]) {
        if (existsSync(cand)) {
          found = cand
          break
        }
      }
      if (found !== null) break
    }
    if (found === null) continue

    let st
    try {
      st = statSync(found)
    } catch {
      continue
    }
    const key = found
    const sig = `${st.mtimeMs}:${st.size}`
    const cached = cache[key]
    if (cached !== undefined && cached.sig === sig && cached.v === CACHE_VERSION) {
      entry.genCalls = cached.genCalls
      entry.models = cached.models ?? []
      entry.modelCounts = cached.modelCounts ?? {}
      entry.modelTokens = cached.modelTokens ?? {}
      entry.tokens = cached.tokens ?? emptyTokens()
      entry.maxContext = cached.maxContext ?? 0
      nextCache[key] = cached
      continue
    }
    if (found.endsWith('.pb')) continue

    scanned += 1
    try {
      const got = await readConversationDb(found)
      entry.genCalls = got.genCalls
      entry.models = got.models
      entry.modelCounts = got.modelCounts
      entry.modelTokens = got.modelTokens
      entry.tokens = got.tokens
      entry.maxContext = got.maxContext
      nextCache[key] = {
        v: CACHE_VERSION,
        sig,
        genCalls: got.genCalls,
        models: got.models,
        modelCounts: got.modelCounts,
        modelTokens: got.modelTokens,
        tokens: got.tokens,
        maxContext: got.maxContext,
      }
    } catch (e) {
      log(`读会话 ${entry.id} 失败: ${e.message ?? e}`)
      entry.modelCounts = {}
      entry.modelTokens = {}
      nextCache[key] = { v: CACHE_VERSION, sig, genCalls: 0, models: [], modelCounts: {}, modelTokens: {}, tokens: emptyTokens(), maxContext: 0 }
    }
  }

  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(nextCache), 'utf8')
  } catch {
    /* 缓存写不了不影响结果 */
  }

  // ---- 聚合 ----
  const conversations = Array.from(byId.values()).sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))

  const dayMap = new Map()
  const modelMap = new Map()
  const wsMap = new Map()
  const totals = { sessions: conversations.length, steps: 0, genCalls: 0, models: new Set(), tokens: emptyTokens() }

  for (const c of conversations) {
    totals.steps += c.steps
    totals.genCalls += c.genCalls
    for (const m of c.models) totals.models.add(m)
    const tk = c.tokens ?? emptyTokens()
    totals.tokens.input += tk.input
    totals.tokens.output += tk.output
    totals.tokens.cacheRead += tk.cacheRead
    totals.tokens.thinking += tk.thinking
    totals.tokens.response += tk.response

    const ts = c.lastModified ?? c.lastInput
    if (ts !== null && ts !== undefined) {
      const k = dayKey(ts)
      let d = dayMap.get(k)
      if (d === undefined) {
        d = { date: k, sessions: 0, steps: 0, genCalls: 0, tokens: emptyTokens() }
        dayMap.set(k, d)
      }
      d.sessions += 1
      d.steps += c.steps
      d.genCalls += c.genCalls
      d.tokens.input += tk.input
      d.tokens.output += tk.output
      d.tokens.cacheRead += tk.cacheRead
      d.tokens.thinking += tk.thinking
      d.tokens.response += tk.response
    }

    const counts = c.modelCounts ?? {}
    const mt = c.modelTokens ?? {}
    for (const m of Object.keys(counts)) {
      let x = modelMap.get(m)
      if (x === undefined) {
        x = { model: m, sessions: 0, genCalls: 0, tokens: emptyTokens() }
        modelMap.set(m, x)
      }
      x.sessions += 1
      x.genCalls += counts[m]
      const t = mt[m]
      if (t !== undefined) {
        x.tokens.input += t.input
        x.tokens.output += t.output
        x.tokens.cacheRead += t.cacheRead
        x.tokens.thinking += t.thinking
        x.tokens.response += t.response
      }
    }

    for (const w of c.workspaces.length > 0 ? c.workspaces : ['(未知)']) {
      let x = wsMap.get(w)
      if (x === undefined) {
        x = { workspace: w, sessions: 0, steps: 0, tokens: emptyTokens() }
        wsMap.set(w, x)
      }
      x.sessions += 1
      x.steps += c.steps
      x.tokens.input += tk.input
      x.tokens.output += tk.output
      x.tokens.cacheRead += tk.cacheRead
      x.tokens.thinking += tk.thinking
      x.tokens.response += tk.response
    }
  }

  const byDay = Array.from(dayMap.values()).sort((a, b) => (a.date < b.date ? -1 : 1))
  const cutoff = Date.now() - 400 * DAY_MS
  const sumToken = (t) => (t === undefined ? 0 : t.input + t.output)

  return {
    ok: true,
    error: null,
    scannedAt: Date.now(),
    stores,
    conversations: conversations.slice(0, 400),
    byDay: byDay.filter((d) => Date.parse(d.date) >= cutoff),
    byModel: Array.from(modelMap.values()).sort((a, b) => sumToken(b.tokens) - sumToken(a.tokens)),
    byWorkspace: Array.from(wsMap.values()).sort((a, b) => sumToken(b.tokens) - sumToken(a.tokens)).slice(0, 60),
    totals: {
      sessions: totals.sessions,
      steps: totals.steps,
      genCalls: totals.genCalls,
      models: totals.models.size,
      tokens: totals.tokens,
    },
  }
}

export function emptyConversations(error) {
  return {
    ok: false,
    error,
    scannedAt: Date.now(),
    stores: [],
    conversations: [],
    byDay: [],
    byModel: [],
    byWorkspace: [],
    totals: { sessions: 0, steps: 0, genCalls: 0, models: 0, tokens: emptyTokens() },
  }
}
