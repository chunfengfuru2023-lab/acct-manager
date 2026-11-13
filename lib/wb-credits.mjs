/**
 * WB 积分与到期观测（2026-11-13 用户需求：账号展示积分、快到期排前面）。
 *
 * 口径：connector 的 fetchCredits 打官方计费接口
 *   POST {billingBase}/v2/billing/meter/get-user-resource
 * 返回 packages[{packageName, remain, size, endTimeMs}]。一个号可能有多包，
 * 「积分过期时间」取**还有余额的包里最早到期的那个**——那才是真正会先烂掉的积分。
 *
 * 计费查询有成本（PLAN.md：克制）：结果缓存 30 分钟，面板首次自动查一次，
 * 之后靠「重新查询」手动刷。查不动的号标 null，绝不阻塞面板。
 *
 * @module acct-manager/wb-credits
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { CLIENT } from './runtime.mjs'
import { allAccounts, listAccounts } from './pool.mjs'

const HERE = dirname(new URL(import.meta.url).pathname)
// 展示名真源由 wb-switch.harvestNames() 落盘（快照/备份/wb-switch 三处合并解密），
// 这里只读结果，避免两个模块各解一遍密、各拿一次 at-rest key。
const NAMES_FILE = join(HERE, '..', 'data', 'wb-names.json')
const CACHE = { at: 0, data: null }
const TTL_MS = 30 * 60_000
const SOON_MS = 7 * 86400_000

/** 展示名：读 wb-names.json（没采集过时为空表，nameOf 会退回 uid 前缀）。 */
export function displayNames() {
  try {
    const obj = JSON.parse(readFileSync(NAMES_FILE, 'utf8'))
    return new Map(Object.entries(obj && typeof obj === 'object' ? obj : {}))
  } catch { return new Map() }
}

/** 名字兜底：池内 nickname → 快照/wb-switch → uid 前缀。 */
export function nameOf(acc, names = displayNames()) {
  return acc.nickname || names.get(acc.uid) || String(acc.uid).slice(0, 8)
}

/**
 * 逐号查积分与最早到期时间。串行 + 间隔，避免计费接口被打爆。
 * @param force 跳过缓存重查
 * @returns {at, rows:[{uid,name,total,expiresAt,expiresLabel,packages,soon,error}], soonCount, total}
 */
export async function wbCreditExpiry({ force = false } = {}) {
  if (!force && CACHE.data && Date.now() - CACHE.at < TTL_MS) return CACHE.data
  const names = displayNames()
  const accs = allAccounts('cn')
  const rows = []
  for (const acc of accs) {
    const row = {
      uid: acc.uid,
      name: nameOf(acc, names),
      total: null,
      expiresAt: null,       // 最早到期的「有余额」包，毫秒；null = 查不到/无到期
      expiresLabel: '未查询',
      packages: [],
      error: '',
    }
    try {
      const c = await CLIENT.fetchCredits(acc)
      row.total = c.total ?? 0
      const pkgs = (c.accounts ?? []).map((p) => ({
        name: p.packageName, remain: p.remain ?? 0, size: p.size ?? 0,
        endTimeMs: p.endTimeMs ?? null, unlimited: p.unlimited === true,
      }))
      row.packages = pkgs
      const live = pkgs.filter((p) => (p.remain > 0 || p.unlimited) && p.endTimeMs)
      if (live.length) {
        const first = live.reduce((a, b) => (a.endTimeMs <= b.endTimeMs ? a : b))
        row.expiresAt = first.endTimeMs
        row.expiresLabel = new Date(first.endTimeMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        row.expiresPackage = first.name
      } else if (pkgs.some((p) => p.unlimited)) {
        row.expiresLabel = '不限量'
      } else if (pkgs.length) {
        row.expiresLabel = '无到期信息'
      } else {
        row.expiresLabel = '无积分包'
      }
    } catch (e) {
      row.error = String(e?.message ?? e).slice(0, 140)
      row.expiresLabel = '查询失败'
    }
    rows.push(row)
    await new Promise((r) => setTimeout(r, 300)) // 计费查询克制：每号间隔
  }
  // 快过期排前：有到期时间的升序在前，查不到/无到期的垫后（同层按积分多的在前，先烧大户）
  rows.sort((a, b) => {
    const ea = a.expiresAt ?? Number.POSITIVE_INFINITY
    const eb = b.expiresAt ?? Number.POSITIVE_INFINITY
    if (ea !== eb) return ea - eb
    return (b.total ?? -1) - (a.total ?? -1)
  })
  const now = Date.now()
  const out = {
    at: Date.now(),
    rows,
    total: rows.reduce((s, r) => s + (r.total ?? 0), 0),
    soonCount: rows.filter((r) => r.expiresAt && r.expiresAt - now < SOON_MS && (r.total ?? 0) > 0).length,
    expiredCount: rows.filter((r) => r.expiresAt && r.expiresAt < now).length,
  }
  CACHE.at = Date.now()
  CACHE.data = out
  return out
}

/** 面板账号表用的轻量视图（不打计费接口，只读缓存 + 池）。 */
export function wbCreditView() {
  const names = displayNames()
  const cached = CACHE.data
  const byUid = new Map((cached?.rows ?? []).map((r) => [r.uid, r]))
  return listAccounts().map((a) => {
    const c = byUid.get(a.uid)
    return {
      uid: a.uid,
      name: nameOf(a, names),
      total: c?.total ?? null,
      expiresAt: c?.expiresAt ?? null,
      expiresLabel: c?.expiresLabel ?? '未查询',
      expiresPackage: c?.expiresPackage ?? '',
      creditError: c?.error ?? '',
    }
  })
}
