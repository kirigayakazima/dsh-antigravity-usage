# 找出被「UTF-8 被当 GBK 读再存成 UTF-8」损坏的文本（开发用，只读）
# 判别：把字符串按 GBK 编码回字节、再按 UTF-8 解码 ——
#   · 若原串是乱码 → 反解得到干净中文
#   · 若原串本就正常 → 反解得到乱码
# 用法: powershell -File scripts/dev/find-mojibake.ps1
param([switch]$Write)

$utf8 = New-Object System.Text.UTF8Encoding($false)
$gbk  = [System.Text.Encoding]::GetEncoding(936)

# 自然中文的常见词，乱码里几乎不会连续出现
$words = @('服务','状态','监控','插件','统计','会话','使用','检测','支持','数据','管理','配置','显示','输入','输出','时间','进行','可以','一个','没有','需要')

$roots = @(
  'D:\CodePackage\DSPlug\antigravity-usage',
  'D:\CodePackage\DSPlug\gemini-web2api-monitor',
  'D:\CodePackage\DSPlug\usage'
)

function Test-Mojibake([string]$s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return $false }
  if ($s -notmatch '[一-鿿]') { return $false }      # 必须含 CJK
  try { $b = $gbk.GetBytes($s) } catch { return $false }
  $back = [System.Text.Encoding]::UTF8.GetString($b)
  if ($back -eq $s) { return $false }
  # 不检查 FFFD：反解出替换符恰恰是「原始字节已部分丢失」的特征，
  # 这类残缺乱码（句末出现 '?'）正是要抓的对象，挡掉会大量漏判。
  # 判据只看下面的自然中文词命中数。
  # 反解结果里出现自然中文词 → 判为乱码
  $hit = 0
  foreach ($w in $words) { if ($back.Contains($w)) { $hit++ } }
  if ($hit -lt 2) { return $false }
  # 原串自己也该有中文词才可能是「反过来」的情况；没有就更确定是乱码
  $origHit = 0
  foreach ($w in $words) { if ($s.Contains($w)) { $origHit++ } }
  return ($origHit -lt $hit)
}

function Repair([string]$s) {
  $b = $gbk.GetBytes($s)
  return [System.Text.Encoding]::UTF8.GetString($b)
}

$exts = '.json','.md','.yml','.yaml','.js','.ts','.mjs','.cjs','.txt'
$total = 0
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  $files = Get-ChildItem $root -Recurse -File -Include ($exts | ForEach-Object { '*' + $_ }) -ErrorAction SilentlyContinue |
           Where-Object { $_.FullName -notmatch '\\node_modules\\|\\\.git\\|\\\.npm-cache\\|\\\.tmp\\' }
  $found = @()
  foreach ($f in $files) {
    $raw = [System.IO.File]::ReadAllText($f.FullName, $utf8)
    $lines = $raw -split "`r?`n"
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if (Test-Mojibake $lines[$i]) {
        $found += [pscustomobject]@{
          File = $f.FullName.Substring($root.Length + 1)
          Line = $i + 1
          Text = $lines[$i].Trim()
        }
      }
    }
  }
  if ($found.Count -gt 0) {
    "`n=== $($root.Substring($root.LastIndexOf('\') + 1)) ==="
    foreach ($x in $found) {
      $total++
      "  $($x.File):$($x.Line)"
      "     乱码 : $($x.Text)"
      "     修复 : $(Repair $x.Text)"
      if ($Write) {
        $p = Join-Path $root $x.File
        $raw = [System.IO.File]::ReadAllText($p, $utf8)
        $pat = [regex]::Escape($x.Text)
        $rep = (Repair $x.Text).Replace('$', '$$')   # 转义替换串里的 $
        $new = [regex]::Replace($raw, $pat, $rep)
        if ($new -ne $raw) {
          [System.IO.File]::WriteAllText($p, $new, $utf8)
          "     [已写入]"
        }
      }
    }
  } else {
    "`n=== $root ===`n  (未发现)"
  }
}
"`n共发现 $total 处"
if ($total -gt 0 -and -not $Write) { "（加 -Write 参数才实际写入）" }
