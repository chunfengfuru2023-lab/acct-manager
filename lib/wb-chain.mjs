/**
 * WB 统一模型链（workbuddymodel 单入口）：自定义序 + 模型级日闸。
 *
 * 语义对齐 Qodermanager：
 *  - 序文件缺失/空 → 默认序：免费档在前（按 id），付费按倍率升序；
 *  - 模型日闸：某模型当天"模型级失败"累计 N 次（默认 3）→ 今日跳过；跨天自动重置；
 *    全链被闸 → 重置防锁死（同 QM）。
 *  - 账号级失败（hard_credit/session_dead）由账号轮换消化，不计模型闸；
 *    只有 not_found / server / soft_rate / 限制类错误才 bump 模型闸。
 *
 * @module acct-manager/wb-chain
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const HERE = dirname(new URL(import.meta.url).pathname)
const DATA = join(HERE, '..', 'data')
const ORDER_FILE = join(DATA, 'wb-chain-order.json')
const GATE_FILE = join(DATA, 'wb-model-gate.json')
export const WB_GATE_N = 3

function shanghaiDay(ms = Date.now()) { return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10) }
function ensureData() { try { mkdirSync(DATA, { recursive: true }) } catch { /* 已存在 */ } }

/** 读自定义序（数组）；无文件/坏文件 → null（=默认序）。 */
export function wbCustomOrder() {
  try {
    const o = JSON.parse(readFileSync(ORDER_FILE, 'utf8')).order
    return Array.isArray(o) && o.length ? o : null
  } catch { return null }
}
/** 写自定义序；空数组 = 删文件恢复默认。原子写。 */
export function wbChainWrite(order) {
  ensureData()
  if (!Array.isArray(order) || order.length === 0) {
    if (existsSync(ORDER_FILE)) unlinkSync(ORDER_FILE)
    return { ok: true, result: '已恢复默认排序（免费在前、按倍率升序）' }
  }
  const tmp = `${ORDER_FILE}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ version: 1, order, updatedAt: Date.now() }, null, 2))
  renameSync(tmp, ORDER_FILE)
  return { ok: true, result: `链序已保存：${order.slice(0, 3).join(' → ')}${order.length > 3 ? ' …' : ''}` }
}

/**
 * 由目录构建生效链：[{id, free, credits}]。
 * custom 序里没列到的模型，按默认规则追加在链尾（不漏模型）。
 */
export function wbBuildChain(catalog) {
  const entries = (catalog ?? []).map((m) => {
    const b = m.billing ?? {}
    const mt = /x([\d.]+)/.exec(String(b.credits ?? ''))
    return { id: m.id, free: b.free === true, credits: mt ? Number(mt[1]) : null }
  })
  const byId = new Map(entries.map((e) => [e.id, e]))
  const custom = wbCustomOrder()
  if (!custom) {
    const free = entries.filter((e) => e.free).sort((a, b) => a.id.localeCompare(b.id))
    const paid = entries.filter((e) => !e.free)
      .sort((a, b) => ((a.credits ?? Infinity) - (b.credits ?? Infinity)) || a.id.localeCompare(b.id))
    return [...free, ...paid]
  }
  const head = custom.map((id) => byId.get(id)).filter(Boolean)
  const rest = entries.filter((e) => !custom.includes(e.id))
    .sort((a, b) => (a.free === b.free ? ((a.credits ?? Infinity) - (b.credits ?? Infinity) || a.id.localeCompare(b.id)) : a.free ? -1 : 1))
  return [...head, ...rest]
}

// ── 模型日闸 ────────────────────────────────────────────────────────────────
let gate = { day: '', counts: {} }
try {
  const g = JSON.parse(readFileSync(GATE_FILE, 'utf8'))
  if (g.day === shanghaiDay()) gate = g
} catch { /* 首次/换日 */ }
function saveGate() { ensureData(); try { writeFileSync(GATE_FILE, JSON.stringify(gate)) } catch { /* 闸账写不进不影响服务 */ } }
export function wbGateBump(id) {
  const day = shanghaiDay()
  if (gate.day !== day) gate = { day, counts: {} }
  gate.counts[id] = (gate.counts[id] ?? 0) + 1
  saveGate()
  return gate.counts[id]
}
export function wbGateClear(id) {
  if (gate.counts[id]) { delete gate.counts[id]; saveGate() }
}
export function wbGated(id) {
  const day = shanghaiDay()
  if (gate.day !== day) { gate = { day, counts: {} }; return false }
  return (gate.counts[id] ?? 0) >= WB_GATE_N
}
/** 全链被闸 → 重置（防锁死，同 QM）。 */
export function wbGateReset() { gate = { day: shanghaiDay(), counts: {} }; saveGate() }
export function wbGateState() { return { day: gate.day, counts: { ...gate.counts } } }
