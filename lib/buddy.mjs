/**
 * WB 增值自动化：每日签到 + Buddy（猫猫）旅行派单/领奖。
 *
 * 依据（2026-11-02 实测 + WorkDaddy 开源实现交叉验证）：
 *  - 签到：POST {issuer}/v2/billing/meter/daily-checkin（旧路径 /billing/... 兜底）；
 *    成功判据照 WorkDaddy checkin-result.js：HTTP ok + code 0，或 code 10001 且
 *    消息证明"今日已签"（already）。200 空响应不算成功。
 *  - 旅行：GET travel/status → 到站则 POST travel/claim（空 body）→ 空闲则
 *    POST travel/depart {location_id}（默认取 travel/config 第一个地点）。
 *  - host 按令牌 iss 选（www.codebuddy.cn / www.workbuddy.cn 等），不猜。
 *
 * 红线：只操作官方活动接口（与 WorkDaddy 同类）；每号一次一号顺序跑；
 * 失败不重试轰炸；全程记事件账。
 * @module acct-manager/buddy
 */

const ACTIVITY_HOSTS = new Set([
  'https://www.workbuddy.ai', 'https://www.workbuddy.cn',
  'https://www.codebuddy.cn', 'https://www.codebuddy.ai',
])
const CHECKIN_PATHS = ['/v2/billing/meter/daily-checkin', '/billing/meter/daily-checkin']
const INACTIVE_RE = /未开启|未开始|未开放|已过期|无.*活动|活动.*(?:结束|关闭|暂停)/i
const ALREADY_RE = /已签到|已领取|已经.*(?:签到|领取)|重复签到|already\s*(?:checked[- ]?in|claimed)/i

/** 令牌 iss → 活动/计费 host；解不出退回 fallback。 */
function issuerOrigin(accessToken, fallback) {
  try {
    const part = String(accessToken || '').split('.')[1]
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4)
    const iss = String(JSON.parse(Buffer.from(padded, 'base64').toString('utf8')).iss || '').replace(/\/+$/, '')
    if (ACTIVITY_HOSTS.has(iss)) return iss
  } catch { /* iss 不可用 */ }
  return fallback
}

function headers(cred) {
  return {
    'Authorization': `Bearer ${cred.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-IDE-Type': 'WorkBuddy', 'X-IDE-Name': 'WorkBuddy', 'X-Product': 'SaaS',
    ...(cred.uid ? { 'X-User-Id': cred.uid } : {}),
    ...(cred.enterpriseId ? { 'X-Enterprise-Id': cred.enterpriseId } : { 'X-No-Enterprise-Id': '1' }),
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  }
}
async function req(method, url, cred, body) {
  const r = await fetch(url, { method, headers: headers(cred), ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) })
  let j = null
  try { j = await r.json() } catch { /* 非 JSON */ }
  return { httpOk: r.ok, status: r.status, json: j }
}

/** 签到结果分类（照 WorkDaddy 的严格判据）。 */
export function classifyCheckin({ httpOk, json }) {
  const code = json?.code
  const text = String(json?.msg ?? json?.message ?? '')
  const inactive = INACTIVE_RE.test(text)
  const already = Number(code) === 10001 && !inactive && ALREADY_RE.test(text)
  const ok = !inactive && ((Number(code) === 0 && httpOk) || already)
  return { ok, already, inactive, code: code ?? null, message: text }
}

/** 单号签到：v2 路径 404 时退回旧路径。 */
export async function checkinAccount(cred) {
  const host = issuerOrigin(cred.accessToken, 'https://www.codebuddy.cn')
  let last = { ok: false, code: null, message: 'no attempt' }
  for (const path of CHECKIN_PATHS) {
    try {
      const r = await req('POST', host + path, cred, {})
      if (r.status === 404) continue // 路径不存在才试下一条；其余按结果分类
      last = classifyCheckin(r)
      break
    } catch (e) { last = { ok: false, code: null, message: String(e).slice(0, 100) } }
  }
  return last
}

/**
 * 单号旅行一轮：查状态 → 到站领奖 → 空闲派出。
 * 返回 {action:'claimed'|'departed'|'waiting'|'no-buddy'|'error', detail}
 */
export async function travelTick(cred) {
  const host = issuerOrigin(cred.accessToken, 'https://www.codebuddy.cn')
  try {
    const info = await req('GET', host + '/activity/growth/buddy/info', cred)
    if (!info.json?.data?.buddy) return { action: 'no-buddy', detail: '未领养 Buddy（需官网同意协议解锁）' }
    let claimed = false
    const st = await req('GET', host + '/activity/growth/buddy/travel/status', cred)
    const s = st.json?.data ?? {}
    const nowSec = Math.floor(Date.now() / 1000)
    if (s.state !== 'idle') {
      if (s.arrive_at && nowSec >= s.arrive_at) {
        const c = await req('POST', host + '/activity/growth/buddy/travel/claim', cred, {})
        if (Number(c.json?.code) !== 0) return { action: 'error', detail: `领奖失败 code=${c.json?.code} ${c.json?.msg ?? ''}` }
        claimed = true
      } else {
        return { action: 'waiting', detail: `旅行中（${s.location ?? '?'}），约 ${Math.max(0, Math.round(((s.arrive_at ?? 0) - nowSec) / 60))} 分钟后到站` }
      }
    }
    // 空闲（或刚领完）→ 派出
    const cfg = await req('GET', host + '/v2/activity/growth/buddy/travel/config', cred)
    const loc = (cfg.json?.data?.locations ?? [])[0]
    if (!loc) return { action: 'error', detail: '旅行配置无地点' }
    const dep = await req('POST', host + '/v2/activity/growth/buddy/travel/depart', cred, { location_id: loc.id })
    const depMsg = String(dep.json?.msg ?? '')
    // 每日派出上限（猫今天已跑过一趟）是良性终态，不是错误——别每轮刷 error 污染事件账
    if (Number(dep.json?.code) !== 0) {
      if (/daily limit|上限|已达.*限/i.test(depMsg)) return { action: 'limit', detail: `今日旅行已达上限（${depMsg}）` }
      return { action: 'error', detail: `派出失败 code=${dep.json?.code} ${depMsg}` }
    }
    return { action: 'departed', claimed, detail: `${claimed ? '已领奖并' : ''}派去「${loc.name}」` }
  } catch (e) {
    return { action: 'error', detail: String(e).slice(0, 120) }
  }
}
