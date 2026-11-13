/**
 * WB 桌面登录态切换（2026-11-13 用户需求：参考 workbuddy-switch 做快捷切号）。
 *
 * 机制照 workbuddy-switch 实测口径：WB 桌面身份真源是 connector 解析出的
 * desktop auth 文件（CN 变体 desktopFilename），5.6+ 的 accessToken/refreshToken/
 * nickname/phoneNumber 是 at-rest 信封：
 *   {$wbEncrypted:1, envelope:base64(JSON{suite,keyId,nonce,authTag,ciphertext})}
 * AAD 与 connector 的 buildAuthenticatedContextAad 逐字节一致（5.6.2 活体验证）。
 *
 * 铁律：
 *  · 写前整份备份到 data/wb-auth-backups/（保留 20 份），绝不无备份写。
 *  · 封完立刻用 connector 自己的 readDesktop 读回校验 uid + 令牌，不符即回滚——
 *    绝不把桌面端登录态写坏（PLAN.md 红线）。
 *  · 身份字段来源优先级：管家快照 → wb-switch 备份 → wb-switch accounts.json
 *    （只读借用，绝不写它的库）。三者都没有 → 拒绝切换并说明原因。
 *  · selfTest 只写 data/ 下的临时副本并用 desktopPath 覆盖读回，绝不碰真身。
 *  · 令牌只进文件与内存，不进日志、不进对话正文。
 *
 * @module acct-manager/wb-switch
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, copyFileSync, unlinkSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { buildStore, ensureElectronEnv } from './runtime.mjs'
import { allAccounts, patchAccount } from './pool.mjs'

const HERE = dirname(new URL(import.meta.url).pathname)
const DATA = join(HERE, '..', 'data')
const BACKUP_DIR = join(DATA, 'wb-auth-backups')
const PROFILE_DIR = join(DATA, 'wb-profiles')          // 管家自己的身份快照（按 uid）
const NAMES_FILE = join(DATA, 'wb-names.json')         // uid → 展示名（从快照/备份解密得来）
const WB_SWITCH_ACCOUNTS = join(homedir(), '.wb-switch', 'accounts.json')
const WB_SWITCH_BACKUPS = join(homedir(), '.wb-switch', 'backups')
const KEEP_BACKUPS = 20
const PROFILE_SECRET_FIELDS = ['nickname', 'phoneNumber']

function ensureDir(p) { try { mkdirSync(p, { recursive: true }) } catch { /* 已存在 */ } }

// ── at-rest 信封：与 connector 逐字节互解 ──────────────────────────────────
/** AAD 照 host-heartbeat 的 buildAuthenticatedContextAad 原样复刻。 */
function aad(keyId, suite) {
  const prefix = Buffer.from('WB-AAD\0', 'ascii')
  const lp = (v) => { const b = Buffer.from(v, 'utf8'); const h = Buffer.allocUnsafe(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]) }
  const s = Buffer.allocUnsafe(4); s.writeUInt32BE(suite)
  return Buffer.concat([prefix, Buffer.from([1]), lp('WBEV1'), lp('sym-v1'), s, lp(keyId), Buffer.from([2]), Buffer.from([0]), Buffer.from([0])])
}
/** 封一个字段：随机 12B nonce + AES-256-GCM。 */
function sealField(key, keyId, plain) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(aad(keyId, 1))
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const envelope = { suite: 1, keyId, nonce: nonce.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
  return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64') }
}
/** 解一个信封字段。失败返回 undefined（绝不抛，调用方自己兜底）。 */
function openField(key, value) {
  try {
    const inner = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8'))
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(inner.nonce, 'base64'), { authTagLength: 16 })
    d.setAAD(aad(inner.keyId, inner.suite))
    d.setAuthTag(Buffer.from(inner.authTag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(inner.ciphertext, 'base64')), d.final()]).toString('utf8')
  } catch { return undefined }
}
/** 从信封里取 keyId（同一台机器同一把 at-rest key）。 */
function keyIdOfField(value) {
  try {
    if (!value || typeof value !== 'object' || value.$wbEncrypted !== 1) return null
    const inner = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8'))
    return typeof inner.keyId === 'string' ? inner.keyId : null
  } catch { return null }
}
/** 取当前机器的 at-rest key + keyId（读不到就抛，调用方转成可读错误）。 */
async function currentKey(store, doc) {
  const kid = keyIdOfField(doc?.auth?.accessToken)
  if (!kid) throw new Error('当前桌面登录态不是 5.6 信封格式，拒绝改写（避免写坏登录态）')
  const key = await store.keyProvider.protectorKeyFor([kid])
  return { key, keyId: kid }
}
/** 把可能是信封的展示字段解成明文；解不开返回 ''（绝不把 foreign 信封写回去）。 */
function plainOrEmpty(value, key) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') return (key ? openField(key, value) : undefined) ?? ''
  return ''
}

// ── 桌面文档读取 ───────────────────────────────────────────────────────────
async function readDesktopDoc() {
  ensureElectronEnv()
  const store = buildStore('cn')
  const path = await store.resolvedDesktopAuthPath()
  if (!path || !existsSync(path)) return null
  try { return { store, path, doc: JSON.parse(readFileSync(path, 'utf8')) } } catch { return null }
}

// ── 展示名 ─────────────────────────────────────────────────────────────────
function readNames() { try { return JSON.parse(readFileSync(NAMES_FILE, 'utf8')) } catch { return {} } }
function writeNames(names) {
  ensureDir(DATA)
  const tmp = `${NAMES_FILE}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(names, null, 2), { mode: 0o600 })
  renameSync(tmp, NAMES_FILE)
}
/** wb-switch 备份里的 .info 文件（顶层 + cn/ 子目录），新的在前。 */
function backupFiles() {
  const out = []
  for (const dir of [WB_SWITCH_BACKUPS, join(WB_SWITCH_BACKUPS, 'cn')]) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.startsWith('workbuddy-desktop.') && f.endsWith('.info')) out.push(join(dir, f))
      }
    } catch { /* 目录不存在 */ }
  }
  return out.sort().reverse()
}
/**
 * 收集 uid → 展示名：管家快照 → wb-switch accounts.json → wb-switch 备份（解密 nickname）。
 * 纯本地文件 + 一次密钥获取，不打任何上游接口。面板账号表用它把 uid 换成人名。
 */
export async function harvestNames() {
  const names = readNames()
  // wb-switch 账号库（明文 nickname）
  try {
    const list = JSON.parse(readFileSync(WB_SWITCH_ACCOUNTS, 'utf8'))
    for (const a of Array.isArray(list) ? list : []) if (a?.id && a?.nickname) names[a.id] = a.nickname
  } catch { /* 没装 wb-switch */ }
  // 备份里的 nickname 是信封：只有 keyId 与本机当前 key 一致才解得开
  let key = null
  try {
    const raw = await readDesktopDoc()
    if (raw) key = (await currentKey(raw.store, raw.doc)).key
  } catch { /* 拿不到 key 就只用明文来源 */ }
  if (key) {
    for (const p of backupFiles()) {
      try {
        const d = JSON.parse(readFileSync(p, 'utf8'))
        const uid = d?.account?.uid
        if (!uid || names[uid]) continue
        const n = plainOrEmpty(d.account?.nickname, key)
        if (n) names[uid] = n
      } catch { /* 坏备份跳过 */ }
    }
  }
  // 管家快照最新，覆盖前面的
  try {
    for (const f of readdirSync(PROFILE_DIR)) {
      if (!f.endsWith('.json')) continue
      try {
        const p = JSON.parse(readFileSync(join(PROFILE_DIR, f), 'utf8'))
        const n = p?.profile?.nickname
        if (p?.uid && typeof n === 'string' && n) names[p.uid] = n
      } catch { /* 坏快照跳过 */ }
    }
  } catch { /* 目录还没建 */ }
  writeNames(names)
  return names
}

// ── 身份快照 ───────────────────────────────────────────────────────────────
/** 把当前桌面身份存成管家自己的快照（0600）。切号前自动做，保证能切回来。 */
export async function captureCurrentProfile() {
  ensureElectronEnv()
  const raw = await readDesktopDoc()
  if (!raw) return { ok: false, error: '读不到桌面登录态文件（App 没登录过？）' }
  const cur = await raw.store.readDesktop().catch(() => null)
  if (!cur?.uid) return { ok: false, error: '桌面端当前无登录态，无从快照' }
  const profile = structuredClone(raw.doc.account ?? {})
  let key = null
  try { key = (await currentKey(raw.store, raw.doc)).key } catch { /* 明文格式：无需解密 */ }
  for (const f of PROFILE_SECRET_FIELDS) profile[f] = plainOrEmpty(profile[f], key)
  ensureDir(PROFILE_DIR)
  const out = {
    version: 1, uid: cur.uid, capturedAt: Date.now(), profile,
    auth: {
      accessToken: cur.accessToken, refreshToken: cur.refreshToken,
      expiresAt: cur.expiresAtMs, refreshExpiresAt: cur.refreshExpiresAtMs ?? 0,
      domain: cur.domain ?? '', sessionState: raw.doc.auth?.sessionState ?? '',
      tokenType: raw.doc.auth?.tokenType ?? 'Bearer',
      expiresIn: raw.doc.auth?.expiresIn ?? 0, refreshExpiresIn: raw.doc.auth?.refreshExpiresIn ?? 0,
    },
  }
  const p = join(PROFILE_DIR, `${cur.uid}.json`)
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 })
  renameSync(tmp, p)
  const nickname = typeof profile.nickname === 'string' ? profile.nickname : ''
  if (nickname) { const names = readNames(); names[cur.uid] = nickname; writeNames(names) }
  return { ok: true, uid: cur.uid, nickname }
}

function ownProfile(uid) {
  try { return JSON.parse(readFileSync(join(PROFILE_DIR, `${uid}.json`), 'utf8')) } catch { return null }
}

/**
 * 解析目标号的身份来源：管家快照 → wb-switch 备份 → wb-switch 账号库。
 * 只取身份字段与 sessionState；令牌一律用池里的最新值。
 */
async function resolveIdentity(uid, store, key) {
  const snap = ownProfile(uid)
  if (snap?.profile) return { profile: snap.profile, auth: snap.auth ?? {}, from: '管家快照' }
  for (const p of backupFiles()) {
    try {
      const d = JSON.parse(readFileSync(p, 'utf8'))
      if (d?.account?.uid !== uid) continue
      const profile = structuredClone(d.account)
      for (const f of PROFILE_SECRET_FIELDS) profile[f] = plainOrEmpty(profile[f], key)
      return {
        profile,
        auth: {
          sessionState: d.auth?.sessionState ?? '', tokenType: d.auth?.tokenType ?? 'Bearer',
          expiresIn: d.auth?.expiresIn ?? 0, refreshExpiresIn: d.auth?.refreshExpiresIn ?? 0,
          domain: d.auth?.domain ?? '',
        },
        from: `wb-switch 备份 ${p.split('/').pop()}`,
      }
    } catch { /* 坏备份跳过 */ }
  }
  try {
    const list = JSON.parse(readFileSync(WB_SWITCH_ACCOUNTS, 'utf8'))
    const a = (Array.isArray(list) ? list : []).find((x) => x?.id === uid)
    if (a) {
      const ar = a.auth_raw ?? {}
      return {
        profile: { ...(a.profile_raw ?? {}), uid, nickname: a.nickname ?? '', lastLogin: true },
        auth: {
          accessToken: a.access_token ?? '', refreshToken: a.refresh_token ?? '',
          expiresAt: a.expiresAt ?? 0, refreshExpiresAt: a.refreshExpiresAt ?? 0,
          domain: a.domain ?? ar.domain ?? '', sessionState: ar.sessionState ?? '',
          tokenType: ar.tokenType ?? 'Bearer', expiresIn: ar.expiresIn ?? 0, refreshExpiresIn: ar.refreshExpiresIn ?? 0,
        },
        from: 'wb-switch accounts.json',
      }
    }
  } catch { /* 没有该库 */ }
  return null
}

/**
 * 组装切换后的桌面文档：保留原文档骨架与其它号的身份条目，
 * 只把 auth 换成目标号（重新封信封），并把目标号标成 lastLogin。
 */
function assembleDoc(rawDoc, acc, identity, key, keyId) {
  const { profile, auth } = identity
  const doc = structuredClone(rawDoc)
  const expiresAt = acc.expiresAtMs || auth.expiresAt || 0
  const refreshExpiresAt = acc.refreshExpiresAtMs || auth.refreshExpiresAt || 0
  const accessToken = acc.accessToken || auth.accessToken
  const refreshToken = acc.refreshToken || auth.refreshToken
  doc.auth = {
    ...(doc.auth ?? {}),
    accessToken: sealField(key, keyId, accessToken),
    refreshToken: sealField(key, keyId, refreshToken),
    expiresAt, refreshExpiresAt,
    expiresIn: Math.max(0, Math.round((expiresAt - Date.now()) / 1000)) || auth.expiresIn || 0,
    refreshExpiresIn: Math.max(0, Math.round((refreshExpiresAt - Date.now()) / 1000)) || auth.refreshExpiresIn || 0,
    domain: acc.domain || auth.domain || doc.auth?.domain || '',
    tokenType: auth.tokenType || doc.auth?.tokenType || 'Bearer',
    sessionState: auth.sessionState || '',
    lastRefreshTime: Date.now(),
  }
  const nickname = typeof profile.nickname === 'string' ? profile.nickname : ''
  const phone = typeof profile.phoneNumber === 'string' ? profile.phoneNumber : ''
  const target = {
    ...profile, uid: acc.uid, lastLogin: true,
    nickname: nickname ? sealField(key, keyId, nickname) : '',
    phoneNumber: phone ? sealField(key, keyId, phone) : '',
    uniqueUserId: profile.uniqueUserId || `${profile.type || 'personal'}_${acc.uid}`,
  }
  // 其它号的身份条目原样保留（信封不动），只把 lastLogin 摘掉
  const others = (arr) => (Array.isArray(arr) ? arr : [])
    .filter((x) => x?.uid && x.uid !== acc.uid)
    .map((x) => ({ ...x, lastLogin: false }))
  doc.account = target
  doc.accounts = [target, ...others(rawDoc.accounts)]
  doc.allAccounts = [target, ...others(rawDoc.allAccounts)]
  return { doc, accessToken, nickname }
}

/** 备份桌面登录态整份文件（切号前必做）。 */
function backupDesktop(path) {
  ensureDir(BACKUP_DIR)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(BACKUP_DIR, `workbuddy-desktop.${stamp}.info`)
  copyFileSync(path, dest)
  const files = readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.info')).sort()
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) {
    try { unlinkSync(join(BACKUP_DIR, f)) } catch { /* 清不掉不挡切号 */ }
  }
  return dest
}

/**
 * 切到指定 uid：备份 → 组文档 → 封信封 → 原子写 → connector 读回校验 → 不符即回滚。
 * @returns {ok, uid, nickname, from, backup, message}
 */
export async function switchWbAccount(uidOrPrefix) {
  ensureElectronEnv()
  const raw = await readDesktopDoc()
  if (!raw) return { ok: false, error: '找不到 WB 桌面登录态文件（App 没登录过？）' }
  const { store, path, doc: rawDoc } = raw

  const acc = allAccounts('cn').find((a) => a.uid === uidOrPrefix || a.uid.startsWith(uidOrPrefix))
  if (!acc) return { ok: false, error: `池内没有账号 ${String(uidOrPrefix).slice(0, 8)}（先同步进池）` }
  const uid = acc.uid

  const cur = await store.readDesktop().catch(() => null)
  if (cur?.uid === uid) return { ok: true, uid, nickname: readNames()[uid] ?? '', message: '已经是当前登录号，无需切换' }

  await captureCurrentProfile().catch(() => null)   // 先存当前号，保证能切回来

  let key, keyId
  try { ({ key, keyId } = await currentKey(store, rawDoc)) } catch (e) { return { ok: false, error: String(e.message ?? e) } }

  const identity = await resolveIdentity(uid, store, key)
  if (!identity) return { ok: false, error: `没有 ${uid.slice(0, 8)} 的身份快照：请在 WB App 里登录该号一次并点「同步」，或先切到它让管家存一份快照` }
  if (!(acc.accessToken || identity.auth.accessToken)) return { ok: false, error: `${uid.slice(0, 8)} 没有可用令牌，先在 App 里登录并同步` }

  const { doc, nickname } = assembleDoc(rawDoc, acc, identity, key, keyId)
  const backup = backupDesktop(path)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 })
  renameSync(tmp, path)

  // 读回校验：connector 自己的解析器必须读出目标 uid，否则立刻回滚
  let verified = null
  try { verified = await store.readDesktop() } catch { verified = null }
  if (verified?.uid !== uid) {
    let rolledBack = true
    try { copyFileSync(backup, path) } catch { rolledBack = false }
    return { ok: false, error: rolledBack ? '写入后读回校验失败，已回滚到切换前的登录态' : `写入后读回校验失败，且回滚失败！请手动从备份恢复：${backup}`, backup }
  }

  await captureCurrentProfile().catch(() => null)
  patchAccount('cn', uid, { lastUsedMs: Date.now() })
  return {
    ok: true, uid, nickname: nickname || readNames()[uid] || '',
    from: identity.from, backup, verifiedUid: verified.uid,
    message: `已切到 ${nickname || uid.slice(0, 8)}（身份来源：${identity.from}）。WB App 重启后界面刷新；网关调用一直用池内令牌，不受影响。`,
  }
}

/**
 * 切号自检（零风险）：把「切到另一个号」的文档写到 data/ 下的临时副本，
 * 用 connector 的 desktopPath 覆盖读回，校验 uid 与令牌逐字节一致，然后删掉副本。
 * 全程不碰真实登录态文件——用来证明信封/AAD/读回链路是通的。
 */
export async function selfTestWbSwitch() {
  ensureElectronEnv()
  const raw = await readDesktopDoc()
  if (!raw) return { ok: false, error: '读不到桌面登录态' }
  const { store, doc: rawDoc } = raw
  const cur = await store.readDesktop().catch(() => null)
  const pool = allAccounts('cn')
  const target = pool.find((a) => a.uid !== cur?.uid && a.accessToken)
  if (!target) return { ok: false, error: '池里没有第二个带令牌的号，无法自检' }

  let key, keyId
  try { ({ key, keyId } = await currentKey(store, rawDoc)) } catch (e) { return { ok: false, error: String(e.message ?? e) } }
  const identity = await resolveIdentity(target.uid, store, key)
  if (!identity) return { ok: false, error: `目标号 ${target.uid.slice(0, 8)} 没有身份快照` }

  const { doc, accessToken, nickname } = assembleDoc(rawDoc, target, identity, key, keyId)
  ensureDir(DATA)
  const tmp = join(DATA, `wb-switch-selftest-${process.pid}.info`)
  writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 })
  const probe = buildStore('cn')
  probe.setDesktopPath(tmp)     // 只读副本，真身零改动
  try {
    const back = await probe.readDesktop()
    const uidOk = back?.uid === target.uid
    const tokenOk = back?.accessToken === accessToken
    const refreshOk = back?.refreshToken === (target.refreshToken || identity.auth.refreshToken)
    // 真实文件必须仍是原来的号
    const real = await store.readDesktop().catch(() => null)
    const realUntouched = real?.uid === cur?.uid
    return {
      ok: uidOk && tokenOk && refreshOk && realUntouched,
      target: target.uid.slice(0, 8), nickname, from: identity.from,
      uidOk, tokenOk, refreshOk, realUntouched,
      message: uidOk && tokenOk && refreshOk && realUntouched
        ? '自检通过：信封可被官方解析器读回，令牌逐字节一致，真实登录态未改动'
        : '自检失败：见各项布尔值',
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) }
  } finally {
    try { unlinkSync(tmp) } catch { /* 忽略 */ }
  }
}

/** 当前桌面登录号（只读，供面板标「当前」）。 */
export async function currentWbAccount() {
  ensureElectronEnv()
  try {
    const cur = await buildStore('cn').readDesktop()
    return cur?.uid ? { uid: cur.uid, expiresAtMs: cur.expiresAtMs } : null
  } catch { return null }
}
