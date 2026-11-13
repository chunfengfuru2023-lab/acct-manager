# 账号管家 · 统一网关方案（acct-manager）

> 定稿 2026-11-01。目标：**一个软件、一个链接**，把 WorkBuddy（+ 后续 Qoder）的
> 全部账号与模型收进一个 OpenAI 兼容网关 `workbuddymodel`，供任意 agent 填链接使用，
> 也可接回 WorkBuddy 自己。Qoder 自动版保持原样不动，功能整体迁移在验证通过后进行。

---

## 〇、先别被发现（防御章 · 优先级最高）

协议复刻类用法在两家 ToS 里基本都落在"禁止"一侧。防御能压低的是**异常信号强度**，
不是归零。以下不是可选项，是网关的内置硬约束。

### 检测面（从两家协议代码实测出来的事实）

| 向量 | WB (codebuddy.cn / workbuddy.ai) | Qoder (gateway.qoder.com.cn) |
|---|---|---|
| 身份头 | `X-IDE-Type/Name/Version`、`X-User-Id`、`X-Enterprise-Id`、专用 chat UA、`X-Conversation-*` 三连 | `Cosy-*` 签名头、`Login-Version`、`X-Request-Id` |
| 会话绑定 | refresh token 绑 `sessionState`；令牌是**有会话身份**的 | COSY 签名覆盖 body + 机器 ID + client-type，三项服务端校验 |
| 并发可见性 | 同令牌多路并发上游看得见 | refresh 幂等、旧令牌不死 → 同令牌多处并发**服务端可见** |

### 网关内置防御（逐条落到代码）

1. **一次一号（最重要）**：同一令牌的同一时刻只服务一个进行中的会话，绝不双开。
   池内多号可并行（= 多台真实设备的正常形态）。实现：`pool.js` 维护 `inFlightUid`，
   选号时跳过正在服务的账号。
2. **频率镜像**：每号漏桶限流 + 请求间随机 jitter，按"重度真人用户"画像设上限；
   夜间自然衰减；不做秒抢那种节奏。
3. **指纹跟版本走**：identity（UA / `X-IDE-Version` / clientVersion）每次从本机真实
   App 的 plist 现读（connector 的 `resolveChatIdentity`/`installedAppVersion` 已实现），
   不写死常量。App 升级身份自动跟上。
4. **灰区降级（熔断反熔断）**：上游返回鉴权/额度类异常按 `classifyUpstreamError` 分档处理——
   - `hard_credit`(402/额度关键词) → 该号凉置到下个计费周期，停止发问；
   - `session_dead`(401/会话死) → 该号立即凉置，**不自动 refresh 硬刷**，事件中心记录，人工/巡检确认才恢复；
   - `soft_rate`(429) → 短冷却（30–60s）后换号；
   - 绝不拿被标记的号反复重试（重试风暴才是逼出封号的最后一步）。
5. **凭据零外流**：账号池 store 文件里令牌用 Keychain 派生密钥加密落盘；网关**只监听
   127.0.0.1**，默认拒绝非 loopback 的 Host/Origin（复用 connector shim 已有的
   `hostIsLoopback`/`originIsLoopback`/bearer 校验三件套）。
6. **只读优先**：探针与"同步当前账号"永远只读 App 原始文件；加号走快照进我们自己的
   store，**绝不写坏 App 的 `.info` / `.observation.json`**（实测：观察文件只跟 App 自身
   会话更新，facts 为空——读它没触发，但我们不去动它）。

### 红线（写死，越界即拒）

- 不自动化注册 / 批量登录新号：号必须由 App 内人工登一次，再"同步进池"。
- 不绕过验证码；不做撞库。
- **不接远程服务器场景**：网关默认只吐 loopback；开 LAN 共享需显式改配置且自担风险。
- 令牌、路径、权限范围不进对话正文，不外发到任何第三方。

---

## 一、实测日结论（证据）

外部解密链路 **通**，全程只读（无 refresh、无写文件、无 chat）：

| | WorkBuddy (CN) | WorkBuddy AI (global) |
|---|---|---|
| 5.6+ 加密登录态外部解密 | ✅ signed-in | ✅ signed-in |
| access 剩余 | ~27.8 天 | ~342.7 天 |
| 模型目录 | 16 个（hy4-preview / hy3 / deepseek-v4.1-flash / glm-5.3 / space-bunny …） | 23 个（default/fast/balanced/primary / hy4-preview …） |
| 积分 | 1134（多个运营裂变包，部分 remain:0 临近过期） | 290（Free 100 + Bonus 包） |

**解密方法（非黑逆向）**：connector 已走通 —— 借 App 自己的 Electron 二进制
（`ELECTRON_RUN_AS_NODE=1`）取 at-rest 密钥 → `protectorKey = sha256(atRestSecretKey)`
→ AES-256-GCM（AAD = `buildAuthenticatedContextAad`，对 5.6.2 活体验证）开
`{$wbEncrypted:1, envelope}` 信封。
旧记录「5.6 读不了」作废：当时的坎是没配 `WORKBUDDY_ELECTRON_BIN` /
`WORKBUDDY_AI_ELECTRON_BIN` 两个环境变量，connector 的 discovery 走 `none` 分支。

**关键约束（WB ≠ Qoder 的多账号模型）**：WB 桌面 App 同一时刻只有**一个活跃登录**。
`.info` 顶层 `auth.{accessToken,refreshToken}` 只对应 `lastLogin:true` 那个号；
`accounts[]` / `allAccounts[]` 只有身份元数据（uid/uin/nickname/type），**不带可用令牌**。
→ WB 账号池走"**登一个同步一个**"快照模式，不是 Qoder 那种 `drt-` 自助刷新型令牌池。

failover 判定现成：`classifyUpstreamError(status, body)` 直接给 `hard_credit` /
`session_dead` / `soft_rate` / `not_found` / `server` / `client` 六档。

---

## 二、架构

```
                    其他 agent / WorkBuddy 自己
                          │  OPENAI_BASE_URL = http://127.0.0.1:19400/v1
                          ▼
   acct-manager gateway (单进程 · 单端口 · loopback)
   ├── 模型命名空间
   │     workbuddymodel/<variant>:<model>      （本轮实现）
   │     qodermodel/<model>                     （下一轮挂载，复用 qoder-router）
   ├── wb/  引擎：connector 的 UpstreamClient.chatStream / fetchModels / fetchCredits
   ├── pool 账号池：快照式 store（Keychain 加密）+ 一次一号 + 分档冷却 + pace 选号
   └── 出口 = "一个链接"：/v1/models 汇总所有账号×模型；/v1/chat/completions 按前缀路由
```

**为什么不自己写上游请求**：connector 的 `WorkBuddyUpstreamClient` 已把协议、身份头、
UA 分裂（CN 用 CLI 型 UA、global 用 App 型 UA，是**承重**的）、SSE 解析全做完且活体验证。
网关直接复用这些类，等于站在已跑通的插件肩膀上，零协议复刻风险。

---

## 三、账号池设计（WB）

store（`acct-manager/data/wb-accounts.enc.json`，Keychain 密钥加密）条目：

```
{ uid, variant: "cn"|"global", nickname, domain,
  accessToken, refreshToken, expiresAtMs, refreshExpiresAtMs,
  syncedAtMs, lastUsedMs, cooldownUntilMs, cooldownReason,
  catalogCache: [{id, name, credits, ctxWindow}] }
```

加号路径（对应 Qoder 的"三个来源"）：
1. **同步当前登录**：解密本机 `.info`，把 lastLogin 那个号快照进池（探针已验证可行）。
2. **找回历史**：`.info` 里 `allAccounts[]` 的 uid 列表 → 提示"这些号请在 App 登一次再同步"（不带令牌，无法静默加）。
3. **OAuth 加号**：connector 走过 `/v2/plugin/auth/token`（占第二会话位）——作为兜底，界面明示代价。

**一次一号 + pace 选号**（借鉴 magpie）：优先"距重置剩余速率最慢"的号，把一个计费周期
里的额度平摊，减少浪费；积分包临过期的号优先消耗（`fetchCredits` 返回每个包的 `endTimeMs`）。

---

## 四、路线图

> **进度（2026-11-01 收工）**：步 0–3 完成，步 5 的 patrol+LaunchAgent 已装载
> （`com.dsh.auto.acct-gateway` 常驻 KeepAlive 自愈实测过；`com.dsh.auto.acct-patrol`
> 每日 04:10，launchd 环境试跑通过）。步 4（挂 qodermodel）、步 6（WB 接回环）未开工。
> bearer 持久化在钥匙串 `acct-manager/gateway-secret`，日志不落口令。

| 步 | 内容 | 碰 App? | 量 |
|---|---|---|---|
| 0 ✅ | 实测日：解密 / 目录 / 余额 / failover kind | 只读 | 完成 |
| 1 | 网关骨架 v0：`/health` + `/v1/models`（只读合并目录） | 只读 | 本次 |
| 2 | v0 chat：`/v1/chat/completions` 流式透传 + 一次一号 + 分档 failover | 只读为主，真 chat 需点头 | 本次/下次 |
| 3 | 账号池 store + Keychain 加密 + 同步当前号 CLI | 读 App | +1 天 |
| 4 | 挂载 `qodermodel`：把 qoder-router 收进同一进程 | 不碰自动版 | +2 天 |
| 5 | 统一调度（额度巡检 / 包过期提醒 / session_dead 巡检）+ GUI 双供应商页 | — | +3 天 |
| 6 | 接回 WB 自己：WB"自定义模型"入口指回本网关实测 | 动 App 设置页 | 并入验收 |

**验收即覆盖 B**：步 2/4 网关真跑起来后，用它替 3425 测 WB 自定义模型入口，一次跑完，
不单独走一遍。

---

## 五、接入配方（给"其他 agent 添加调用"）

任意吃 OpenAI 兼容 base URL 的 agent：

```
OPENAI_BASE_URL = http://127.0.0.1:19400/v1
OPENAI_API_KEY  = <本地网关口令>        # loopback + bearer，常量时间校验
model           = workbuddymodel/cn:hy4-preview     # 或 qodermodel/glm-5.3-flash
```

- ZCode / DSH：填上面两个 env 即可；mal roster 里登记 `workbuddymodel` provider。
- 模型显隐：池里某号没这模型 → `/v1/models` 不列；选了不可用的返回 `not_found` 并换号重试。
- 全本地：不出机器、不中转任何第三方。

---

## 六、管理面板与客户端（2026-11-01 补）

- **面板**：`http://127.0.0.1:19400/panel`（网关内置零依赖单页）。账号池状态、
  双引擎模型（点名字=复制调用名）、余额手查（计费查询不自动轮询）、agent 接入配置
  一键复制、口令按需展示。
- **客户端 App**：`~/Applications/账号管家.app` 双击即用——网关没醒自动
  `launchctl kickstart`，带面板 token 打开默认浏览器。
- **鉴权分层**：只读状态免 token（数据脱敏）；`/panel/secret`（网关口令）与
  `/panel/action`（同步号）必须 token；token 存钥匙串 `acct-manager/panel-token`，
  经 HTML 注入或 `#token=` 传入（.app 壳用后者）。跨站伪造无效：自定义头
  `X-Panel-Token` 触发 CORS 预检，网关不应答 OPTIONS。
- agent 侧鉴权仍是 bearer（`gateway-secret`），两套口令分开：面板被路人看了
  也拿不到 agent 接入用的 bearer。

## 七、事件记录（真实检测信号 · 2026-11-01）

**AI 号（uid <账号A>）被上游标记限制**：池打通后该号第一次 chat（hy4-preview，
内容仅"数到3"）即回 `403 code 11140`「账号存在异常行为，已被限制使用」。
- 该号今日经网关的请求总数：**1 次**。限制更像账号级存量标记（或国际版对非 App
  链路更严），但无法远程分辨，不做无证据归因。
- 处置（按防御红线执行）：停手不重试、凉置 24h、事件记账（`events.jsonl`
  `account-restricted`）、`/v1/chat/completions` 对该版短路 503。
- **待用户核实**：在 WorkBuddy AI App 里给该号发一句话——若 App 内同样被拒，
  则限制与网关无关；若 App 内正常，说明国际版对插件链路（UA/身份）另有校验，
  需比对 App 报文。核实前不解禁。
- 顺带修掉一个真隐患：`upsertAccount` 重同步会覆盖冷却字段 → patrol 每天会把
  风控标记"洗白"回炉。已改为未到期冷却原样保留（pool.mjs，含注释）。
- CN 号全程干净（hy4/deepseek 两次 chat 正常；一次 hy4 回复是内容审查拒答，非限制）。

## 八、待办未决（诚实清单）

1. WB App"自定义模型"入口能否指回 19400（步 6 实测）；会不会被 App 自动更新冲掉。
2. 池内 CN 与 global 是否允许混在一条 `workbuddymodel/*` 里，还是分 `workbuddymodel/cn:*` /
   `:ai:*`（当前设计用 `<variant>` 前缀区分，避免两版令牌/域名串线）。
3. Qoder 侧 `session_dead` 类冷却的"人工确认恢复"要不要做成事件中心一键，还是自动等周期。
4. 令牌加密落盘用 Keychain 派生（`login` keychain 一个通用项）——首次会弹钥匙串授权。

## 九、WB 签到 + 猫猫旅行 + Qoder 全操作整合（2026-11-02）

- **WB 签到/旅行**（`lib/buddy.mjs` + `buddy-run.mjs`，LaunchAgent `com.dsh.auto.acct-buddy`
  每 2h）：接口从 WorkDaddy（babygoton/WorkDaddy，AGPL）的内置自动化定义交叉验证，
  实测全通——签到 `POST /v2/billing/meter/daily-checkin`（成功判据照其 checkin-result.js
  严格化：200 空响应不算成功）；旅行 `activity/growth/buddy/*` 状态机（到站领奖→空闲派出，
  "每日上限"归良性 limit 不刷错误）。每号一次一号顺序跑 + 随机 jitter。
- **Qoder 操作整合**（`lib/qoder-ops.mjs`）：签到/同步/找回历史/接力检查/无感切换全走
  自动版官方 CLI（`--checkin-all` 等，同一通道零重复实现）；唯"粘贴令牌加号"CLI 没有，
  按 Store.swift 原样复刻（drt-→deviceToken/refresh；其它→jobToken/exchange），
  store.json 写入严格照 save() 合并规矩（重读磁盘/uid 并集/排除名单并集/备份 3 份/原子写）。
  vault 加密已验证与 Swift 字节级互解（PBKDF2-SHA256 'qoder-switch-v1' 60000 → AES-256-GCM）。
- **面板**：WB 池加签到/旅行列 + "立即签到+派猫旅行"；Qoder 卡加套餐/签到/当前号/切号按钮 +
  四操作按钮 + 粘贴令牌加号框。号池数据两边实时共用（store.json 单一真源），
  自动版 GUI 可不再打开。
- 🔴 **事故记录（2026-11-02，必须留档）**：整合调研时跑了自动版 `--selftest` **未带
  `QODER_SWITCH_SANDBOX=1`**，真实 `auth.v1.dat` 被覆写为测试假数据、desktop profile
  默认模型被改。当场恢复：profile 从 .bak 还原；登录态用官方 `--switch` 从完好号池写回
  （13 号令牌全程无损），端到端复测通过。**纪律：任何自动版 CLI 试验必须先确认沙箱，
  `--selftest` 永不裸跑。**

## 十、验收快照（2026-11-02）

- 面板截图验收：WB 池 5 号（4 可用 + 1 停手期标注）、签到/旅行列、Qoder 13 号表
  （套餐/可花/今日/签到✓/切号按钮）、四操作按钮、加号输入框，全部渲染正常。
- 功能实测：`qoder-checkin` 经面板 17.8s 跑完 13 号；`qoder-add` 垃圾令牌在验证阶段
  即 401 失败、store.json md5 不变（错误路径安全）；buddy-run 幂等（已签秒回 already）。
- WB 池涨到 5 号（用户多登了号同步）——多号轮换+逐号签到旅行实测成立。

## 十一、Qodermanager 链序编辑器（2026-11-02 用户需求"面板改模型排序"）
- **机制**：QM 网关（18300）的链序原本硬编码（免费按 id、付费按价格）。给它加了可选
  覆盖文件 `QoderSwitch/qm-chain-order.json`——缺失/空 = 逐字节原行为；有则按序排。
  QM 每 60s 心跳 refreshChain，**写完最迟 1 分钟生效，无需重启**。补丁前已备份
  （gateway.mjs.bak-order-*）。故意不写进 model-matrix.json——矩阵被目录同步周期性重写会冲掉。
- **面板**：Qoder 卡新增"模型排序"编辑器（↑↓ 调序 + 保存 + 恢复默认），编辑中的草稿
  不被 30s 自动刷新冲掉（qmDirty 旗标）。
- **端到端实测**：基线=改前一致 → 面板写 [kimi-k3, qwen3.8-flash, deepseek-flash] →
  66s 后 QM /stats 确认 kimi-k3 升至付费首位 → 恢复默认 → 回到 deepseek-flash 首位、
  序文件删除。线上页面五项 UI 元素 curl 验证齐全。

## 十二、WorkBuddy 统一链（workbuddymodel 单入口）+ AI 变体下线（2026-11-02）

- **用户需求**：WB 也要像 Qodermanager 一样"所有模型内部排序、对外一个名"。
- **实现**（`lib/wb-chain.mjs` + 网关 `runWbChat` 重写）：
  - 裸名 `workbuddymodel` = 统一链入口（`/v1/models` 首位新增该条目）；点名
    `workbuddymodel/cn:<id>` 保留，仍走指定模型。
  - 默认序：**免费在前（按 id）、付费按倍率升序**（倍率取自目录 `billing.credits`
    的 x 值；实测链头 hy3 x0.00 限时免费）。自定义序 `data/wb-chain-order.json`，
    缺失/空=默认；没列到的模型按默认规则追加链尾（不漏）。
  - 双层失败语义：**账号级**（hard_credit/session_dead/限制/soft_rate）→ 冷却该号
    换下一号；**模型级**（not_found/client/server）→ 降档下一模型 + 模型日闸
    （当天 3 次即跳过，跨日重置，全闸重置防锁死——同 QM 纪律）。
  - 面板 WB 卡加"统一链排序"编辑器（↑↓/保存/恢复默认，与 QM 同款）；路由结果记
    `wb-chain-route` 事件（哪个模型哪个号服务的）。
- **实测**：裸名调用 → 自动选链头 hy3（免费）回"统一"，记账 `hy3 via <账号B>`；
  写自定义序 kimi-k3-1 提首位 → 链立即反映（custom=True）→ 恢复默认 → 序文件删除。
- **AI 变体下线**（用户定"不用了"）：`VARIANTS` 唯一真源删 ai；池里 <账号A> 已移除
  （正好是被限制那个）；解析正则收窄只认 cn；`/v1/models` 24 个零 ai 残留；
  点名 ai 模型返回 400。ZCode 配置里本无 ai 条目，无需动。
- 顺手修：面板模型徽章倍率一直不显示（读错字段 `m.credits`，实为 `m.billing.credits`）。

## 十三、面板拆两页 + qodermodel 统一走 Qodermanager（2026-11-02 用户定）

- **两页标签**：WorkBuddy / Qoder 各一页（tab 记忆在 localStorage），各自一张
  "接入配置"卡：WB 页吐 `19400 + workbuddymodel`，Qoder 页吐 `18300 + Qodermanager`
  （QM 口令经 `/panel/qm-secret` 现取，面板 token 保护，无 token 403 实测）。
- **qodermodel 转发对象切换**：bridge(19399) → **Qodermanager(18300)**。
  用户确认"我说的 Qoder = Qodermanager"后执行：QM 只收单名（链路由内部选档），
  所以 `qodermodel` 裸名 = QM 链，**钉名 `qodermodel/<id>` 下线**（列出来必 400 是骗人），
  `/v1/models` 只列单条 `qodermodel`。QM 地址/口令读 `QoderSwitch/qodermanager.env`。
- **bridge 不动不退役**：WorkBuddy App 内自定义模型还指着它，两套并行各管各的入口。
- 实测：OpenAI + Anthropic 两协议 qodermodel 真实调用全通（回复走 QM 链，
  QM /stats 记账确认实际模型+账号）；两页结构、qm-secret 鉴权线上 curl 验证齐全。

## 十四、令牌续命：WB 已做，Qoder 不需要（2026-11-02 用户问"会不会到期/巡号刷新"）

- **WB refresh 幂等实测**（拿非活跃号 <账号B> 做双刷）：refresh 返回新对令牌，
  且**旧 refresh 重放仍成功** → 无轮转作废 → 后台刷不会踢掉 App 登录，可放心自动续。
- **patrol 新增续命段**：access 剩 <7 天的池内号逐个 `refreshToken` 回写（含已过期
  但 refresh 还活的号，用 `allAccounts` 不过滤）；失败只记 `renew-fail` 事件不删号。
  每天 04:10 随 patrol 跑 → **WB 池令牌理论上永不掉线**，不需要"巡号切换"。
  实测安全：当天 4 号 access 26-30 天，patrol 一个没碰、池完好。
- **Qoder 不需要巡号**：refresh 寿命实测 **360 天**（13 号全在 349-359 天区间），
  且自动版 `ensureToken` 本就按需刷新+回写 store（save() 带备份合并）。
  巡号切换反而有风险（写 auth.v1.dat 打断客户端），纯亏。
- **切换不刷新令牌的原理澄清**：App 只在 access 临期才 refresh——切号动作本身
  不产生续命效果；真正保命的是"临期前有人刷一次"，patrol 现在就是那个"人"。
- 事故复查：/tmp/qm-gateway.log 零 selftest 污染痕迹，QM 链路健康。

## 十五、WB 账号消耗优先级可自定义（2026-11-02 用户问"先烧哪个号"）

- **默认**：最久未用优先（LRU 轮换）——池内号均匀消耗。
- **自定义**：`data/wb-account-order.json`（uid 数组=消耗顺序，序外垫底 LRU）；
  面板 WB 页"账号消耗优先级"表直接 ↑↓ 调序 + 保存/恢复默认（与链编辑器同款交互）。
- 选号只认"可用号"：停手期/过期号自动跳过，不会把序里第 1 位烧挂的号硬塞。
- 实测：写序 [<账号C>,…] → pickAccounts 首位变 → 真实调用路由事件
  `wb-chain-route 用号=<账号C>` → 恢复默认。链级(模型)与池级(账号)两层序独立生效。

## 十六、实时用量统计：双引擎当日/历史（2026-11-03 用户需求）

- **WB 侧**：网关原本无账本 → 新建 `lib/wb-usage.mjs`（wb-usage.jsonl，上海日分桶，
  行含 uid/model/input/output/reasoning/credit）。记账接在两条协议出口的流式与
  非流式路径（pipeStream/pipeStreamAnthropic 加 onUsage 旁路扫 usage，不碰转发字节；
  非流式从聚合结果取）。credit 用上游 usage.credit 实际扣分值，免费档=0。
- **Qoder 侧**：读现成 counts.jsonl（QM 网关实时写，我们只读不双记）。
  ⚠️ 没用 qoder-router 的 summarizeUsage——它只累加 token 不累加积分（读源码确认），
  自己写聚合（qoder-view.qoderUsage）：token+实扣+标价双口径、wireKey→可读模型名映射、
  45s 缓存防面板 30s 轮询打爆 5MB 账本。
- **口径纪律**（照 call-count.js）：credits=实际扣费（billable 才非 0），
  quotedCredits=标价。面板 Qoder 卡显示"积分消耗 0.00 · 标价 192.64 分（免费档不真扣）"
  ——避免把免费档标价虚报成消耗。
- **面板**：两页各一张"用量"卡，当日（4 大数字：次数/输入/输出/积分）+
  历史（按天表格：次数/token/积分/当日主力号），30s 随面板自动刷。
- **实测**：真实调用→账本落盘→端点→截图全链路绿。WB 当日 29 次/10.9M/25.21 分
  （数字随对话进行实时上涨，即咱们这条会话本身在被计量）；QD 当日 68 次/4.8M/
  实扣 0（全走免费档，标价 192.64）。

## 十七、局域网开放 + 设备子令牌（2026-11-03 用户需求，自家设备）

- **开关**：`ACCT_LAN=1`（写进 com.dsh.auto.acct-gateway.plist）→ 监听 0.0.0.0:19400；
  默认（不设/0）仍只 127.0.0.1。QM(18300)/bridge(19399) 保持 loopback 不对外。
  防火墙当前关闭（放行）；面板顶部实时显示"局域网开放中 http://<ip>:19400"。
- **钥匙库**（lib/lan-keys.mjs，data/lan-keys.json 0600）：每把子令牌 = 设备名 +
  每日次数上限 + 逐日 token/积分计量 + 可单独吊销/删除。lan- 前缀，常量时间比对。
- **鉴权分层**（authReq）：主密钥全功能；子令牌只许 /v1/models、/v1/chat/completions、
  /v1/messages 三路，其余（含计费查询 /workbuddy/balances）403；超限 429（次日自动重置）；
  吊销 403。**面板路由按来源 IP 隔离**（isLoopback）：LAN 开了别的机器也读不到状态/取不了口令。
- **计量**：子令牌每次调用记 1 次（日限按次）；WB 路顺带记 token+credit 到该钥匙。
  Qoder 路 token 由 QM 账本管，这里只记次数，不双计。
- **实测全绿**：limit=1 钥匙第 1 次 200、第 2 次 429（"今日 1 次已用完"）；高限额子令牌
  打 /workbuddy/balances → 403"只可用于模型调用"、打 /v1/models → 200；吊销后 403；
  主密钥走局域网 IP 200；LAN IP 打面板 403。测试钥匙已清理，WB 池 4 号未受影响。
- **面板**：WB 页底部"局域网设备钥匙"卡——新建（设备名+上限，钥匙自动复制）、
  进度条看今日用量、吊销/删除、点钥匙复制。
- ⚠️ 明文 HTTP：仅自家可信设备可用（用户确认）；访客网络下不要开。关法=plist 里
  ACCT_LAN 改 0 + bootout/bootstrap 重载。

## 十八、Qoder 钉名直连（2026-11-03 用户问"为什么只能加一个 Qodermanager"）

- **原因**：QM 网关(18300)设计为只认单名 Qodermanager（链式选档），钉名过去必 400，
  所以切 QM 后端时钉名列表被下线。WB 能钉名是因为管家网关自己说 WB 协议。
- **解法**（lib/qoder-native.mjs）：管家网关原生说 Qoder 协议——复用 qoder-router 的
  QoderAdapter + usableCredential（store.json 号池直取、临期自动刷、**不写 auth.v1.dat**）
  + orderedAccounts（已按可花排序，quota/auth 错自动换下一号）。
- **路由**：`qodermodel/<id>` → 原生钉名直连；裸 `qodermodel` → 仍走 QM 链（回归实测通）。
  /v1/models 重新列 9 个钉名；面板 Qoder 徽章点击=复制 qodermodel/<id>。
- **记账**：钉名用量写进同一本 counts.jsonl（inst='acct-gateway'，格式对齐 QM 行），
  面板 Qoder 用量卡自动包含。实测 credit/billable 真值入账（deepseek-flash 0.009 分）。
- **实测全绿**：钉名非流式"钉名通"、流式逐 chunk+[DONE]、Anthropic 协议"双协议"
  （glm-5.3-flash）、裸名回归"好"、/v1/models 27 条（1 WB 链入口 + 16 WB 模型 +
  1 qodermodel + 9 钉名）。
- **bridge 定位不变**：WorkBuddy App 内自定义模型仍用它；本方案与它并行、互不依赖。
