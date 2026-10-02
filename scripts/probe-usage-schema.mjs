// 把 modelUsage 的完整字段表和缓存字段拿下来，并和本地 protobuf 的 1.4.* 对上号。
// 用法: node scripts/probe-usage-schema.mjs
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SVC = '/exa.language_server_pb.LanguageServerService'
const PORT_RE = /listening on random port at (\d+) for HTTP(?!S)/

function discoverPort() {
  const home = homedir()
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
  const cands = []
  const logDir = join(home, '.gemini', 'antigravity', 'log')
  if (existsSync(logDir)) {
    for (const n of readdirSync(logDir).filter((x) => x.endsWith('.log'))) {
      const p = join(logDir, n)
      cands.push({ p, t: statSync(p).mtimeMs })
    }
  }
  cands.push({ p: join(appData, 'Antigravity', 'logs', 'language_server.log'), t: 0 })
  cands.sort((a, b) => b.t - a.t)
  for (const c of cands) {
    try {
      const m = readFileSync(c.p, 'utf8').match(PORT_RE)
      if (m !== null) return Number(m[1])
    } catch {
      /* skip */
    }
  }
  return null
}

const port = discoverPort()
const html = await (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(8000) })).text()
const csrf = html.match(/csrfToken":"([^"]+)"/)[1]

let cascadeId = null
{
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(homedir(), '.gemini', 'antigravity', 'conversation_summaries.db'), { readOnly: true })
  cascadeId = db.prepare('SELECT conversation_id FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 1').get().conversation_id
  db.close()
}

console.log('抓轨迹…', cascadeId)
const res = await fetch(`http://127.0.0.1:${port}${SVC}/GetCascadeTrajectory`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': csrf },
  body: JSON.stringify({ cascadeId }),
  signal: AbortSignal.timeout(60000),
})
const root = await res.json()
console.log('响应', JSON.stringify(root).length, '字节')

// 递归找所有 modelUsage
const usages = []
const cacheKeys = new Map()
const allKeys = new Map()
function walk(node, depth) {
  if (node === null || typeof node !== 'object' || depth > 12) return
  if (Array.isArray(node)) {
    for (const x of node) walk(x, depth + 1)
    return
  }
  for (const [k, v] of Object.entries(node)) {
    const low = k.toLowerCase()
    if (low.includes('cache') || low.includes('token') || low.includes('credit')) {
      const prev = cacheKeys.get(k) ?? { n: 0, sample: null }
      prev.n += 1
      if (prev.sample === null && (typeof v === 'string' || typeof v === 'number')) prev.sample = v
      cacheKeys.set(k, prev)
    }
    if (k === 'modelUsage' && v !== null && typeof v === 'object') usages.push(v)
    if (typeof v === 'object') walk(v, depth + 1)
  }
}
walk(root, 0)

console.log('\n=== 找到 ' + usages.length + ' 条 modelUsage ===')
const keySets = new Map()
for (const u of usages) {
  const keys = Object.keys(u).sort().join(',')
  keySets.set(keys, (keySets.get(keys) ?? 0) + 1)
}
console.log('\n不同的字段组合:')
for (const [k, n] of keySets) console.log(`  x${n}  ${k}`)

console.log('\n=== 前 3 条 modelUsage 完整内容 ===')
for (const u of usages.slice(0, 3)) console.log('  ' + JSON.stringify(u))

console.log('\n=== 所有含 cache/token/credit 的字段名 ===')
for (const [k, v] of [...cacheKeys.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 25)) {
  console.log(`  ${k.padEnd(34)} x${String(v.n).padStart(6)}   例: ${String(v.sample).slice(0, 40)}`)
}

console.log('\n=== 含 cache 的字段在哪些路径下（看一个样本的完整对象）===')
function findFirstWithCache(node, depth = 0, path = '') {
  if (node === null || typeof node !== 'object' || depth > 12) return null
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const r = findFirstWithCache(node[i], depth + 1, path + '[' + i + ']')
      if (r !== null) return r
    }
    return null
  }
  const keys = Object.keys(node)
  if (keys.some((k) => k.toLowerCase().includes('cache'))) return { path, obj: node }
  for (const k of keys) {
    const r = findFirstWithCache(node[k], depth + 1, path + '.' + k)
    if (r !== null) return r
  }
  return null
}
const hit = findFirstWithCache(root)
if (hit !== null) {
  console.log('  路径:', hit.path)
  console.log('  ' + JSON.stringify(hit.obj).slice(0, 1200))
} else {
  console.log('  没找到带 cache 的对象（只有字符串里出现 cache 字样）')
}
