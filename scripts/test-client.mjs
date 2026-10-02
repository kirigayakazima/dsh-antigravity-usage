// antigravity-usage — 客户端 bundle 形状与 slot 注册检查（开发用）。
//
// 只验证「模块形状 + slot 注册」这一层，不渲染组件、不模拟 DOM：
//   - bundle 用 __ModuleLoader__.load 注册，id 等于 package name
//   - factory 返回的对象有 inject / apply
//   - apply(ctx) 会注册
//       sidebar.panellist  { id: 'antigravity-usage' }   ← 竖排的侧边栏行（list 槽位用 id）
//       main               { key: 'antigravity-usage' }   ← 右侧专属整页（keyed 槽位用 key）
//     两者标识必须一致 —— 侧边栏点那一行会 selectPanel(id)，切到的就是 main 里 key 相同的面板。
//
// 用法: node scripts/test-client.mjs
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

let failed = 0
function check(label, ok, extra) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || extra === undefined ? '' : '  → ' + extra}`)
  if (!ok) failed += 1
}

const ReactStub = {
  Fragment: Symbol('Fragment'),
  Component: class Component { constructor(p) { this.props = p } },
  createElement: (type, props, ...children) => ({ __el: true, type, props, children }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useMemo: (f) => f(),
}

let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (o) => { captured = o } } },
  console,
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  AbortSignal,
  URL,
}
sandbox.globalThis = sandbox

runInContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), createContext(sandbox), { filename: 'lib/client.js' })

console.log('=== 模块形状 ===')
check('调用了 __ModuleLoader__.load', captured !== null && typeof captured === 'object')
check(`id 等于 package name (${pkg.name})`, captured !== null && captured.id === pkg.name, captured && captured.id)
check('factory 是函数', captured !== null && typeof captured.factory === 'function')

const exportsObj = captured.factory((name) => {
  if (name === 'react') return ReactStub
  throw new Error('unexpected require: ' + name)
})

check('factory 返回对象', exportsObj !== null && typeof exportsObj === 'object')
check("inject 为 ['slots']", Array.isArray(exportsObj.inject) && exportsObj.inject.length === 1 && exportsObj.inject[0] === 'slots', JSON.stringify(exportsObj.inject))
check('apply 是函数', typeof exportsObj.apply === 'function')

// ---- 假的 slots 服务 ----
const injects = []
const registrations = []
const fakeSlots = {
  inject(ownerKey, cb) {
    injects.push(ownerKey)
    let r
    try {
      r = cb()
    } catch (e) {
      check(`slots.inject(${ownerKey}) 回调不抛异常`, false, e.message)
      return () => {}
    }
    // 生成器形式：驱动到底（官方 plugin-manager 就用 function* + yield register）
    if (r !== null && r !== undefined && typeof r.next === 'function') {
      let step = r.next()
      while (step.done !== true) step = r.next()
    }
    return () => {}
  },
  register(meta, component) {
    registrations.push({ meta, component })
    return () => {}
  },
}

console.log('\n=== slot 注册 ===')
let threw = null
let dispose = null
try {
  dispose = exportsObj.apply({ slots: fakeSlots, get: () => undefined })
} catch (e) {
  threw = e
}
check('apply 未抛异常', threw === null, threw && threw.message)
check('调用了 slots.inject 两次', injects.length === 2, JSON.stringify(injects))
check('ownerKey = sidebar.panellist', injects[0] === 'sidebar.panellist', injects[0])
check('ownerKey = main', injects[1] === 'main', injects[1])
check('注册了两项', registrations.length === 2, String(registrations.length))

const bySlot = new Map(registrations.map((r) => [r.meta.name, r]))

const pan = bySlot.get('sidebar.panellist')
check('注册了 sidebar.panellist', pan !== undefined)
if (pan !== undefined) {
  check('panellist id = antigravity-usage', pan.meta.id === 'antigravity-usage', String(pan.meta.id))
  check('panellist order 是数字', typeof pan.meta.order === 'number', String(pan.meta.order))
  check('panellist label 是函数（thunk，可带实时百分比）', typeof pan.meta.label === 'function')
  check('panellist label() 返回字符串', typeof pan.meta.label() === 'string', pan.meta.label())
  check('panellist 有组件', typeof pan.component === 'function')
}

const main = bySlot.get('main')
check('注册了 main', main !== undefined)
if (main !== undefined) {
  check('main key = antigravity-usage', main.meta.key === 'antigravity-usage', String(main.meta.key))
  check('main 有组件', typeof main.component === 'function')
  check('main.key 与 panellist.id 一致（否则点侧边栏切不过去）', main.meta.key === pan.meta.id)
}

check('不再占用挤爆的 sidebar.footer.action', bySlot.has('sidebar.footer.action') === false)
check('不再注册 shell.overlay（改用整页）', bySlot.has('shell.overlay') === false)
check('apply 返回 disposer 函数', typeof dispose === 'function')

console.log('\n=== 组件可渲染性 ===')
if (pan !== undefined) {
  let el = null
  let err = null
  try {
    el = pan.component({ size: 16, active: false })
  } catch (e) {
    err = e
  }
  check('侧边栏 glyph 组件不抛异常', err === null, err && err.message)
  check('侧边栏 glyph 渲染出元素', el !== null && el !== undefined, String(el))
}
if (main !== undefined) {
  let el = null
  let err = null
  try {
    el = main.component()
  } catch (e) {
    err = e
  }
  check('main 页面组件不抛异常', err === null, err && err.message)
  check('main 页面渲染出元素', el !== null && el !== undefined, String(el))
}

console.log('\n=== 缺少 slots 时的降级 ===')
let degraded = null
const realWarn = console.warn
console.warn = () => {}
try {
  exportsObj.apply({})
} catch (e) {
  degraded = e
} finally {
  console.warn = realWarn
}
check('slots 缺失时不抛异常', degraded === null, degraded && degraded.message)

console.log('\n=== 调试入口 ===')
const internals = exportsObj.__internals
check('有 __internals', internals !== undefined)
check('__internals 有 PanelPage / PanelIcon / TABS',
  internals !== undefined &&
  typeof internals.PanelPage === 'function' &&
  typeof internals.PanelIcon === 'function' &&
  Array.isArray(internals.TABS))

console.log(failed === 0
  ? '\n✅ 模块形状与注册检查通过（视觉验证需在连着的 Harness 页面里做）'
  : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
