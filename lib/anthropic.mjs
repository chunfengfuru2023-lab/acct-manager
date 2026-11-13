/**
 * Anthropic Messages 协议 ⇄ OpenAI chat 协议翻译层。
 *
 * 让同一个网关同时吃两种客户端：ZCode/Claude Code 系发 POST /v1/messages
 * （anthropic-messages 型），其余 agent 发 /v1/chat/completions（openai 型）。
 * 上游恒为 WB/Qoder 的 OpenAI 形 SSE，本层负责双向翻译。
 *
 * @module acct-manager/anthropic
 */

// ── 请求：Anthropic → OpenAI ────────────────────────────────────────────────
export function anthropicToOpenAI(body) {
  const messages = []
  const sys = body.system
  if (typeof sys === 'string' && sys) messages.push({ role: 'system', content: sys })
  else if (Array.isArray(sys)) {
    const text = sys.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    if (text) messages.push({ role: 'system', content: text })
  }
  for (const m of body.messages ?? []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    if (typeof m.content === 'string') { messages.push({ role, content: m.content }); continue }
    // 块数组：text 合并；tool_use → assistant.tool_calls；tool_result → role=tool
    const texts = []
    const toolCalls = []
    const toolResults = []
    for (const b of m.content ?? []) {
      if (b?.type === 'text') texts.push(b.text ?? '')
      else if (b?.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })
      else if (b?.type === 'tool_result') toolResults.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '') })
    }
    for (const tr of toolResults) messages.push(tr) // OpenAI 要求 tool 消息先于后续 assistant
    if (texts.length || toolCalls.length) {
      messages.push({ role, content: texts.join(''), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) })
    }
  }
  const out = {
    model: body.model,
    messages,
    stream: body.stream === true,
    ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { top_p: body.top_p } : {}),
    ...(body.stop_sequences ? { stop: body.stop_sequences } : {}),
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } } }))
    if (body.tool_choice) out.tool_choice = typeof body.tool_choice === 'string' ? body.tool_choice : (body.tool_choice.name ? { type: 'function', function: { name: body.tool_choice.name } } : undefined)
  }
  return out
}

// ── 流式翻译：OpenAI SSE chunk → Anthropic 事件序列 ─────────────────────────
// 块状态机：同一时刻至多一个打开的 content block；换类型即关旧开新。
// Anthropic 契约：message_start → content_block_start/delta/stop… →
// message_delta(stop_reason+usage) → message_stop。
export function makeAnthropicStreamTranslator(requestedModel) {
  const msgId = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  let started = false
  let blockIndex = 0
  let current = null // 'text' | 'thinking' | 'tool_use' | null
  const toolBlockAt = new Map() // openai tool_call index → anthropic block index
  let finishReason = null
  let usage = { input_tokens: 0, output_tokens: 0 }
  let finished = false // 终止帧只发一次：[DONE] 与流尾都会触达 finish()
  const out = []
  const ev = (type, data) => out.push(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)

  function ensureStart() {
    if (started) return
    started = true
    ev('message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: requestedModel, content: [], stop_reason: null, stop_sequence: null, usage } })
  }
  function closeBlock() {
    if (current === null) return
    ev('content_block_stop', { type: 'content_block_stop', index: blockIndex })
    current = null
    blockIndex++
  }
  function openBlock(spec) {
    ensureStart()
    closeBlock()
    ev('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: spec })
    current = spec.type
  }

  return {
    feed(dataStr) {
      out.length = 0
      if (!dataStr) return ''
      if (dataStr === '[DONE]') return this.finish()
      let chunk
      try { chunk = JSON.parse(dataStr) } catch { return '' }
      if (chunk.usage) usage = {
        input_tokens: chunk.usage.prompt_tokens ?? usage.input_tokens,
        output_tokens: chunk.usage.completion_tokens ?? usage.output_tokens,
      }
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
      const delta = choice?.delta ?? {}
      if (delta.reasoning_content) {
        if (current !== 'thinking') openBlock({ type: 'thinking', thinking: '' })
        ev('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } })
      }
      if (typeof delta.content === 'string' && delta.content) {
        if (current !== 'text') openBlock({ type: 'text', text: '' })
        ev('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: delta.content } })
      }
      for (const tc of delta.tool_calls ?? []) {
        const oi = tc.index ?? 0
        let bi = toolBlockAt.get(oi)
        if (bi === undefined) {
          openBlock({ type: 'tool_use', id: tc.id ?? `toolu_${randomId()}`, name: tc.function?.name ?? '', input: {} })
          bi = blockIndex
          toolBlockAt.set(oi, bi)
        }
        if (tc.function?.arguments) ev('content_block_delta', { type: 'content_block_delta', index: bi, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } })
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason
      return out.join('')
    },
    finish() {
      out.length = 0
      if (finished) return '' // 已收口就不再补终止帧（[DONE] 与流尾双触达）
      finished = true
      ensureStart() // 空回复也给出合法事件流
      closeBlock()
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: mapStop(finishReason), stop_sequence: null }, usage })
      ev('message_stop', { type: 'message_stop' })
      return out.join('')
    },
  }
}

// ── 非流式：OpenAI 聚合结果 → Anthropic message 文档 ────────────────────────
export function openaiToAnthropicMessage(openaiResult) {
  const msg = openaiResult.choices?.[0]?.message ?? {}
  const content = []
  if (msg.reasoning_content) content.push({ type: 'thinking', thinking: msg.reasoning_content })
  if (msg.content) content.push({ type: 'text', text: msg.content })
  for (const tc of msg.tool_calls ?? []) {
    let input = {}
    try { input = JSON.parse(tc.function?.arguments || '{}') } catch { input = { _raw: tc.function?.arguments } }
    content.push({ type: 'tool_use', id: tc.id ?? `toolu_${randomId()}`, name: tc.function?.name, input })
  }
  return {
    id: `msg_${randomId()}`, type: 'message', role: 'assistant',
    model: openaiResult.model, content,
    stop_reason: mapStop(openaiResult.choices?.[0]?.finish_reason), stop_sequence: null,
    usage: {
      input_tokens: openaiResult.usage?.prompt_tokens ?? 0,
      output_tokens: openaiResult.usage?.completion_tokens ?? 0,
    },
  }
}

/** Anthropic 形错误体（客户端按这个格式解析错误）。 */
export function anthropicErrorBody(type, message) {
  return { type: 'error', error: { type, message } }
}

function mapStop(r) {
  if (r === 'length') return 'max_tokens'
  if (r === 'tool_calls' || r === 'function_call') return 'tool_use'
  return 'end_turn'
}
function randomId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }
