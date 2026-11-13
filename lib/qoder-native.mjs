/**
 * Qoder 钉名直连：qodermodel/<id> 不经 QM，管家自己从号池取凭据打 Qoder 网关。
 *
 * 背景（2026-11-03 用户需求"像 WB 一样能加独立模型"）：QM 网关只认单名
 * Qodermanager（链式选档），钉名必须绕开它。复用 qoder-router 现成库
 * （adapter/wire/account-pool，bridge 同款路子），但凭据从 store.json 号池直取
 * （usableCredential 自带临期刷新，只读号池）——**不写 auth.v1.dat**，
 * 桌面登录态零影响。撞额度/坏凭据自动换下一号（orderedAccounts 已按可花排序）。
 * 用量写进同一本 counts.jsonl（inst='acct-gateway'），面板 Qoder 用量卡自动包含。
 * @module acct-manager/qoder-native
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { qoderModule } from './paths.mjs'

const { QoderAdapter } = await import(qoderModule('adapter.js'))
const { usableCredential, orderedAccounts, loadModelMatrix, modelUsable } = await import(qoderModule('account-pool.js'))
const { QODER_GATEWAY } = await import(qoderModule('wire.js'))

const LEDGER = join(homedir(), 'Library', 'Application Support', 'QoderSwitch', 'counts.jsonl')
const day = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

/** 矩阵里可钉的模型（去 auto）：[{id, key, free}]，供 /v1/models 与校验。 */
export function qoderPinnedModels() {
  const matrix = loadModelMatrix()
  if (!matrix) return []
  return (matrix.rows ?? [])
    .filter((r) => typeof r?.id === 'string' && r.id && r.id !== 'auto')
    .map((r) => ({
      id: r.id, key: r.key || r.id,
      free: Array.isArray(r.cells) && r.cells.length > 0 && r.cells.every((c) => c?.free === true),
    }))
}

// OpenAI tools → adapter 扁平形状（bridge 实测：不转会 400 Invalid tools[0].function）
function toQoderTools(tools) {
  if (!Array.isArray(tools)) return undefined
  const out = []
  for (const t of tools) {
    const fn = t?.function ?? t
    if (typeof fn?.name !== 'string' || fn.name.length === 0) continue
    out.push({ name: fn.name, description: typeof fn.description === 'string' ? fn.description : '', parameters: fn.parameters ?? { type: 'object', properties: {} } })
  }
  return out.length ? out : undefined
}

// OpenAI messages → harness 块数组（bridge 实测：纯字符串会让 content.filter 崩）
function toQoderMessages(messages) {
  if (!Array.isArray(messages)) return []
  const out = []
  for (const m of messages) {
    const role = ['system', 'user', 'assistant', 'tool'].includes(m?.role) ? m.role : 'user'
    let text = ''
    const raw = m?.content
    if (typeof raw === 'string') text = raw
    else if (Array.isArray(raw)) text = raw.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
    else if (raw != null) text = String(raw)
    const blocks = [{ type: 'text', text }]
    if (role === 'assistant' && Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc?.function ?? {}
        blocks.push({ type: 'tool-call', id: String(tc?.id ?? `call_${blocks.length}`), name: String(fn.name ?? ''), arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}) })
      }
    }
    const msg = { role, content: blocks }
    if (role === 'tool') msg.toolCallId = String(m?.tool_call_id ?? m?.toolCallId ?? '')
    if (role === 'assistant' && blocks.length > 1 && text.length === 0) {
      msg.content = blocks.filter((b) => b.type !== 'text')
      if (!msg.content.length) msg.content = [{ type: 'text', text: '' }]
    }
    out.push(msg)
  }
  return out
}

function toOpenAIUsage(u) {
  if (!u) return undefined
  const cache = Number(u.cacheReadTokens) || 0
  const input = Number(u.inputTokens) || 0
  const out = Number(u.outputTokens) || 0
  const reasoning = Number(u.reasoningTokens)
  const prompt = input + cache
  return {
    prompt_tokens: prompt, completion_tokens: out,
    total_tokens: prompt + out,
    prompt_tokens_details: { cached_tokens: cache },
    ...Number.isFinite(reasoning) ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {},
    ...typeof u.credits === 'number' ? { credits: u.credits } : {},
    ...typeof u.billable === 'boolean' ? { billable: u.billable } : {},
  }
}
/** 账本行（对齐 QM recordGatewayUsage 格式，inst 区分来源）。 */
function ledger(uid, rawUsage, wireKey) {
  if (!rawUsage) return
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const quoted = typeof rawUsage.credits === 'number' && rawUsage.credits >= 0 ? rawUsage.credits : 0
  const billable = rawUsage.billable === true
  const credits = billable ? quoted : 0
  const row = {
    day: day(), uid, kind: 'usage', at: Date.now(), inst: 'acct-gateway',
    model: wireKey, input: num(rawUsage.inputTokens), output: num(rawUsage.outputTokens),
    cacheRead: num(rawUsage.cacheReadTokens), reasoning: num(rawUsage.reasoningTokens),
  }
  if (credits) row.credits = credits
  if (quoted) row.quotedCredits = quoted
  row.billable = billable
  try { appendFileSync(LEDGER, JSON.stringify(row) + '\n') } catch { /* 记账失败不影响请求 */ }
}

const QUOTA_CODES = new Set(['ACCOUNT_QUOTA', 'ACCOUNT_QUOTA_EXCEEDED', 'QUOTA_EXCEEDED', 'CREDITS_EXHAUSTED'])
const AUTH_CODES = new Set(['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL'])

/**
 * 钉名补全：yield OpenAI chat.completion.chunk 形状对象（含末尾 usage chunk）。
 * 账号轮换：quota/auth → 下一号；UNKNOWN_MODEL/其他错 → 抛出。
 * 返回前保证至少开始过一次上游流；usedUid/实际模型由 done 事件带出。
 */
export async function* qoderPinnedStream(modelId, body) {
  const models = qoderPinnedModels()
  const target = models.find((m) => m.id === modelId || m.key === modelId)
  if (!target) throw Object.assign(new Error(`Qoder 没有模型 "${modelId}"`), { code: 'UNKNOWN_MODEL' })

  const candidates = orderedAccounts().filter((a) => modelUsable(a, target.id))
  if (!candidates.length) throw Object.assign(new Error('号池里没有支持该模型的可用账号'), { code: 'NO_ACCOUNT' })

  const id = `chatcmpl-${Date.now().toString(36)}`
  const created = Math.floor(Date.now() / 1000)
  const send = (extra) => ({ id, object: 'chat.completion.chunk', created, model: `qodermodel/${target.id}`, ...extra })

  let lastErr = null
  for (const account of candidates) {
    let cred
    try { cred = await usableCredential(account.uid) } catch (e) { lastErr = e; continue }
    const connection = { gateway: QODER_GATEWAY, userId: cred.uid, token: cred.token, userName: cred.name || account.name, userEmail: '' }
    const adapter = new QoderAdapter({ providerName: 'acct-manager', connection: async () => connection })
    const options = {
      model: target.id,
      messages: toQoderMessages(body.messages),
      qoderConnection: connection,
      ...(typeof body.max_tokens === 'number' ? { maxTokens: body.max_tokens } : {}),
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      ...(Array.isArray(body.stop) ? { stop: body.stop } : {}),
      ...toQoderTools(body.tools) ? { tools: toQoderTools(body.tools) } : {},
      reasoningEffort: body.reasoning_effort === 'max' ? 'max' : body.reasoning_effort === 'low' ? 'low' : 'high',
    }
    let started = false, rawUsage = null
    try {
      yield send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
      started = true
      for await (const c of adapter.streamOnce(options)) {
        if (c.type === 'text-delta' && c.text) yield send({ choices: [{ index: 0, delta: { content: c.text }, finish_reason: null }] })
        else if (c.type === 'reasoning-delta' && c.text) yield send({ choices: [{ index: 0, delta: { reasoning_content: c.text }, finish_reason: null }] })
        else if (c.type === 'tool-call-delta') yield send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...(c.id ? { id: c.id, type: 'function', function: { name: c.name ?? '', arguments: c.argumentsDelta ?? '' } } : { function: { arguments: c.argumentsDelta ?? '' } }) }] }, finish_reason: null }] })
        else if (c.type === 'usage') rawUsage = c.usage
        else if (c.type === 'finish') {
          const reason = c.reason?.kind === 'tool-calls' ? 'tool_calls' : c.reason?.kind === 'max-tokens' ? 'length' : 'stop'
          yield send({ choices: [{ index: 0, delta: {}, finish_reason: reason }], ...(toOpenAIUsage(rawUsage) ? { usage: toOpenAIUsage(rawUsage) } : {}) })
        }
      }
      ledger(account.uid, rawUsage, target.key)
      return
    } catch (err) {
      lastErr = err
      const code = String(err?.code || '')
      // 流已开跑才炸：不能换号重放（客户端已收到半截），直接收尾报错
      if (started && rawUsage) { yield send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }); return }
      if (code === 'UNKNOWN_MODEL') throw err // 模型不存在：换号无意义
      if (QUOTA_CODES.has(code) || AUTH_CODES.has(code) || /daily count exceeded|401|403/i.test(String(err?.message || ''))) continue
      throw err // 其他错（网络/上游 5xx）：抛出，让上层报错，不连撞全池
    }
  }
  throw Object.assign(new Error(`全部账号试过都不行：${String(lastErr?.message ?? lastErr)}`), { code: 'POOL_EXHAUSTED' })
}
