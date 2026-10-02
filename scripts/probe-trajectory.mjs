// 问语言服务器本人：轨迹接口里到底有没有 token / 缓存命中（开发用，只读）。
// 客户端包里存在 ModalityTokenCountSchema / ModelUsageStatsSchema，
// 说明协议是**有** token 消息的 —— 那就试 GetCascadeTrajectory 拿一条轨迹回来找。
// 用法: node scripts/probe-trajectory.mjs
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

async function handshake(port) {
  const html = await (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(8000) })).text()
  const m = html.match(/csrfToken":"([^"]+)"/)
  return m === null ? null : m[1]
}

async function call(port, csrf, method, body) {
  const res = await fetch(`http://127.0.0.1:${port}${SVC}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': csrf },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(25000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}: ${text.slice(0, 200)}`)
  return text === '' ? null : JSON.parse(text)
}

const port = discoverPort()
if (port === null) {
  console.error('找不到语言服务器端口')
  process.exit(2)
}
const csrf = await handshake(port)
console.log('port =', port, ' csrf =', csrf === null ? '无' : 'ok')
if (csrf === null) process.exit(2)

// 取一个最近用过的 cascadeId
let cascadeId = null
const sumPath = join(homedir(), '.gemini', 'antigravity', 'conversation_summaries.db')
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(sumPath, { readOnly: true })
const row = db.prepare('SELECT conversation_id FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 1').get()
cascadeId = row === undefined ? null : row.conversation_id
db.close()
console.log('cascadeId =', cascadeId)
if (cascadeId === null) process.exit(2)

// 试各种 verbosity / 方法名组合
const attempts = [
  ['GetCascadeTrajectory', { cascadeId }],
  ['GetCascadeTrajectory', { cascadeId, trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI' }],
  ['GetCascadeTrajectory', { cascadeId, trajectoryVerbosity: 2 }],
  ['GetCascadeTrajectorySteps', { cascadeId }],
  ['GetUserTrajectory', { cascadeId }],
]

let got = null
for (const [method, body] of attempts) {
  try {
    const r = await call(port, csrf, method, body)
    const json = JSON.stringify(r ?? null)
    console.log(`\n✅ ${method} ${JSON.stringify(body).slice(0, 60)} → ${json.length} 字节`)
    got = { method, r, json }
    break
  } catch (e) {
    console.log(`❌ ${method} → ${e.message.slice(0, 120)}`)
  }
}

if (got === null) {
  console.log('\n所有方法都失败 —— 该接口可能要求额外参数或不在这个语言服务器上。')
  process.exit(1)
}

// 在响应里找 token / cache 关键字
const low = got.json.toLowerCase()
console.log('\n=== 关键字出现次数 ===')
for (const k of ['token', 'cache', 'usage', 'prompttoken', 'candidatetoken', 'thoughtstoken', 'cachedcontent', 'billable']) {
  const n = low.split(k).length - 1
  if (n > 0) console.log(`  ${k}: ${n}`)
}
const idx = low.indexOf('token')
if (idx >= 0) {
  console.log('\n=== "token" 首次出现处上下文 ===')
  console.log('  ' + got.json.slice(Math.max(0, idx - 400), idx + 600))
}
