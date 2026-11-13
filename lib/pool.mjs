/**
 * 账号池：多号快照 + AES-256-GCM 落盘加密。
 *
 * 只加密 accessToken / refreshToken 两个字段（envelope 风格），元数据（uid/nickname/
 * 到期时间/冷却）明文，list 展示不触发解密。写入路径永远只写我们自己的 store，
 * 绝不写 WB/Qoder App 的原始文件。
 *
 * @module acct-manager/pool
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { getOrCreateMasterKey } from './keychain.mjs'

const HERE = dirname(new URL(import.meta.url).pathname)
// 本文件在 lib/ 下：store 放工程根的 data/，别在 lib/ 里建目录
const STORE_PATH = join(HERE, '..', 'data', 'wb-accounts.enc.json')
const KEY = Buffer.from(getOrCreateMasterKey(), 'base64url') // 32B，进程生命周期内驻内存

const SECRET_FIELDS = ['accessToken', 'refreshToken']

function encryptValue(plain) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, nonce)
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return JSON.stringify({ n: nonce.toString('base64'), t: cipher.getAuthTag().toString('base64'), c: ct.toString('base64') })
}
function decryptValue(blob) {
  try {
    const { n, t, c } = JSON.parse(blob)
    const dec = createDecipheriv('aes-256-gcm', KEY, Buffer.from(n, 'base64'))
    dec.setAuthTag(Buffer.from(t, 'base64'))
    return Buffer.concat([dec.update(Buffer.from(c, 'base64')), dec.final()]).toString('utf8')
  } catch { return '' }
}

function seal(doc) {
  const out = { ...doc }
  for (const f of SECRET_FIELDS) if (typeof out[f] === 'string' && out[f] !== '') out[f] = encryptValue(out[f])
  return out
}
function open(acc) {
  const out = { ...acc }
  for (const f of SECRET_FIELDS) if (typeof out[f] === 'string' && out[f].startsWith('{')) out[f] = decryptValue(out[f])
  return out
}

function loadRaw() {
  if (!existsSync(STORE_PATH)) return { version: 1, accounts: [] }
  try { return JSON.parse(readFileSync(STORE_PATH, 'utf8')) } catch { return { version: 1, accounts: [] } }
}
function saveRaw(doc) {
  mkdirSync(dirname(STORE_PATH), { recursive: true })
  const tmp = `${STORE_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 })
  renameSync(tmp, STORE_PATH)
}

/** 快照一个号进池（按 uid+variantKey 幂等 upsert）。cred 为 connector credential 形状。 */
export function upsertAccount(variantKey, cred, meta = {}) {
  const doc = loadRaw()
  const entry = seal({
    uid: cred.uid, variantKey,
    nickname: cred.nickname ?? meta.nickname ?? '',
    domain: cred.domain ?? '',
    enterpriseId: cred.enterpriseId ?? '',
    accessToken: cred.accessToken, refreshToken: cred.refreshToken ?? '',
    expiresAtMs: cred.expiresAtMs ?? 0, refreshExpiresAtMs: cred.refreshExpiresAtMs ?? 0,
    syncedAtMs: Date.now(), lastUsedMs: 0,
    cooldownUntilMs: 0, cooldownKind: '',
    ...meta,
  })
  const i = doc.accounts.findIndex((a) => a.uid === cred.uid && a.variantKey === variantKey)
  if (i >= 0) {
    const prev = doc.accounts[i]
    // 未到期的冷却必须原样保留（尤其 restricted/hard_credit）：重同步不许替号"洗白"
    // 风控标记，否则 patrol 每天会把凉置清零 → 限制号反复回炉撞上游（重试风暴）。2026-11-01
    if (prev.cooldownUntilMs > Date.now()) { entry.cooldownUntilMs = prev.cooldownUntilMs; entry.cooldownKind = prev.cooldownKind }
    if (prev.lastUsedMs) entry.lastUsedMs = prev.lastUsedMs
    doc.accounts[i] = { ...prev, ...entry }
  } else doc.accounts.push(entry)
  saveRaw(doc)
  return entry
}

export function listAccounts() { return loadRaw().accounts.map((a) => ({ ...a, accessToken: a.accessToken ? '•' : '', refreshToken: a.refreshToken ? '•' : '' })) }

/** 解密后的全部账号（不过滤冷却/过期）——令牌续命要用到已过期但 refresh 还活着的号。 */
export function allAccounts(variantKey) {
  return loadRaw().accounts.filter((a) => !variantKey || a.variantKey === variantKey).map(open)
}

// ── 账号消耗优先级（2026-11-02 用户需求）────────────────────────────────────
// 序文件缺失/空 = 默认轮换（最久未用优先）；有 = 按序消耗，序外账号垫底轮换。
const ACC_ORDER = join(HERE, '..', 'data', 'wb-account-order.json')
export function wbAccountOrder() {
  try { const o = JSON.parse(readFileSync(ACC_ORDER, 'utf8')).order; return Array.isArray(o) ? o : [] } catch { return [] }
}
export function wbAccountOrderWrite(order) {
  if (!Array.isArray(order) || order.length === 0) {
    if (existsSync(ACC_ORDER)) unlinkSync(ACC_ORDER)
    return { ok: true, result: '已恢复默认轮换（最久未用的号先用）' }
  }
  const tmp = `${ACC_ORDER}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ version: 1, order, updatedAt: Date.now() }, null, 2))
  renameSync(tmp, ACC_ORDER)
  return { ok: true, result: `消耗优先级已保存：${order.length} 个号按序` }
}

export function removeAccount(match) {
  const doc = loadRaw()
  const before = doc.accounts.length
  doc.accounts = doc.accounts.filter((a) => !(a.uid.startsWith(match) || a.nickname === match))
  saveRaw(doc)
  return before - doc.accounts.length
}

/**
 * 取某版的可用账号（解密后的 cred）。排序：自定义消耗序在前（按序），
 * 序外/无序文件 → 按"最近最少用"垫后（原 LRU 轮换）。过滤冷却与过期。
 * excludeUids：一次一号——调用方传入正在服务中的 uid 集合。
 */
export function pickAccounts(variantKey, excludeUids = new Set()) {
  const now = Date.now()
  const rank = new Map(wbAccountOrder().map((uid, i) => [uid, i]))
  return loadRaw().accounts
    .filter((a) => a.variantKey === variantKey && !excludeUids.has(a.uid))
    .filter((a) => !(a.cooldownUntilMs > now))
    .filter((a) => a.expiresAtMs > now + 60_000) // access 至少还剩 1 分钟才给用
    .sort((a, b) => {
      const ra = rank.has(a.uid) ? rank.get(a.uid) : Number.POSITIVE_INFINITY
      const rb = rank.has(b.uid) ? rank.get(b.uid) : Number.POSITIVE_INFINITY
      if (ra !== rb) return ra - rb
      return (a.lastUsedMs || 0) - (b.lastUsedMs || 0) // 同层内 LRU 兜底
    })
    .map(open)
}

/** 回写：令牌刷新 / 使用时间 / 冷却状态。 */
export function patchAccount(variantKey, uid, patch) {
  const doc = loadRaw()
  const acc = doc.accounts.find((a) => a.uid === uid && a.variantKey === variantKey)
  if (!acc) return false
  Object.assign(acc, seal(patch))
  saveRaw(doc)
  return true
}

/** 清掉已到期冷却（含手动恢复：传 force 清全部）。 */
export function sweepCooldown(force = false) {
  const doc = loadRaw()
  let n = 0
  for (const a of doc.accounts) if ((force || a.cooldownUntilMs <= Date.now()) && a.cooldownUntilMs !== 0) { a.cooldownUntilMs = 0; a.cooldownKind = ''; n++ }
  if (n) saveRaw(doc)
  return n
}
