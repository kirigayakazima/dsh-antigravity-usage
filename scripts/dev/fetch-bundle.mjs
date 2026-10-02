// 从本地 DSH 服务器取回插件 bundle，确认对外提供的是哪一版（开发用）。
// 用法: node scripts/fetch-bundle.mjs [port]
const port = Number(process.argv[2] ?? 19387)
const id = 'dsh-antigravity-usage'

const candidates = [
  `/plugins/??${id}/client.js&rev=0`,
  `/plugins/??${encodeURIComponent(id)}/client.js&rev=0`,
  `/plugins/${id}/client.js`,
  `/plugins/??${id}/client.js`,
  `/plugins`,
]

for (const path of candidates) {
  const url = `http://127.0.0.1:${port}${path}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const text = await res.text()
    const hasFix = text.includes('GuardedOverlay')
    const hasOldBug = text.includes('au-mask') && !hasFix
    const hasMarker = text.includes('antigravity-usage')
    console.log(
      `${String(res.status).padEnd(4)} len=${String(text.length).padEnd(8)} ` +
      `plugin=${hasMarker ? 'Y' : 'n'} newCode=${hasFix ? 'Y' : 'n'} oldCode=${hasOldBug ? 'Y' : 'n'}  ${path}`,
    )
    if (res.status === 200 && hasFix) {
      console.log('\n✅ 服务器正在提供修好的版本（含 GuardedOverlay）')
      break
    }
  } catch (e) {
    console.log(`ERR  ${path}  -> ${e.message}`)
  }
}
