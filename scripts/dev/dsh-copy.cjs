// 把 app.asar 内的文件复制到磁盘（Electron asar 支持）：
//   $env:ELECTRON_RUN_AS_NODE=1
//   & "<exe>" scripts\dev\dsh-copy.cjs <asar内路径> <输出路径>
const fs = require('node:fs')
fs.copyFileSync(process.argv[2], process.argv[3])
console.log('已写出 ' + process.argv[3] + ' (' + fs.statSync(process.argv[3]).size + ' 字节)')
