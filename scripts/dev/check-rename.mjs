// 改名一致性核对（开发用）：包名 / patch name / 客户端 load id 三者必须完全相同
//   node scripts/dev/check-rename.mjs
import { readFileSync } from 'node:fs'

const PROJECTS = ['D:/CodePackage/DSPlug/antigravity-usage', 'D:/CodePackage/DSPlug/gemini-web2api-monitor']
const OLD = '@dsh-external/'
let bad = 0

function check(label, ok, extra) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || extra === undefined ? '' : '  → ' + extra}`)
  if (!ok) bad += 1
}

for (const dir of PROJECTS) {
  const dirName = dir.split('/').pop()
  const expected = 'dsh-' + dirName // 目录名 + 前缀 = 新包名
  console.log(`\n=== ${dirName}（期望包名 ${expected}）===`)
  const pkg = JSON.parse(readFileSync(dir + '/package.json', 'utf8'))
  const patch = readFileSync(dir + '/cordis.patch.yml', 'utf8')
  const client = readFileSync(dir + '/lib/client.js', 'utf8')

  const patchName = (patch.match(/^\s*name:\s*"?([^"\n]+)"?\s*$/m) || [])[1]
  const clientId = (client.match(/__ModuleLoader__\.load\(\{\s*id:\s*["']([^"']+)/) || [])[1]

  check('package.json name', pkg.name === expected, pkg.name)
  check('cordis.patch.yml name', patchName === expected, patchName)
  check('客户端 load id', clientId === expected, clientId)
  check('三者完全一致', pkg.name === patchName && patchName === clientId)
  check('没有 @dsh-external 残留', !JSON.stringify([pkg.name, patch, client]).includes(OLD))

  const repo = pkg.repository && pkg.repository.url
  const repoName = repo === undefined ? '' : repo.replace(/.*github\.com\//, '').replace(/\.git$/, '').split('/')[1]
  check('repository 与包名一致', repoName === expected, repoName)
}
console.log(bad === 0 ? '\n✅ 改名一致' : `\n❌ ${bad} 项不一致`)
process.exit(bad === 0 ? 0 : 1)
