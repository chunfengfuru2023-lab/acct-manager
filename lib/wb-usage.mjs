/**
 * WB 用量账本：每次 chat 完成后记一行（号/模型/token/积分），供面板当日+历史聚合。
 *
 * 口径对齐 Qoder 侧 counts.jsonl：
 *  - credit 是上游 usage 里的实际扣分值（免费档=0），直接记不猜；
 *  - 上海日分桶；聚合按（天 × 号 × 模型）。
 * 写失败静默（账本坏不影响服务）。
 * @module acct-manager/wb-usage
 */
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const HERE = dirname(new URL(import.meta.url).pathname)
const FILE = join(HERE, '..', 'data', 'wb-usage.jsonl')
try { mkdirSync(dirname(FILE), { recursive: true }) } catch { /* 已存在 */ }

export function shanghaiDay(ms = Date.now()) { return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10) }

/** usage 为 OpenAI 形状（prompt_tokens/completion_tokens/credit/cached_tokens）。 */
export function recordWbUsage({ uid, model, usage, stream }) {
  if (!usage || !uid) return
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const row = {
    day: shanghaiDay(), at: Date.now(), uid, model,
    input: num(usage.prompt_tokens), output: num(usage.completion_tokens),
    cached: num(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens),
    reasoning: num(usage.completion_tokens_details?.reasoning_tokens),
    credit: typeof usage.credit === 'number' ? usage.credit : 0,
    ...(stream ? { stream: 1 } : {}),
  }
  if (row.input + row.output + row.credit === 0) return
  try { appendFileSync(FILE, JSON.stringify(row) + '\n') } catch { /* 账本写失败不致命 */ }
}

/**
 * 聚合：{ days: [{ day, total:{calls,input,output,credit}, byUid:[{uid,calls,input,output,credit,byModel:[...]}] }] }
 * 缺省给最近 30 天；传 day 只看那一天。
 */
export function summarizeWbUsage({ day, days = 30 } = {}) {
  let rows = []
  try {
    rows = readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return { days: [] } }
  let cutoff = ''
  if (!day) {
    const d = new Date(Date.now() - (days - 1) * 86400_000)
    cutoff = shanghaiDay(d.getTime())
  }
  const byDay = new Map()
  for (const r of rows) {
    if (day ? r.day !== day : r.day < cutoff) continue
    const perDay = byDay.get(r.day) ?? { day: r.day, total: { calls: 0, input: 0, output: 0, credit: 0 }, uids: new Map() }
    perDay.total.calls++; perDay.total.input += r.input; perDay.total.output += r.output; perDay.total.credit += r.credit
    const acc = perDay.uids.get(r.uid) ?? { uid: r.uid, calls: 0, input: 0, output: 0, credit: 0, models: new Map() }
    acc.calls++; acc.input += r.input; acc.output += r.output; acc.credit += r.credit
    const mo = acc.models.get(r.model) ?? { model: r.model, calls: 0, input: 0, output: 0, credit: 0 }
    mo.calls++; mo.input += r.input; mo.output += r.output; mo.credit += r.credit
    acc.models.set(r.model, mo)
    perDay.uids.set(r.uid, acc)
    byDay.set(r.day, perDay)
  }
  return {
    days: [...byDay.values()]
      .sort((a, b) => b.day.localeCompare(a.day))
      .map((d) => ({
        day: d.day, total: d.total,
        byUid: [...d.uids.values()].sort((a, b) => b.credit - a.credit || b.calls - a.calls)
          .map((u) => ({ ...u, byModel: [...u.models.values()].sort((a, b) => b.calls - a.calls) })),
      })),
  }
}
