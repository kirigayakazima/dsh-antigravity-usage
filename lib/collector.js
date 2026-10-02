// antigravity-usage — Antigravity（反重力）本地语言服务器采集器。
//
// 反重力的 token 消耗**不落盘**：~/.gemini/antigravity/conversations/*.db 里只有步数、
// 模型 ID 和会话内容，没有任何 token 计数。真正的额度数据由本地语言服务器（IDE 或
// agy CLI 起的那个进程）通过 HTTP 暴露出来：
//
//   1. GET  http://127.0.0.1:<port>/                       → 页面里含 window.__APP_CONFIG__.csrfToken
//   2. POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetUserStatus
//   3. POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary
//
// 缺 `x-codeium-csrf-token` 头会 401。端口是随机分配的，但会写进启动日志：
//   - CLI : ~/.gemini/antigravity/log/cli-<ts>.log   → "listening on random port at N for HTTP"
//   - IDE : %APPDATA%/Antigravity/logs/language_server.log
//
// 全程只读，不修改反重力任何文件。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const SVC = '/exa.language_server_pb.LanguageServerService'

// 注意 (?!S)：日志里 HTTPS (gRPC) 那一行的前缀也是 "for HTTP"，不排除会匹配到 gRPC 端口
const PORT_RE = /listening on random port at (\d+) for HTTP(?!S)/

function safeStat(p) {
  try {
    return statSync(p).mtimeMs
  } catch {
    return 0
  }
}

/** 从单个日志文件里抠出 HTTP 端口。 */
export function portFromLogFile(file) {
  try {
    const m = readFileSync(file, 'utf8').match(PORT_RE)
    if (m) return Number(m[1])
  } catch {
    /* 读不到就跳过 */
  }
  return null
}

function newestLogs(dir, limit) {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.log'))
      .map((n) => ({ p: join(dir, n), t: safeStat(join(dir, n)) }))
      .sort((a, b) => b.t - a.t)
      .slice(0, limit)
      .map((f) => f.p)
  } catch {
    return []
  }
}

/** 候选日志文件，按「最新优先」排列。 */
export function logCandidates() {
  const home = homedir()
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  const out = []
  out.push(...newestLogs(join(home, '.gemini', 'antigravity', 'log'), 4))
  out.push(...newestLogs(join(home, '.gemini', 'antigravity-cli', 'log'), 2))
  out.push(join(appData, 'Antigravity', 'logs', 'language_server.log'))
  out.push(join(appData, 'Antigravity', 'logs', 'main.log'))
  out.push(join(localAppData, 'Antigravity', 'logs', 'language_server.log'))
  return out
}

/** 按「最新日志优先」查找端口。 */
export function discoverPort() {
  for (const file of logCandidates()) {
    const port = portFromLogFile(file)
    if (port !== null) return { port, source: file }
  }
  return null
}

function parseCsrf(html) {
  const m = html.match(/csrfToken":"([^"]+)"/)
  return m ? m[1] : null
}

/** 判断某个端口上跑的是不是反重力的语言服务器，是则返回 csrf token。 */
async function probePort(port, timeoutMs) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const html = await res.text()
    if (!html.includes('__APP_CONFIG__')) return null
    if (!/productName"\s*:\s*"antigravity"/.test(html)) return null
    return parseCsrf(html)
  } catch {
    return null
  }
}

/**
 * 端口扫描兜底：日志缺失时（例如日志被清过）暴力找一遍。
 * 只在 deepScan 打开时调用，带并发上限。
 */
export async function scanForPort(timeoutMs, log) {
  const CONCURRENCY = 256
  let cursor = 1024
  let found = null

  async function worker() {
    while (found === null) {
      const port = cursor
      cursor += 1
      if (port > 65535) return
      const csrf = await probePort(port, timeoutMs)
      if (csrf !== null && found === null) {
        found = { port, source: `port-scan:${port}` }
        if (log) log(`deep scan hit port ${port}`)
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  return found
}

function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function resetInMs(resetTime) {
  if (typeof resetTime !== 'string' || resetTime === '') return null
  const t = Date.parse(resetTime)
  if (!Number.isFinite(t)) return null
  return t - Date.now()
}

export function emptySnapshot(error, port, source) {
  return {
    ok: false,
    ts: Date.now(),
    error,
    port,
    source,
    latencyMs: null,
    account: null,
    credits: null,
    groups: [],
    models: [],
  }
}

/** 采集器：持有已知端口与 csrf token，401 时自动重新握手一次。 */
export class AntigravityCollector {
  constructor(opts = {}) {
    this.opts = opts
    this.port = opts.httpPort && opts.httpPort > 0 ? opts.httpPort : (opts.knownPort && opts.knownPort > 0 ? opts.knownPort : null)
    this.source = null
    this.csrf = null
  }

  get currentPort() {
    return this.port
  }

  get currentSource() {
    return this.source
  }

  timeout() {
    return this.opts.timeoutMs ?? 8000
  }

  log(msg) {
    if (typeof this.opts.log === 'function') this.opts.log(msg)
  }

  /** 确保 port + csrf 可用（必要时重新发现）。 */
  async handshake(force) {
    if (!force && this.port !== null && this.csrf !== null) return

    // 1) 先验证已知/配置端口
    if (this.port !== null && !force) {
      const csrf = await probePort(this.port, this.timeout())
      if (csrf !== null) {
        this.csrf = csrf
        return
      }
      this.log(`known port ${this.port} no longer answers; rediscovering`)
      this.port = null
      this.csrf = null
    }

    // 2) 日志发现
    const hit = discoverPort()
    if (hit !== null) {
      const csrf = await probePort(hit.port, this.timeout())
      if (csrf !== null) {
        this.port = hit.port
        this.source = hit.source
        this.csrf = csrf
        this.log(`language server on 127.0.0.1:${hit.port} (${hit.source})`)
        return
      }
      this.log(`log said port ${hit.port} but handshake failed`)
    }

    // 3) 端口扫描兜底
    if (this.opts.deepScan === true) {
      const scanned = await scanForPort(this.timeout(), this.opts.log)
      if (scanned !== null) {
        const csrf = await probePort(scanned.port, this.timeout())
        if (csrf !== null) {
          this.port = scanned.port
          this.source = scanned.source
          this.csrf = csrf
          return
        }
      }
    }

    throw new Error('未找到反重力语言服务器（IDE 或 agy 未运行？端口发现失败）')
  }

  async callRaw(method, body) {
    const url = `http://127.0.0.1:${this.port}${SVC}/${method}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-codeium-csrf-token': this.csrf ?? '',
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(this.timeout()),
    })
    const text = await res.text()
    if (!res.ok) {
      const err = new Error(`${method} -> HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return text === '' ? null : JSON.parse(text)
  }

  /** 带一次自动重试（csrf 过期 / 进程重启换端口）。 */
  async call(method, body = {}) {
    await this.handshake(false)
    try {
      return await this.callRaw(method, body)
    } catch (e) {
      const status = e && e.status
      if (status === 401 || status === 403 || status === 404) {
        this.log(`${method} -> ${status}; re-handshaking`)
        this.csrf = null
        await this.handshake(true)
        return await this.callRaw(method, body)
      }
      throw e
    }
  }

  /** 采集一次完整快照。任何失败都返回 ok:false 的快照，不抛异常。 */
  async collect() {
    const t0 = Date.now()
    try {
      const statusRaw = await this.call('GetUserStatus')
      const quotaRaw = await this.call('RetrieveUserQuotaSummary')
      const us = (statusRaw && (statusRaw.userStatus ?? statusRaw)) ?? {}
      const resp = (quotaRaw && (quotaRaw.response ?? quotaRaw)) ?? {}

      const planInfo = (us.planStatus && us.planStatus.planInfo) ?? {}

      const groups = []
      for (const g of resp.groups ?? []) {
        const buckets = []
        for (const b of g.buckets ?? []) {
          const remaining = Math.min(1, Math.max(0, num(b.remainingFraction, 1)))
          const rt = typeof b.resetTime === 'string' ? b.resetTime : ''
          buckets.push({
            id: String(b.bucketId ?? b.displayName ?? 'unknown'),
            label: String(b.displayName ?? ''),
            description: String(b.description ?? ''),
            window: String(b.window ?? ''),
            remainingFraction: remaining,
            usedFraction: 1 - remaining,
            resetTime: rt,
            resetInMs: resetInMs(rt),
          })
        }
        groups.push({
          name: String(g.displayName ?? ''),
          description: String(g.description ?? ''),
          buckets,
        })
      }

      const models = []
      const configs = (us.cascadeModelConfigData && us.cascadeModelConfigData.clientModelConfigs) ?? []
      for (const c of configs) {
        const q = c.quotaInfo ?? {}
        models.push({
          label: String(c.label ?? ''),
          model: String((c.modelOrAlias && c.modelOrAlias.model) ?? c.model ?? ''),
          remainingFraction: Math.min(1, Math.max(0, num(q.remainingFraction, 1))),
          resetTime: typeof q.resetTime === 'string' ? q.resetTime : '',
        })
      }

      return {
        ok: true,
        ts: Date.now(),
        error: null,
        port: this.port,
        source: this.source,
        latencyMs: Date.now() - t0,
        account: {
          name: String(us.name ?? ''),
          email: String(us.email ?? ''),
          tier: String((us.userTier && us.userTier.name) ?? ''),
          planName: String(planInfo.planName ?? ''),
        },
        credits: {
          promptAvailable: num(us.planStatus && us.planStatus.availablePromptCredits),
          promptMonthly: num(planInfo.monthlyPromptCredits),
          flowAvailable: num(us.planStatus && us.planStatus.availableFlowCredits),
          flowMonthly: num(planInfo.monthlyFlowCredits),
        },
        groups,
        models,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.log(`collect failed: ${msg}`)
      // 端口/凭据可能已失效，下次重新握手
      this.csrf = null
      return { ...emptySnapshot(msg, this.port, this.source), latencyMs: Date.now() - t0 }
    }
  }
}
