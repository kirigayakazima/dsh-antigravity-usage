// antigravity-usage — 用真 React 真渲染一遍注册进 slot 的组件（开发用）。
// 目的：抓「组件渲染时抛错 → DSH 把条目标成 renderFailure → 界面上什么都不显示」这类问题。
// 用法: node scripts/test-render.mjs
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- 捕获 bundle 注册 ----
let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (o) => { captured = o } } },
  console,
  // SSR 里 effect 不跑，但组件体可能引用这些
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: () => Promise.reject(new Error('no network in render test')),
  AbortSignal,
  URL,
  Map,
  Set,
  Date,
  Math,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Symbol,
  Error,
  Promise,
  setTimeout: () => 0,
  clearTimeout: () => {},
}
sandbox.globalThis = sandbox

runInContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), createContext(sandbox), { filename: 'client.js' })

const exportsObj = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})

// ---- 假的 slots 服务，拿到注册项 ----
const registrations = []
const fakeSlots = {
  inject: (ownerKey, cb) => {
    const r = cb()
    // 生成器形式（main 面板用 function* + yield register）要驱动到底
    if (r !== null && r !== undefined && typeof r.next === 'function') {
      let step = r.next()
      while (step.done !== true) step = r.next()
    }
    return () => {}
  },
  register: (meta, component) => {
    registrations.push({ meta, component })
    return () => {}
  },
}

exportsObj.apply({ slots: fakeSlots, get: () => undefined })

let failed = 0
function check(label, ok, extra) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || extra === undefined ? '' : '  → ' + extra}`)
  if (!ok) failed += 1
}

function renderCase(label, el) {
  let err = null
  let html = ''
  try {
    html = renderToStaticMarkup(el)
  } catch (e) {
    err = e
  }
  if (err !== null) {
    console.log(`\n❌ ${label} 抛错了：`)
    console.log('   ' + (err.stack ?? String(err)).split('\n').slice(0, 6).join('\n   '))
    failed += 1
  }
  return { html, err }
}

console.log('=== 用真 React (v' + React.version + ') 渲染注册进 slot 的组件 ===')
for (const reg of registrations) {
  const key = reg.meta.name === 'main' ? reg.meta.key : reg.meta.id
  // sidebar.panellist 的 glyph 会拿到 {size, active}（对应展开/收纳态）
  const propSets = reg.meta.name === 'sidebar.panellist'
    ? [{ size: 16, active: false }, { size: 18, active: true }]
    : [{}]
  for (const props of propSets) {
    const label = `${reg.meta.name} / ${key}  props=${JSON.stringify(props)}`
    const { html, err } = renderCase(label, React.createElement(reg.component, props))
    if (err === null) {
      const short = html.length > 140 ? html.slice(0, 140) + '…' : html
      console.log(`\n✅ ${label}  渲染 ${html.length} 字节`)
      console.log('   ' + short)
    }
  }
}

console.log('\n=== 专属整页与六个标签（空数据状态）===')
const internals = exportsObj.__internals
if (internals === undefined) {
  check('有 __internals 测试入口', false)
} else {
  const cases = [
    { label: 'PanelPage（整页）', el: React.createElement(internals.PanelPage, { interval: () => () => {} }) },
    { label: 'PanelIcon（侧边栏 glyph）', el: React.createElement(internals.PanelIcon, { size: 16, active: false }) },
  ]
  for (const t of internals.TABS) {
    cases.push({
      label: `Tab ${t.key} (${t.label})`,
      el: React.createElement(t.comp, { interval: () => () => {}, overview: null }),
    })
  }
  for (const c of cases) {
    const { html, err } = renderCase(c.label, c.el)
    if (err === null) console.log(`  ✅ ${c.label.padEnd(24)} 渲染 ${html.length} 字节`)
  }

  // 样式防回归：表格居中是被明确要求过的（数字右对齐贴在很右边，行对不上）
  console.log('\n=== 表格样式防回归 ===')
  const pageHtml = renderCase('style', React.createElement(internals.PanelPage, { interval: () => () => {} })).html
  check('.au-table th 居中', /\.au-table th \{[^}]*text-align:center/.test(pageHtml))
  check('.au-table td 居中', /\.au-table td \{[^}]*text-align:center/.test(pageHtml))
  check('首列仍左对齐（长标题好读）', pageHtml.includes('.au-table th:first-child, .au-table td:first-child { text-align:left; }'))
  check('有斑马纹', pageHtml.includes('nth-child(even)'))

  // KPI 卡片行（对齐「API 用量统计」的观感）
  console.log('\n=== KPI 卡片行 ===')
  const kpiCount = (pageHtml.match(/class="au-kpi"/g) ?? []).length
  check('渲染出 5 张 KPI 卡片', kpiCount === 5, String(kpiCount))
  check('有总 Token 卡', pageHtml.includes('总 Token'))
  check('有缓存命中率卡', pageHtml.includes('缓存命中率'))
  check('有构成条 au-stack', pageHtml.includes('au-stack'))
  check('有未命中/缓存命中/输出 图例', pageHtml.includes('未命中输入') && pageHtml.includes('缓存命中'))
  check('有时间范围按钮', pageHtml.includes('近 30 天') && pageHtml.includes('今天'))
}

console.log('\n' + (failed === 0 ? '✅ 真渲染无异常' : `❌ ${failed} 项渲染失败`))
process.exit(failed === 0 ? 0 : 1)
