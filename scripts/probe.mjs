// antigravity-usage — 采集探针（开发用，验证链路）
// 用法: node scripts/probe.mjs
//
// 链路: 定位 agy / Antigravity 语言服务器 HTTP 端口 → GET / 取 csrfToken
//       → POST /exa.language_server_pb.LanguageServerService/{GetUserStatus,RetrieveUserQuotaSummary}
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SVC = '/exa.language_server_pb.LanguageServerService'

/** 从日志目录里找出「Language server listening on random port at N for HTTP」 */
function portFromLogs(dir) {
  let files = []
  try {
    files = readdirSync(dir)
      .filter((n) => n.endsWith('.log'))
      .map((n) => ({ n, p: join(dir, n), t: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
  } catch {
    return null
  }
  for (const f of files.slice(0, 4)) {
    let txt = ''
    try {
      txt = readFileSync(f.p, 'utf8')
    } catch {
      continue
    }
    const m = txt.match(/listening on random port at (\d+) for HTTP(?!S)/)
    if (m) return { port: Number(m[1]), source: f.p }
  }
  return null
}

function discover() {
  const home = homedir()
  const cliLogs = join(home, '.gemini', 'antigravity', 'log')
  const ideLog = join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Antigravity', 'logs', 'language_server.log')
  const hit = portFromLogs(cliLogs)
  if (hit) return hit
  try {
    const txt = readFileSync(ideLog, 'utf8')
    const m = txt.match(/listening on random port at (\d+) for HTTP(?!S)/)
    if (m) return { port: Number(m[1]), source: ideLog }
  } catch {}
  return null
}

async function call(port, csrf, method, body = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${SVC}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': csrf },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} HTTP ${r.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

const found = discover()
if (!found) {
  console.error('未找到语言服务器端口（agy 或 Antigravity IDE 未运行？）')
  process.exit(2)
}
console.log('port =', found.port, '\nsource =', found.source)

const idx = await (await fetch(`http://127.0.0.1:${found.port}/`, { signal: AbortSignal.timeout(10000) })).text()
const csrf = idx.match(/csrfToken":"([^"]+)"/)?.[1]
if (!csrf) throw new Error('未能从 GET / 中解析 csrfToken')
console.log('csrf =', csrf)

const status = await call(found.port, csrf, 'GetUserStatus')
const quota = await call(found.port, csrf, 'RetrieveUserQuotaSummary')

const us = status.userStatus ?? status
console.log('\n=== 账号 ===')
console.log(' ', us.name, '/', us.email, '/ tier:', us.userTier?.name)
console.log('  plan:', us.planStatus?.planInfo?.planName,
  '| promptCredits', us.planStatus?.availablePromptCredits, '/', us.planStatus?.planInfo?.monthlyPromptCredits,
  '| flowCredits', us.planStatus?.availableFlowCredits, '/', us.planStatus?.planInfo?.monthlyFlowCredits)

console.log('\n=== 额度分组 (RetrieveUserQuotaSummary) ===')
for (const g of quota.response?.groups ?? []) {
  console.log(' -', g.displayName)
  for (const b of g.buckets ?? []) {
    console.log(`     ${b.bucketId.padEnd(14)} ${b.displayName.padEnd(24)} ${(b.remainingFraction * 100).toFixed(2)}%  reset ${b.resetTime}`)
  }
}

console.log('\n=== 各模型 quotaInfo (GetUserStatus) ===')
for (const c of us.cascadeModelConfigData?.clientModelConfigs ?? []) {
  const q = c.quotaInfo ?? {}
  console.log(`  ${(c.label ?? '?').padEnd(30)} ${((q.remainingFraction ?? 1) * 100).toFixed(2)}%  ${q.resetTime ?? ''}`)
}
