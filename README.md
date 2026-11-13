# acct-manager · 账号管家

一个本地网关 + 一个网页面板，把 **WorkBuddy** 和 **Qoder CN** 的多账号、多模型收进
一个 OpenAI 兼容出口。任意 agent 填一条链接就能用，账号轮换 / 模型降档 / 积分观测
都在面板里管。

> 仅本机运行，默认只监听 `127.0.0.1`。账号令牌等运行期数据一律不入库（见 `.gitignore`）。
>
> ⚠️ 合规提示：本项目通过复用官方客户端协议管理**你自己的**账号，此类用法可能违反
> WorkBuddy / Qoder 的服务条款，存在账号被限制的风险。请自行评估，后果自负；
> 勿用于批量注册、撞库或任何未经授权的账号。

---

## 它解决什么

- **一个链接**：`http://127.0.0.1:19400/v1`，模型名填 `workbuddymodel` 或 `qodermodel`，
  也可以钉死单模型（`workbuddymodel/cn:<id>`、`qodermodel/<id>`）。
- **多号轮换**：一次一号（同一令牌同一时刻只服务一个会话），撞额度/会话失效自动换下一号，
  分档冷却（额度/会话死 6h、软限 60s、官方限制标记 24h）。
- **模型链降档**：裸名走统一链，自定义序优先；模型级失败计日闸（3 次/日跳过），跨天重置。
- **积分观测**：逐号查积分与**积分包到期时间**，快到期的账号排最前，优先烧掉会过期的积分。
- **快捷切号**：面板一键把 WorkBuddy / Qoder 桌面端登录态换成指定号（写前备份 + 读回校验 + 失败回滚）。

## 目录结构

```
gateway.mjs          统一网关（OpenAI + Anthropic 双协议出口、面板路由）
acct-cli.mjs         命令行（列号/同步/删号/清冷却/巡检/事件）
lib/
  paths.mjs          外部依赖路径解析（无硬编码用户名路径）
  runtime.mjs        connector 装配、变体表、store 工厂
  pool.mjs           WB 账号池（AES-256-GCM 落盘加密）
  wb-chain.mjs       WB 统一链 + 模型日闸
  wb-credits.mjs     WB 积分与到期观测
  wb-switch.mjs      WB 桌面登录态切号（at-rest 信封重封 + 读回校验）
  wb-usage.mjs       WB 用量账本
  qoder-view.mjs     Qoder 号池/额度/链序只读整合 + 积分到期
  qoder-native.mjs   Qoder 钉名直连（绕开 QM 链）
  qoder-ops.mjs      Qoder 官方 CLI 动作包装 + 粘贴令牌加号
  keychain.mjs       钥匙串密钥（网关 bearer / 面板令牌 / 池主密钥）
  lan-keys.mjs       局域网设备子钥匙（限次、可吊销）
  patrol.mjs         巡检（重同步 + 扫冷却 + 查余额/临期包）
  refresh.mjs        定时快照（目录 + 积分）
  buddy.mjs          WB 签到 + 猫旅行
web/panel.html       管理面板（单文件，无构建）
client/              macOS 面板壳（Swift，可选）
probe/               只读探针（验证登录态可解、拉目录与积分）
PLAN.md              设计与防御约束（检测面、红线、架构）
```

## 依赖

1. **Node.js** ≥ 20（用到 top-level await、原生 fetch）。
2. **dsh-workbuddy-qoder-connect**：提供 WB 协议客户端与 Qoder 路由库。
   路径按以下顺序解析（见 `lib/paths.mjs`）：
   - 环境变量 `ACCT_CONNECT_DIR`
   - 与本仓库**同级**的 `dsh-workbuddy-qoder-connect/`（推荐）
   - 本仓库内 `vendor/dsh-workbuddy-qoder-connect/`
   - `~/Documents/dsh/dsh-workbuddy-qoder-connect/`
3. **WorkBuddy.app**（解密 5.6+ 登录态需借它自己的 Electron 二进制；
   也可用 `WORKBUDDY_ELECTRON_BIN` 显式指定）。
4. **Qoder 账号管家 CLI**（签到/同步/切号走官方通道）。默认从
   `~/Documents/dsh/acct-manager/bin/qoder-switch-{desktop,auto}` 找，
   也可用 `QODER_SWITCH_BIN` 指定。裸二进制需 `QS_EDITION=auto|desktop` 分流。
5. **Qodermanager 网关**（可选，Qoder 链式选档）：默认 `127.0.0.1:18300`，
   口令读 `~/Library/Application Support/QoderSwitch/qodermanager.env`。

## 跑起来

```bash
node gateway.mjs                 # 默认 19400，只监听本机
node gateway.mjs --port 19500    # 换端口
ACCT_LAN=1 node gateway.mjs      # 开局域网（配合面板「设备钥匙」发受限子令牌）
```

面板：浏览器打开 `http://127.0.0.1:19400/panel`
（面板令牌由网关注入 HTML，跨站脚本拿不到；也可 `#token=<令牌>` 覆盖）。

agent 侧配置：

```
OPENAI_BASE_URL = http://127.0.0.1:19400/v1
OPENAI_API_KEY  = <面板「显示口令」取出的 bearer>
model           = workbuddymodel        # 或 qodermodel / 钉名
```

命令行：

```bash
node acct-cli.mjs --list          # 列池内账号（令牌掩码）
node acct-cli.mjs --sync          # 把 App 当前登录号快照进池（只读 App 文件）
node acct-cli.mjs --patrol        # 手动巡检
node acct-cli.mjs --events 30     # 回看事件流水
```

## 数据与密钥（全部本机，绝不入库）

| 位置 | 内容 |
| --- | --- |
| `data/wb-accounts.enc.json` | WB 账号池，令牌 AES-256-GCM 加密 |
| `data/wb-profiles/` | 切号用的身份快照（含明文令牌，0600） |
| `data/wb-auth-backups/` | 切号前的桌面登录态整份备份（保留 20 份） |
| `data/lan-keys.json` | 局域网设备子钥匙 |
| `data/*.jsonl` | 调用与事件账本 |
| 钥匙串 `acct-manager` | `master-key` / `gateway-secret` / `panel-token` |
| `~/Library/Application Support/QoderSwitch/` | Qoder 号池与链序（与 Qoder 管家共用） |

`.gitignore` 已把 `data/`、`logs/`、`backups/`、`bin/` 全部排除。
**克隆后是空池**：先在 App 里登录，再 `--sync` 或面板点「同步」。

## 红线（写死在代码里，越界即拒）

- 不自动化注册 / 批量登录新号；号必须人工在 App 里登一次再同步进池。
- 不绕验证码、不撞库。
- 默认只吐 loopback；开 LAN 需显式 `ACCT_LAN=1` 且自担风险。
- 令牌、路径、权限范围不进日志、不外发第三方。
- 切号写前必备份、写后必用官方解析器读回校验，不符立即回滚。
- 官方主动标记账号异常（403 / 限制语）→ 长凉置 24h，绝不反复重试。

详见 `PLAN.md` 的「防御章」。
