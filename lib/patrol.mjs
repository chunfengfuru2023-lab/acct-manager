#!/usr/bin/env node
/**
 * acct-manager · 统一巡检 patrol（每日一次，LaunchAgent 挂载）
 *
 * 设计取舍（2026-11-01 定）：
 *  - WB 的 refresh 有令牌轮转风险，App 活跃使用时我们会读到更新后的新令牌，
 *    与 App 的 refresh 竞态会打架。所以 patrol **不主动 refresh**，
 *    改为每日"只读重同步"——App 自己把登录态养着，我们只抄最新的。
 *  - 号在主用 App 之外（池里的其他快照号）临期时，界面提示人工去 App 登一下，
 *    不做后台硬刷。
 *
 * 干四件事，全只读上游（fetchCredits 是按次计费的查询，每日一次为上限）：
 *  1. 重同步各版当前登录号进池（--sync 语义）
 *  2. 扫掉到期冷却
 *  3. 查各版积分与临期包（3 天内到期的包列出剩余量，提示先用）
 *  4. 事件流水写 data/events.jsonl（供界面/命令行 --since 回看）
 */
import { readFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { CLIENT, VARIANTS, buildStore, ensureElectronEnv } from './runtime.mjs'
import { upsertAccount, sweepCooldown, pickAccounts, allAccounts, patchAccount } from './pool.mjs'

const HERE = dirname(new URL(import.meta.url).pathname)
const EVENTS = join(HERE, '..', 'data', 'events.jsonl') // patrol 在 lib/ 下：data 归工程根
ensureElectronEnv()

function event(type, data) {
  appendFileSync(EVENTS, JSON.stringify({ at: Date.now(), type, ...data }) + '\n')
  console.log(`[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}] ${type}`, JSON.stringify(data, null, 0).slice(0, 300))
}

// 1. 重同步
for (const vk of Object.keys(VARIANTS)) {
  const cred = await buildStore(vk).current()
  if (cred) {
    const n = upsertAccount(vk, cred)
    event('sync', { variant: vk, uid: n.uid.slice(0, 8), accessLeftDays: Math.round((n.expiresAtMs - Date.now()) / 86400000 * 10) / 10 })
  } else event('sync-skip', { variant: vk, reason: 'App 无登录态或解密不可用' })
}

// 1.5 池内令牌续命（2026-11-02 实测 WB refresh 幂等：旧令牌刷后仍有效，
//     与 App 无轮转竞态 → 可放心后台刷）。access 剩 <7 天的号逐个续，
//     新令牌回写池；失败的不动（下次巡检再试），绝不删号。
const RENEW_MS = 7 * 86400_000
for (const vk of Object.keys(VARIANTS)) {
  for (const acc of allAccounts(vk)) { // 含已过 access 期的号（refresh 还活着就能救回来）
    if (!acc.refreshToken) continue
    if (acc.expiresAtMs - Date.now() > RENEW_MS) continue // 还年轻，不动
    try {
      const r = await CLIENT.refreshToken(acc)
      patchAccount(vk, acc.uid, {
        accessToken: r.accessToken,
        refreshToken: r.refreshToken || acc.refreshToken,
        expiresAtMs: r.expiresInSec ? Date.now() + r.expiresInSec * 1000 : acc.expiresAtMs,
      })
      event('renew', { variant: vk, uid: acc.uid.slice(0, 8), newAccessLeftDays: r.expiresInSec ? Math.round(r.expiresInSec / 86400) : '?' })
    } catch (e) { event('renew-fail', { variant: vk, uid: acc.uid.slice(0, 8), error: String(e.message ?? e).slice(0, 120) }) }
    await new Promise((r) => setTimeout(r, 400))
  }
}

// 2. 扫冷却
const swept = sweepCooldown()
if (swept) event('cooldown-sweep', { cleared: swept })

// 3. 积分 + 临期包（每版一次查询，克制）
const NEAR_MS = 3 * 86400_000
for (const [vk, { label }] of Object.entries(VARIANTS)) {
  try {
    const cred = pickAccounts(vk)[0]
    if (!cred) { event('balance-skip', { variant: vk, reason: '全部冷却中或池空' }); continue }
    const c = await CLIENT.fetchCredits(cred)
    const expiring = (c.accounts ?? []).filter((p) => p.endTimeMs - Date.now() < NEAR_MS && p.remain > 0)
      .map((p) => `${p.packageName} 剩${p.remain}（${Math.round((p.endTimeMs - Date.now()) / 86400000 * 10) / 10}天后过期）`)
    event('balance', { variant: vk, label, total: c.total, expiringSoon: expiring.length ? expiring : '无' })
  } catch (e) { event('balance-error', { variant: vk, error: String(e).slice(0, 140) }) }
}
console.log('patrol 完成')
