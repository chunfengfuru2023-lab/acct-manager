#!/usr/bin/env node
/**
 * acct-manager CLI（对齐 Qoder 自动版的命令行习惯）
 *
 *   node acct-cli.mjs --list                 列池内账号（令牌掩码，不解密）
 *   node acct-cli.mjs --sync [--variant cn|all]
 *                                            把 App 当前登录号快照进池（只读 App 文件）
 *   node acct-cli.mjs --remove <uid前缀|昵称>
 *   node acct-cli.mjs --sweep [--force]      清到期冷却 / 手动恢复全部
 *   node acct-cli.mjs --patrol               手动跑一次巡检（重同步+扫冷却+查余额/临期包）
 *   node acct-cli.mjs --events [n]           回看最近 n 条事件流水（默认 20）
 *
 * 红线：只读 App 的 .info；池文件加密落盘；绝不 refresh 之外的写操作碰 App 目录。
 */
import { ensureElectronEnv, VARIANTS, buildStore } from './lib/runtime.mjs'
import { upsertAccount, listAccounts, removeAccount, sweepCooldown } from './lib/pool.mjs'

ensureElectronEnv()
const args = process.argv.slice(2)
const flag = (name) => args.indexOf(`--${name}`)
const argOf = (name, dflt) => { const i = flag(name); return i >= 0 ? args[i + 1] : dflt }

const requested = argOf('variant', 'all').split(',').map((s) => s.trim())
const variantKeys = requested.includes('all') ? Object.keys(VARIANTS) : requested.filter((k) => k in VARIANTS)
if (!variantKeys.length) { console.log(`--variant 不认识: ${requested.join(',')}（可用 cn | ai | all）`); process.exitCode = 64; process.exit(64) }

switch (true) {
  case flag('list') >= 0: {
    const rows = listAccounts()
    if (!rows.length) console.log('（池是空的——先 --sync）')
    for (const a of rows) {
      const cooled = a.cooldownUntilMs > Date.now() ? ` 冷却中(${a.cooldownKind})` : ''
      console.log(`  ${a.variantKey}  ${a.uid.slice(0, 8)}  ${a.nickname || '（无昵称）'}  access剩${Math.max(0, Math.round((a.expiresAtMs - Date.now()) / 8640000) / 10)}天${cooled}`)
    }
    break
  }
  case flag('sync') >= 0: {
    for (const vk of variantKeys) {
      const store = buildStore(vk)
      const cred = await store.current() // 只读：解密 App 登录态，不 refresh
      if (!cred) { console.log(`  [${vk}] 无登录态或解密不可用——App 里登一次，或检查 /Applications 下的 App`); continue }
      upsertAccount(vk, cred)
      console.log(`  [${vk}] 已快照进池: ${cred.uid.slice(0, 8)} ${cred.nickname ?? ''}（access 剩 ${Math.round((cred.expiresAtMs - Date.now()) / 8640000) / 10} 天）`)
    }
    break
  }
  case flag('remove') >= 0: {
    console.log(`移除 ${removeAccount(argOf('remove', ''))} 个账号`)
    break
  }
  case flag('sweep') >= 0: {
    console.log(`清理 ${sweepCooldown(flag('force') >= 0)} 条冷却`)
    break
  }
  case flag('patrol') >= 0: {
    await import('./lib/patrol.mjs') // patrol 自身是脚本，import 即执行
    break
  }
  case flag('events') >= 0: {
    const { readFileSync, existsSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const p = join(dirname(new URL(import.meta.url).pathname), 'data', 'events.jsonl')
    if (!existsSync(p)) { console.log('（还没有巡检记录）'); break }
    const n = Number(args[flag('events') + 1]) || 20
    const lines = readFileSync(p, 'utf8').trim().split('\n').slice(-n)
    for (const l of lines) {
      try {
        const e = JSON.parse(l)
        const { at, ...rest } = e
        console.log(new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), JSON.stringify(rest).slice(0, 180))
      } catch {}
    }
    break
  }
  default:
    console.log('用法: --list | --sync [--variant cn|all] | --remove <uid|昵称> | --sweep [--force] | --patrol | --events [n]')
    process.exitCode = 64
}
