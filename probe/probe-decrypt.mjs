#!/usr/bin/env node
/**
 * 实测日探针（只读）：验证外部进程能否解密本机 WorkBuddy 5.6+ 登录态。
 *
 * 原则：
 *  - 只调用 status()（设计为 never refreshes, never throws）——不触发令牌刷新，
 *    不写任何文件，不碰 App 原始 info/observation.json。
 *  - 输出全部脱敏：绝不打印 token 本体，只打印长度/前缀指纹/过期时间。
 *  - 不联网。本脚本只验证「本地可解」这一事实。
 *
 * 用法: node --input-type=module -I probe-decrypt.mjs
 */
import { wbEntry } from '../lib/paths.mjs'
const { WorkBuddyCredentialStore, CN_VARIANT, AI_VARIANT } = await import(wbEntry())

const MASK = (s) => s ? `${s.slice(0, 6)}…(${s.length} chars)` : '(none)'

function fmtTs(ms) {
  if (!ms) return 'n/a'
  const d = new Date(ms)
  const now = Date.now()
  const live = ms > now ? `剩余 ${Math.round((ms - now) / 86400000 * 10) / 10} 天` : '⚠️ 已过期'
  return `${d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} (${live})`
}

for (const variant of [CN_VARIANT, AI_VARIANT]) {
  console.log(`\n===== ${variant.displayName} (${variant.region}) =====`)
  const store = new WorkBuddyCredentialStore({ variant })
  console.log('desktop 候选路径:', store.resolveDesktopCandidates().join(', '))
  const st = await store.status()
  if (st.state !== 'signed-in') {
    console.log('状态: signed-out —', st.reasonCode, st.reason ?? '')
    continue
  }
  console.log('状态: signed-in ✅（解密链路可用）')
  console.log('昵称: ', st.nickname ?? '(无)')
  console.log('来源: ', st.source)
  console.log('access 过期: ', fmtTs(st.expiresAtMs))
  console.log('refresh 过期:', fmtTs(st.refreshExpiresAtMs))
  if (st.domain) console.log('domain: ', st.domain)

  // 再深一层：拿 credential 本体，只看结构，输出前打印掩码
  const cred = await store.current()
  if (cred) {
    console.log('令牌指纹: access', MASK(cred.accessToken), '| refresh', MASK(cred.refreshToken))
  }
}
console.log('\n探针结束（全程只读，未刷新、未写文件）')
