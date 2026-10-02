// antigravity-usage — client 半边（浏览器 bundle）。
// Client module factory format: window.__ModuleLoader__.load({ id, factory })
//
// 两个 UI 入口：
//   1. sidebar.footer.action  侧边栏底部一个**小图标按钮**（不是宽条，避免把那一行挤爆）
//   2. shell.overlay          点按钮弹出的居中弹窗（自己画 fixed 遮罩，关闭时返回 null）
//
// 面板六个标签：额度 / 趋势 / 热力图 / 汇总 / 重置 / 会话
// 其中「额度」需要反重力在运行；其余全部来自本地历史与离线会话库，**反重力关着也照常显示**。
//
// 数据来自宿主半边：
//   GET  /api/antigravity-usage                 概览（status + snapshot + lastKnown）
//   GET  /api/antigravity-usage/history?range=  额度时间序列
//   GET  /api/antigravity-usage/usage           逐日/逐月汇总 + 重置事件
//   GET  /api/antigravity-usage/conversations   离线会话用量
//   POST /api/antigravity-usage/refresh         立即采集 + 重扫
//   POST /api/antigravity-usage/diag            客户端自报（诊断）
window.__ModuleLoader__.load({
  id: 'dsh-antigravity-usage',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const PLUGIN_ID = 'dsh-antigravity-usage'
    const API = '/api/antigravity-usage'
    const API_HISTORY = API + '/history'
    const API_USAGE = API + '/usage'
    const API_CONV = API + '/conversations'
    const API_REFRESH = API + '/refresh'
    const API_DIAG = API + '/diag'

    // 客户端自报：宿主记进 clientDiag，可在 /api/antigravity-usage 里直接读到
    let diagSent = 0
    let domProbesSent = 0
    function report(step, extra) {
      try {
        if (diagSent > 40) return
        diagSent += 1
        if (typeof fetch === 'function') {
          fetch(API_DIAG, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ step, at: Date.now(), ...(extra ?? {}) }),
          }).catch(() => {})
        }
      } catch {
        /* 自报失败不影响功能 */
      }
    }

    // ================= 侧边栏那一行的实时文案 =================
    // sidebar.panellist 的 label 是**每次投影都重读**的 thunk，所以这里用一个
    // 不依赖 React 挂载状态的轮询去刷新它（见 apply 末尾）。
    const badge = { text: '', pct: null }
    let slotsRef = null
    function badgeLabel() {
      return badge.text === '' ? '反重力额度' : '反重力额度 · ' + badge.text
    }

    // ================= 样式 =================
    const CSS = `
/* 专属整页（注册在 main 面板里）。侧边栏那一行由 DSH 自己画，我们只提供 glyph。 */
.au-page { display:flex; flex-direction:column; height:100%; min-height:0;
  color:var(--dsw-alias-label-primary); }
.au-ico-pct { font-size:10.5px; font-weight:700; line-height:1.5; padding:0 4px; border-radius:7px;
  color:#fff; font-variant-numeric:tabular-nums; flex:0 0 auto; }
.au-head { display:flex; align-items:center; gap:10px; padding:12px 16px;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2)); flex:0 0 auto; }
.au-title { margin:0; font-size:14.5px; font-weight:700; white-space:nowrap; }
.au-head-meta { font-size:11px; opacity:.6; margin-left:auto; text-align:right; line-height:1.45; }
.au-tabs { display:flex; gap:4px; padding:8px 14px 0;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2)); flex:0 0 auto; flex-wrap:wrap; }
.au-tab { padding:6px 12px; border:none; background:transparent; color:inherit; cursor:pointer;
  font-size:12.5px; border-radius:7px 7px 0 0; border-bottom:2px solid transparent; opacity:.7; }
.au-tab:hover { opacity:1; background:rgba(128,128,128,.1); }
.au-tab.on { opacity:1; font-weight:700; border-bottom-color:var(--dsw-alias-brand-primary,#3b82f6); }
.au-body { padding:14px 16px 20px; overflow:auto; font-size:12.5px; line-height:1.65; flex:1 1 auto; }
.au-card { border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2)); border-radius:10px;
  padding:12px 14px; margin-bottom:12px; background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.04)); }
.au-card-title { font-weight:700; font-size:12.5px; margin:0 0 10px; display:flex; align-items:center; gap:8px; }
.au-card-desc { font-size:11px; opacity:.6; margin:-6px 0 10px; line-height:1.55; }
.au-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:10px; }
.au-bucket { border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18)); border-radius:8px;
  padding:10px 12px; background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06)); }
.au-bucket-head { display:flex; align-items:baseline; gap:6px; }
.au-bucket-label { font-size:11.5px; opacity:.75; flex:1; }
.au-bucket-pct { font-size:20px; font-weight:800; font-variant-numeric:tabular-nums; }
.au-bar { height:6px; border-radius:3px; background:rgba(128,128,128,.22); overflow:hidden; margin:8px 0 6px; }
.au-bar-fill { height:100%; border-radius:3px; transition:width .5s cubic-bezier(.4,0,.2,1); }
.au-kv { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:11.5px; }
.au-k { opacity:.6; white-space:nowrap; }
.au-v { font-weight:600; font-variant-numeric:tabular-nums; }
.au-btn { padding:5px 13px; cursor:pointer; border-radius:6px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));
  background:transparent; color:inherit; font-size:12px; font-family:inherit; }
.au-btn:disabled { opacity:.5; cursor:default; }
.au-btn.on { background:var(--dsw-alias-brand-primary,#3b82f6); border-color:transparent; color:#fff; font-weight:600; }
.au-hint { margin:8px 0 0; padding:9px 12px; border-radius:7px; font-size:11.5px; line-height:1.55;
  background:rgba(180,83,9,.09); border:1px solid rgba(180,83,9,.28); }
.au-empty { text-align:center; opacity:.55; padding:16px 0; font-size:12px; }
.au-legend { display:flex; gap:14px; flex-wrap:wrap; font-size:11px; margin-top:6px; opacity:.85; align-items:center; }
.au-legend-i { display:inline-flex; align-items:center; gap:5px; }
.au-legend-dot { width:9px; height:9px; border-radius:2px; display:inline-block; }
.au-models { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:3px 14px; font-size:11.5px; }
.au-model { display:flex; align-items:center; gap:7px; }
.au-model-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.85; }
.au-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
/* 表格：表头与数据一律居中 —— 之前数字右对齐贴在很右边，
   加上表格拉满宽度，横着看很难把值和行对上。另加斑马纹帮助追行。 */
.au-table { width:100%; border-collapse:collapse; font-size:11.5px; }
.au-table th { text-align:center; font-weight:600; opacity:.6; padding:5px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25)); white-space:nowrap; }
.au-table td { text-align:center; padding:4px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12));
  font-variant-numeric:tabular-nums; }
.au-table tbody tr:nth-child(even) td { background:rgba(128,128,128,.05); }
.au-table tbody tr:hover td { background:color-mix(in srgb, var(--dsw-alias-brand-primary,#3b82f6) 14%, transparent); }
/* 首个标识列（日期 / 模型 / 工作区 / 会话名）保持左对齐，长文本才好读 */
.au-table th:first-child, .au-table td:first-child { text-align:left; }
.au-num { text-align:center; }
.au-trunc { max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* KPI 卡片行（对齐「API 用量统计」的观感：小标签 + 大数字 + 说明 + 构成条） */
.au-kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:10px; margin-bottom:12px; }
.au-kpi { border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2)); border-radius:10px;
  padding:12px 14px; background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.04)); min-width:0; }
.au-kpi-label { font-size:11.5px; opacity:.62; }
.au-kpi-value { font-size:27px; font-weight:800; line-height:1.15; margin:2px 0 3px;
  font-variant-numeric:tabular-nums; letter-spacing:-.01em; }
.au-kpi-sub { font-size:11px; opacity:.6; line-height:1.5; }
.au-stack { display:flex; height:7px; border-radius:4px; overflow:hidden; margin:9px 0 7px;
  background:rgba(128,128,128,.16); }
.au-stack > i { display:block; height:100%; }
.au-ok { color:#16a34a; } .au-warn { color:#b45309; }
.au-toolbar { display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap:wrap; }
.au-spacer { flex:1 1 auto; }
.au-btn-group { display:flex; gap:0; }
.au-btn-group .au-btn { border-radius:0; margin-left:-1px; }
.au-btn-group .au-btn:first-child { border-radius:6px 0 0 6px; margin-left:0; }
.au-btn-group .au-btn:last-child { border-radius:0 6px 6px 0; }
.au-input { min-width:200px; text-align:left; cursor:text; font-family:inherit; }
.au-heat-wrap { overflow-x:auto; padding-bottom:4px; }
.au-heat { display:grid; grid-auto-flow:column; grid-template-rows:repeat(7,11px); gap:3px; width:max-content; }
.au-cell { width:11px; height:11px; border-radius:2px; background:rgba(128,128,128,.16); }
.au-cell.today { outline:1px solid var(--dsw-alias-brand-primary,#3b82f6); outline-offset:1px; }
@media (prefers-reduced-motion: reduce) { .au-bar-fill { transition:none } }
`

    const cssTagId = PLUGIN_ID + '/styles.css'
    function styles() {
      return React.createElement('style', { key: 'au-styles', 'data-plugin-css': cssTagId }, CSS)
    }

    // ================= 小工具 =================
    function remainingColor(v) {
      if (v <= 0.15) return '#dc2626'
      if (v <= 0.4) return '#ea580c'
      if (v <= 0.7) return '#ca8a04'
      return '#16a34a'
    }
    function pct(v, digits) {
      const d = digits === undefined ? 2 : digits
      if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
      return (v * 100).toFixed(d) + '%'
    }
    function fmtTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      return new Date(ms).toLocaleString('zh-CN', { hour12: false })
    }
    function fmtCountdown(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      if (ms <= 0) return '即将重置'
      const s = Math.floor(ms / 1000)
      const d = Math.floor(s / 86400)
      const h = Math.floor((s % 86400) / 3600)
      const m = Math.floor((s % 3600) / 60)
      if (d > 0) return d + '天' + h + '小时'
      if (h > 0) return h + '小时' + m + '分'
      if (m > 0) return m + '分' + (s % 60) + '秒'
      return (s % 60) + '秒'
    }
    function num(v) {
      return typeof v === 'number' && Number.isFinite(v) ? v : 0
    }
    /** 紧凑数字：23.6M / 1.59M / 12.3k */
    function fmtNum(v) {
      const n = num(v)
      if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
      return String(Math.round(n))
    }
    function fmtFull(v) {
      return num(v).toLocaleString('en-US')
    }
    /** 缓存命中率 = cacheRead / (input + cacheRead) */
    function hitRate(t) {
      if (t === undefined || t === null) return null
      const denom = num(t.input) + num(t.cacheRead)
      if (denom === 0) return null
      return num(t.cacheRead) / denom
    }
    function fmtHit(t) {
      const r = hitRate(t)
      return r === null ? '—' : (r * 100).toFixed(1) + '%'
    }
    function emptyTok() {
      return { input: 0, output: 0, cacheRead: 0, thinking: 0, response: 0, genCalls: 0 }
    }
    function useTick(ms) {
      const step = ms === undefined ? 1000 : ms
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const h = setInterval(() => force((x) => x + 1), step)
        return () => clearInterval(h)
      }, [step])
    }
    function makeTimer(ctx) {
      try {
        if (typeof ctx.get === 'function') {
          const t = ctx.get('timer')
          if (t !== undefined && t !== null && typeof t.interval === 'function') {
            return (fn, ms) => t.interval(fn, ms)
          }
        }
      } catch {
        /* 退回原生定时器 */
      }
      return (fn, ms) => {
        const h = setInterval(fn, ms)
        return () => clearInterval(h)
      }
    }
    function dayKeyOf(d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    }
    function shortWs(w) {
      if (typeof w !== 'string' || w === '') return '—'
      const parts = w.replace(/\\/g, '/').split('/').filter((x) => x !== '')
      return parts.length <= 2 ? w : '…/' + parts.slice(-2).join('/')
    }

    // ================= 取数 hook =================
    function useJson(url, interval, refreshMs) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const load = () => {
          fetch(url, { headers: { accept: 'application/json' } })
            .then((r) => {
              if (!r.ok) throw new Error('HTTP ' + r.status)
              return r.json()
            })
            .then(
              (j) => {
                if (!alive) return
                setData(j)
                setError(null)
              },
              (e) => {
                if (!alive) return
                setError(String(e && e.message ? e.message : e))
              },
            )
        }
        load()
        const cancel = interval(load, refreshMs)
        return () => {
          alive = false
          cancel()
        }
      }, [url, interval, refreshMs])
      return { data, error }
    }

    // ================= 错误边界 =================
    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { hasError: false, message: '' }
      }
      static getDerivedStateFromError(error) {
        return { hasError: true, message: String(error && error.message ? error.message : error) }
      }
      componentDidCatch(error) {
        report('render-crash', { message: String(error && error.message ? error.message : error) })
        console.error('[antigravity-usage] render error:', error)
      }
      render() {
        if (this.state.hasError) {
          return React.createElement('div', { className: 'au-card' },
            React.createElement('div', { className: 'au-card-title' }, '⚠️ 面板渲染失败'),
            React.createElement('div', { className: 'au-empty' }, this.state.message),
            React.createElement('div', { style: { textAlign: 'center' } },
              React.createElement('button', {
                className: 'au-btn',
                onClick: () => this.setState({ hasError: false, message: '' }),
              }, '重试')))
        }
        return this.props.children
      }
    }

    // ================= 趋势折线图（手写 SVG） =================
    function TrendChart(props) {
      const points = props.points || []
      const series = props.series || []
      const H = props.height === undefined ? 210 : props.height
      const W = 920
      const P = { l: 46, r: 14, t: 12, b: 26 }
      const iw = W - P.l - P.r
      const ih = H - P.t - P.b
      const n = points.length
      if (n < 2 || series.length === 0) {
        return React.createElement('div', { className: 'au-empty' }, '历史采样还不够（趋势图需要至少 2 个采样点）。')
      }
      const x = (i) => P.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw)
      const y = (v) => P.t + ih - Math.min(1, Math.max(0, v)) * ih
      const grid = [0, 0.25, 0.5, 0.75, 1].map((g, i) =>
        React.createElement('g', { key: 'g' + i },
          React.createElement('line', {
            x1: P.l, y1: y(g), x2: W - P.r, y2: y(g),
            stroke: 'var(--dsw-alias-border-l1,rgba(128,128,128,.25))', strokeWidth: 1,
            strokeDasharray: g === 0 ? undefined : '3 4',
          }),
          React.createElement('text', {
            x: P.l - 6, y: y(g) + 3.5, textAnchor: 'end', fontSize: 10,
            fill: 'var(--dsw-alias-label-secondary,#888)',
          }, Math.round(g * 100) + '%')))
      const tickIdx = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i && v >= 0)
      const xLabels = tickIdx.map((i, k) => React.createElement('text', {
        key: 'x' + k, x: x(i), y: H - 7,
        textAnchor: i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle'),
        fontSize: 10, fill: 'var(--dsw-alias-label-secondary,#888)',
      }, new Date(points[i].t).toLocaleString('zh-CN', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      })))
      const seriesEls = series.map((s) => {
        if (s.values.length !== n) return null
        const d = s.values.map((v, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ')
        return React.createElement('g', { key: s.key },
          React.createElement('path', {
            d, fill: 'none', stroke: s.color, strokeWidth: 2.1,
            strokeLinejoin: 'round', strokeLinecap: 'round',
          }),
          React.createElement('circle', { cx: x(n - 1), cy: y(s.values[n - 1]), r: 3, fill: s.color }))
      })
      return React.createElement('div', {},
        React.createElement('svg', {
          viewBox: '0 0 ' + W + ' ' + H,
          style: { width: '100%', height: 'auto', maxHeight: H + 'px', display: 'block' },
          preserveAspectRatio: 'none',
        }, grid, seriesEls, xLabels),
        React.createElement('div', { className: 'au-legend' },
          series.map((s) => React.createElement('span', { className: 'au-legend-i', key: s.key },
            React.createElement('span', { className: 'au-legend-dot', style: { background: s.color } }), s.label))))
    }

    // ================= KPI 卡片行 + 时间范围 =================
    // 口径对齐「API 用量统计」：反重力的 inputTokens **不含**缓存命中
    // （实测某步 inputTokens=2693 而 cacheReadTokens=16264，两者之和 ≈ estimatedTokensUsed=18949），
    // 所以 总 Token = 未命中输入 + 缓存命中 + 输出，命中率 = 缓存命中 ÷ (未命中 + 缓存命中)。
    const KPI_RANGES = [
      { key: 'today', label: '今天', days: 1 },
      { key: '7d', label: '7 天', days: 7 },
      { key: '14d', label: '14 天', days: 14 },
      { key: '30d', label: '近 30 天', days: 30 },
      { key: '90d', label: '近 90 天', days: 90 },
      { key: 'all', label: '全部', days: 0 },
    ]

    function rangeCutoff(days) {
      if (days === 0) return ''
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      d.setDate(d.getDate() - (days - 1))
      return dayKeyOf(d)
    }

    /** 把 byDay 按范围累加（每个会话只落在一天，所以直接相加不会重复） */
    function sumByDay(byDay, days) {
      const cutoff = rangeCutoff(days)
      const tok = emptyTok()
      let sessions = 0
      let steps = 0
      let genCalls = 0
      let activeDays = 0
      for (const d of byDay) {
        if (cutoff !== '' && String(d.date) < cutoff) continue
        sessions += num(d.sessions)
        steps += num(d.steps)
        genCalls += num(d.genCalls)
        if (num(d.sessions) > 0 || num(d.genCalls) > 0) activeDays += 1
        const t = d.tokens
        if (t === undefined || t === null) continue
        tok.input += num(t.input)
        tok.output += num(t.output)
        tok.cacheRead += num(t.cacheRead)
        tok.thinking += num(t.thinking)
        tok.response += num(t.response)
      }
      return { tok, sessions, steps, genCalls, activeDays }
    }

    function KpiRow(props) {
      const conv = props.conv
      const days = props.days
      const byDay = conv && Array.isArray(conv.byDay) ? conv.byDay : []
      const s = sumByDay(byDay, days)
      const t = s.tok
      const prompt = t.input + t.cacheRead
      const total = prompt + t.output
      const hit = hitRate(t)
      const pctOf = (v) => (total === 0 ? 0 : (v / total) * 100)
      const rangeLabel = (KPI_RANGES.find((r) => r.days === days) || {}).label || ''
      const rangeText = days === 0 ? '全部历史' : '近 ' + rangeLabel

      const card = (key, label, valueNode, subNode, extra) =>
        React.createElement('div', { className: 'au-kpi', key },
          React.createElement('div', { className: 'au-kpi-label' }, label),
          React.createElement('div', { className: 'au-kpi-value' }, valueNode),
          subNode === null ? null : React.createElement('div', { className: 'au-kpi-sub' }, subNode),
          extra === undefined ? null : extra)

      return React.createElement('div', { className: 'au-kpis' },
        card('total', '总 Token', fmtNum(total),
          React.createElement('span', null,
            '未命中输入 ', fmtNum(t.input), ' · 缓存命中 ', fmtNum(t.cacheRead), ' · 输出 ', fmtNum(t.output)),
          React.createElement('div', null,
            React.createElement('div', { className: 'au-stack' },
              React.createElement('i', { style: { width: pctOf(t.input) + '%', background: '#16a34a' } }),
              React.createElement('i', { style: { width: pctOf(t.cacheRead) + '%', background: '#3b82f6' } }),
              React.createElement('i', { style: { width: pctOf(t.output) + '%', background: '#8b5cf6' } })),
            React.createElement('div', { className: 'au-legend', style: { marginTop: 0, fontSize: 10.5 } },
              React.createElement('span', { className: 'au-legend-i' },
                React.createElement('span', { className: 'au-legend-dot', style: { background: '#16a34a' } }), '未命中输入 ' + fmtNum(t.input)),
              React.createElement('span', { className: 'au-legend-i' },
                React.createElement('span', { className: 'au-legend-dot', style: { background: '#3b82f6' } }), '缓存命中 ' + fmtNum(t.cacheRead)),
              React.createElement('span', { className: 'au-legend-i' },
                React.createElement('span', { className: 'au-legend-dot', style: { background: '#8b5cf6' } }), '输出 ' + fmtNum(t.output))))),

        card('hit', '缓存命中率', hit === null ? '—' : (hit * 100).toFixed(1) + '%',
          '命中 ' + fmtNum(t.cacheRead) + ' / 未命中 ' + fmtNum(t.input)),

        card('calls', '模型调用次数', fmtNum(s.genCalls),
          rangeText + '内 ' + s.activeDays + ' 天有活动'),

        card('out', '输出 Token', fmtNum(t.output),
          '思考 ' + fmtNum(t.thinking) + ' · 回复 ' + fmtNum(t.response)),

        card('sessions', '会话数', String(s.sessions),
          rangeText + '共 ' + s.steps.toLocaleString('en-US') + ' 步'))
    }

    function RangeTabs(props) {
      return React.createElement('div', { className: 'au-btn-group' },
        KPI_RANGES.map((r) => React.createElement('button', {
          key: r.key,
          className: 'au-btn' + (props.days === r.days ? ' on' : ''),
          onClick: () => props.onChange(r.days),
        }, r.label)))
    }

    // ================= 标签一：当前额度 =================
    function TabQuota(props) {
      const ov = props.overview || {}
      const status = ov.status || {}
      const snap = ov.snapshot || {}
      const lastKnown = ov.lastKnown || null
      const live = snap.ok === true
      useTick(1000)

      const shown = live ? snap : lastKnown
      const isStale = !live && lastKnown !== null
      const groups = shown && Array.isArray(shown.groups) ? shown.groups : []
      const models = shown && Array.isArray(shown.models) ? shown.models : []
      const credits = shown ? shown.credits : null
      const account = shown ? shown.account : null

      const out = []
      out.push(React.createElement('div', { className: 'au-card', key: 'acct' },
        React.createElement('div', { className: 'au-card-title' },
          '🛰️ ' + (account && account.name ? account.name : '反重力'),
          account && account.tier ? React.createElement('span', { className: 'au-ico-pct', style: { background: '#6b7280' } }, account.tier) : null,
          account && account.planName ? React.createElement('span', { className: 'au-ico-pct', style: { background: '#6b7280' } }, account.planName) : null,
          React.createElement('span', {
            className: live ? 'au-ok' : 'au-warn', style: { marginLeft: 'auto', fontSize: 11.5 },
          }, live ? '● 实时' : (isStale ? '● 快照（已过期）' : '● 不可用'))),
        React.createElement('div', { className: 'au-kv' },
          React.createElement('span', { className: 'au-k' }, '账号'),
          React.createElement('span', { className: 'au-v' }, (account && account.email) || '—'),
          React.createElement('span', { className: 'au-k' }, '语言服务器'),
          React.createElement('span', { className: 'au-v' }, status.port ? '127.0.0.1:' + status.port : '未连接'),
          React.createElement('span', { className: 'au-k' }, '本次尝试'),
          React.createElement('span', { className: 'au-v' }, fmtTime(status.lastCollectAt)),
          shown && shown.ts ? React.createElement('span', { className: 'au-k' }, '数据时间') : null,
          shown && shown.ts ? React.createElement('span', { className: 'au-v' }, fmtTime(shown.ts)) : null,
          credits !== null ? React.createElement('span', { className: 'au-k' }, 'Prompt 额度') : null,
          credits !== null
            ? React.createElement('span', { className: 'au-v' },
                credits.promptAvailable + ' / ' + credits.promptMonthly + '　Flow ' + credits.flowAvailable + ' / ' + credits.flowMonthly)
            : null)))

      if (!live) {
        out.push(React.createElement('div', { className: 'au-hint', key: 'off' },
          '反重力当前没有运行，实时额度不可用。' +
          (isStale
            ? (shown && shown.synthetic
                ? '下面灰色显示的是由最后一次采样还原的额度（不是完整快照）。'
                : '下面灰色显示的是最后一次成功采到的额度。')
            : '') +
          ' 趋势 / 热力图 / 汇总 / 重置 / 会话都不受影响。'))
      }

      if (groups.length === 0) {
        out.push(React.createElement('div', { className: 'au-card', key: 'none' },
          React.createElement('div', { className: 'au-empty' },
            '还没有任何额度快照。打开反重力（IDE 或 agy CLI）后，这里会出现实时额度。')))
      } else {
        groups.forEach((g, gi) => {
          out.push(React.createElement('div', { className: 'au-card', key: 'g' + gi },
            React.createElement('div', { className: 'au-card-title' }, '📊 ' + (g.name || '额度')),
            g.description ? React.createElement('div', { className: 'au-card-desc' }, g.description) : null,
            React.createElement('div', { className: 'au-grid' },
              (g.buckets || []).map((b, bi) => {
                const v = b.remainingFraction
                const color = remainingColor(v)
                const resetIn = typeof b.resetInMs === 'number' ? b.resetInMs : null
                return React.createElement('div', {
                  className: 'au-bucket', key: 'b' + bi, style: isStale ? { opacity: 0.6 } : undefined,
                },
                  React.createElement('div', { className: 'au-bucket-head' },
                    React.createElement('span', { className: 'au-bucket-label' }, b.label || b.id),
                    React.createElement('span', { className: 'au-bucket-pct', style: { color } }, pct(v))),
                  React.createElement('div', { className: 'au-bar' },
                    React.createElement('div', {
                      className: 'au-bar-fill',
                      style: { width: (v * 100).toFixed(2) + '%', background: color },
                    })),
                  React.createElement('div', { className: 'au-kv' },
                    React.createElement('span', { className: 'au-k' }, '重置'),
                    React.createElement('span', { className: 'au-v' },
                      resetIn !== null && live ? fmtCountdown(resetIn) : (b.resetTime ? fmtTime(Date.parse(b.resetTime)) : '—')),
                    React.createElement('span', { className: 'au-k' }, '已用'),
                    React.createElement('span', { className: 'au-v' }, pct(b.usedFraction))))
              }))))
        })
      }

      if (models.length > 0) {
        out.push(React.createElement('div', { className: 'au-card', key: 'models' },
          React.createElement('div', { className: 'au-card-title' }, '🧩 各模型剩余额度'),
          React.createElement('div', { className: 'au-models' },
            models.map((m, i) => React.createElement('div', { className: 'au-model', key: 'm' + i },
              React.createElement('span', { className: 'au-dot', style: { background: remainingColor(m.remainingFraction) } }),
              React.createElement('span', { className: 'au-model-name', title: m.model }, m.label || m.model),
              React.createElement('span', {
                className: 'au-v', style: { color: remainingColor(m.remainingFraction) },
              }, pct(m.remainingFraction, 0)))))))
      }

      return React.createElement('div', {}, out)
    }

    // ================= 标签二：趋势 =================
    const RANGES = [
      { key: '24h', label: '24 小时' },
      { key: '7d', label: '7 天' },
      { key: '30d', label: '30 天' },
      { key: 'all', label: '全部' },
    ]
    const SERIES_COLORS = ['#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#06b6d4']

    function TabTrend(props) {
      const [range, setRange] = React.useState('24h')
      const { data } = useJson(API_HISTORY + '?range=' + range, props.interval, 60000)
      const ov = props.overview || {}
      const shown = ov.snapshot && ov.snapshot.ok ? ov.snapshot : ov.lastKnown
      const groups = shown && Array.isArray(shown.groups) ? shown.groups : []

      const points = data && Array.isArray(data.points) ? data.points : []
      const keys = []
      const labelOf = new Map()
      for (const g of groups) {
        for (const b of (g.buckets || [])) {
          if (keys.indexOf(b.id) < 0) {
            keys.push(b.id)
            labelOf.set(b.id, (b.label || b.id) + (g.name ? ' · ' + g.name : ''))
          }
        }
      }
      for (const p of points) {
        for (const k of Object.keys(p.values || {})) {
          if (keys.indexOf(k) < 0) {
            keys.push(k)
            labelOf.set(k, k)
          }
        }
      }
      const series = keys.slice(0, SERIES_COLORS.length).map((k, i) => ({
        key: k,
        label: labelOf.get(k) || k,
        color: SERIES_COLORS[i % SERIES_COLORS.length],
        values: points.map((p) => num((p.values || {})[k])),
      }))

      const sampleCount = data ? num(data.sampleCount) : 0
      const windowText = points.length >= 2
        ? fmtTime(points[0].t) + ' → ' + fmtTime(points[points.length - 1].t)
        : null

      return React.createElement('div', {},
        React.createElement('div', { className: 'au-toolbar' },
          RANGES.map((r) => React.createElement('button', {
            key: r.key,
            className: 'au-btn' + (range === r.key ? ' on' : ''),
            onClick: () => setRange(r.key),
          }, r.label))),
        React.createElement('div', { className: 'au-card' },
          React.createElement('div', { className: 'au-card-title' }, '📈 剩余额度随时间变化'),
          React.createElement('div', { className: 'au-card-desc' },
            '反重力官方接口只给「剩余额度百分比」，所以这里画的是剩余额度：' +
            '下降即消耗（消耗 ∝ token 成本），上升表示窗口滚动恢复或周期重置。'),
          React.createElement(TrendChart, { points, series }),
          windowText !== null
            ? React.createElement('div', { className: 'au-card-desc', style: { marginTop: 8, marginBottom: 0 } },
                windowText + '　（' + points.length + ' 个绘图点 / ' + sampleCount + ' 次采样）')
            : null),
        sampleCount === 0
          ? React.createElement('div', { className: 'au-card' },
              React.createElement('div', { className: 'au-empty' },
                '这个时间范围还没有采样。插件每 ' + Math.round(num(ov.status && ov.status.intervalMs) / 1000) +
                ' 秒采一次，开着反重力就会慢慢积累。'))
          : null)
    }

    // ================= 标签三：热力图 =================
    const HEAT_DAYS = 182

    function buildHeatCells(days) {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const start = new Date(today.getTime() - (days - 1) * 86400000)
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
      const cells = []
      for (let d = new Date(start.getTime()); d.getTime() <= today.getTime(); d.setDate(d.getDate() + 1)) {
        cells.push({ date: dayKeyOf(d), ms: d.getTime() })
      }
      return cells
    }

    const HEAT_COLORS = [
      'rgba(128,128,128,.16)',
      'color-mix(in srgb, #16a34a 28%, transparent)',
      'color-mix(in srgb, #16a34a 52%, transparent)',
      'color-mix(in srgb, #16a34a 76%, transparent)',
      '#16a34a',
    ]

    function TabHeatmap(props) {
      const [metric, setMetric] = React.useState('sessions')
      const { data: usage } = useJson(API_USAGE, props.interval, 120000)
      const { data: conv } = useJson(API_CONV, props.interval, 120000)
      const cells = React.useMemo(() => buildHeatCells(HEAT_DAYS), [])
      const todayKey = dayKeyOf(new Date())

      const usageByDay = new Map()
      if (usage && Array.isArray(usage.daily)) for (const d of usage.daily) usageByDay.set(d.date, d)
      const convByDay = new Map()
      if (conv && Array.isArray(conv.byDay)) for (const d of conv.byDay) convByDay.set(d.date, d)

      const valueOf = (dateKey) => {
        if (metric === 'quota') {
          const d = usageByDay.get(dateKey)
          return d ? num(d.consumed) : 0
        }
        const d = convByDay.get(dateKey)
        if (d === undefined) return 0
        if (metric === 'tokens') return num(d.tokens && d.tokens.input) + num(d.tokens && d.tokens.output)
        if (metric === 'cache') return num(d.tokens && d.tokens.cacheRead)
        return metric === 'steps' ? num(d.steps) : num(d.sessions)
      }

      const values = cells.map((c) => valueOf(c.date))
      const max = values.reduce((m, v) => Math.max(m, v), 0)
      const unit = metric === 'quota' ? '' : (metric === 'steps' ? ' 步' : (metric === 'sessions' ? ' 个会话' : ''))
      const peakText = metric === 'quota'
        ? pct(max, 1)
        : (metric === 'tokens' || metric === 'cache' ? fmtNum(max) + ' token' : Math.round(max) + unit)
      const colorOf = (v) => {
        if (v <= 0) return HEAT_COLORS[0]
        const r = max > 0 ? v / max : 1
        return HEAT_COLORS[r > 0.75 ? 4 : (r > 0.5 ? 3 : (r > 0.25 ? 2 : 1))]
      }

      const metricButtons = [
        { key: 'sessions', label: '会话数' },
        { key: 'steps', label: '步数' },
        { key: 'tokens', label: 'token' },
        { key: 'cache', label: '缓存读取' },
        { key: 'quota', label: '额度消耗' },
      ]
      const heatDesc = metric === 'quota'
        ? '按日统计的额度消耗（各额度桶当日消耗百分比之和）。只有插件在跑、且反重力在运行时才会有采样点。'
        : (metric === 'tokens'
            ? '按日统计的输入+输出 token（来自本地会话库的 gen_metadata）。'
            : (metric === 'cache'
                ? '按日统计的缓存命中读取 token（cacheReadTokens）。'
                : '来自反重力本地会话库（离线可读），反重力关着也照常有数据。'))

      return React.createElement('div', {},
        React.createElement('div', { className: 'au-toolbar' },
          metricButtons.map((m) => React.createElement('button', {
            key: m.key,
            className: 'au-btn' + (metric === m.key ? ' on' : ''),
            onClick: () => setMetric(m.key),
          }, m.label)),
          React.createElement('span', { className: 'au-spacer' }),
          React.createElement('span', { style: { fontSize: 11, opacity: 0.6 } },
            '近 ' + HEAT_DAYS + ' 天　峰值 ' + peakText)),
        React.createElement('div', { className: 'au-card' },
          React.createElement('div', { className: 'au-card-title' }, '🗓️ 日历热力图'),
          React.createElement('div', { className: 'au-card-desc' }, heatDesc),
          React.createElement('div', { className: 'au-heat-wrap' },
            React.createElement('div', { className: 'au-heat' },
              cells.map((c) => {
                const v = valueOf(c.date)
                return React.createElement('div', {
                  key: c.date,
                  className: 'au-cell' + (c.date === todayKey ? ' today' : ''),
                  style: { background: colorOf(v) },
                  title: c.date + '　' + (metric === 'quota' ? pct(v, 2) : Math.round(v) + unit),
                })
              }))),
          React.createElement('div', { className: 'au-legend' },
            React.createElement('span', {}, '少'),
            HEAT_COLORS.map((c, i) => React.createElement('span', {
              key: i, className: 'au-cell', style: { background: c, display: 'inline-block' },
            })),
            React.createElement('span', {}, '多'))))
    }

    // ================= 标签四：汇总 =================
    function TabSummary(props) {
      const { data: usage } = useJson(API_USAGE, props.interval, 120000)
      const { data: conv } = useJson(API_CONV, props.interval, 120000)
      const daily = usage && Array.isArray(usage.daily) ? usage.daily : []
      const monthly = usage && Array.isArray(usage.monthly) ? usage.monthly.slice().reverse() : []
      const convByDay = new Map()
      if (conv && Array.isArray(conv.byDay)) for (const d of conv.byDay) convByDay.set(d.date, d)

      const rows = []
      for (const d of daily) {
        const c = convByDay.get(d.date)
        rows.push({
          date: d.date,
          consumed: num(d.consumed),
          resets: num(d.resets),
          sessions: c ? num(c.sessions) : 0,
          steps: c ? num(c.steps) : 0,
          genCalls: c ? num(c.genCalls) : 0,
          tokens: c ? c.tokens : null,
        })
      }
      const seen = new Set(rows.map((r) => r.date))
      for (const [date, c] of convByDay) {
        if (seen.has(date)) continue
        rows.push({
          date,
          consumed: 0,
          resets: 0,
          sessions: num(c.sessions),
          steps: num(c.steps),
          genCalls: num(c.genCalls),
          tokens: c.tokens,
        })
      }
      rows.sort((a, b) => (a.date < b.date ? 1 : -1))
      // 跟随页头的时间范围；'全部' 时不过滤
      const cutoff = rangeCutoff(num(props.days))
      const shownRows = cutoff === '' ? rows : rows.filter((r) => r.date >= cutoff)

      return React.createElement('div', {},
        React.createElement('div', { className: 'au-card' },
          React.createElement('div', { className: 'au-card-title' }, '📅 逐月额度'),
          monthly.length === 0
            ? React.createElement('div', { className: 'au-empty' }, '还没有逐月额度数据。')
            : React.createElement('table', { className: 'au-table' },
                React.createElement('thead', {}, React.createElement('tr', {},
                  React.createElement('th', {}, '月份'),
                  React.createElement('th', { className: 'au-num' }, '额度消耗'),
                  React.createElement('th', { className: 'au-num' }, '恢复'),
                  React.createElement('th', { className: 'au-num' }, '重置次数'))),
                React.createElement('tbody', {}, monthly.map((m) => React.createElement('tr', { key: m.month },
                  React.createElement('td', {}, m.month),
                  React.createElement('td', { className: 'au-num' }, pct(m.consumed)),
                  React.createElement('td', { className: 'au-num' }, pct(m.recovered)),
                  React.createElement('td', { className: 'au-num' }, String(num(m.resets)))))))),
        React.createElement('div', { className: 'au-card' },
          React.createElement('div', { className: 'au-card-title' }, '📆 逐日（' + Math.min(shownRows.length, 60) + ' 天）'),
          rows.length === 0
            ? React.createElement('div', { className: 'au-empty' }, '暂无数据。')
            : React.createElement('table', { className: 'au-table' },
                React.createElement('thead', {}, React.createElement('tr', {},
                  React.createElement('th', {}, '日期'),
                  React.createElement('th', { className: 'au-num' }, '额度消耗'),
                  React.createElement('th', { className: 'au-num' }, '会话'),
                  React.createElement('th', { className: 'au-num' }, '步数'),
                  React.createElement('th', { className: 'au-num' }, '生成'),
                  React.createElement('th', { className: 'au-num' }, '输入'),
                  React.createElement('th', { className: 'au-num' }, '输出'),
                  React.createElement('th', { className: 'au-num' }, '缓存读取'),
                  React.createElement('th', { className: 'au-num' }, '命中率'))),
                React.createElement('tbody', {}, shownRows.slice(0, 60).map((d) => React.createElement('tr', { key: d.date },
                  React.createElement('td', {}, d.date),
                  React.createElement('td', { className: 'au-num' }, d.consumed > 0 ? pct(d.consumed) : '—'),
                  React.createElement('td', { className: 'au-num' }, d.sessions > 0 ? String(d.sessions) : '—'),
                  React.createElement('td', { className: 'au-num' }, d.steps > 0 ? String(d.steps) : '—'),
                  React.createElement('td', { className: 'au-num' }, d.genCalls > 0 ? String(d.genCalls) : '—'),
                  React.createElement('td', { className: 'au-num', title: fmtFull(d.tokens && d.tokens.input) }, d.tokens ? fmtNum(d.tokens.input) : '—'),
                  React.createElement('td', { className: 'au-num', title: fmtFull(d.tokens && d.tokens.output) }, d.tokens ? fmtNum(d.tokens.output) : '—'),
                  React.createElement('td', { className: 'au-num', title: fmtFull(d.tokens && d.tokens.cacheRead) }, d.tokens ? fmtNum(d.tokens.cacheRead) : '—'),
                  React.createElement('td', { className: 'au-num' }, fmtHit(d.tokens))))))),
        React.createElement('div', { className: 'au-card-desc' },
          '「额度消耗」只统计插件运行、且反重力在运行时采到的部分；' +
          '「会话 / 步数 / 生成 / token / 缓存」全部来自反重力本地会话库，是完整历史（反重力没开也有）。'))
    }

    // ================= 标签五：重置历史 =================
    function TabResets(props) {
      const { data: usage } = useJson(API_USAGE, props.interval, 120000)
      const resets = usage && Array.isArray(usage.resets) ? usage.resets : []
      const daily = usage && Array.isArray(usage.daily) ? usage.daily : []
      const perBucket = new Map()
      for (const d of daily) {
        for (const b of (d.byBucket || [])) {
          let x = perBucket.get(b.id)
          if (x === undefined) {
            x = { id: b.id, consumed: 0, recovered: 0, resets: 0 }
            perBucket.set(b.id, x)
          }
          x.consumed += num(b.consumed)
          x.recovered += num(b.recovered)
          x.resets += num(b.resets)
        }
      }
      const buckets = Array.from(perBucket.values()).sort((a, b) => b.consumed - a.consumed)

      return React.createElement('div', {},
        React.createElement('div', { className: 'au-card' },
          React.createElement('div', { className: 'au-card-title' }, '🔄 各额度桶累计'),
          buckets.length === 0
            ? React.createElement('div', { className: 'au-empty' }, '还没有额度采样。')
            : React.createElement('table', { className: 'au-table' },
                React.createElement('thead', {}, React.createElement('tr', {},
                  React.createElement('th', {}, '额度桶'),
                  React.createElement('th', { className: 'au-num' }, '累计消耗'),
                  React.createElement('th', { className: 'au-num' }, '累计恢复'),
                  React.createElement('th', { className: 'au-num' }, '重置次数'))),
                React.createElement('tbody', {}, buckets.map((b) => React.createElement('tr', { key: b.id },
                  React.createElement('td', {}, b.id),
                  React.createElement('td', { className: 'au-num' }, pct(b.consumed)),
                  React.createElement('td', { className: 'au-num' }, pct(b.recovered)),
                  React.createElement('td', { className: 'au-num' }, String(b.resets))))))),
        React.createElement('div', { className: 'au-card' },
          React.createElement('div', { className: 'au-card-title' },
            '⏱️ 重置事件（' + Math.min(resets.length, 100) + ' / ' + resets.length + ' 条）'),
          React.createElement('div', { className: 'au-card-desc' },
            '判定规则：剩余额度在 12 小时内回升 ≥ 5% 记一次重置；窗口滚动造成的碎步恢复不算。'),
          resets.length === 0
            ? React.createElement('div', { className: 'au-empty' }, '还没有监测到重置事件。')
            : React.createElement('table', { className: 'au-table' },
                React.createElement('thead', {}, React.createElement('tr', {},
                  React.createElement('th', {}, '时间'),
                  React.createElement('th', {}, '额度桶'),
                  React.createElement('th', { className: 'au-num' }, '从'),
                  React.createElement('th', { className: 'au-num' }, '到'),
                  React.createElement('th', { className: 'au-num' }, '回升'))),
                React.createElement('tbody', {}, resets.slice(0, 100).map((r, i) => React.createElement('tr', { key: i },
                  React.createElement('td', {}, fmtTime(r.at)),
                  React.createElement('td', {}, r.bucketId),
                  React.createElement('td', { className: 'au-num' }, pct(r.from, 1)),
                  React.createElement('td', { className: 'au-num' }, pct(r.to, 1)),
                  React.createElement('td', { className: 'au-num' }, '+' + pct(r.jump, 1))))))))
    }

    // ================= 标签六：本地会话（离线） =================
    function TabConversations(props) {
      const { data } = useJson(API_CONV + '?full=1', props.interval, 120000)
      const [q, setQ] = React.useState('')
      const [wsFilter, setWsFilter] = React.useState('')
      const conv = data && Array.isArray(data.conversations) ? data.conversations : []
      const totals = (data && data.totals) || { sessions: 0, steps: 0, genCalls: 0, models: 0 }
      const byModel = data && Array.isArray(data.byModel) ? data.byModel : []
      const byWs = data && Array.isArray(data.byWorkspace) ? data.byWorkspace : []
      const stores = data && Array.isArray(data.stores) ? data.stores : []

      const filtered = conv.filter((c) => {
        if (wsFilter !== '' && !(c.workspaces || []).some((w) => w === wsFilter)) return false
        if (q === '') return true
        const hay = ((c.title || '') + ' ' + (c.preview || '') + ' ' + (c.workspaces || []).join(' ') + ' ' + (c.models || []).join(' ')).toLowerCase()
        return hay.indexOf(q.toLowerCase()) >= 0
      })

      const tok = totals.tokens || emptyTok()

      return React.createElement('div', {},
        React.createElement('div', { className: 'au-card' },
          React.createElement('div', { className: 'au-card-title' }, '💾 离线用量总览'),
          React.createElement('div', { className: 'au-card-desc' },
            '直接只读扫描反重力落在磁盘上的会话库，反重力没运行也有数据。' +
            'token 是从每个会话的 gen_metadata 里解出来的（字段号由语言服务器的 modelUsage 校准）。' +
            (data && data.scannedAt ? '最后扫描 ' + fmtTime(data.scannedAt) + '。' : '')),
          React.createElement('div', { className: 'au-kv' },
            React.createElement('span', { className: 'au-k' }, '会话数'),
            React.createElement('span', { className: 'au-v' }, String(totals.sessions)),
            React.createElement('span', { className: 'au-k' }, '总步数'),
            React.createElement('span', { className: 'au-v' }, String(totals.steps)),
            React.createElement('span', { className: 'au-k' }, '生成次数'),
            React.createElement('span', { className: 'au-v' }, String(totals.genCalls)),
            React.createElement('span', { className: 'au-k' }, '用过的模型'),
            React.createElement('span', { className: 'au-v' }, String(totals.models)),
            React.createElement('span', { className: 'au-k' }, '输入 token'),
            React.createElement('span', { className: 'au-v', title: fmtFull(tok.input) }, fmtNum(tok.input)),
            React.createElement('span', { className: 'au-k' }, '输出 token'),
            React.createElement('span', { className: 'au-v', title: fmtFull(tok.output) },
              fmtNum(tok.output) + '（思考 ' + fmtNum(tok.thinking) + ' + 回复 ' + fmtNum(tok.response) + '）'),
            React.createElement('span', { className: 'au-k' }, '缓存命中读取'),
            React.createElement('span', { className: 'au-v', title: fmtFull(tok.cacheRead) }, fmtNum(tok.cacheRead)),
            React.createElement('span', { className: 'au-k' }, '缓存命中率'),
            React.createElement('span', { className: 'au-v au-ok' }, fmtHit(tok))),
          stores.length > 0
            ? React.createElement('div', { style: { marginTop: 8, fontSize: 11, opacity: 0.62 } },
                stores.map((s, i) => React.createElement('div', { key: i },
                  (s.ok ? '✅ ' : '— ') + s.label + '：' + s.sessions + ' 个会话' + (s.ok ? '' : '（' + (s.error || '不可用') + '）'))))
            : null),

        byModel.length > 0
          ? React.createElement('div', { className: 'au-card' },
              React.createElement('div', { className: 'au-card-title' }, '🧠 按模型'),
              React.createElement('table', { className: 'au-table' },
                React.createElement('thead', {}, React.createElement('tr', {},
                  React.createElement('th', {}, '模型'),
                  React.createElement('th', { className: 'au-num' }, '生成'),
                  React.createElement('th', { className: 'au-num' }, '输入'),
                  React.createElement('th', { className: 'au-num' }, '输出'),
                  React.createElement('th', { className: 'au-num' }, '缓存读取'),
                  React.createElement('th', { className: 'au-num' }, '命中率'))),
                React.createElement('tbody', {}, byModel.slice(0, 20).map((m) => React.createElement('tr', { key: m.model },
                  React.createElement('td', {}, m.model),
                  React.createElement('td', { className: 'au-num' }, String(m.genCalls)),
                  React.createElement('td', { className: 'au-num', title: fmtFull(m.tokens && m.tokens.input) }, fmtNum(m.tokens && m.tokens.input)),
                  React.createElement('td', { className: 'au-num', title: fmtFull(m.tokens && m.tokens.output) }, fmtNum(m.tokens && m.tokens.output)),
                  React.createElement('td', { className: 'au-num', title: fmtFull(m.tokens && m.tokens.cacheRead) }, fmtNum(m.tokens && m.tokens.cacheRead)),
                  React.createElement('td', { className: 'au-num' }, fmtHit(m.tokens)))))))
          : null,

        byWs.length > 0
          ? React.createElement('div', { className: 'au-card' },
              React.createElement('div', { className: 'au-card-title' }, '📁 按工作区（点一行可筛选）'),
              React.createElement('table', { className: 'au-table' },
                React.createElement('thead', {}, React.createElement('tr', {},
                  React.createElement('th', {}, '工作区'),
                  React.createElement('th', { className: 'au-num' }, '会话'),
                  React.createElement('th', { className: 'au-num' }, '步数'),
                  React.createElement('th', { className: 'au-num' }, '输入'),
                  React.createElement('th', { className: 'au-num' }, '输出'))),
                React.createElement('tbody', {}, byWs.slice(0, 20).map((w) => React.createElement('tr', {
                  key: w.workspace,
                  onClick: () => setWsFilter(wsFilter === w.workspace ? '' : w.workspace),
                  style: { cursor: 'pointer' },
                },
                  React.createElement('td', { className: 'au-trunc', title: w.workspace }, shortWs(w.workspace)),
                  React.createElement('td', { className: 'au-num' }, String(w.sessions)),
                  React.createElement('td', { className: 'au-num' }, String(w.steps)),
                  React.createElement('td', {
                    className: 'au-num', title: fmtFull(w.tokens && w.tokens.input),
                  }, fmtNum(w.tokens && w.tokens.input)),
                  React.createElement('td', {
                    className: 'au-num', title: fmtFull(w.tokens && w.tokens.output),
                  }, fmtNum(w.tokens && w.tokens.output)))))))
          : null,

        React.createElement('div', { className: 'au-card' },
          React.createElement('div', { className: 'au-toolbar' },
            React.createElement('input', {
              className: 'au-btn au-input',
              placeholder: '搜索标题 / 工作区 / 模型…',
              value: q,
              onChange: (e) => setQ(e.target.value),
            }),
            wsFilter !== ''
              ? React.createElement('button', {
                  className: 'au-btn on', onClick: () => setWsFilter(''),
                }, '工作区: ' + shortWs(wsFilter) + ' ✕')
              : null,
            React.createElement('span', { className: 'au-spacer' }),
            React.createElement('span', { style: { fontSize: 11, opacity: 0.6 } },
              filtered.length + ' / ' + conv.length + ' 个会话')),
          filtered.length === 0
            ? React.createElement('div', { className: 'au-empty' }, conv.length === 0 ? '没有读到本地会话。' : '没有匹配的会话。')
            : React.createElement('table', { className: 'au-table' },
                React.createElement('thead', {}, React.createElement('tr', {},
                  React.createElement('th', {}, '会话'),
                  React.createElement('th', {}, '工作区'),
                  React.createElement('th', {}, '模型'),
                  React.createElement('th', { className: 'au-num' }, '步数'),
                  React.createElement('th', { className: 'au-num' }, '生成'),
                  React.createElement('th', { className: 'au-num' }, '输入'),
                  React.createElement('th', { className: 'au-num' }, '输出'),
                  React.createElement('th', { className: 'au-num' }, '缓存读取'),
                  React.createElement('th', { className: 'au-num' }, '命中率'),
                  React.createElement('th', {}, '最后活动'))),
                React.createElement('tbody', {}, filtered.slice(0, 150).map((c) => React.createElement('tr', { key: c.id },
                  React.createElement('td', {
                    className: 'au-trunc', title: (c.title || '') + '\n' + (c.preview || ''),
                  }, c.title || c.preview || '(无标题)'),
                  React.createElement('td', {
                    className: 'au-trunc', title: (c.workspaces || []).join('\n'),
                  }, shortWs((c.workspaces || [])[0])),
                  React.createElement('td', {
                    className: 'au-trunc', title: (c.models || []).join('\n'),
                  }, (c.models || []).slice(0, 2).join(', ') || '—'),
                  React.createElement('td', { className: 'au-num' }, String(c.steps)),
                  React.createElement('td', { className: 'au-num' }, String(c.genCalls)),
                  React.createElement('td', {
                    className: 'au-num', title: fmtFull(c.tokens && c.tokens.input),
                  }, fmtNum(c.tokens && c.tokens.input)),
                  React.createElement('td', {
                    className: 'au-num', title: fmtFull(c.tokens && c.tokens.output),
                  }, fmtNum(c.tokens && c.tokens.output)),
                  React.createElement('td', {
                    className: 'au-num', title: fmtFull(c.tokens && c.tokens.cacheRead),
                  }, fmtNum(c.tokens && c.tokens.cacheRead)),
                  React.createElement('td', { className: 'au-num' }, fmtHit(c.tokens)),
                  React.createElement('td', {}, fmtTime(c.lastModified))))))))
    }

    // ================= 弹窗 =================
    const TABS = [
      { key: 'quota', label: '额度', comp: TabQuota },
      { key: 'trend', label: '趋势', comp: TabTrend },
      { key: 'heat', label: '热力图', comp: TabHeatmap },
      { key: 'summary', label: '汇总', comp: TabSummary },
      { key: 'resets', label: '重置', comp: TabResets },
      { key: 'conv', label: '会话', comp: TabConversations },
    ]

    // main 面板（keyed）——侧边栏点 panellist 那一行就会切到这里
    function PanelPage(props) {
      const interval = props.interval
      const [tab, setTab] = React.useState('quota')
      const [busy, setBusy] = React.useState(false)
      const [days, setDays] = React.useState(0) // 0 = 全部
      const ov = useJson(API, interval, 30000)
      const conv = useJson(API_CONV, interval, 120000)
      const status = (ov.data && ov.data.status) || {}
      const live = (ov.data && ov.data.snapshot && ov.data.snapshot.ok) === true

      const doRefresh = () => {
        setBusy(true)
        fetch(API_REFRESH, { method: 'POST' })
          .then((r) => r.json())
          .then(() => {}, () => {})
          .then(() => setBusy(false))
      }

      const Current = (TABS.find((t) => t.key === tab) || TABS[0]).comp
      const offlineTotals = (status.offline && status.offline.totals) || {}

      return React.createElement('div', { className: 'au-page' },
        styles(),
        React.createElement('div', { className: 'au-head' },
          React.createElement('h2', { className: 'au-title' }, '🛰️ 反重力额度 / 用量'),
          React.createElement('div', { className: 'au-head-meta' },
            React.createElement('div', {}, live ? '● 实时额度可用' : '○ 反重力未运行（仅历史）'),
            React.createElement('div', {},
              '离线会话 ' + num(offlineTotals.sessions) + ' 个　额度采样 ' + num(status.history && status.history.samples) + ' 次')),
          React.createElement(RangeTabs, { days, onChange: setDays }),
          React.createElement('button', {
            className: 'au-btn', onClick: doRefresh, disabled: busy,
          }, busy ? '刷新中…' : '刷新')),
        React.createElement('div', { className: 'au-tabs' },
          TABS.map((t) => React.createElement('button', {
            key: t.key,
            className: 'au-tab' + (tab === t.key ? ' on' : ''),
            onClick: () => setTab(t.key),
          }, t.label))),
        React.createElement('div', { className: 'au-body' },
          ov.error !== null && ov.data === null
            ? React.createElement('div', { className: 'au-empty' }, '宿主接口不可达：' + ov.error)
            : React.createElement(React.Fragment, null,
                React.createElement(ErrorBoundary, null,
                  React.createElement(KpiRow, { conv: conv.data, days })),
                React.createElement(ErrorBoundary, null,
                  React.createElement(Current, { interval, overview: ov.data, days, conv: conv.data, onChangeDays: setDays })))))
    }


    // ================= 侧边栏 glyph（sidebar.panellist） =================
    // 这一行的按钮和外层是侧边栏自己画的（PanelRow：selectPanel(id)），
    // 我们只提供那个 glyph，拿到 {size, active}。
    function PanelIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      const ref = React.useRef(null)

      // 一次性探针：确认 DSH 真的把这一行画出来了、并且可见（行本身是 DSH 画的）
      React.useEffect(() => {
        if (domProbesSent >= 2) return
        domProbesSent += 1
        const id = setTimeout(() => {
          try {
            const el = ref.current
            const btn = el !== null && el.closest !== undefined ? el.closest('button') : null
            const r = btn !== null ? btn.getBoundingClientRect() : null
            // 顺便查重复注册：HMR 反复 apply 时若旧条目没被回收，这里会 >1
            let myEntries = null
            try {
              if (slotsRef !== null && typeof slotsRef.entriesOfSlot === 'function') {
                const list = slotsRef.entriesOfSlot('sidebar.panellist')
                myEntries = Array.isArray(list)
                  ? list.filter((e) => e && e.options && e.options.id === 'antigravity-usage').length
                  : null
              }
            } catch {
              /* ignore */
            }
            report('panellist-dom', {
              found: btn !== null,
              label: btn !== null ? btn.getAttribute('aria-label') : null,
              rowsInDom: document.querySelectorAll('[aria-label^="反重力额度"]').length,
              myEntries,
              // 旧版本的条目有没有被回收干净（HMR 重载后不该再出现在这两个槽位里）
              footerEntries: (() => {
                try {
                  return slotsRef.entriesOfSlot('sidebar.footer.action').map((e) => e && e.options && e.options.id)
                } catch {
                  return null
                }
              })(),
              overlayEntries: (() => {
                try {
                  return slotsRef.entriesOfSlot('shell.overlay').map((e) => e && e.options && e.options.id)
                } catch {
                  return null
                }
              })(),
              x: r !== null ? Math.round(r.x) : null,
              y: r !== null ? Math.round(r.y) : null,
              w: r !== null ? Math.round(r.width) : null,
              h: r !== null ? Math.round(r.height) : null,
              visibility: btn !== null ? getComputedStyle(btn).visibility : null,
            })
          } catch (e) {
            report('panellist-dom-err', { message: String(e && e.message) })
          }
        }, 1200)
        return () => clearTimeout(id)
      }, [])

      return React.createElement('span', {
        ref,
        style: {
          fontSize: Math.max(11, size - 2),
          lineHeight: 1,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          filter: props.active ? 'none' : 'grayscale(0.15)',
        },
      }, '🛰️')
    }

    // ================= 注册 =================
    // 客户端半边只声明 slots（官方模板做法）；定时器走 ctx.get('timer') 安全获取，拿不到退回原生。
    exports.inject = ['slots']
    exports.apply = (ctx) => {
      const slots = ctx.slots ?? (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      report('apply', { hasSlots: slots !== undefined && slots !== null })
      if (slots === undefined || slots === null) {
        console.warn('[' + PLUGIN_ID + '] slots 服务不可用，客户端面板未注册')
        report('apply-no-slots')
        return
      }
      const interval = makeTimer(ctx)
      slotsRef = slots

      function GuardedIcon(props) {
        return React.createElement(ErrorBoundary, null,
          React.createElement(PanelIcon, { size: props && props.size, active: props && props.active }))
      }
      function GuardedPage() {
        return React.createElement(ErrorBoundary, null,
          React.createElement(PanelPage, { interval }))
      }

      // PANEL_ID 同时用于 sidebar.panellist 的 id（list 槽位）与 main 的 key（keyed 槽位），
      // 侧边栏点这一行时执行 selectPanel(id)，切到的就是 main 里 key 相同的那个面板。
      const PANEL_ID = 'antigravity-usage'

      const disposers = [
        // 竖排的侧边栏行：侧边栏自己画按钮+文字（文字取 label thunk，所以能带实时百分比）
        slots.inject('sidebar.panellist', () => {
          const d = slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: () => badgeLabel(),
          }, GuardedIcon)
          report('panellist-registered', { hasDisposer: typeof d === 'function' })
          return d
        }),
        // 右侧主区域的专属整页
        slots.inject('main', function* () {
          const d = yield slots.register({ name: 'main', key: PANEL_ID }, GuardedPage)
          report('main-registered', { hasDisposer: typeof d === 'function' })
          return d
        }),
      ]
      report('registered')

      // 标签里带实时百分比：label 是每次投影都重读的 thunk，
      // 所以这里用独立轮询（不依赖 React 是否挂载）刷新 badge 文案；先立刻拉一次。
      const refreshBadge = () => {
        fetch(API, { headers: { accept: 'application/json' } })
          .then((r) => r.json())
          .then((j) => {
            const snap = j && j.snapshot && j.snapshot.ok ? j.snapshot : (j ? j.lastKnown : null)
            const groups = snap && Array.isArray(snap.groups) ? snap.groups : []
            let worst = null
            for (const g of groups) {
              for (const b of (g.buckets || [])) {
                if (worst === null || b.remainingFraction < worst) worst = b.remainingFraction
              }
            }
            badge.text = worst === null ? '' : Math.round(worst * 100) + '%'
            badge.pct = worst
          })
          .catch(() => {})
      }
      refreshBadge()
      const stopBadgePoll = interval(refreshBadge, 60000)

      return () => {
        try {
          stopBadgePoll()
        } catch {
          /* ignore */
        }
        for (const d of disposers) {
          try {
            if (typeof d === 'function') d()
          } catch {
            /* 回收失败静默 */
          }
        }
      }
    }

    // 供测试/调试直接渲染内部组件用（DSH 加载器只用 inject/apply，多余键会被忽略）
    exports.__internals = {
      PanelPage,
      PanelIcon,
      TABS,
    }

    return module.exports
  },
})
