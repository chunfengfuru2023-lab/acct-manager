#!/usr/bin/env node
/**
 * acct-manager · 统一网关（loopback OpenAI 兼容出口 `workbuddymodel`）
 *
 * 一个进程一个端口，只监听 127.0.0.1。把池内 WorkBuddy / WorkBuddy AI 账号的全部
 * 模型汇成一个链接：任意吃 OpenAI 兼容 base URL 的 agent 填 URL + bearer 即用。
 *
 * 出口命名： workbuddymodel/cn:<id>（国际版 AI 变体 2026-11-02 起停用）
 *   GET  /health                 探针（免鉴权）
 *   GET  /v1/models              只读合并各版目录（缓存，不打计费）
 *   GET  /workbuddy/balances     只读积分/包到期观测（⚠️ 上游按次计费查询，别轮询）
 *   POST /v1/chat/completions    流式/非流式透传，一次一号 + 分档冷却
 *
 * 上游协议、身份头、UA 分裂、SSE 全复用 dsh-workbuddy-qoder-connect 现成类。
 * 账号池走 lib/pool.mjs（Keychain 主密钥 + AES-256-GCM 密文落盘，只读 App 登录态）。
 * 网关自身不 refresh（续期归 patrol 巡检）；拒绝非 loopback 来源。
 *
 * @module acct-manager/gateway
 */
import { createServer } from 'node:http'
import { appendFileSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { CLIENT, VARIANTS, ensureElectronEnv, buildStore } from './lib/runtime.mjs'
import { pickAccounts, patchAccount, sweepCooldown, listAccounts, upsertAccount, wbAccountOrder, wbAccountOrderWrite } from './lib/pool.mjs'
import { getOrCreateGatewaySecret, getOrCreatePanelToken } from './lib/keychain.mjs'
import { qoderFull, qmChain, qmChainWrite, qoderUsage, creditExpiry } from './lib/qoder-view.mjs'
import { qoderPinnedStream, qoderPinnedModels } from './lib/qoder-native.mjs'
import { wbBuildChain, wbChainWrite, wbCustomOrder, wbGateBump, wbGateClear, wbGated, wbGateReset, wbGateState, WB_GATE_N } from './lib/wb-chain.mjs'
import { recordWbUsage, summarizeWbUsage, shanghaiDay } from './lib/wb-usage.mjs'
import { switchWbAccount, currentWbAccount, captureCurrentProfile, harvestNames, selfTestWbSwitch } from './lib/wb-switch.mjs'
import { wbCreditExpiry, wbCreditView } from './lib/wb-credits.mjs'
import { lanIp, createKey, revokeKey, deleteKey, setLimit, matchKey, keyAllowed, recordUsage, listKeys } from './lib/lan-keys.mjs'
import { QODER_ACTIONS, qoderSwitch, qoderAddByToken } from './lib/qoder-ops.mjs'
import { anthropicToOpenAI, makeAnthropicStreamTranslator, openaiToAnthropicMessage, anthropicErrorBody } from './lib/anthropic.mjs'

ensureElectronEnv() // 兜底：单独起网关时也能解密 App 登录态

const HERE = dirname(new URL(import.meta.url).pathname)
const PORT = Number(process.argv[process.argv.indexOf('--port') + 1] || 19400)
const EVENTS_FILE = join(HERE, 'data', 'events.jsonl')

/** 与 patrol 同一本事件账；限流/冷却/账号限制标记都记这里。写坏不影响服务。 */
function event(type, data) {
  try { appendFileSync(EVENTS_FILE, JSON.stringify({ at: Date.now(), type, ...data }) + '\n') } catch { /* 忽略 */ }
}

// ── 账号选取（池内过滤冷却/过期，LRU 轮号；cred 形状对齐 chatStream 入参）───
function accountCandidates(variantKey) {
  return pickAccounts(variantKey).map((a) => ({ uid: a.uid, cred: a }))
}

// 一次一号：同一令牌同一时刻只服务一个进行中的会话（防"单点并发"这一最强信号）
const inFlight = new Set()

// ── 模型目录缓存（只读 /v3/config，不打计费；TTL 内复用）────────────────────
const catalogCache = new Map() // variantKey → {at, models}
const CATALOG_TTL_MS = 60_000
async function catalog(variantKey) {
  const hit = catalogCache.get(variantKey)
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.models
  const cred = accountCandidates(variantKey)[0]?.cred
  if (!cred) return hit?.models ?? [] // 池空/全冷却时退回旧缓存
  const models = await CLIENT.fetchModels(cred)
  catalogCache.set(variantKey, { at: Date.now(), models })
  return models
}

function exposedId(variantKey, modelId) { return `workbuddymodel/${variantKey}:${modelId}` }
/** 解析模型名：workbuddymodel/cn:<id> 钉死单模型（支持逗号钉多个，按序降档）；裸 workbuddymodel 走统一链。 */
function parseExposed(name) {
  const n = name ?? ''
  if (n === 'workbuddymodel') return { variantKey: 'cn', chain: true, modelId: null }
  const m = /^workbuddymodel\/(cn):(.+)$/.exec(n)
  if (!m) return null
  const ids = m[2].split(',').map(s => s.trim()).filter(Boolean)
  if (!ids.length) return null
  return { variantKey: m[1], modelId: ids[0], modelIds: ids }
}

// ── qodermodel：统一转发 Qodermanager 网关（18300）────────────────────────────
// 2026-11-02 用户拍板：Qoder 侧唯一出口 = Qodermanager（链路由/日闸/切号/记账都在它内部，
// 口令 QM_TOKEN 在 QoderSwitch/qodermanager.env）。此前转 bridge(19399) 的钉名模式下线：
// QM 只收 "Qodermanager" 一个名，钉名转过去必 400，列出来就是骗人。
// bridge 本体不动不退役——WorkBuddy App 内自定义模型还指着它。
const QM_ENV_FILE = join(homedir(), 'Library', 'Application Support', 'QoderSwitch', 'qodermanager.env')
function qmEndpoint() {
  try {
    const env = readFileSync(QM_ENV_FILE, 'utf8')
    const port = Number(/QM_PORT=(\d+)/.exec(env)?.[1] || 18300)
    const token = /QM_TOKEN=(\S+)/.exec(env)?.[1] || ''
    return { base: `http://127.0.0.1:${port}`, token }
  } catch { return { base: 'http://127.0.0.1:18300', token: '' } }
}
/**
 * 解析 Qoder 模型名：
 *  - 裸 qodermodel        → 走 QM 网关链（链序/日闸/QM 记账）
 *  - qodermodel/<模型id>  → 钉名直连号池（qoder-native，绕开 QM 的单名限制）
 */
function parseQoderExposed(name) {
  const n = name ?? ''
  if (n === 'qodermodel') return { pinned: null }
  const m = /^qodermodel\/(.+)$/.exec(n)
  return m ? { pinned: m[1].trim() } : null
}
async function qoderChat(res, body, wantStream) {
  const upstream = await qoderUpstream(body)
  if (upstream.err) return openaiErr(res, 502, 'qm_unreachable', upstream.err)
  if (!upstream.response.ok) {
    const text = (await upstream.response.text().catch(() => '')).slice(0, 300)
    return openaiErr(res, upstream.response.status, 'upstream_error', text)
  }
  if (wantStream) return pipeStream(res, upstream.response)
  const text = await upstream.response.text()
  return json(res, 200, aggregateSse(text, body.model))
}
async function qoderChatAnthropic(res, body, requestedModel, wantStream) {
  const upstream = await qoderUpstream(body)
  if (upstream.err) return json(res, 502, anthropicErrorBody('api_error', upstream.err))
  if (!upstream.response.ok) {
    const text = (await upstream.response.text().catch(() => '')).slice(0, 300)
    return json(res, upstream.response.status, anthropicErrorBody('api_error', text))
  }
  if (wantStream) return pipeStreamAnthropic(res, upstream.response, requestedModel)
  const text = await upstream.response.text()
  return json(res, 200, openaiToAnthropicMessage(aggregateSse(text, requestedModel)))
}

// ── qodermodel/<id> 钉名：管家原生直连号池（不绕 QM，绕开其单名限制）────────
/** 收集 qoderPinnedStream 的 chunk → 聚合 OpenAI chat.completion（非流式用）。 */
async function collectPinned(gen, requestedModel) {
  let text = '', reasoning = '', finish = 'stop', usage
  const tools = new Map()
  for await (const ch of gen) {
    if (ch.usage) usage = ch.usage
    const d = ch.choices?.[0]?.delta ?? {}
    if (typeof d.content === 'string') text += d.content
    if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content
    for (const tc of d.tool_calls ?? []) {
      const cur = tools.get(0) ?? { id: '', name: '', args: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name = tc.function.name
      if (tc.function?.arguments) cur.args += tc.function.arguments
      tools.set(0, cur)
    }
    if (ch.choices?.[0]?.finish_reason) finish = ch.choices[0].finish_reason
  }
  const msg = { role: 'assistant', content: text }
  if (reasoning) msg.reasoning_content = reasoning
  if (tools.size) msg.tool_calls = [...tools.values()].map((t) => ({ id: t.id || randomUUID(), type: 'function', function: { name: t.name, arguments: t.args } }))
  return { id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, message: msg, finish_reason: finish }], ...usage ? { usage } : {} }
}
/** 钉名 → OpenAI 协议出口（流式逐 chunk 下发 / 非流式聚合）。 */
async function qoderPinnedChat(res, modelId, body, wantStream, auth, onUsage) {
  const gen = qoderPinnedStream(modelId, body)
  if (wantStream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    try {
      for await (const ch of gen) { if (ch.usage) onUsage?.(ch.usage); res.write(`data: ${JSON.stringify(ch)}\n\n`) }
      res.write('data: [DONE]\n\n')
    } catch (e) { res.write(`data: ${JSON.stringify({ error: { message: String(e?.message ?? e), type: 'upstream_error' } })}\n\n`) }
    finally { res.end() }
    return
  }
  try {
    const result = await collectPinned(gen, body.model)
    onUsage?.(result.usage)
    if (auth?.key) { try { recordUsage(auth.key, { input: result.usage?.prompt_tokens || 0, output: result.usage?.completion_tokens || 0 }) } catch { /* 计量失败不挡 */ } }
    return json(res, 200, result)
  } catch (e) {
    return openaiErr(res, mapStatus({ kind: String(e?.code ?? 'upstream'), message: String(e?.message ?? e) }), 'upstream_error', String(e?.message ?? e).slice(0, 200))
  }
}
/** 钉名 → Anthropic 协议出口（翻译器逐 chunk 喂）。 */
async function qoderPinnedChatAnthropic(res, modelId, body, requestedModel, wantStream, onUsage) {
  const gen = qoderPinnedStream(modelId, body)
  if (wantStream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const tr = makeAnthropicStreamTranslator(requestedModel)
    try {
      for await (const ch of gen) { if (ch.usage) onUsage?.(ch.usage); const frame = tr.feed(JSON.stringify(ch)); if (frame) res.write(frame) }
      const tail = tr.finish(); if (tail) res.write(tail)
    } catch (e) { const f = tr.finish(); if (f) res.write(f) }
    finally { res.end() }
    return
  }
  try {
    const result = await collectPinned(gen, requestedModel)
    onUsage?.(result.usage)
    return json(res, 200, openaiToAnthropicMessage(result))
  } catch (e) {
    return json(res, 502, anthropicErrorBody('api_error', String(e?.message ?? e).slice(0, 200)))
  }
}
/** 打 Qodermanager 网关（链路由/日闸/切号/记账全在它内部）；返回 {response} 或 {err}。 */
async function qoderUpstream(body) {
  const { base, token } = qmEndpoint()
  if (!token) return { err: 'QM_TOKEN 读不到（qodermanager.env 缺失？）' }
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, model: 'Qodermanager', stream: true }), // QM 只认这一个名，恒流式
      signal: AbortSignal.timeout(300_000),
    })
    return { response }
  } catch (e) {
    return { err: `Qodermanager(18300) 不可达：${String(e).slice(0, 120)}` }
  }
}

/**
 * WB 链式路由（两协议共用）：
 *  - 裸名 workbuddymodel → 全链依序试（wb-chain 自定义序/默认序 + 模型日闸）；
 *  - 钉名 workbuddymodel/cn:<id> → 只试该模型（尊重显式选择，不查闸）。
 * 失败语义：账号级（额度/会话死/限制/软限）→ 冷却该号换下一个；
 * 模型级（not_found/client/server）→ 降档到链中下一个模型并计闸。
 * 命中返回 {ok:true, response, usedModel}；全败 {ok:false, err}。
 */
async function runWbChat(target, body) {
  const vk = target.variantKey
  if (!accountCandidates(vk).length) return { ok: false, err: { kind: 'no_available_account', message: `workbuddymodel/${vk} 无可用账号（池空、未登录或全部冷却）`, status: 503 } }

  let models
  if (target.chain) {
    const cat = await catalog(vk)
    models = wbBuildChain(cat)
    if (!models.length) return { ok: false, err: { kind: 'no_models', message: 'WB 目录为空（号未登录或取目录失败）', status: 503 } }
    if (models.every((m) => wbGated(m.id))) { wbGateReset(); event('wb-gate-reset', { reason: 'all-gated' }) } // 全闸重置防锁死（同 QM）
  } else {
    models = (target.modelIds ?? [target.modelId]).map((id) => ({ id }))
  }

  let lastErr
  // 🔴 换号预算（2026-11-13）：改成「全池挨个试」后，最坏情况是 链长×池大小 次上游请求。
  //   防御红线要求不制造重试风暴，这里给单次请求封顶：超了就收尾报错，交人工/下一轮。
  const MAX_ATTEMPTS = 12
  let attempts = 0
  for (const model of models) {
    if (attempts >= MAX_ATTEMPTS) { event('wb-attempt-budget', { limit: MAX_ATTEMPTS, lastModel: model.id }); break }
    if (target.chain && wbGated(model.id)) continue // 今日已闸的模型直接降档
    const upstreamBody = JSON.stringify({ ...body, model: model.id, stream: true }) // 上游恒流式
    let modelBroken = false
    let tried = 0        // 本模型真实打过几个号
    let modelFailed = 0  // 其中「非账号级」失败几个（全池都失败才判模型坏）
    for (const { uid, cred } of accountCandidates(vk)) { // 每模型重取：被前序模型冷却掉的号自动跳过
      if (!cred.accessToken) { // 解密失败/密文损坏：不发空令牌撞 401（那会被误判 session_dead）
        lastErr = { kind: 'pool_corrupt', message: `账号 ${uid.slice(0, 8)} 凭据解不开，需重新 --sync` }
        continue
      }
      if (inFlight.has(uid)) continue
      if (attempts >= MAX_ATTEMPTS) break
      attempts += 1
      inFlight.add(uid)
      let result
      try { result = await CLIENT.chatStream(cred, upstreamBody) } finally { inFlight.delete(uid) }
      if (result.ok) {
        patchAccount(vk, uid, { lastUsedMs: Date.now() })
        if (target.chain) { wbGateClear(model.id); event('wb-chain-route', { model: model.id, uid: uid.slice(0, 8) }) }
        return { ok: true, response: result.response, usedModel: model.id, usedUid: uid }
      }
      lastErr = result
      tried += 1
      // 失败明细必须落账：2026-11-03 kimi 断线排查时事件里只有模型闸、没有失败原因，
      // 导致「其他号有积分却断了」查不动。这里把 kind/status/上游原文（截断）记下来。
      event('wb-attempt-fail', {
        variant: vk, model: model.id, uid: uid.slice(0, 8),
        kind: result.kind ?? 'unknown', status: result.status ?? 0,
        message: String(result.message ?? '').slice(0, 240),
      })
      // 账号级限制：停手长凉置（24h）并记账，换下一个号——绝不连撞同一号
      if (isAccountRestricted(result)) {
        setCooldown(vk, uid, 'restricted', 24 * 3600_000)
        event('account-restricted', { variant: vk, uid: uid.slice(0, 8), status: result.status, message: String(result.message ?? '').slice(0, 200) })
        continue
      }
      // 分档冷却：额度/会话死 停 6h（patrol/人工可提前清）；软限 60s——都是账号级，换号
      if (result.kind === 'hard_credit' || result.kind === 'session_dead') { setCooldown(vk, uid, result.kind, 6 * 3600_000); event('cooldown', { variant: vk, uid: uid.slice(0, 8), kind: result.kind }); continue }
      if (result.kind === 'soft_rate') { setCooldown(vk, uid, result.kind, 60_000); continue }
      // 🔴 2026-11-13 断线根因修复：原来这里 `modelBroken = true; break`——
      //   任何被 connector 归成 client/server 的失败（模型未对该号开通、403 request
      //   illegal、上游偶发 5xx、额度文案不在标记表里……）都会【只试第一个号就跳出
      //   账号循环】。钉名单模型时直接整条请求失败，链式时把整条链 3 轮闸光 → 表现为
      //   「其他账号明明有积分，却断了」。实测 2026-11-03 16:41–16:59 全链 16 个模型
      //   各闸 3 次、期间零条账号冷却事件 = 从未换过号，正是这条 break 干的。
      //   现在：只有 404 not_found（模型真的不存在）才判定模型级、立即降档；
      //   其余一律继续换下一个号，全池试完才认定该模型坏了。
      if (result.kind === 'not_found') { modelBroken = true; break }
      modelFailed += 1
    }
    // 全池都没成功 → 该模型这一轮算失败（链式才计闸；钉名不计闸，尊重显式选择）
    if (target.chain && (modelBroken || (tried > 0 && modelFailed > 0))) {
      const n = wbGateBump(model.id)
      event('wb-model-gate', { model: model.id, n, tried, reason: modelBroken ? 'not_found' : 'all-accounts-failed' })
      continue
    }
    if (!target.chain && (target.modelIds?.length ?? 1) <= 1) break // 单钉名：全池试完即止；多钉名按序降档
  }
  return { ok: false, err: lastErr }
}

// ── SSE 工具 ────────────────────────────────────────────────────────────────
function* sseData(text) {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('data:')) yield t.slice(5).trim()
  }
}
/** 非流式：消费整段 SSE，聚合成一条 chat.completion。 */
function aggregateSse(text, requestedModel) {
  let content = '', finish = 'stop', usage, reasoning = ''
  const tools = new Map() // index → {id,name,args}
  for (const data of sseData(text)) {
    if (!data || data === '[DONE]') continue
    let chunk
    try { chunk = JSON.parse(data) } catch { continue }
    if (chunk.usage) usage = chunk.usage
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
    if (!choice) continue
    if (choice.finish_reason) finish = choice.finish_reason
    const delta = choice.delta ?? choice.message ?? {}
    if (typeof delta.content === 'string') content += delta.content
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0
      const cur = tools.get(idx) ?? { id: '', name: '', args: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name = tc.function.name
      if (tc.function?.arguments) cur.args += tc.function.arguments
      tools.set(idx, cur)
    }
  }
  const msg = { role: 'assistant', content }
  if (reasoning) msg.reasoning_content = reasoning
  if (tools.size) msg.tool_calls = [...tools.entries()].sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({ id: t.id || randomUUID(), type: 'function', function: { name: t.name, arguments: t.args } }))
  return {
    id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
    model: requestedModel, choices: [{ index: 0, message: msg, finish_reason: finish }],
    ...usage ? { usage } : {},
  }
}

/** 分档冷却写入池（patchAccount 里 token 字段是加密的，冷却字段明文直存）。 */
function setCooldown(variantKey, uid, kind, ms) {
  patchAccount(variantKey, uid, { cooldownUntilMs: Date.now() + ms, cooldownKind: kind })
}

/**
 * 上游"账号级限制"标记检测（防御红线）：官方主动把号判异常时会回 403/限制语，
 * 这类信号必须长凉置且绝不反复拿该号重试——重试只会加重风控。connector 只把 403
 * 归成 generic client，这里补一层语义识别。命中即停手、记账、等人工/patrol。
 */
const RESTRICTION_MARKERS = ['11140', 'restricted', 'unusual activity', '已被限制', '异常行为', '限制使用']
function isAccountRestricted(result) {
  if (result.status !== 403 && result.kind !== 'client') return false
  const hay = String(result.message ?? '')
  return RESTRICTION_MARKERS.some((m) => hay.includes(m))
}

// ── 管理面板实现 ────────────────────────────────────────────────────────────
// 令牌：网关心给浏览器的 HTML 注入，跨站脚本伪造不了（自定义头触发 CORS 预检，
// 网关不应答 OPTIONS → 恶意页面被浏览器拦死）。同源 fetch 无影响。
const PANEL_TOKEN = getOrCreatePanelToken()
const PANEL_FILE = join(HERE, 'web', 'panel.html')

function panelTokenOk(req) {
  const presented = String(req.headers['x-panel-token'] ?? '')
  const a = Buffer.from(presented), b = Buffer.from(PANEL_TOKEN)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
function panelHtml(req, res) {
  let html
  try { html = readFileSync(PANEL_FILE, 'utf8') } catch { return json(res, 500, { error: 'panel.html 缺失' }) }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html.replace('__PANEL_TOKEN__', PANEL_TOKEN))
}
async function panelState(res) {
  const accOrder = wbAccountOrder()
  const rankOf = (uid) => { const i = accOrder.findIndex((p) => uid === p || uid.startsWith(p)); return i < 0 ? 999 : i }
  // 2026-11-13：账号表对齐 Qoder 页——带展示名、积分、积分过期时间、今日调用、当前登录号。
  // 积分/过期读 wb-credits 缓存（计费接口有成本，不随 30s 轮询打）；没查过就是「未查询」。
  const creditBy = new Map(wbCreditView().map((c) => [c.uid, c]))
  const currentWb = await currentWbAccount().catch(() => null)
  const todayWb = new Map((summarizeWbUsage({ day: shanghaiDay() }).days[0]?.byUid ?? []).map((u) => [u.uid, u]))
  const accounts = listAccounts().map((a) => {
    const c = creditBy.get(a.uid) ?? {}
    return {
      label: VARIANTS[a.variantKey]?.label ?? a.variantKey,
      uid: a.uid.slice(0, 8),
      fullUid: a.uid,                       // 切号动作要全 uid（前缀也认，但全量最稳）
      name: c.name ?? a.uid.slice(0, 8),
      current: currentWb?.uid === a.uid,     // WB 桌面端当前登录号
      credit: c.total ?? null,               // 积分余额（null=未查询）
      creditExpiresAt: c.expiresAt ?? null,  // 最早到期的有余额积分包
      creditExpiresLabel: c.expiresLabel ?? '未查询',
      creditExpiresPackage: c.expiresPackage ?? '',
      creditError: c.creditError ?? '',
      todayCalls: todayWb.get(a.uid)?.calls ?? 0,
      todayCredit: todayWb.get(a.uid)?.credit ?? 0,
      expiresAtMs: a.expiresAtMs,
      cooldownUntilMs: a.cooldownUntilMs,
      cooldownKind: a.cooldownKind,
      _rank: rankOf(a.uid), _last: a.lastUsedMs || 0,
    }
  })
  // 积分快过期的排最前（用户 2026-11-13 要求，与 Qoder 页同口径）：
  //   ① 有到期时间的按升序；② 无到期/未查询的垫后；③ 同层仍尊重自定义消耗序 → LRU。
  //   注意：这只是**展示序**，真实消耗序仍由 accOrder/pickAccounts 决定，两者分开不混淆。
  const nowMs = Date.now()
  accounts.sort((a, b) => {
    const ea = a.creditExpiresAt ?? Number.POSITIVE_INFINITY
    const eb = b.creditExpiresAt ?? Number.POSITIVE_INFINITY
    if (ea !== eb) return ea - eb
    const soonA = a.creditExpiresAt && a.creditExpiresAt - nowMs < 7 * 86400_000 ? 0 : 1
    const soonB = b.creditExpiresAt && b.creditExpiresAt - nowMs < 7 * 86400_000 ? 0 : 1
    if (soonA !== soonB) return soonA - soonB
    return a._rank - b._rank || a._last - b._last
  })
  const models = {}
  for (const vk of Object.keys(VARIANTS)) {
    try { models[vk] = (await catalog(vk)).map((m) => ({ id: m.id, credits: m.billing?.credits ?? null, free: m.billing?.free === true })) } catch { models[vk] = [] }
  }
  const qoderPool = await qoderFull().catch(() => ({ error: '快照失败' }))
  const qm = await qmChain().catch(() => null)
  const qoder = (qm?.chain ?? []).map((m) => m.id) // QM 徽章=链序（钉名已下线，仅展示排序用）
  // WB 统一链生效序（含闸状态），供面板编辑器
  let wb = null
  try {
    const cat = await catalog('cn').catch(() => [])
    wb = { chain: wbBuildChain(cat), custom: !!wbCustomOrder(), gate: wbGateState(), gateN: WB_GATE_N }
  } catch { /* 目录空时编辑器显示占位 */ }
  let buddy = null
  try { buddy = JSON.parse(readFileSync(join(HERE, 'data', 'buddy-status.json'), 'utf8')) } catch { /* 还没跑过 */ }
  const lan = { on: LAN_ON, ip: lanIp(), port: PORT, keys: listKeys() }
  // 定时刷新快照（lib/refresh.mjs，每天 00:00 / 12:00 由 launchd 跑）
  let refresh = null
  try { refresh = JSON.parse(readFileSync(join(HERE, 'data', 'refresh-snapshot.json'), 'utf8')) } catch { /* 还没跑过 */ }
  return json(res, 200, { accounts, models, qoder, qoderPool, qm, wb, buddy, refresh, accOrder: { order: accOrder, custom: accOrder.length > 0 }, lan })
}
// 积分过期查询（2026-11-13 用户需求）：Qoder 号池逐号查上游 expiresAt，快过期排前。
// ?force=1 跳过 30 分钟缓存重查（面板「查积分/到期」按钮）；默认吃缓存。
async function panelCreditExpiry(req, res) {
  const force = new URL(req.url, 'http://x').searchParams.get('force') === '1'
  const r = await creditExpiry({ force }).catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) }))
  return json(res, 200, r)
}
// WB 积分过期查询（同口径）：逐号打官方计费接口取积分包，最早到期的有余额包排前。
// ?force=1 跳过 30 分钟缓存重查；计费查询有成本，默认吃缓存。
async function panelWbCreditExpiry(req, res) {
  const force = new URL(req.url, 'http://x').searchParams.get('force') === '1'
  const r = await wbCreditExpiry({ force }).catch((e) => ({ error: String(e?.message ?? e).slice(0, 160) }))
  return json(res, 200, r)
}
async function panelBalances(res) {
  // 逐号查积分（计费查询有成本：手动触发、串行、每号间隔 300ms）
  const accounts = []
  for (const vk of Object.keys(VARIANTS)) {
    for (const { uid, cred } of accountCandidates(vk)) {
      try {
        const c = await CLIENT.fetchCredits(cred)
        const soon = (c.accounts ?? []).filter((p) => p.endTimeMs - Date.now() < 3 * 86400_000 && p.remain > 0)
          .map((p) => `${p.packageName} 剩${p.remain}（${Math.round((p.endTimeMs - Date.now()) / 86400000 * 10) / 10}天后过期）`)
        accounts.push({ variant: vk, uid: uid.slice(0, 8), total: c.total, packages: (c.accounts ?? []).length, expiringSoon: soon })
      } catch (e) { accounts.push({ variant: vk, uid: uid.slice(0, 8), error: String(e).slice(0, 100) }) }
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  const byVariant = {}
  for (const a of accounts) { (byVariant[a.variant] ??= []).push(a) }
  return json(res, 200, { accounts, byVariant })
}
/**
 * 双引擎用量（当日+历史）：WB 读自己的 wb-usage.jsonl；Qoder 读 counts.jsonl
 * （QM 网关实时写，我们只读聚合）。两边同构输出，面板一套渲染。
 * ?days=N 控制历史窗口（默认 8 天）。
 */
async function panelUsage(req, res) {
  const days = Math.min(60, Math.max(1, Number(new URL(req.url, 'http://x').searchParams.get('days')) || 8))
  const wb = summarizeWbUsage({ days })
  const qoder = await qoderUsage({ days })
  // 免费档清单：实扣 0 是正常还是异常，面板要能区分（2026-11-04 用户指正：
  // 免费档上游本来就不扣，不能一律标红）
  wb.freeModels = freeModelSet(await catalog('cn').catch(() => []), (m) => m.billing?.free === true)
  return json(res, 200, { wb, qoder, days, at: Date.now() })
}
/** 目录里 free=true 的模型 → {id: true}。 */
function freeModelSet(models, isFree) {
  const out = {}
  for (const m of models ?? []) if (m?.id && isFree(m)) out[m.id] = true
  return out
}
/** 起独立 node 子进程跑脚本（buddy-run 读池写状态，不阻塞网关主循环）。 */
function runScript(script, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script], { timeout: timeoutMs, maxBuffer: 4 << 20 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '') }))
  })
}
const tailLine = (s) => String(s || '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''

async function panelAction(req, res) {
  let body
  try { body = JSON.parse(await readBody(req)) } catch { return openaiErr(res, 400, 'invalid_request', 'body not JSON') }
  const action = body.action

  // WB：同步 App 当前登录号进池
  if (action === 'sync') {
    const out = []
    for (const vk of Object.keys(VARIANTS)) {
      try {
        const cred = await buildStore(vk).current() // 只读 App 登录态，不 refresh
        if (cred) { const e = upsertAccount(vk, cred); out.push(`${vk}：${e.uid.slice(0, 8)} 已入池`) }
        else out.push(`${vk}：App 无登录态`)
      } catch (e) { out.push(`${vk}：失败 ${String(e).slice(0, 80)}`) }
    }
    return json(res, 200, { ok: true, result: out.join(' · ') })
  }

  // WB 签到+旅行：立即跑一轮（spawn buddy-run，独立进程读池，不阻塞网关）
  if (action === 'buddy-now') {
    const r = await runScript(join(HERE, 'lib', 'buddy-run.mjs'), 180_000)
    return json(res, 200, r.ok ? { ok: true, result: tailLine(r.out) } : { ok: false, error: r.err || tailLine(r.out) })
  }

  // Qoder：官方 CLI 动作（签到/同步/找回/接力）——绝不含 --selftest
  if (QODER_ACTIONS[action]) {
    const r = await QODER_ACTIONS[action]()
    return json(res, 200, r.ok ? { ok: true, result: tailLine(r.out) } : { ok: false, error: r.err || tailLine(r.out) })
  }
  // Qoder 无感切换（带目标）
  if (action === 'qoder-switch') {
    const r = await qoderSwitch(body.target)
    return json(res, 200, r.ok ? { ok: true, result: tailLine(r.out) } : { ok: false, error: r.err || tailLine(r.out) })
  }
  // Qoder 粘贴令牌加号（CLI 无此入口，vault 写入 store.json）
  if (action === 'qoder-add') {
    const r = await qoderAddByToken(body.token)
    return json(res, 200, r)
  }
  // Qodermanager 链序：写自定义序（数组）或恢复默认（空数组）
  if (action === 'qm-chain-set') {
    if (!Array.isArray(body.order)) return json(res, 400, { ok: false, error: 'order 需为模型 id 数组' })
    return json(res, 200, qmChainWrite(body.order))
  }
  // WB 统一链序：同上语义（裸 workbuddymodel 走这条链）
  if (action === 'wb-chain-set') {
    if (!Array.isArray(body.order)) return json(res, 400, { ok: false, error: 'order 需为模型 id 数组' })
    return json(res, 200, wbChainWrite(body.order))
  }
  // WB 桌面登录态快捷切号（2026-11-13 用户需求，参考 workbuddy-switch）：
  // 写前整份备份 + 写后用 connector 读回校验，不符即回滚，绝不写坏 App 登录态。
  if (action === 'wb-switch') {
    if (!body.target) return json(res, 400, { ok: false, error: '缺 target（uid 或前缀）' })
    const r = await switchWbAccount(String(body.target)).catch((e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 200) }))
    event('wb-switch', { uid: String(body.target).slice(0, 8), ok: r.ok === true, from: r.from ?? '', message: String(r.error ?? r.message ?? '').slice(0, 160) })
    return json(res, 200, r.ok ? { ok: true, result: r.message, uid: r.uid, nickname: r.nickname } : { ok: false, error: r.error })
  }
  // 存一份当前桌面身份快照（切号前自动做，这里给手动入口，便于先把各号都存下来）
  if (action === 'wb-capture') {
    const r = await captureCurrentProfile().catch((e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 200) }))
    return json(res, 200, r.ok ? { ok: true, result: `已存快照：${r.nickname || r.uid.slice(0, 8)}` } : { ok: false, error: r.error })
  }
  // 采集展示名（纯本地文件 + 一次密钥，不打上游）
  if (action === 'wb-names') {
    const names = await harvestNames().catch(() => ({}))
    return json(res, 200, { ok: true, result: `已采集 ${Object.keys(names).length} 个账号名` })
  }
  // 切号自检：只写临时副本、用 desktopPath 覆盖读回，真实登录态零改动
  if (action === 'wb-switch-selftest') {
    const r = await selfTestWbSwitch().catch((e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 200) }))
    return json(res, 200, r)
  }
  // WB 账号消耗优先级：uid 数组（前缀也可，补全为全 uid）；空数组=恢复 LRU 轮换
  if (action === 'wb-account-order-set') {
    if (!Array.isArray(body.order)) return json(res, 400, { ok: false, error: 'order 需为账号 uid 数组' })
    const all = listAccounts().map((a) => a.uid)
    const full = body.order.map((p) => all.find((u) => u === p || u.startsWith(p))).filter(Boolean)
    return json(res, 200, wbAccountOrderWrite(body.order.length === 0 ? [] : full))
  }
  // 局域网设备钥匙管理（面板=本机专属，这些动作天然只本机可发）
  if (action === 'lan-key-add') {
    const k = createKey(body.name, body.dailyLimit)
    return json(res, 200, { ok: true, result: `已建钥匙「${k.name}」（${k.dailyLimit} 次/日）`, key: { id: k.id, token: k.token } })
  }
  if (action === 'lan-key-revoke') return json(res, 200, revokeKey(body.id))
  if (action === 'lan-key-delete') return json(res, 200, deleteKey(body.id))
  if (action === 'lan-key-limit') return json(res, 200, setLimit(body.id, body.dailyLimit))

  return json(res, 400, { ok: false, error: `未知动作：${action}` })
}

// ── HTTP 层：loopback + constant-time bearer ────────────────────────────────
const SHARED_SECRET = getOrCreateGatewaySecret() // 钥匙串持久化：重启不换，agent 配置一次长期有效
const LAN_ON = process.env.ACCT_LAN === '1'      // ACCT_LAN=1 才监听 0.0.0.0（默认只 127.0.0.1）
function presentedToken(req) {
  // 两种习惯都认：OpenAI 系 Authorization: Bearer；Anthropic 系 x-api-key
  const h = req.headers.authorization
  const m = h && /^Bearer\s+(.+)$/i.exec(h.trim())
  if (m) return m[1]
  const k = req.headers['x-api-key']
  return typeof k === 'string' ? k : null
}
function bearerOk(req) {
  const presented = presentedToken(req)
  if (presented === null) return false
  const a = Buffer.from(presented), b = Buffer.from(SHARED_SECRET)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
/** 鉴权结果：主密钥全功能；lan- 子令牌只许 chat/models、受每日上限（本机来源免限）。 */
function authReq(req) {
  if (bearerOk(req)) return { ok: true, local: true }
  const presented = presentedToken(req) ?? ''
  const key = presented.startsWith('lan-') ? matchKey(presented) : null
  if (!key) return { ok: false, status: 401, type: 'unauthorized', msg: 'missing or invalid bearer' }
  if (key.revoked) return { ok: false, status: 403, type: 'key_revoked', msg: `设备钥匙「${key.name}」已吊销` }
  const allow = keyAllowed(key)
  if (!allow.ok) return { ok: false, status: 429, type: 'daily_limit', msg: `设备「${key.name}」今日 ${key.dailyLimit} 次已用完（明天重置）` }
  return { ok: true, local: false, key }
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
function openaiErr(res, code, type, msg) { json(res, code, { error: { message: msg, type, code } }) }
const isLoopback = (ip) => !ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.')

async function handle(req, res) {
  const url = (req.url ?? '/').split('?')[0]
  if (req.method === 'GET' && url === '/health') {
    sweepCooldown() // 顺手清到期冷却，无旁路成本
    return json(res, 200, { ok: true, gateway: 'acct-manager', port: PORT })
  }

  // ── 管理面板（浏览器用；不占 agent bearer）───────────────────────────────
  // 只读状态/余额免 token（数据本就脱敏，页面内注入的 token 照样带上）；
  // 口令展示与同步动作必须 token。跨站伪造无效：自定义头触发 CORS 预检，网关不应答 OPTIONS。
  if (url === '/panel' || url === '/panel/') return panelHtml(req, res)
  if (url.startsWith('/panel/')) {
    // 面板只许本机来源：LAN 开了也不让别的机器读状态/取口令（口令类路由的命门）
    if (!isLoopback(req.socket.remoteAddress)) return openaiErr(res, 403, 'forbidden', '面板仅限本机访问')
    if (req.method === 'GET' && (url === '/panel/state' || url === '/panel/balances' || url === '/panel/credit-expiry' || url === '/panel/wb-credit-expiry' || req.url.startsWith('/panel/usage'))) {
      if (url === '/panel/state') return panelState(res)
      if (url === '/panel/balances') return panelBalances(res)
      if (url === '/panel/credit-expiry') return panelCreditExpiry(req, res)
      if (url === '/panel/wb-credit-expiry') return panelWbCreditExpiry(req, res)
      return panelUsage(req, res)
    }
    if (!panelTokenOk(req)) return openaiErr(res, 403, 'forbidden', '面板令牌缺失或错误')
    if (req.method === 'POST' && url === '/panel/secret') return json(res, 200, { secret: SHARED_SECRET })
    if (req.method === 'POST' && url === '/panel/qm-secret') { const ep = qmEndpoint(); return json(res, 200, { base: ep.base, token: ep.token }) }
    if (req.method === 'POST' && url === '/panel/action') return panelAction(req, res)
    return openaiErr(res, 404, 'not_found', `no panel route: ${url}`)
  }

  const auth = authReq(req)
  if (!auth.ok) return openaiErr(res, auth.status, auth.type, auth.msg)
  // 子令牌只许模型调用三路（models/chat/messages）；其余 agent 侧路由（如计费查询
  // /workbuddy/balances）拒之。面板路由在前面已按 loopback 拦下，不经过这里。
  if (!auth.local && url !== '/v1/models' && url !== '/v1/chat/completions' && url !== '/v1/messages') {
    return openaiErr(res, 403, 'forbidden', '设备钥匙只可用于模型调用')
  }

  if (req.method === 'GET' && url === '/v1/models') {
    const data = [{ id: 'workbuddymodel', object: 'model', created: 0, owned_by: 'wb-chain' }] // 统一链入口（同 Qodermanager 语义）
    for (const vk of Object.keys(VARIANTS)) {
      let models = []
      try { models = await catalog(vk) } catch { /* 取目录失败：跳过该版 */ }
      for (const m of models) data.push({ id: exposedId(vk, m.id), object: 'model', created: 0, owned_by: `workbuddy:${vk}` })
    }
    // Qoder：裸名走 QM 链 + 9 个钉名单模（管家原生直连号池，2026-11-03 恢复）
    data.push({ id: 'qodermodel', object: 'model', created: 0, owned_by: 'qodermanager' })
    for (const m of qoderPinnedModels()) {
      data.push({ id: `qodermodel/${m.id}`, object: 'model', created: 0, owned_by: 'qoder-pinned' })
    }
    return json(res, 200, { object: 'list', data })
  }

  if (req.method === 'GET' && url === '/workbuddy/balances') {
    const out = {}
    for (const [vk, { label }] of Object.entries(VARIANTS)) {
      const cands = accountCandidates(vk)
      if (!cands.length) { out[vk] = { label, state: 'no-account-or-all-cooled', accounts: 0 }; continue }
      try {
        const c = await CLIENT.fetchCredits(cands[0].cred) // 每版只查首选号：计费查询，克制
        out[vk] = { label, total: c.total, packages: (c.accounts ?? []).length, poolSize: cands.length }
      } catch (e) { out[vk] = { label, error: String(e).slice(0, 120) } }
    }
    return json(res, 200, out)
  }

  if (req.method === 'POST' && url === '/v1/chat/completions') {
    const raw = await readBody(req)
    let body
    try { body = JSON.parse(raw) } catch { return openaiErr(res, 400, 'invalid_request', 'body not JSON') }
    const target = parseExposed(body.model)
    const qoderTarget = target ? null : parseQoderExposed(body.model)
    if (!target && !qoderTarget) return openaiErr(res, 400, 'invalid_request', `model 需形如 workbuddymodel/cn:<id> 或 qodermodel/<id>，收到 ${body.model}`)

    const wantStream = body.stream === true
    // 子令牌计数：qoder 路在此记一次（token 由账本另管）；WB 路在 usage 回调记，各只记一次。
    if (auth.key && qoderTarget) { try { recordUsage(auth.key, {}) } catch { /* 计数失败不挡调用 */ } }
    if (qoderTarget?.pinned) return qoderPinnedChat(res, qoderTarget.pinned, body, wantStream, auth, null) // 钉名：管家原生直连号池
    if (qoderTarget) return qoderChat(res, body, wantStream) // 裸名：QM 链（其自记 counts.jsonl，不双记）
    const outcome = await runWbChat(target, body)
    if (!outcome.ok) return openaiErr(res, mapStatus(outcome.err), 'upstream_error',
      `${outcome.err?.kind ?? 'unknown'} · ${String(outcome.err?.message ?? '').slice(0, 200)}`)
    const keyCount = (usage) => { if (auth.key) { try { recordUsage(auth.key, { input: usage?.prompt_tokens || 0, output: usage?.completion_tokens || 0, credit: usage?.credit || 0 }) } catch { /* 计量失败不挡 */ } } }
    if (wantStream) return pipeStream(res, outcome.response, (usage) => { recordWbUsage({ uid: outcome.usedUid, model: outcome.usedModel, usage, stream: true }); keyCount(usage) })
    const text = await outcome.response.text()
    const result = aggregateSse(text, body.model)
    recordWbUsage({ uid: outcome.usedUid, model: outcome.usedModel, usage: result.usage, stream: false })
    keyCount(result.usage)
    return json(res, 200, result)
  }

  // ── Anthropic Messages 协议（ZCode / Claude Code 系客户端）────────────────
  // 请求体翻译 → 同一套 WB/Qoder 路由 → 响应翻译回 Anthropic 事件流/文档。
  if (req.method === 'POST' && url === '/v1/messages') {
    const raw = await readBody(req)
    let ab
    try { ab = JSON.parse(raw) } catch { return json(res, 400, anthropicErrorBody('invalid_request_error', 'body not JSON')) }
    const target = parseExposed(ab.model)
    const qoderTarget = target ? null : parseQoderExposed(ab.model)
    if (!target && !qoderTarget) return json(res, 400, anthropicErrorBody('invalid_request_error', `model 需形如 workbuddymodel/cn:<id> 或 qodermodel/<id>，收到 ${ab.model}`))
    const body = anthropicToOpenAI(ab)
    const wantStream = ab.stream === true

    if (auth.key && qoderTarget) { try { recordUsage(auth.key, {}) } catch { /* 计数失败不挡调用 */ } }
    if (qoderTarget?.pinned) return qoderPinnedChatAnthropic(res, qoderTarget.pinned, body, ab.model, wantStream, null) // 钉名：原生直连
    if (qoderTarget) return qoderChatAnthropic(res, body, ab.model, wantStream) // 裸名：QM 链（QM 自记，不双记）
    const outcome = await runWbChat(target, body)
    if (!outcome.ok) return json(res, mapStatus(outcome.err), anthropicErrorBody('api_error',
      `${outcome.err?.kind ?? 'unknown'} · ${String(outcome.err?.message ?? '').slice(0, 200)}`))
    const keyCount = (usage) => { if (auth.key) { try { recordUsage(auth.key, { input: usage?.prompt_tokens || 0, output: usage?.completion_tokens || 0, credit: usage?.credit || 0 }) } catch { /* 计量失败不挡 */ } } }
    if (wantStream) return pipeStreamAnthropic(res, outcome.response, ab.model, (usage) => { recordWbUsage({ uid: outcome.usedUid, model: outcome.usedModel, usage, stream: true }); keyCount(usage) })
    const text = await outcome.response.text()
    const agg = aggregateSse(text, ab.model)
    recordWbUsage({ uid: outcome.usedUid, model: outcome.usedModel, usage: agg.usage, stream: false })
    keyCount(agg.usage)
    return json(res, 200, openaiToAnthropicMessage(agg))
  }

  return openaiErr(res, 404, 'not_found', `no route: ${req.method} ${url}`)
}

function mapStatus(e) {
  if (!e) return 502
  if (e.status && e.status !== 0) return e.status >= 400 ? e.status : 502
  return e.kind === 'server' ? 502 : 500
}
function pipeStream(res, upstream, onUsage) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  const reader = upstream.body.getReader()
  const dec = new TextDecoder()
  let buf = '', lastUsage = null
  ;(async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break
        const text = dec.decode(value, { stream: true })
        res.write(text) // 字节原样透传
        if (onUsage) { // 旁路扫 usage（不碰转发内容）
          buf += text
          let nl
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
            if (line.startsWith('data:')) { try { const j = JSON.parse(line.slice(5).trim()); if (j.usage) lastUsage = j.usage } catch { /* 非 JSON 心跳 */ } }
          }
        }
      }
      if (onUsage && buf.trim().startsWith('data:')) { try { const j = JSON.parse(buf.trim().slice(5).trim()); if (j.usage) lastUsage = j.usage } catch { /* 尾行残缺 */ } }
    } catch { /* 客户端断开 */ }
    finally { if (onUsage) { try { onUsage(lastUsage) } catch { /* 记账失败不断流 */ } } res.end() }
  })()
}
/** OpenAI SSE → Anthropic 事件流的增量翻译管道（跨 chunk 断行缓冲）。 */
function pipeStreamAnthropic(res, upstream, requestedModel, onUsage) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  const tr = makeAnthropicStreamTranslator(requestedModel)
  const reader = upstream.body.getReader()
  const dec = new TextDecoder()
  let buf = '', lastUsage = null
  ;(async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue // event: 行/注释/心跳不管，只译 data
          const payload = line.slice(5).trim()
          if (onUsage && payload && payload !== '[DONE]') { try { const j = JSON.parse(payload); if (j.usage) lastUsage = j.usage } catch { /* 交给翻译器处理 */ } }
          const frame = tr.feed(payload)
          if (frame) res.write(frame)
        }
      }
      const tail = tr.finish()
      if (tail) res.write(tail)
    } catch { /* 客户端断开 */ }
    finally { if (onUsage) { try { onUsage(lastUsage) } catch { /* 记账失败不断流 */ } } res.end() }
  })()
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0
    req.on('data', (c) => { n += c.length; if (n > 8 << 20) return reject(new Error('body too large')); chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

createServer(handle).listen(PORT, LAN_ON ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`[acct-manager] 网关就绪 http://127.0.0.1:${PORT}/v1  （bearer 见钥匙串 acct-manager/gateway-secret，不落日志）`)
  console.log('  GET /health · /v1/models · /workbuddy/balances · POST /v1/chat/completions')
  if (LAN_ON) console.log(`  LAN 模式已开：局域网可连 http://${lanIp()}:${PORT}/v1 （子令牌在面板「设备钥匙」卡管理）`)
  // 展示名采集：纯本地文件 + 一次 at-rest key，不打上游；失败不影响网关服务。
  harvestNames().then((n) => console.log(`  WB 账号展示名已采集 ${Object.keys(n).length} 个`)).catch(() => {})
})
