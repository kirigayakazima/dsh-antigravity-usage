// antigravity-usage — 宿主半边冒烟测试（开发用）。
//
// 用 mock ctx 加载 lib/index.js，把六条路由都打一遍。
// 关键：**实时额度不可用不算失败** —— 那正是设计要支持的场景（反重力没开时靠离线数据）。
// 用法: node scripts/smoke.mjs [--temp]
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const useTemp = process.argv.includes('--temp')
if (useTemp) {
  process.env.ANTIGRAVITY_USAGE_DATA_DIR = mkdtempSync(join(tmpdir(), 'au-smoke-'))
}

const routes = new Map()
const cleanups = []

const webServer = {
  register(route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
}
const timer = { interval: (fn, ms) => { const h = setInterval(fn, ms); return () => clearInterval(h) } }
const ctx = {
  get(name) {
    if (name === 'webServer') return webServer
    if (name === 'timer') return timer
    return undefined
  },
  effect(setup) {
    const dispose = setup()
    if (typeof dispose === 'function') cleanups.push(dispose)
    return dispose
  },
  logger: { info: (m) => console.log('  [info]', m), warn: (m) => console.log('  [warn]', m) },
}

function fakeRes() {
  const out = { code: 0, headers: {}, body: '' }
  return {
    out,
    set statusCode(v) { out.code = v },
    get statusCode() { return out.code },
    setHeader(k, v) { out.headers[k] = v },
    end(b) { out.body = b === undefined ? '' : String(b) },
  }
}

function fakeReq(method, path, query) {
  const listeners = {}
  const req = {
    method,
    url: path + (query ?? ''),
    on(ev, fn) { listeners[ev] = fn; return req },
  }
  // 让 handler 里的 readBody 能拿到（异步触发，避免同步 end 之前还没注册）
  setTimeout(() => {
    if (listeners.data !== undefined) listeners.data(Buffer.from(req.__body ?? ''))
    if (listeners.end !== undefined) listeners.end()
  }, 0)
  return req
}

async function call(path, { method = 'GET', query = '', body = null } = {}) {
  const route = routes.get(path)
  if (route === undefined) throw new Error('route not registered: ' + path)
  const req = fakeReq(method, path, query)
  req.__body = body
  // 手动触发 body 流（fakeReq 的 setTimeout 已注册）
  const p = new Promise((resolve) => {
    const res = fakeRes()
    res.end = ((orig) => (b) => { orig(b); resolve({ code: res.out.code, json: res.out.body === '' ? null : JSON.parse(res.out.body) }) })(res.end)
    route.handler(req, res).catch((e) => resolve({ code: -1, err: String(e) }))
  })
  return await p
}

let failed = 0
function check(label, ok, extra) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || extra === undefined ? '' : '  → ' + extra}`)
  if (!ok) failed += 1
}

console.log('=== 加载插件 ===')
const mod = await import('../lib/index.js')
console.log('  name   =', mod.name, ' injob =', JSON.stringify(mod.inject))
mod.apply(ctx)
const expectedRoutes = [
  '/api/antigravity-usage',
  '/api/antigravity-usage/history',
  '/api/antigravity-usage/usage',
  '/api/antigravity-usage/conversations',
  '/api/antigravity-usage/refresh',
  '/api/antigravity-usage/diag',
]
console.log('\n=== 路由注册 ===')
for (const r of expectedRoutes) check('注册 ' + r, routes.has(r))
check('没有多余路由', routes.size === expectedRoutes.length, String(routes.size))

// 等 boot 的两次异步任务（采集 + 会话扫描）落地
await new Promise((r) => setTimeout(r, 2500))

console.log('\n=== GET /api/antigravity-usage ===')
const ov = await call('/api/antigravity-usage')
check('HTTP 200', ov.code === 200, String(ov.code))
if (ov.json !== null) {
  const st = ov.json.status
  console.log('    live =', st.live, ' port =', st.port, ' lastError =', st.lastError)
  console.log('    离线会话 =', st.offline.totals.sessions, ' 生成 =', st.offline.totals.genCalls)
  console.log('    额度采样 =', st.history.samples, ' lastKnownAt =', st.lastKnownAt)
  check('有 status', st !== undefined)
  check('有 snapshot', ov.json.snapshot !== undefined)
  check('有 lastKnown 字段', 'lastKnown' in ov.json)
  check('离线会话 > 0（反重力没开也应如此）', st.offline.totals.sessions > 0, String(st.offline.totals.sessions))
  check('clientDiag 是数组（本测试没有客户端，故为空）', Array.isArray(st.clientDiag))
}

console.log('\n=== GET /api/antigravity-usage/usage ===')
const usage = await call('/api/antigravity-usage/usage')
check('HTTP 200', usage.code === 200, String(usage.code))
check('有 daily/monthly/resets', Array.isArray(usage.json.daily) && Array.isArray(usage.json.monthly) && Array.isArray(usage.json.resets))

console.log('\n=== GET /api/antigravity-usage/conversations ===')
const conv = await call('/api/antigravity-usage/conversations', { query: '?full=1' })
check('HTTP 200', conv.code === 200, String(conv.code))
check('读到会话', (conv.json.conversations ?? []).length > 0, String((conv.json.conversations ?? []).length))
check('有按模型聚合', (conv.json.byModel ?? []).length > 0)
check('有按工作区聚合', (conv.json.byWorkspace ?? []).length > 0)
check('有逐日聚合', (conv.json.byDay ?? []).length > 0)
const first = (conv.json.conversations ?? [])[0]
if (first !== undefined) {
  console.log('    例:', first.steps + ' 步 /', first.genCalls + ' 生成 /', (first.title || first.preview || '').slice(0, 20))
}

// token / 缓存命中（从本地 gen_metadata 解出来的）
const tk = conv.json.totals === undefined ? undefined : conv.json.totals.tokens
console.log('    totals.tokens =', JSON.stringify(tk))
check('totals 里有 tokens', tk !== undefined && tk !== null)
check('输入 token > 0（真实数据）', (tk === undefined ? 0 : tk.input) > 0, String(tk && tk.input))
check('输出 token > 0', (tk === undefined ? 0 : tk.output) > 0, String(tk && tk.output))
check('缓存命中读取 > 0', (tk === undefined ? 0 : tk.cacheRead) > 0, String(tk && tk.cacheRead))
check('第一个会话带 tokens', first === undefined || (first.tokens !== undefined && first.tokens !== null))
check('按模型带 tokens', ((conv.json.byModel ?? [])[0] ?? {}).tokens !== undefined)
check('按日带 tokens', ((conv.json.byDay ?? [])[0] ?? {}).tokens !== undefined)

console.log('\n=== GET /api/antigravity-usage/history ===')
for (const range of ['24h', '7d', 'all']) {
  const h = await call('/api/antigravity-usage/history', { query: '?range=' + range })
  check(`range=${range} HTTP 200`, h.code === 200, String(h.code))
}

console.log('\n=== POST /api/antigravity-usage/diag ===')
const diag = await call('/api/antigravity-usage/diag', { method: 'POST', body: JSON.stringify({ step: 'smoke-test', hi: 1 }) })
check('HTTP 200', diag.code === 200, String(diag.code))
check('已接收', diag.json && diag.json.ok === true)
const ov2 = await call('/api/antigravity-usage')
check('上报出现在 clientDiag', (ov2.json.status.clientDiag ?? []).some((d) => d.step === 'smoke-test'))

console.log('\n=== POST /api/antigravity-usage/refresh ===')
const rf = await call('/api/antigravity-usage/refresh', { method: 'POST' })
check('HTTP 200', rf.code === 200, String(rf.code))
check('返回 status', rf.json && rf.json.status !== undefined)
const bad = await call('/api/antigravity-usage/refresh', { method: 'GET' })
check('GET 得 405', bad.code === 405, String(bad.code))

console.log('\n=== 卸载清理 ===')
for (const c of cleanups) c()
check('cleanup 数量 > 0', cleanups.length > 0, String(cleanups.length))
check('路由已回收', routes.size === 0, String(routes.size))

console.log('\n' + (failed === 0 ? '✅ 冒烟测试通过（实时额度不可用属正常场景，不判失败）' : `❌ ${failed} 项失败`))
process.exit(failed === 0 ? 0 : 1)
