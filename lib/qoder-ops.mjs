/**
 * Qoder 操作整合层：把自动版 CLI 与号池写入包成面板可调的动作。
 *
 * 原则：
 *  1. 能借官方 CLI 的一律借（签到/同步/找回历史/切换——协议与风控逻辑都在
 *     自动版里，重新实现=找炸）。⚠️ 永不带 --selftest（2026-11-02 事故：
 *     不带沙箱环境变量会覆写真实 auth.v1.dat 与 desktop profile）。
 *  2. CLI 没有的"粘贴令牌加号"才自己写：接口照 API.swift 复刻
 *     （drt- → deviceToken/refresh；其它 → jobToken/exchange），store.json
 *     写入严格照 Store.swift save() 的合并规矩：写前重读磁盘、按 uid 并集、
 *     排除名单并集、备份保留 3 份、原子写。令牌用已验证字节级一致的 vault
 *     加密（PBKDF2-SHA256 'qoder-switch-v1' 60000 → AES-256-GCM 'enc:'）。
 *  3. 与自动版 GUI 并发安全：save() 的 uid 并集设计本就允许两版互写。
 * @module acct-manager/qoder-ops
 */
import { execFile } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { pbkdf2Sync, createCipheriv, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, unlinkSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 2026-11-13 迁移：CLI 二进制脱离 .app 壳收进本目录（bin/），原 .app 已卸载。
// 仍需 QS_EDITION=auto：无 Info.plist 时 Edition 走环境变量分流（Edition.swift:24）。
const AUTO_BIN = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..', 'bin', 'qoder-switch-auto')
const DIR = join(homedir(), 'Library', 'Application Support', 'QoderSwitch')
const STORE = join(DIR, 'store.json')
const OPENAPI = 'https://openapi.qoder.com.cn'

// ── vault（与 Crypto.swift QoderVault 字节级互解，2026-11-02 实测验证）──────
let _key = null
function vaultKey() {
  if (_key) return _key
  const pw = execFileSync('/usr/bin/security',
    ['find-generic-password', '-s', 'Qoder CN App Safe Storage', '-a', 'Qoder CN App Key', '-w'],
    { encoding: 'utf8' }).trim()
  _key = pbkdf2Sync(pw, 'qoder-switch-v1', 60000, 32, 'sha256')
  return _key
}
function seal(plain) {
  const nonce = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', vaultKey(), nonce)
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()])
  return 'enc:' + Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64')
}

// ── 官方 CLI 包装 ───────────────────────────────────────────────────────────
function cli(args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    execFile(AUTO_BIN, args, { timeout: timeoutMs, maxBuffer: 4 << 20, env: { ...process.env, QS_EDITION: 'auto' } },
      (err, stdout, stderr) => resolve({
        ok: !err, code: err?.code ?? 0,
        out: String(stdout || '').trim(), err: String(stderr || '').trim(),
      }))
  })
}
/** 动作白名单——绝不含 --selftest。 */
export const QODER_ACTIONS = {
  'qoder-checkin': () => cli(['--checkin-all'], 300_000),      // 全号签到（官方通道）
  'qoder-sync': () => cli(['--sync']),                          // 同步当前登录号进池
  'qoder-import': () => cli(['--import-cache']),                // 找回历史账号
  'qoder-failover': () => cli(['--failover-force']),            // 立刻接力检查
}
export async function qoderSwitch(uidOrName) {
  if (!uidOrName) return { ok: false, err: '缺 uid/昵称' }
  return cli(['--silent-switch', String(uidOrName)]) // 无感：只写凭证不重启 App
}

// ── 粘贴令牌加号（CLI 无此入口，照 Swift 原样复刻）──────────────────────────
const HEADERS = {
  'Accept': 'application/json', 'Content-Type': 'application/json',
  'User-Agent': 'qoder-cn-desktop', 'Cosy-Version': '1.0.1', 'Cosy-ClientType': '10',
}
async function apiPost(path, body, token) {
  const r = await fetch(OPENAPI + path, {
    method: 'POST',
    headers: { ...HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status}：${text.slice(0, 160)}`)
  return JSON.parse(text)
}
/** 自动识别两种凭据：drt- 设备刷新令牌 / 其它 = PAT（同 Store.swift 判据）。 */
export async function qoderAddByToken(raw) {
  const t = String(raw || '').trim()
  if (!t) return { ok: false, error: '令牌是空的' }
  const isPat = !t.startsWith('drt-')
  let freshToken, storeRT, expAt, expRT, uid, name, avatar
  try {
    if (isPat) {
      const ex = await apiPost('/api/v1/jobToken/exchange', { personal_token: t })
      freshToken = ex.token
      if (!freshToken) throw new Error('交换成功但响应里没有 token')
      storeRT = t; expAt = ex.expiresAt ?? ''; expRT = ''
      uid = ex.user?.id ?? ex.user?.userId ?? ''
      name = ex.user?.nickname ?? ex.user?.name ?? 'PAT 账号'
      if (!uid) throw new Error('交换成功但响应里没有 user.id，无法确定账号身份')
      avatar = ''
    } else {
      const fr = await apiPost('/api/v1/deviceToken/refresh', { refresh_token: t })
      freshToken = fr.device_token
      if (!freshToken) throw new Error('刷新接口没返回 device_token')
      storeRT = fr.refresh_token || t
      expAt = fr.expires_at ?? ''; expRT = fr.refresh_token_expires_at ?? ''
      const info = await fetch(OPENAPI + '/api/v1/userinfo', { headers: { ...HEADERS, Authorization: `Bearer ${freshToken}` }, signal: AbortSignal.timeout(15000) }).then(r => r.json())
      uid = info.id ?? ''; name = info.name ?? uid.slice(0, 8); avatar = info.avatar ?? ''
    }
  } catch (e) {
    return { ok: false, error: `令牌验证失败：${String(e.message ?? e).slice(0, 160)}` }
  }
  const wrote = mergeAddAccount({ uid, name, avatarURL: avatar, token: seal(freshToken), refreshToken: seal(storeRT), expiresAt: expAt, refreshExpiresAt: expRT, kind: isPat ? 'pat' : 'device', note: '', addedAt: Date.now() / 1000 })
  return wrote
}

/**
 * 照 Store.swift save() 的合并规矩写 store.json：
 * 重读磁盘 → uid 并集（本写覆盖同 uid）→ 排除名单里移除该 uid（手动添加=明确恢复）
 * → 备份保留 3 份 → 原子写。states/switchedAt/currentUid 不动（那是自动版权威）。
 */
function mergeAddAccount(account, nowSec = Date.now() / 1000) {
  if (!existsSync(STORE)) return { ok: false, error: 'store.json 不存在——先启动一次自动版' }
  let doc
  try { doc = JSON.parse(readFileSync(STORE, 'utf8')) } catch (e) { return { ok: false, error: `store.json 读不了：${e}` } }
  doc.accounts ??= []; doc.states ??= {}; doc.excludedAccountIds ??= []
  const i = doc.accounts.findIndex((a) => a.uid === account.uid)
  const existed = i >= 0
  if (existed) doc.accounts[i] = { ...doc.accounts[i], ...account }
  else doc.accounts.push(account)
  doc.excludedAccountIds = doc.excludedAccountIds.filter((x) => x !== account.uid)
  doc.accounts.sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0))
  // 新号无额度快照时补一个占位，面板显示"待刷新"而不是消失
  if (!doc.states[account.uid]) doc.states[account.uid] = { reachable: true, quotaAt: 0 }
  // 备份（保留最近 3 份，同 backupSharedStore 规矩）
  const stamp = Math.floor(Date.now() / 1000)
  copyFileSync(STORE, join(DIR, `store.json.bak-acct-${stamp}`))
  try {
    const baks = readdirSync(DIR).filter((n) => n.startsWith('store.json.bak-acct-')).sort().slice(0, -3)
    for (const n of baks) unlinkSync(join(DIR, n))
  } catch { /* 清旧备份失败不影响写入 */ }
  const tmp = `${STORE}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(doc))
  renameSync(tmp, STORE)
  return { ok: true, result: existed ? `账号 ${account.name} 已存在，令牌已更新` : `已添加账号：${account.name}${account.kind === 'pat' ? '（PAT）' : ''}` }
}
