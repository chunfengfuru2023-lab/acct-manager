/**
 * Qoder 只读整合层：把 Qoder 自动版的数据（号池/额度/今日记账/模型链）读进
 * acct-manager 的面板与巡检，供"统一管控"展示。
 *
 * 铁律：qoder-router 模块只 import 读函数；QoderSwitch 里唯一允许我们写的
 * 文件是 qm-chain-order.json（QM 网关的自定义链序，本就是给人改的，2026-11-02
 * 用户需求）。store.json 的写入只发生在 qoder-ops 的加号路径（照 save() 规矩）。
 * 绝不触发切号/签到/refresh——那些走自动版官方 CLI。
 *
 * @module acct-manager/qoder-view
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { qoderLib } from './paths.mjs'

const QSWITCH_DIR = join(homedir(), 'Library', 'Application Support', 'QoderSwitch')
const CHAIN_ORDER_FILE = join(QSWITCH_DIR, 'qm-chain-order.json')

// qoder-router 现成模块（connect 仓库 qoder/lib），只读复用；路径解析见 paths.mjs
const QODER_LIB = qoderLib()

let mods = null
async function load() {
  if (mods) return mods
  try {
    const pool = await import(`${QODER_LIB}/account-pool.js`)
    const count = await import(`${QODER_LIB}/call-count.js`)
    mods = { pool, count }
  } catch (e) {
    mods = { error: String(e?.message ?? e) }
  }
  return mods
}

/**
 * 面板用快照：Qoder 号池 + 每号今日次数 + 当前模型链 + 签到状态。
 * 全程读现成函数；任何异常降级为 { error }，不让面板整体挂。
 */
export async function qoderSnapshot() {
  const { pool, count, error } = await load()
  if (error) return { error }
  try {
    const day = count.shanghaiDay()
    // 今日各号成功次数：summarize 返回 [{uid, ok, ...}]
    const todayBy = new Map()
    try {
      for (const row of count.summarize(day)) todayBy.set(row.uid, row.ok ?? 0)
    } catch { /* 记账文件读失败：次数列留空 */ }

    // 签到状态：store.json 的 states[uid].lastCheckinDay / lastCheckin
    let states = {}
    try {
      const { readFileSync } = await import('node:fs')
      const { homedir } = await import('node:os')
      const { join } = await import('node:path')
      const store = JSON.parse(readFileSync(join(homedir(), 'Library', 'Application Support', 'QoderSwitch', 'store.json'), 'utf8'))
      states = store.states ?? {}
    } catch { /* 读不到就全标未知 */ }

    const accounts = pool.orderedAccounts().map((a) => {
      const st = states[a.uid] ?? {}
      return {
        uid: a.uid,
        name: a.name ?? a.uid.slice(0, 8),
        remaining: a.remaining ?? 0,
        addonRemaining: a.addonRemaining ?? 0,
        spendable: a.spendable ?? ((a.remaining ?? 0) + (a.addonRemaining ?? 0)),
        todayCalls: todayBy.get(a.uid) ?? 0,
        checkinDay: st.lastCheckinDay ?? '',        // 最近一次签到日（上海日）
        checkedToday: st.lastCheckinDay === day,     // 今天签没签
        checkinMsg: st.lastCheckin?.message ?? '',    // 上次结果文案
      }
    })
    const chain = pool.modelChain('automations') ?? []
    return { accounts, chain, day, total: accounts.length }
  } catch (e) {
    return { error: String(e?.message ?? e) }
  }
}

/**
 * Qodermanager 链序：读当前生效序 + 写自定义序。
 * 序文件 qm-chain-order.json 由 QM 网关每 60s 心跳重读——写完最迟 1 分钟生效，
 * 无需重启。空序 = 恢复默认（免费按 id、付费按价格）。
 */
export async function qmChain() {
  const matrix = (() => { try { return JSON.parse(readFileSync(join(QSWITCH_DIR, 'model-matrix.json'), 'utf8')) } catch { return null } })()
  const live = liveCatalog()
  const custom = (() => {
    try { const o = JSON.parse(readFileSync(CHAIN_ORDER_FILE, 'utf8')).order; return Array.isArray(o) ? o : null } catch { return null }
  })()
  // 复刻 QM buildChain 的默认序，让面板能显示"默认会是什么顺序"
  const entries = (matrix?.rows ?? []).filter((r) => typeof r?.id === 'string' && r.id && r.id !== 'auto').map((r) => {
    const cells = Array.isArray(r.cells) ? r.cells : []
    const prices = cells.map((c) => (typeof c?.price === 'number' ? c.price : null)).filter((p) => p !== null)
    return { id: r.id, free: cells.length > 0 && cells.every((c) => c?.free === true), price: prices.length ? Math.min(...prices) : Infinity }
  })
  // 上游新上的模型先出现在 catalog-snapshot.json，矩阵要等凌晨 deep 扫描才补进来。
  // 只补进展示（标 matrix:false + 顺手记进未登记清单），引擎能不能真跑由矩阵决定，不在这里假装。
  const known = new Set(entries.map((e) => e.id))
  const liveButUnlisted = []
  for (const m of live?.models ?? []) {
    if (!m?.id || m.id === 'auto' || known.has(m.id)) continue
    known.add(m.id)
    entries.push({ id: m.id, free: m.free === true, price: typeof m.price === 'number' ? m.price : Infinity, matrix: false })
    liveButUnlisted.push(m.id)
  }
  // 2026-11-13 用户需求：有自定义序时完全按手动顺序展示，不再把免费档强制置顶
  // （之前 free/paid 分组拼接，手动怎么调 qwen3.8-flash 都会被顶回最前面）。
  // 没有自定义序才回退默认序（免费在前、付费按价格升序）。
  const tag = (m) => ({ id: m.id, free: m.free, price: Number.isFinite(m.price) ? m.price : null, ...(m.matrix === false ? { matrix: false } : {}) })
  if (custom) {
    const rank = new Map(custom.map((id, i) => [id, i]))
    const knownIds = new Set(entries.map((e) => e.id))
    const ordered = custom.filter((id) => knownIds.has(id)).map((id) => entries.find((e) => e.id === id))
    const rest = entries.filter((e) => !rank.has(e.id))
    rest.sort((a, b) => (a.free !== b.free ? (a.free ? -1 : 1) : (a.price - b.price) || a.id.localeCompare(b.id)))
    return { chain: [...ordered, ...rest].map(tag), custom: true, liveAt: live?.fetchedAt ?? '', liveUnlisted: liveButUnlisted }
  }
  const free = entries.filter((e) => e.free).sort((a, b) => a.id.localeCompare(b.id))
  const paid = entries.filter((e) => !e.free).sort((a, b) => (a.price - b.price) || a.id.localeCompare(b.id))
  return {
    chain: [...free, ...paid].map(tag),
    custom: false,
    liveAt: live?.fetchedAt ?? '',
    liveUnlisted: liveButUnlisted,
  }
}

/** 上游目录快照（tools/model-catalog-sync.mjs light 模式产出）。读不到返回 null。 */
function liveCatalog() {
  try {
    const s = JSON.parse(readFileSync(join(QSWITCH_DIR, 'catalog-snapshot.json'), 'utf8'))
    return Array.isArray(s.models) ? s : null
  } catch { return null }
}

function matrixRows() {
  try { return JSON.parse(readFileSync(join(QSWITCH_DIR, 'model-matrix.json'), 'utf8')).rows ?? [] } catch { return [] }
}

/** 免费档 id 集合：矩阵里所有账号 cell 都 free 的模型 → {id:true}。
 *  免费档实扣天然是 0（上游不收），面板靠这个区分「正常不扣」和「账本丢了 billable」。 */
export function freeModelIds(rows) {
  const out = {}
  for (const r of rows ?? []) {
    const cells = Array.isArray(r.cells) ? r.cells : []
    if (r?.id && cells.length && cells.every((c) => c?.free === true)) out[r.id] = true
  }
  return out
}

/** 写 QM 自定义链序（数组=顺序；传 null/[] = 删文件恢复默认）。原子写。 */
export function qmChainWrite(order) {
  if (!Array.isArray(order) || order.length === 0) {
    if (existsSync(CHAIN_ORDER_FILE)) unlinkSync(CHAIN_ORDER_FILE)
    return { ok: true, result: '已恢复默认排序（免费按 id、付费按价格）' }
  }
  const tmp = `${CHAIN_ORDER_FILE}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ version: 1, order, updatedAt: Date.now() }, null, 2))
  renameSync(tmp, CHAIN_ORDER_FILE)
  return { ok: true, result: `链序已保存：${order.slice(0, 3).join(' → ')}${order.length > 3 ? ' …' : ''}（最迟 1 分钟生效）` }
}

/**
 * Qoder 用量聚合（当日 + 历史 N 天），输出与 WB 侧 summarizeWbUsage 同构：
 *   { days: [{ day, total:{calls,input,output,credit,quotedCredit,cacheRead,reasoning},
 *              byUid:[{uid,name,calls,input,output,credit,byModel:[...]}] }] }
 *
 * 为什么不用 qoder-router 现成的 summarizeUsage：它只累加 token，不累加积分
 * （2026-11-03 读源码确认），而面板要显示积分。账本 5MB+，缓存 45s 防面板轮询打爆。
 * 积分口径照 call-count.js：credits=实际扣费（billable 才非 0），quotedCredit=标价。
 */
let usageCache = { at: 0, key: '', data: null }
export async function qoderUsage({ days = 8 } = {}) {
  const key = `d${days}`
  if (usageCache.key === key && Date.now() - usageCache.at < 45_000) return usageCache.data
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const nameBy = new Map()
  try { for (const a of (await load()).pool.orderedAccounts() ?? []) nameBy.set(a.uid, a.name ?? a.uid.slice(0, 8)) } catch { /* 号池读不到：显示 uid 前缀 */ }
  // wireKey(qfmodel) → 可读 id(qwen3.8-flash)
  const keyToId = new Map()
  try {
    const matrix = JSON.parse(readFileSync(join(QSWITCH_DIR, 'model-matrix.json'), 'utf8'))
    for (const r of matrix.rows ?? []) if (r?.key && r?.id) keyToId.set(r.key, r.id)
  } catch { /* 矩阵读不到：原样显示 wireKey */ }
  let cutoff = ''
  {
    const d = new Date(Date.now() - (days - 1) * 86400_000)
    cutoff = new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
  }
  const byDay = new Map()
  try {
    const lines = readFileSync(join(QSWITCH_DIR, 'counts.jsonl'), 'utf8').split('\n')
    for (const line of lines) {
      if (!line || line.charCodeAt(0) !== 123 /* { */) continue // 快速跳过空行
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (!e || e.kind !== 'usage' || typeof e.day !== 'string' || typeof e.uid !== 'string') continue
      if (e.day < cutoff) continue
      const perDay = byDay.get(e.day) ?? { day: e.day, total: { calls: 0, input: 0, output: 0, credit: 0, quotedCredit: 0, cacheRead: 0, reasoning: 0 }, uids: new Map() }
      const inp = num(e.input), out = num(e.output), cr = num(e.cacheRead), rs = num(e.reasoning), cd = num(e.credits), qc = num(e.quotedCredits)
      perDay.total.calls++; perDay.total.input += inp; perDay.total.output += out
      perDay.total.credit += cd; perDay.total.quotedCredit += qc; perDay.total.cacheRead += cr; perDay.total.reasoning += rs
      const acc = perDay.uids.get(e.uid) ?? { uid: e.uid, name: nameBy.get(e.uid) ?? e.uid.slice(0, 8), calls: 0, input: 0, output: 0, credit: 0, quotedCredit: 0, models: new Map() }
      acc.calls++; acc.input += inp; acc.output += out; acc.credit += cd; acc.quotedCredit += qc
      const mid = keyToId.get(e.model) ?? e.model ?? '(unknown)'
      const mo = acc.models.get(mid) ?? { model: mid, calls: 0, input: 0, output: 0, credit: 0, quotedCredit: 0 }
      mo.calls++; mo.input += inp; mo.output += out; mo.credit += cd; mo.quotedCredit += qc
      acc.models.set(mid, mo)
      perDay.uids.set(e.uid, acc)
      byDay.set(e.day, perDay)
    }
  } catch (e) {
    return { error: String(e?.message ?? e) }
  }
  const data = {
    days: [...byDay.values()]
      .sort((a, b) => b.day.localeCompare(a.day))
      .map((d) => ({
        day: d.day, total: d.total,
        byUid: [...d.uids.values()].sort((a, b) => b.credit - a.credit || b.calls - a.calls)
          .map((u) => ({ ...u, byModel: [...u.models.values()].sort((a, b) => b.calls - a.calls) })),
      })),
    freeModels: freeModelIds(matrixRows()),
  }
  usageCache = { at: Date.now(), key, data }
  return data
}

/** patrol 用：Qoder 池健康摘要（号数 / 合计可花 / 今日已用次数 / 是否有号触顶）。 */
export async function qoderHealth() {
  const snap = await qoderSnapshot()
  if (snap.error) return { error: snap.error }
  const totalSpendable = snap.accounts.reduce((s, a) => s + (a.spendable ?? 0), 0)
  const totalCalls = snap.accounts.reduce((s, a) => s + (a.todayCalls ?? 0), 0)
  const capped = snap.accounts.filter((a) => a.spendable <= 0).length
  return {
    day: snap.day,
    accounts: snap.total,
    totalSpendable,
    totalCalls,
    exhaustedAccounts: capped,
  }
}

/**
 * 自动版 GUI 数据的只读全量镜像：号池明细（套餐/当前登录/排除名单）、
 * 自动签到设置（auto.json）、事件中心（log.json 最新 N 条）、模型链文件。
 * 全部读 QoderSwitch 原地文件——自动版本身照常运行，这里零写入零迁移。
 */
export async function qoderFull() {
  const { readFileSync } = await import('node:fs')
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  const DIR = join(homedir(), 'Library', 'Application Support', 'QoderSwitch')
  const readJson = (name, fallback) => {
    try { return JSON.parse(readFileSync(join(DIR, name), 'utf8')) } catch { return fallback }
  }
  const snap = await qoderSnapshot()
  if (snap.error) return snap
  const store = readJson('store.json', { accounts: [], states: {}, currentUid: '', excludedAccountIds: [] })
  const auto = readJson('auto.json', {})
  const log = readJson('log.json', [])
  const chainsFile = readJson('model-chains.json', null)
  // 事件中心：log.json 是追加列表，取最新 20 条倒序
  const events = (Array.isArray(log) ? log.slice(-20).reverse() : []).map((e) => ({
    at: (e.at ?? 0) * 1000, kind: e.kind ?? '', account: e.account ?? '',
    ok: e.ok !== false, message: String(e.message ?? '').slice(0, 80),
  }))
  // 把套餐名/当前登录/排除态并进快照账号表
  const planBy = new Map()
  for (const [uid, st] of Object.entries(store.states ?? {})) planBy.set(uid, st.quota?.planName ?? '')
  const excluded = new Set(store.excludedAccountIds ?? [])
  // 2026-11-13：与 WB 页同构——账号表直接带积分过期列，不再只放在单独卡片里。
  // 过期数据读 creditExpiry 的 30 分钟缓存（没查过就是「未查询」，绝不为此打上游）。
  const expBy = new Map((CREDIT_EXPIRE_CACHE.data?.rows ?? []).map((r) => [r.uid, r]))
  const accounts = snap.accounts.map((a) => {
    const e = expBy.get(a.uid)
    const raw = e?.expiresAt ?? null
    const real = raw && raw < EXPIRE_SENTINEL ? raw : null   // 哨兵值＝不过期，不参与排序
    return {
      ...a,
      // 积分列：查过「查积分/到期」就用上游实时值（e.live），没查过才退回 store 快照
      ...(e?.live ? { remaining: e.remaining, addonRemaining: e.addonRemaining, spendable: e.spendable } : {}),
      creditLive: e?.live === true,
      plan: planBy.get(a.uid) ?? '',
      current: a.uid === store.currentUid,
      excluded: excluded.has(a.uid),
      creditExpiresAt: real,
      creditExpiresLabel: e ? (real ? e.expiresLabel : '不过期/未公开') : '未查询',
    }
  })
  // 积分快到期的排最前（与 WB 页同口径）；无到期/未查询垫后，同层保持号池原序。
  const nowMs = Date.now()
  accounts.sort((x, y) => {
    const ex = x.creditExpiresAt ?? Number.POSITIVE_INFINITY
    const ey = y.creditExpiresAt ?? Number.POSITIVE_INFINITY
    if (ex !== ey) return ex - ey
    const sx = x.creditExpiresAt && x.creditExpiresAt - nowMs < 7 * 86400_000 ? 0 : 1
    const sy = y.creditExpiresAt && y.creditExpiresAt - nowMs < 7 * 86400_000 ? 0 : 1
    if (sx !== sy) return sx - sy
    return (y.spendable ?? 0) - (x.spendable ?? 0)
  })
  return {
    day: snap.day,
    total: accounts.length,
    accounts,
    chain: snap.chain,
    chainsFile: chainsFile?.chains ? Object.entries(chainsFile.chains).map(([k, v]) => ({ inst: k, models: v.models ?? [] })) : [],
    autoCheckin: { enabled: !!auto.enabled, installed: !!auto.launchAgentInstalled, time: auto.hour != null ? `${String(auto.hour).padStart(2, '0')}:${String(auto.minute ?? 0).padStart(2, '0')}` : '—' },
    events,
    checkedToday: accounts.filter((a) => a.checkedToday).length,
  }
}

// ── 积分过期查询（2026-11-13 用户需求）────────────────────────────────────
// 上游 /sash/api/v2/me/usage 的 qoderUsage.expiresAt 是套餐/积分过期时间（毫秒）。
// 哨兵值 253402214400000（=9999年）表示「不过期/未公开」。逐号实时查上游，
// 结果缓存 30 分钟，避免面板轮询打爆。查不动的号标 null，绝不阻塞快照。
const CREDIT_EXPIRE_CACHE = { at: 0, data: null }
const EXPIRE_SENTINEL = 253402214400000

export async function creditExpiry({ force = false } = {}) {
  if (!force && CREDIT_EXPIRE_CACHE.data && Date.now() - CREDIT_EXPIRE_CACHE.at < 30 * 60_000) {
    return CREDIT_EXPIRE_CACHE.data
  }
  const mods = await load()
  if (mods.error) return { error: mods.error }
  const store = (() => { try { return JSON.parse(readFileSync(join(QSWITCH_DIR, 'store.json'), 'utf8')) } catch { return null } })()
  if (!store) return { error: 'store.json 读不到' }
  const excluded = new Set(store.excludedAccountIds ?? [])
  const rows = []
  for (const a of store.accounts ?? []) {
    if (!a?.uid || excluded.has(a.uid)) continue
    const q = store.states?.[a.uid]?.quota ?? {}
    const row = {
      uid: a.uid,
      name: a.name ?? String(a.uid).slice(0, 8),
      remaining: q.remaining ?? 0,
      addonRemaining: q.addonRemaining ?? 0,
      spendable: (q.remaining ?? 0) + (q.addonRemaining ?? 0),
      plan: q.planName ?? '',
      expiresAt: null,   // 毫秒时间戳；null = 查询失败/未知
      expiresLabel: '查询失败',
    }
    try {
      const cred = await mods.pool.usableCredential(a.uid)
      const res = await fetch('https://openapi.qoder.com.cn/sash/api/v2/me/usage', {
        headers: { Authorization: `Bearer ${cred?.token ?? ''}` },
      })
      const u = (await res.json())?.qoderUsage
      if (typeof u?.expiresAt === 'number' && u.expiresAt > 0) {
        row.expiresAt = u.expiresAt
        row.expiresLabel = u.expiresAt >= EXPIRE_SENTINEL ? '不过期' : new Date(u.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      }
      // 🔴 2026-11-13 用户问「积分为啥一直不变」：原来积分列读 store.json 快照
      //   （只有签到/巡检才写回，调用烧掉的积分不反映）。既然这里已经逐号打了
      //   usage 接口，顺手用上游实时余额覆盖快照值——积分列变成「点查积分/到期
      //   那一刻的实时值」，30 分钟缓存内不重打。
      if (u?.userQuota || u?.addOnQuota) {
        row.remaining = Number(u.userQuota?.remaining) || 0
        row.addonRemaining = Number(u.addOnQuota?.remaining) || 0
        row.spendable = row.remaining + row.addonRemaining
        row.live = true
      }
    } catch { /* 保持 查询失败 + 快照值 */ }
    rows.push(row)
  }
  // 快过期的排前面：升序时哨兵值/未知排最后
  rows.sort((x, y) => (x.expiresAt ?? Infinity) - (y.expiresAt ?? Infinity) || y.spendable - x.spendable)
  const out = { at: Date.now(), rows, soonCount: rows.filter((r) => r.expiresAt && r.expiresAt < EXPIRE_SENTINEL && r.expiresAt - Date.now() < 7 * 86400_000).length }
  CREDIT_EXPIRE_CACHE.at = Date.now()
  CREDIT_EXPIRE_CACHE.data = out
  return out
}
