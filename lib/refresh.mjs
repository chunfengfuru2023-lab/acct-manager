#!/usr/bin/env node
/**
 * acct-manager · 定时刷新（每天 00:00 / 12:00，LaunchAgent 挂载）
 *
 * 用户需求（2026-11-04）：两端模型清单 + 积分消耗，每天零点、中午各刷一次。
 *
 * 做的四件事，全部只读上游，不打请求到模型端点：
 *  1. WB 目录：拉一次实时目录 → 写 data/model-catalog.wb.json（含 free/credits）。
 *     catalogCache 有 60s TTL，直接问网关拿最省；拿不到再自己 fetchModels。
 *  2. WB 积分：patrol 的 balance 口径（pickAccounts 取可用号查 fetchCredits）。
 *  3. Qoder 池积分：读自动版 store.json 的 states[uid].quota（零请求）。
 *  4. Qoder 模型矩阵：只读 model-matrix.json（deep 扫描是凌晨 4:30 的活，这里不抢）。
 * 结果落 data/refresh-snapshot.json，面板状态接口顺带带上，界面能看到"上次刷新"。
 *
 * 退出码：0 成功 / 1 有失败项（部分端点出错，但快照照写）
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const HERE = dirname(new URL(import.meta.url).pathname)
const DATA = join(HERE, '..', 'data')
const SNAP = join(DATA, 'refresh-snapshot.json')
const QSWITCH = join(homedir(), 'Library', 'Application Support', 'QoderSwitch')

mkdirSync(DATA, { recursive: true })

const errs = []
const log = (m) => console.log(`[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}] ${m}`)
const err = (where, e) => { errs.push({ where, error: String(e?.message ?? e).slice(0, 160) }); log(`✗ ${where}: ${String(e?.message ?? e).slice(0, 160)}`) }

function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback } }

/** 后端运行时（Electron env 兜底必须在构造 store 之前）。 */
let CLIENT, VARIANTS, pickAccounts, sweepCooldown
try {
  const rt = await import('./runtime.mjs')
  CLIENT = rt.CLIENT; VARIANTS = rt.VARIANTS
  rt.ensureElectronEnv()
  const pool = await import('./pool.mjs')
  pickAccounts = pool.pickAccounts; sweepCooldown = pool.sweepCooldown
} catch (e) { err('import runtime', e) }

const snapshot = { at: Date.now(), atIso: new Date().toISOString(), wb: {}, qoder: {}, errors: [] }

// ── 1 + 2. WorkBuddy：模型目录 + 积分 ────────────────────────────────────────
if (CLIENT) {
  sweepCooldown?.()

  for (const [vk, meta] of Object.entries(VARIANTS ?? {})) {
    // 模型：上游只在能取到可用凭据时才有目录，拿不到就留空并记失败
    try {
      const cred = pickAccounts(vk)[0]
      if (!cred) throw new Error('池内无可用号（空池或全冷却）')
      const models = await CLIENT.fetchModels(cred)
      snapshot.wb[vk] = {
        label: meta.label,
        models: (models ?? []).map((m) => ({
          id: m.id,
          free: m.billing?.free === true,
          credits: m.billing?.credits ?? null,
        })),
        freeCount: (models ?? []).filter((m) => m.billing?.free === true).length,
      }
      log(`WB ${vk} 目录 ${snapshot.wb[vk].models.length} 个（免费 ${snapshot.wb[vk].freeCount}）`)
    } catch (e) { err(`WB ${vk} 目录`, e) }

    // 积分：与 patrol 同口径，一次查询
    try {
      const cred = pickAccounts(vk)[0]
      if (!cred) throw new Error('池内无可用号')
      const c = await CLIENT.fetchCredits(cred)
      snapshot.wb[vk] = {
        ...(snapshot.wb[vk] ?? {}),
        balance: { total: c.total ?? 0, packages: (c.accounts ?? []).length },
      }
      log(`WB ${vk} 积分合计 ${c.total ?? 0}`)
    } catch (e) { err(`WB ${vk} 积分`, e) }
  }
}

// ── 3. Qoder 池积分（读 store.json 的 states[uid].quota，零请求） ────────────
// 余额真源是自动版 store.json 的 states[uid].quota（remaining 套餐 + addonRemaining 加购）；
// accounts[] 里没这两个字段。自动版 CLI 没有 --status 这类查询命令，不自己造。
try {
  const store = readJson(join(QSWITCH, 'store.json'), {})
  const excluded = new Set(store.excludedAccountIds ?? [])
  const states = store.states ?? {}
  const accounts = (store.accounts ?? []).filter((a) => !excluded.has(a.uid))
  const rows = accounts.map((a) => {
    const q = states[a.uid]?.quota ?? {}
    return {
      name: a.name ?? String(a.uid).slice(0, 8),
      remaining: q.remaining ?? 0,
      addonRemaining: q.addonRemaining ?? 0,
      spendable: (q.remaining ?? 0) + (q.addonRemaining ?? 0),
      plan: q.planName ?? '',
      quotaAt: states[a.uid]?.quotaAt ?? 0,
    }
  })
  const stamps = rows.map((r) => r.quotaAt).filter((t) => t > 0)
  snapshot.qoder.pool = {
    accounts: rows.length,
    spendable: rows.reduce((s, r) => s + r.spendable, 0),
    // 余额只在签到/巡检时更新：给最旧一条的时间，太旧说明面板上的数字是陈的
    oldestQuotaAt: stamps.length ? Math.min(...stamps) : null,
    noQuotaAccounts: rows.filter((r) => !r.quotaAt).length,
    rows,
  }
  log(`Qoder 池 ${rows.length} 个号，可花合计 ${snapshot.qoder.pool.spendable}（${snapshot.qoder.pool.noQuotaAccounts} 个号无余额记录）`)
} catch (e) { err('Qoder 号池', e) }

// ── 4. Qoder 模型矩阵（只读；deep 扫描不归这里） ────────────────────────────
try {
  const m = readJson(join(QSWITCH, 'model-matrix.json'), null)
  if (!m) throw new Error('model-matrix.json 读不到')
  const rows = (m.rows ?? []).filter((r) => r?.id && r.id !== 'auto')
  snapshot.qoder.matrix = {
    generatedAt: m.generatedAt,
    models: rows.length,
    free: rows.filter((r) => (r.cells ?? []).length && r.cells.every((c) => c?.free === true)).map((r) => r.id),
  }
  const cat = readJson(join(QSWITCH, 'catalog-snapshot.json'), null)
  if (cat?.models) {
    const known = new Set(rows.map((r) => r.id))
    snapshot.qoder.liveUnlisted = cat.models.map((x) => x.id).filter((id) => id && id !== 'auto' && !known.has(id))
    snapshot.qoder.liveAt = cat.fetchedAt ?? ''
  }
  log(`Qoder 矩阵 ${rows.length} 个模型（免费 ${snapshot.qoder.matrix.free.length}），未登记 ${(snapshot.qoder.liveUnlisted ?? []).length}`)
} catch (e) { err('Qoder 矩阵', e) }

// ── 落盘（原子写）────────────────────────────────────────────────────────────
snapshot.errors = errs
try {
  const tmp = `${SNAP}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2))
  renameSync(tmp, SNAP)
  log(`快照已写 ${SNAP}（失败项 ${errs.length}）`)
} catch (e) { console.error('快照写入失败:', String(e?.message ?? e)) }

process.exit(errs.length ? 1 : 0)
