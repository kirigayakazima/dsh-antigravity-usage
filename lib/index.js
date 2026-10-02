// antigravity-usage — 反重力（Antigravity）token / 额度 / 用量监控（宿主半边）。
//
// 两个**互相独立**的数据源：
//
//   A. 实时额度（需要反重力在运行）
//      lib/collector.js 打它本地语言服务器的 HTTP 接口，拿「剩余额度百分比」。
//      token 消耗 ∝ 额度消耗，所以消耗就是用相邻采样的差值反推的。
//      —— 反重力没开时这一路会失败，但**不影响 B**。
//
//   B. 离线用量（不需要反重力在运行）
//      lib/conversations.js 只读扫它落在磁盘上的 SQLite：
//      会话数、步数、生成次数、用了哪些模型、哪个工作区、什么时候。
//
// 面板永远能显示 B 和 A 的历史；A 的实时值只是「有就显示」。
//
// 全程只读：不写反重力任何目录。
import { homedir } from 'node:os'
import { join } from 'node:path'

import { AntigravityCollector, emptySnapshot } from './collector.js'
import { scanConversations, emptyConversations } from './conversations.js'
import { HistoryStore } from './history.js'

export const name = 'antigravity-usage'
export const inject = ['timer', 'webServer']

export const VERSION = '0.2.0'

const DEFAULT_INTERVAL_MS = 120000
const DEFAULT_RETAIN_DAYS = 180
const DEFAULT_MAX_POINTS = 400
const DEFAULT_TIMEOUT_MS = 8000
const CONVERSATIONS_INTERVAL_MS = 600000
const DIAG_LIMIT = 60

function envInt(key, fallback) {
  const raw = process.env[key]
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function envBool(key, fallback) {
  const raw = process.env[key]
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function resolveDataDir() {
  const configured = process.env.ANTIGRAVITY_USAGE_DATA_DIR
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'antigravity-usage')
}

function sendJson(res, code, value) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= maxBytes) chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

export function apply(ctx) {
  const intervalMs = envInt('ANTIGRAVITY_USAGE_INTERVAL_MS', DEFAULT_INTERVAL_MS)
  const retainDays = envInt('ANTIGRAVITY_USAGE_RETAIN_DAYS', DEFAULT_RETAIN_DAYS)
  const maxPoints = envInt('ANTIGRAVITY_USAGE_MAX_POINTS', DEFAULT_MAX_POINTS)
  const httpPort = envInt('ANTIGRAVITY_USAGE_PORT', 0)
  const deepScan = envBool('ANTIGRAVITY_USAGE_DEEP_SCAN', false)
  const timeoutMs = envInt('ANTIGRAVITY_USAGE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
  const dataDir = resolveDataDir()

  const log = (msg) => {
    try {
      ctx.logger?.info?.(`[antigravity-usage] ${msg}`)
    } catch {
      /* 日志失败静默 */
    }
  }
  const warn = (msg) => {
    try {
      if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(`[antigravity-usage] ${msg}`)
      else log(msg)
    } catch {
      /* 静默 */
    }
  }

  // ---------- 状态 ----------
  let lastError = null
  let snapshot = emptySnapshot('尚未采集', null, null)
  let lastCollectAt = null
  let collecting = false

  const history = new HistoryStore(dataDir, retainDays)
  history.load()
  let lastKnown = history.loadLastKnown()

  // 没有 last-known.json（例如刚升级到本版本）时，用最后一条采样合成一份，
  // 这样反重力没开也能灰显出「上次已知额度」，而不是空面板。
  if (lastKnown === null) {
    const s = history.lastSample()
    if (s !== null && s.b !== undefined && Object.keys(s.b).length > 0) {
      lastKnown = {
        ok: true,
        ts: s.t,
        error: null,
        port: s.p ?? null,
        source: null,
        latencyMs: null,
        account: null,
        credits: s.c === undefined ? null : {
          promptAvailable: s.c.pa, promptMonthly: s.c.pm, flowAvailable: s.c.fa, flowMonthly: s.c.fm,
        },
        synthetic: true,
        groups: [{
          name: '历史快照',
          description: '由最后一次成功采样还原（不是完整快照）。',
          buckets: Object.keys(s.b).map((id) => ({
            id,
            label: id,
            description: '',
            window: id.endsWith('-5h') ? '5h' : (id.endsWith('-weekly') ? 'weekly' : ''),
            remainingFraction: s.b[id],
            usedFraction: 1 - s.b[id],
            resetTime: '',
            resetInMs: null,
          })),
        }],
        models: [],
      }
    }
  }

  let conversations = emptyConversations('尚未扫描')
  let scanningConversations = false
  let lastConversationScanAt = null

  // 客户端上报（诊断用：客户端 apply 跑没跑、注册没注册、有没有渲染崩溃）
  const clientDiag = []

  const collector = new AntigravityCollector({ httpPort, timeoutMs, deepScan, log })

  function pushDiag(entry) {
    clientDiag.push({ at: Date.now(), ...entry })
    while (clientDiag.length > DIAG_LIMIT) clientDiag.shift()
  }

  async function collectOnce(reason) {
    if (collecting) return snapshot
    collecting = true
    try {
      const s = await collector.collect()
      snapshot = s
      lastCollectAt = Date.now()
      if (s.ok) {
        lastError = null
        history.append(s)
        lastKnown = s
        history.saveLastKnown(s)
      } else {
        lastError = s.error
        warn(`实时额度采集失败（${reason}）: ${s.error ?? '未知错误'}（离线用量不受影响）`)
      }
      return s
    } finally {
      collecting = false
    }
  }

  async function scanConversationsOnce(reason) {
    if (scanningConversations) return conversations
    scanningConversations = true
    try {
      conversations = await scanConversations({ dataDir, log })
      lastConversationScanAt = Date.now()
      log(`离线会话扫描完成（${reason}）：${conversations.totals.sessions} 会话 / ${conversations.totals.genCalls} 次生成`)
      return conversations
    } catch (e) {
      conversations = emptyConversations(String(e.message ?? e))
      warn(`离线会话扫描失败：${e.message ?? e}`)
      return conversations
    } finally {
      scanningConversations = false
    }
  }

  function statusPayload() {
    return {
      name,
      version: VERSION,
      dataDir,
      historyFile: history.file,
      intervalMs,
      retainDays,
      deepScan,
      httpPort,
      port: collector.currentPort,
      portSource: collector.currentSource,
      lastCollectAt,
      lastError: lastError ?? history.error,
      collecting,
      live: snapshot.ok === true,
      history: { samples: history.size, firstAt: history.firstAt, lastAt: history.lastAt },
      offline: {
        ok: conversations.ok === true,
        error: conversations.error,
        scannedAt: lastConversationScanAt,
        scanning: scanningConversations,
        totals: conversations.totals,
      },
      lastKnownAt: lastKnown !== null ? lastKnown.ts : null,
      clientDiag: clientDiag.slice(-20),
    }
  }

  function overview() {
    return { status: statusPayload(), snapshot, lastKnown }
  }

  // ---------- HTTP 路由 ----------
  const webServer = ctx.get('webServer')
  if (webServer !== undefined && webServer !== null && typeof webServer.register === 'function') {
    const route = (path, handler) =>
      ctx.effect(() => webServer.register({ kind: 'exact', path, handler }))

    route('/api/antigravity-usage', (req, res) => sendJson(res, 200, overview()))

    route('/api/antigravity-usage/history', (req, res) => {
      let raw = '24h'
      try {
        raw = new URL(String(req.url ?? '/'), 'http://localhost').searchParams.get('range') ?? '24h'
      } catch {
        /* 默认值 */
      }
      const range = raw === '7d' || raw === '30d' || raw === 'all' ? raw : '24h'
      sendJson(res, 200, history.query(range, maxPoints))
    })

    route('/api/antigravity-usage/usage', (req, res) => sendJson(res, 200, history.aggregate()))

    route('/api/antigravity-usage/conversations', (req, res) => {
      let full = false
      try {
        full = new URL(String(req.url ?? '/'), 'http://localhost').searchParams.get('full') === '1'
      } catch {
        /* 默认精简 */
      }
      if (lastConversationScanAt === null && scanningConversations === false) void scanConversationsOnce('on-demand')
      const out = full ? conversations : { ...conversations, conversations: conversations.conversations.slice(0, 60) }
      sendJson(res, 200, out)
    })

    route('/api/antigravity-usage/refresh', async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end()
        return
      }
      await collectOnce('manual')
      await scanConversationsOnce('manual')
      sendJson(res, 200, overview())
    })

    // 客户端自报：apply 是否跑了、注册了哪些槽位、有没有渲染崩溃
    route('/api/antigravity-usage/diag', async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end()
        return
      }
      const body = await readBody(req, 8 * 1024)
      try {
        const parsed = JSON.parse(body)
        pushDiag(parsed)
        // 只记 step，避免大对象刷日志
        log(`客户端上报: ${typeof parsed.step === 'string' ? parsed.step : 'unknown'}`)
      } catch {
        pushDiag({ step: 'bad-json', raw: body.slice(0, 200) })
      }
      sendJson(res, 200, { ok: true, received: clientDiag.length })
    })
  }

  // ---------- 定时 ----------
  const timer = ctx.get('timer')
  const every = (fn, ms) =>
    ctx.effect(() => {
      let cancel = null
      let handle = null
      if (timer !== undefined && timer !== null && typeof timer.interval === 'function') {
        cancel = timer.interval(fn, ms)
      } else if (typeof ctx.setInterval === 'function') {
        handle = ctx.setInterval(fn, ms)
      }
      return () => {
        if (typeof cancel === 'function') cancel()
        if (handle !== null && typeof ctx.clearInterval === 'function') ctx.clearInterval(handle)
      }
    })

  every(() => void collectOnce('timer'), intervalMs)
  every(() => void scanConversationsOnce('timer'), CONVERSATIONS_INTERVAL_MS)

  ctx.effect(() => () => {
    void history.compact().catch(() => {})
  })

  // 启动：实时采一次 + 离线扫一次（互不阻塞）
  void collectOnce('boot')
  void scanConversationsOnce('boot')

  log(`已启动：实时额度每 ${intervalMs}ms；离线会话每 ${CONVERSATIONS_INTERVAL_MS}ms；数据目录 ${dataDir}`)
}

export default { name, inject, apply }
