# 反重力额度 / 用量 · dsh-antigravity-usage

DSH 插件：把**反重力（Antigravity）的额度与用量**做成侧边栏竖排的一行「🛰️ 反重力额度」，
点开在右侧主区域打开一个六标签专属整页。

> 已安装进 `~/.dsh/profiles/desktop`（当前 DSH 桌面端使用的 profile）。

---

## 一、设计要点：两个互相独立的数据源

这是本插件最重要的一条设计约束：**实时额度不可用时，面板必须照样能用。**

| | 来源 | 需要反重力在运行吗 | 给什么 |
|---|---|---|---|
| **A. 实时额度** | 反重力本地语言服务器的 HTTP 接口 | ✅ 需要 | 各额度桶 / 各模型的**剩余额度百分比**、重置倒计时、credits |
| **B. 离线用量** | 反重力落在磁盘上的 SQLite（只读） | ❌ **不需要** | 会话数、步数、生成次数、用过的模型、工作区、时间 |

A 失败时：额度页显示一行「反重力当前没有运行」，并灰显**最后一次成功采到的额度**；
趋势 / 热力图 / 汇总 / 重置 / 会话五个标签完全不受影响。

### A 是怎么拿到额度的（以及为什么只能拿到百分比）

反重力的 token 消耗**不落盘** —— `~/.gemini/antigravity/conversations/*.db` 里只有步数、模型 ID
和会话内容，没有任何 token 计数。真正的额度由它本地语言服务器通过 HTTP 暴露：

```
1. GET  http://127.0.0.1:<port>/   → 页面里含 window.__APP_CONFIG__.csrfToken
2. POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetUserStatus
3. POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary
   Header: x-codeium-csrf-token: <token>      ← 缺了就是 401
```

官方对这份额度的原话：*"Quota is consumed proportionally to the cost of the tokens."*
所以**消耗 ∝ token 成本**，插件用相邻采样的差值反推消耗；但要精确 token 数，接口并不提供。

端口随机分配，写在启动日志里，插件按「最新日志优先」解析：

| 形态 | 日志位置 |
|---|---|
| CLI（`agy`） | `~/.gemini/antigravity/log/cli-<ts>.log` |
| IDE | `%APPDATA%\Antigravity\logs\language_server.log` |

### B 是怎么读的

```
~/.gemini/antigravity/conversation_summaries.db   → 会话清单（标题/步数/工作区/时间）
~/.gemini/antigravity/conversations/<id>.db       → gen_metadata：模型 + 生成次数
~/.gemini/antigravity-cli/...                     → 同上（CLI 那一套）
~/.gemini/antigravity-ide/...                     → 同上（若存在）
```

用 Node 内置的 `node:sqlite`（DSH 宿主自己也在用它）以 `readOnly` 打开；
万一只读打开失败（库需要恢复等），退化成「复制到临时目录读副本」，**绝不写反重力任何目录**。
按 `mtime+size` 缓存，28 个会话约 130ms。

### token 与缓存命中：本地其实一直有，只是 protobuf 没字段名

`gen_metadata` 的 blob 是 protobuf，**不带字段名**，所以之前只看关键词是找不到 token 的。
字段号是拿 **语言服务器 `GetCascadeTrajectory` 返回的 `modelUsage`** 逐项核对出来的
（同一会话、同一步，五项全等）：

| `gen_metadata` 里的路径 | 含义 |
|---|---|
| `1.4.2` | `inputTokens` 输入 token |
| `1.4.3` | `outputTokens` 输出 token |
| `1.4.5` | **`cacheReadTokens` 缓存命中读取** |
| `1.4.9` | `thinkingOutputTokens` 思考 token |
| `1.4.10` | `responseOutputTokens` 回复 token |
| `1.9.10.1` | `estimatedTokensUsed` 估算上下文 |
| `1.9.10.4` | `maxContextTokens`（256000） |

核对样例：本地 `1.4.2=2693 / 1.4.3=110 / 1.4.9=15 / 1.4.10=95 / 1.4.5=16264`
↔ 轨迹里同一步 `inputTokens=2693 / outputTokens=110 / thinkingOutputTokens=15 /
responseOutputTokens=95 / cacheReadTokens=16264`。

**所以 token 和缓存命中全部可以离线算出来**，不需要反重力在运行 —— 这正是本插件「不依赖运行时」的关键。

实测本机：输入 23,648,148 / 输出 1,585,016（思考 575,452 + 回复 1,009,564）/
缓存命中读取 205,816,674 / **缓存命中率 89.7%**。

> 想要一份「带字段名的权威对照」时，可以临时跑
> `node scripts/probe-usage-schema.mjs`（它会调一次 `GetCascadeTrajectory`，只读）。

**⚠️ 扫描缓存必须带结构版本号（`CACHE_VERSION`）**：缓存条目按 `mtime+size` 命中，但如果新版本
往条目里加了字段（比如这次的 token），旧缓存会让新字段一律读到 `undefined` —— 表现就是
**升级后 token 全变 0**（实际踩过）。所以任何改动缓存结构的提交都必须 `CACHE_VERSION += 1`；
`test-conversations.mjs` 里有一条回归：把缓存条目里的 `v` 抹掉再扫，断言 token 仍然正确。

## 二、面板内容（六个标签）

| 标签 | 内容 | 可用性 |
|---|---|---|
| **额度** | 各分组 / 各模型剩余额度、进度条、重置倒计时、credits、账号套餐 | 需反重力运行（否则灰显上次快照） |
| **趋势** | 剩余额度随时间变化（手写 SVG 折线，24h / 7d / 30d / 全部） | ✅ 离线可用 |
| **热力图** | 近 182 天日历热力图，指标可切：会话数 / 步数 / 额度消耗 | ✅ 离线可用 |
| **汇总** | 逐月 + 逐日表：额度消耗、重置次数、会话数、步数、生成次数 | ✅ 离线可用 |
| **重置** | 各额度桶累计消耗/恢复/重置 + 重置事件列表 | ✅ 离线可用 |
| **会话** | 本地会话表（标题/工作区/模型/步数/生成/最后活动），可按工作区筛选、搜索 | ✅ 离线可用 |

## 三、HTTP 接口（宿主 → 客户端）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/antigravity-usage` | `{ status, snapshot, lastKnown }` |
| GET | `/api/antigravity-usage/history?range=24h\|7d\|30d\|all` | 额度时间序列 |
| GET | `/api/antigravity-usage/usage` | 逐日/逐月汇总 + 重置事件 |
| GET | `/api/antigravity-usage/conversations?full=1` | 离线会话用量 |
| POST | `/api/antigravity-usage/refresh` | 立即采集 + 重扫 |
| POST | `/api/antigravity-usage/diag` | 客户端自报（诊断） |

**这些路由不需要鉴权**（只有页面 `/` 是 401），可以直接
`curl http://127.0.0.1:19387/api/antigravity-usage` 自检；
`status.clientDiag` 里能看到客户端半边有没有跑起来、有没有渲染崩溃 —— 排查客户端问题时不用猜。

## 四、历史是怎么算的

官方接口只给「当前剩余额度」这一个瞬时值，所以插件自己按间隔采样，把每次读数追加成 JSONL：

```
$DSH_HOME/antigravity-usage/history.jsonl
{"t":1760000000000,"p":2810,"c":{"pa":500,"pm":50000,"fa":100,"fm":150000},
 "b":{"gemini-weekly":0.8357,"gemini-5h":1,"3p-weekly":1,"3p-5h":1}}
```

- `remainingFraction` **下降** → 记入消耗
- **上升** → 窗口滚动恢复或周期重置，记入恢复，**不计消耗**
- 上升 ≥ 5% 且间隔 < 12h 才算一次「重置」
- 间隔 < 2s 的重复采样就地合并

`last-known.json` 单独持久化最后一次成功快照，重启 DSH 后仍能灰显「上次已知额度」。

## 五、配置（环境变量，改完重启 DSH）

| 变量 | 默认 | 说明 |
|---|---|---|
| `ANTIGRAVITY_USAGE_INTERVAL_MS` | `120000` | 实时额度采样间隔 |
| `ANTIGRAVITY_USAGE_DATA_DIR` | `$DSH_HOME/antigravity-usage` | 数据目录 |
| `ANTIGRAVITY_USAGE_RETAIN_DAYS` | `180` | 历史保留天数 |
| `ANTIGRAVITY_USAGE_MAX_POINTS` | `400` | 历史接口一次最多返回的采样点数 |
| `ANTIGRAVITY_USAGE_PORT` | `0`（自动发现） | 手动指定语言服务器端口 |
| `ANTIGRAVITY_USAGE_DEEP_SCAN` | `false` | 日志发现失败时是否全端口扫描兜底 |
| `ANTIGRAVITY_USAGE_TIMEOUT_MS` | `8000` | 单次 HTTP 超时 |

离线会话扫描固定每 10 分钟一次，按会话库 mtime 增量。

## 六、目录结构

```
antigravity-usage/
├── package.json          # dsh.bundle + dsh.client 清单、meta/icon
├── cordis.patch.yml      # 插件行注册（id: antigravity-usage）
├── icon.svg
├── locale/{en,zh}.json
├── lib/
│   ├── index.js          # 宿主半边：六条路由 + 两个定时器 + lastKnown + 客户端自报通道
│   ├── collector.js      # A：端口发现 + csrf 握手 + 本地 API 采集
│   ├── history.js        # 采样落盘、消耗反推、逐日/逐月、重置事件、lastKnown
│   ├── conversations.js  # B：离线只读扫 SQLite（node:sqlite）+ token/缓存解码
│   └── client.js         # 客户端 bundle：侧边栏 glyph（sidebar.panellist）+ 专属整页（main）
├── scripts/              # 开发/测试脚本，不随插件发布
│   ├── probe.mjs              # 裸探针：直接打反重力本地 API
│   ├── probe-trajectory.mjs   # 问语言服务器要轨迹（modelUsage 的权威来源）
│   ├── probe-usage-schema.mjs # 取 modelUsage 完整字段表 + 缓存字段
│   ├── smoke.mjs              # 宿主半边六条路由冒烟（mock ctx）
│   ├── test-history.mjs       # 历史算法 + 逐日/逐月 + lastKnown
│   ├── test-conversations.mjs # 离线会话扫描 + token 解码 + 缓存版本回归
│   ├── test-client.mjs        # 客户端模块形状 + slot 注册回归
│   ├── test-render.mjs        # 用真 React 渲染 glyph / 整页 / 六标签 + 样式防回归
│   └── dev/                   # 排查 DSH 自身用的工具（asar / HMR / 槽位目录）
│       ├── asar.mjs / asarsearch.cjs / asargrep.cjs   # 读 app.asar 内部
│       ├── hmr-graph.mjs / fetch-bundle.mjs           # 读客户端插件 graph 与 bundle
│       ├── list-sidebar-slots.cjs / sidebar-css.cjs   # 槽位目录与布局 CSS
│       └── probe-tokens.mjs / probe-token-*.mjs       # 找 token 字段的排查脚本
```

## 七、开发

```powershell
cd D:\CodePackage\DSPlug\antigravity-usage
npm run check                        # node --check 五个源文件
node scripts/test-history.mjs        # 历史算法
node scripts/test-conversations.mjs  # 离线扫描
node scripts/test-client.mjs         # 客户端形状 + 注册
node scripts/test-render.mjs         # 真 React 渲染
node scripts/smoke.mjs --temp        # 宿主半边冒烟
```

**生效方式**

| 改动 | 生效方式 |
|---|---|
| `lib/client.js` | **不用重启也不用刷新** —— DSH 的 `@deepseek-ai/dsh-client-hmr` 每 500ms stat 轮询客户端 bundle（mtime/ctime/size），变化即推 SSE `/plugins/events`，页面 `entries.reload(id, rev)` 重跑 `apply` |
| `lib/*.js` 其它（宿主半边） | **必须重启 DSH** |

因为本插件没有构建步骤、`lib/client.js` 就是最终产物，那个轮询直接看得到源码改动。

## 八、踩坑记录

- **`shell.overlay` 不是弹窗容器**，是「frame-wide floating layer」，条目内联铺开、且**整层 click-through**。
  所以注册进去的组件必须：关闭时返回 `null`（否则常驻占位、把页面撑坏），打开时自己画 `position:fixed`
  遮罩，并给需要点击的元素加 `pointer-events:auto`。判定「关闭返回 null」的那一层要留在**注册的组件本身**
  里，别包在箭头函数里，否则既容易写错也没法单独调用验证（`test-render.mjs` 有回归断言）。
- **不要往 `sidebar.footer.action` 里挤**：它是不换行的横向 flex 行（`width:100%`、无 `wrap`）。
  实测它已经有 4 个条目（DSH 自带的 `cordis-panel`、`usage-vendor-stats-entry`(10)、
  `gemini-web2api-monitor-entry`(11)、以及本插件）。**排最后的那个会被挤出侧边栏、被主面板盖住 ——
  DOM 里在、`getBoundingClientRect()` 也正常，但肉眼看就是没有。** 本插件一度栽在这里。
  正解是换到 DSH 原生的竖排槽位，见下条。
- **侧边栏竖排一行 = `sidebar.panellist`（list，用 `id`）+ `main`（keyed，用 `key`）**：
  *"Global panel icons"*，DSH 侧边栏的 `PanelRow` 自己画按钮和文字、自己处理点击
  （`selectPanel(id)`），**插件只提供那个 glyph 组件，拿到 `{size, active}`**。
  点这一行会切到 `main` 里 **`key` 与 `id` 相同**的那个面板 —— 两者必须一致，否则点了没反应。
  另外 `label` 是**每次投影都重读的 thunk**，所以可以把实时百分比写进那一行的文字里。
- **客户端半边改完不用重启**：`@deepseek-ai/dsh-client-hmr` 每 500ms stat 轮询客户端 bundle
  （mtime/ctime/size），变化即推 SSE `/plugins/events`，页面 `entries.reload(id, rev)` 会**重新执行
  `apply`**（实测确认）。只有宿主半边改动才需要重启 DSH。
- **排查客户端问题的正确姿势**：`POST /api/antigravity-usage/diag` + `GET /api/antigravity-usage`
  读 `status.clientDiag`。客户端在 `apply` / 注册 / 渲染 / 渲染崩溃时自报；组件还会在挂载后用
  `getBoundingClientRect()` 把自己的真实几何量出来上报 —— 「注册了但看不见」就是这么定位的，
  不用靠猜、也不用麻烦用户截图。
- **`for HTTPS (gRPC)` 也含 `for HTTP`**：解析端口必须用 `for HTTP(?!S)`。
- **不要直接访问未 inject 的服务属性**（`ctx.timer`）：未声明会被 cordis 拒绝并抛错；
  `ctx.get('timer')` 是安全查找。
- **Windows PowerShell 5.1 按 GBK 读 UTF-8**：`ConvertFrom-Json` 校验含中文的 `package.json` 会误报，要用 Node。

## 九、验证状态

| 项 | 状态 |
|---|---|
| A 路：端口发现 + csrf + 真实额度采集 | ✅ 反重力在运行时实测通过（真实账号/套餐/4 桶/14 模型） |
| B 路：离线会话扫描 | ✅ 实测 28 会话 / 3894 步 / 1867 次生成 / 9 个模型，180ms |
| 历史：消耗反推 / 逐日逐月 / 重置事件 / lastKnown | ✅ 合成数据全项断言通过 |
| 宿主六条路由 | ✅ mock ctx 冒烟通过 |
| 客户端模块形状 + slot 注册 | ✅ 26 项断言通过（含 `main.key` 必须等于 `panellist.id`） |
| 用真 React 渲染 glyph / 整页 / 六标签 | ✅ 无异常 |
| 清单 / 图标 / locale + loader 按包名解析 | ✅ 通过 |
| **侧边栏那一行真的画出来且可见** | ✅ 在应用内量到：`{found:true, label:"反重力额度", x:14, y:184, w:252, h:36, visible}` |
| **HMR 反复 apply 不产生重复注册 / 残留** | ✅ `myEntries:1`、`rowsInDom:1`；旧 `sidebar.footer.action` 与 `shell.overlay` 条目已回收 |
| **整页的视觉细节** | ⏳ 待人工确认（用户已确认侧边栏行位置可用） |

未做视觉验证的原因：DSH Web GUI 的页面路由需要带 token 的 URL（裸请求 401），也没有另起浏览器去凑截图。
客户端是否跑起来、注册进了哪个槽位、组件有没有渲染崩溃、那一行的真实几何，全部由
`POST /api/antigravity-usage/diag` + `GET /api/antigravity-usage` 的 `status.clientDiag` 自报
（见第三节）—— 排「注册了但看不见」这类问题时不用猜、也不用麻烦用户截图。
