// 运行中 profile 的改名迁移：把 @dsh-external/* 的引用统一改成 dsh-*（开发用，一次性）
//   node scripts/dev/rename-profile.mjs
// 动的文件：package.json / cordis.patch.yml / pnpm-lock.yaml / node_modules/.package-map.json
// 以及 node_modules 里的两个符号链接。改名前先备份。
import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync, rmdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const P = 'C:/Users/xuaner/.dsh/profiles/desktop'
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
const PAIRS = [
  ['@dsh-external/antigravity-usage', 'dsh-antigravity-usage'],
  ['@dsh-external/gemini-web2api-monitor', 'dsh-gemini-web2api-monitor'],
]

let bad = 0
function check(label, ok, extra) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || extra === undefined ? '' : '  → ' + extra}`)
  if (!ok) bad += 1
}

console.log(`=== 备份（后缀 -rename-${STAMP}）===`)
const targets = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'node_modules/.package-map.json']
for (const rel of targets) {
  const p = join(P, rel)
  if (!existsSync(p)) {
    console.log(`  跳过（不存在）: ${rel}`)
    continue
  }
  copyFileSync(p, `${p}.bak-rename-${STAMP}`)
  console.log(`  已备份 ${rel}`)
}

console.log('\n=== 文本替换 ===')
for (const rel of targets) {
  const p = join(P, rel)
  if (!existsSync(p)) continue
  const before = readFileSync(p, 'utf8')
  let after = before
  for (const [from, to] of PAIRS) {
    const n = after.split(from).length - 1
    if (n > 0) console.log(`  ${rel}: ${from} → ${to}  ×${n}`)
    after = after.split(from).join(to)
  }
  if (after !== before) writeFileSync(p, after, 'utf8')
}

console.log('\n=== 移动符号链接 ===')
const nm = join(P, 'node_modules')
for (const [, to] of PAIRS) {
  const oldPath = join(nm, '@dsh-external', to.replace(/^dsh-/, ''))
  const newPath = join(nm, to)
  if (existsSync(newPath) && !existsSync(oldPath)) {
    console.log(`  已在位: ${to}`)
    continue
  }
  if (!existsSync(oldPath)) {
    console.log(`  跳过（旧链接不存在）: ${oldPath}`)
    continue
  }
  renameSync(oldPath, newPath)
  console.log(`  ${oldPath}  →  ${newPath}`)
}
const scope = join(nm, '@dsh-external')
if (existsSync(scope) && readdirSync(scope).length === 0) {
  rmdirSync(scope)
  console.log('  已删除空目录 @dsh-external')
} else if (existsSync(scope)) {
  console.log(`  @dsh-external 仍有内容，保留: ${readdirSync(scope).join(', ')}`)
}

console.log('\n=== 迁移后自检 ===')
const pkg = JSON.parse(readFileSync(join(P, 'package.json'), 'utf8'))
const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
check('package.json 无 @dsh-external 残留', !readFileSync(join(P, 'package.json'), 'utf8').includes('@dsh-external'))
check('cordis.patch.yml 无残留', !readFileSync(join(P, 'cordis.patch.yml'), 'utf8').includes('@dsh-external'))
check('pnpm-lock.yaml 无残留', !readFileSync(join(P, 'pnpm-lock.yaml'), 'utf8').includes('@dsh-external'))
check('.package-map.json 无残留', !readFileSync(join(P, 'node_modules/.package-map.json'), 'utf8').includes('@dsh-external'))
check('bundles 含 dsh-antigravity-usage', bundles.includes('dsh-antigravity-usage'), JSON.stringify(bundles))
check('bundles 含 dsh-gemini-web2api-monitor', bundles.includes('dsh-gemini-web2api-monitor'))
check('node_modules/dsh-antigravity-usage 存在', existsSync(join(nm, 'dsh-antigravity-usage')))
check('node_modules/dsh-gemini-web2api-monitor 存在', existsSync(join(nm, 'dsh-gemini-web2api-monitor')))
check('node_modules/@dsh-external 已消失', !existsSync(join(nm, '@dsh-external')))

console.log(bad === 0 ? '\n✅ profile 改名完成' : `\n❌ ${bad} 项自检失败`)
process.exit(bad === 0 ? 0 : 1)
