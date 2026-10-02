// 连上 DSH 的 /plugins/events SSE，读第一帧 graph，并回取本插件的 bundle 内容。
// 用来确认宿主是否已经把改动后的 rev 推给了页面（即客户端 HMR 是否生效）。
// 用法: node scripts/hmr-graph.mjs [port]
const port = Number(process.argv[2] ?? 19387)
const PLUGIN_ID = '@dsh-external/antigravity-usage'

const ac = new AbortController()
const timer = setTimeout(() => ac.abort(), 12000)

let text = ''
try {
  const res = await fetch(`http://127.0.0.1:${port}/plugins/events`, {
    headers: { accept: 'text/event-stream' },
    signal: ac.signal,
  })
  console.log('SSE status =', res.status)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text += dec.decode(value, { stream: true })
    if (text.includes('\n\n') && text.length > 64) break
  }
  try { await reader.cancel() } catch {}
} catch (e) {
  if (e.name !== 'AbortError') console.log('SSE 读取结束:', e.message)
} finally {
  clearTimeout(timer)
}

const m = text.match(/^data: (.*)$/m)
if (m === null) {
  console.log('没有拿到 data 帧。原始前 400 字符:')
  console.log(text.slice(0, 400))
  process.exit(1)
}

const frame = JSON.parse(m[1])
console.log('frame.type =', frame.type)
const graph = frame.graph ?? {}
const entries = graph.entries ?? graph.modules ?? []
console.log('graph 里的条目数 =', entries.length)

const mine = entries.find((e) => e.id === PLUGIN_ID)
if (mine === undefined) {
  console.log('\n❌ graph 里没有本插件。所有 id：')
  for (const e of entries) console.log('   ', e.id)
  process.exit(2)
}

console.log('\n✅ 本插件在 graph 里：')
console.log(JSON.stringify(mine, null, 2).slice(0, 900))

// 回取 bundle 内容
const url = mine.url ?? mine.href ?? null
const paths = [
  url,
  `/plugins/${PLUGIN_ID}/client.js`,
  `/plugins/??${PLUGIN_ID}/client.js&rev=${mine.rev ?? ''}`,
].filter((p) => typeof p === 'string' && p !== '')

for (const p of paths) {
  const full = p.startsWith('http') ? p : `http://127.0.0.1:${port}${p.startsWith('/') ? '' : '/'}${p}`
  try {
    const r = await fetch(full, { signal: AbortSignal.timeout(8000) })
    const body = await r.text()
    console.log(
      `\n${r.status}  len=${body.length}  newCode=${body.includes('GuardedOverlay') ? 'Y' : 'n'}  ` +
      `oldFlatBug=${body.includes('shell.overlay') && !body.includes('GuardedOverlay') ? 'Y' : 'n'}\n  ${p}`,
    )
    if (r.status === 200 && body.includes('GuardedOverlay')) {
      console.log('\n🎉 宿主对外提供的正是修好的版本（含 GuardedOverlay）')
      break
    }
  } catch (e) {
    console.log(`ERR ${p} -> ${e.message}`)
  }
}
