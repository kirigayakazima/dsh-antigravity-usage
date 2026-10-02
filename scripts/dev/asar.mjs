// 极简 asar 解析器（开发用）：列出 / 提取 app.asar 内的文件。
// 用法:
//   node scripts/asar.mjs list <asar> [子串过滤]
//   node scripts/asar.mjs cat  <asar> <内部路径>
import { openSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs'

function readHeader(asar) {
  const fd = openSync(asar, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const jsonSize = head.readUInt32LE(8)
  const buf = Buffer.alloc(headerSize)
  readSync(fd, buf, 0, headerSize, 8)
  closeSync(fd)
  const json = buf.subarray(0, jsonSize).toString('utf8')
  return { header: JSON.parse(json), base: 8 + headerSize }
}

function walk(node, prefix, out) {
  if (node.files === undefined) {
    out.push({ path: prefix, size: node.size, offset: node.offset })
    return
  }
  for (const name of Object.keys(node.files)) {
    walk(node.files[name], prefix === '' ? name : prefix + '/' + name, out)
  }
}

const [, , cmd, asar, arg] = process.argv
const { header, base } = readHeader(asar)
const out = []
walk(header, '', out)

if (cmd === 'list') {
  const filter = arg === undefined ? '' : arg
  const hits = out.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()))
  console.log(`共 ${out.length} 个文件，匹配 "${filter}" 的 ${hits.length} 个：`)
  for (const h of hits.slice(0, 400)) console.log('  ' + h.path + '  (' + h.size + 'b)')
} else if (cmd === 'cat') {
  const f = out.find((x) => x.path === arg)
  if (f === undefined) {
    console.error('not found: ' + arg)
    process.exit(1)
  }
  const fd = openSync(asar, 'r')
  const buf = Buffer.alloc(f.size)
  readSync(fd, buf, 0, f.size, base + Number(f.offset))
  closeSync(fd)
  process.stdout.write(buf.toString('utf8'))
} else {
  console.error('usage: node scripts/asar.mjs list|cat <asar> [arg]')
  process.exit(2)
}
