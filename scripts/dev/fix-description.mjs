// 修正两个 package.json 里被「UTF-8 当 GBK 读再存」损坏的 description（开发用）
//   node scripts/dev/fix-description.mjs
// usage 的原文取自 npm 注册表（线上是干净的，权威来源）；
// gemini 从未正确发布过，用反向解码抢救 + 补回两个丢失的字节。
import { readFileSync, writeFileSync } from 'node:fs'

const GEMINI_DIR = 'D:/CodePackage/DSPlug/gemini-web2api-monitor'
const USAGE_DIR = 'D:/CodePackage/DSPlug/usage'

// 反向解码抢救回来的原文，补回被换成 '?' 的两个字：
//   读上?slot39  → 读上游 slot39
//   定时检?      → 定时检测
const GEMINI_FIXED = '监控 gemini-web2api 反代服务的模型降级状态（读上游 slot39 权威字段，定时检测 + 状态展示）'

function patch(dir, desc, note) {
  const p = dir + '/package.json'
  const raw = readFileSync(p, 'utf8')
  JSON.parse(raw) // 先确认 JSON 合法
  const before = (raw.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1]
  if (before === desc) {
    console.log(`  已是正确文案，跳过: ${p}`)
    return false
  }
  // 外科式只替换 description 的值，避免整个文件被重新格式化
  const re = /("description"\s*:\s*")((?:[^"\\]|\\.)*)(")/
  if (!re.test(raw)) {
    console.log(`  ⚠️ 找不到 description 字段: ${p}`)
    return false
  }
  const escaped = desc.replace(/(["\\])/g, '\\$1')
  const out = raw.replace(re, `$1${escaped}$3`)
  JSON.parse(out) // 替换后再确认一次仍然合法
  writeFileSync(p, out, 'utf8')
  console.log(`  [${note}] ${dir.split('/').pop()}`)
  console.log(`     修复前: ${before}`)
  console.log(`     修复后: ${desc}`)
  return true
}

async function main() {
  // usage 的权威原文 = 线上注册表里那份（本地已被损坏，但线上是好的）
  const packument = await fetch('https://registry.npmjs.org/dsh-usage-vendor-stats').then((r) => r.json())
  const USAGE_SOURCE = packument.description
  if (typeof USAGE_SOURCE !== 'string' || USAGE_SOURCE.length < 10) {
    console.error('  取不到 npm 上的原文，中止')
    process.exit(1)
  }

  console.log('=== 修复 description ===')
  patch(GEMINI_DIR, GEMINI_FIXED, '反向解码 + 补字')
  patch(USAGE_DIR, USAGE_SOURCE, '取自 npm 注册表')

  console.log('\n=== 复核：重新读取并验证 ===')
  for (const dir of [GEMINI_DIR, USAGE_DIR]) {
    const j = JSON.parse(readFileSync(dir + '/package.json', 'utf8'))
    console.log(`  ${j.name}`)
    console.log(`     JSON 合法 ✅   description = ${j.description}`)
  }
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
