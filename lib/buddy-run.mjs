#!/usr/bin/env node
/**
 * WB 增值自动化运行器：对池内每个号跑「签到 + 猫猫旅行」一轮。
 *
 *   node lib/buddy-run.mjs            签到 + 旅行（默认）
 *   node lib/buddy-run.mjs --checkin  只签到
 *   node lib/buddy-run.mjs --travel   只旅行
 *
 * 一次一号顺序跑（同令牌不并发），每号之间随机停顿更像人。全程记事件账。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { ensureElectronEnv, VARIANTS } from './runtime.mjs'
import { pickAccounts } from './pool.mjs'
import { checkinAccount, travelTick } from './buddy.mjs'

ensureElectronEnv()
const HERE = dirname(new URL(import.meta.url).pathname)
const EVENTS = join(HERE, '..', 'data', 'events.jsonl')
const STATUS = join(HERE, '..', 'data', 'buddy-status.json')
const only = process.argv.slice(2)
const doCheckin = !only.includes('--travel')
const doTravel = !only.includes('--checkin')

// 状态快照：面板每次刷新读它。按 variant:uid 存最新一轮结果 + 当日汇总。
const status = { updatedAt: Date.now(), accounts: {}, day: shanghaiDay() }
function shanghaiDay(ms = Date.now()) {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10)
}
function saveStatus() {
  try { mkdirSync(dirname(STATUS), { recursive: true }); writeFileSync(STATUS, JSON.stringify(status, null, 2)) } catch {}
}
// 载入上一份：跨进程保留当日已签/已旅行结果（每 2h 独立进程跑，靠文件接力）
try {
  const prev = JSON.parse(readFileSync(STATUS, 'utf8'))
  if (prev.day === status.day) status.accounts = prev.accounts ?? {}
} catch { /* 首次或换日 */ }

function log(type, data) {
  const line = JSON.stringify({ at: Date.now(), type, ...data })
  try { mkdirSync(dirname(EVENTS), { recursive: true }); appendFileSync(EVENTS, line + '\n') } catch {}
  console.log(`  ${type}`, JSON.stringify(data))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jitter = () => 200 + Math.floor(Math.random() * 400)

let ran = 0
for (const vk of Object.keys(VARIANTS)) {
  const accounts = pickAccounts(vk)
  if (!accounts.length) { log('buddy-skip', { variant: vk, reason: '无可用号（未同步或冷却中）' }); continue }
  for (const cred of accounts) {
    ran++
    const key = `${vk}:${(cred.uid || '').slice(0, 8)}`
    const rec = status.accounts[key] ??= { variant: vk, uid: (cred.uid || '').slice(0, 8), name: cred.nickname || (cred.uid || '').slice(0, 8) }
    if (doCheckin) {
      const r = await checkinAccount(cred)
      rec.checkin = { ok: r.ok, already: !!r.already, at: Date.now(), msg: r.message?.slice(0, 60) }
      log('checkin', { variant: vk, uid: rec.uid, ok: r.ok, already: r.already, inactive: r.inactive, msg: r.message?.slice(0, 60) })
    }
    if (doTravel) {
      const t = await travelTick(cred)
      rec.travel = { action: t.action, detail: t.detail, at: Date.now() }
      log('travel', { variant: vk, uid: rec.uid, action: t.action, detail: t.detail })
    }
    saveStatus()
    await sleep(jitter())
  }
}
saveStatus()
console.log(`buddy-run 完成：${ran} 个号`)
