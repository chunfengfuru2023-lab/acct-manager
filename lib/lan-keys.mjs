/**
 * 局域网设备子令牌：按设备发钥匙、每日次数上限、用量计量、可吊销。
 *
 * 背景（2026-11-03 用户需求）：QM/管家链接开放给自家局域网设备使用。
 * 安全模型：主密钥仍是总钥匙（全功能）；子令牌=受限分身——只走 chat/models，
 * 每日调用上限，可单独吊销，面板集中管理。数据文件 data/lan-keys.json（0600）。
 * 默认网关仍只监听 127.0.0.1；ACCT_LAN=1 才开对外（plist 里显式打开）。
 * @module acct-manager/lan-keys
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'

const HERE = dirname(new URL(import.meta.url).pathname)
const FILE = join(HERE, '..', 'data', 'lan-keys.json')
const day = (ms = Date.now()) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10)

function load() {
  try { const d = JSON.parse(readFileSync(FILE, 'utf8')); if (Array.isArray(d.keys)) return d } catch { /* 首次 */ }
  return { version: 1, keys: [] }
}
function save(d) {
  mkdirSync(dirname(FILE), { recursive: true })
  const tmp = `${FILE}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 })
  renameSync(tmp, FILE)
  try { chmodSync(FILE, 0o600) } catch { /* 尽力 */ }
}

/** 本机局域网 IPv4（面板展示设备端 base URL 用）。 */
export function lanIp() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return '127.0.0.1'
}

export function createKey(name, dailyLimit = 500) {
  const d = load()
  const key = {
    id: 'lk' + randomBytes(4).toString('hex'),
    name: String(name || '').trim().slice(0, 40) || '未命名设备',
    token: 'lan-' + randomBytes(16).toString('base64url'),
    dailyLimit: Math.max(1, Math.min(100000, Number(dailyLimit) || 500)),
    createdAt: Date.now(), revoked: false, usage: {},
  }
  d.keys.push(key); save(d)
  return key
}
export function revokeKey(id) {
  const d = load(); const k = d.keys.find((x) => x.id === id)
  if (!k) return { ok: false, error: '钥匙不存在' }
  k.revoked = true; save(d); return { ok: true, result: `已吊销「${k.name}」` }
}
export function deleteKey(id) {
  const d = load(); const n = d.keys.length
  d.keys = d.keys.filter((x) => x.id !== id)
  if (d.keys.length !== n) save(d)
  return { ok: true, result: '已删除' }
}
export function setLimit(id, limit) {
  const d = load(); const k = d.keys.find((x) => x.id === id)
  if (!k) return { ok: false, error: '钥匙不存在' }
  k.dailyLimit = Math.max(1, Math.min(100000, Number(limit) || k.dailyLimit)); save(d)
  return { ok: true, result: `「${k.name}」上限改为 ${k.dailyLimit} 次/日` }
}

/** 按令牌找钥匙（常量时间逐个比；非 lan- 前缀直接拒，省掉全表扫描）。 */
export function matchKey(token) {
  if (typeof token !== 'string' || !token.startsWith('lan-')) return null
  const a = Buffer.from(token)
  for (const k of load().keys) {
    const b = Buffer.from(k.token)
    if (a.length === b.length && timingSafeEqual(a, b)) return k
  }
  return null
}
export function keyAllowed(k) {
  if (k.revoked) return { ok: false, reason: 'revoked' }
  const used = (k.usage[day()] ?? {}).calls ?? 0
  if (used >= k.dailyLimit) return { ok: false, reason: 'limit', used }
  return { ok: true, used }
}
export function recordUsage(k, { input = 0, output = 0, credit = 0 } = {}) {
  const d = load(); const cur = d.keys.find((x) => x.id === k.id); if (!cur) return
  const u = cur.usage[day()] ??= { calls: 0, input: 0, output: 0, credit: 0 }
  u.calls++; u.input += input; u.output += output; u.credit += credit
  const days = Object.keys(cur.usage).sort()
  while (days.length > 30) delete cur.usage[days.shift()] // 只留 30 天
  save(d)
}
export function listKeys() {
  const today = day()
  return load().keys.map((k) => ({
    id: k.id, name: k.name, token: k.token, dailyLimit: k.dailyLimit, revoked: k.revoked,
    today: k.usage[today] ?? { calls: 0, input: 0, output: 0, credit: 0 },
    lastUsed: k.usage[today]?.calls ? today : (Object.keys(k.usage).sort().pop() ?? ''),
  }))
}
