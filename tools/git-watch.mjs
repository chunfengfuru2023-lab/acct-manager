#!/usr/bin/env node
/**
 * 事件驱动同步 watcher（2026-11-13 用户要求：有修改才同步，没修改不动）。
 *
 * 取代每 10 分钟轮询：fs.watch 监听两个白名单仓库，文件落盘后 debounce 8 秒
 * 调一次 git-sync.sh（提交+推送+敏感扫描都在脚本里）。无改动时零动作、零日志。
 *
 * 忽略：.git / logs / data / backups / bin / node_modules（运行期产物与 git 内部写入）。
 * 日志：acct-manager/logs/git-watch.log（logs/ 已 gitignore）。
 *
 * 依赖 ZCode 宿主进程运行（TCC：Documents 只有宿主有权读，launchd 后台读不了）。
 */
import { watch, appendFileSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPOS = [
  join(HERE, '..'),                          // acct-manager
  join(HERE, '..', '..', 'qoder-switch'),    // qoder-switch
]
const SYNC = join(HERE, 'git-sync.sh')
const LOG = join(HERE, '..', 'logs', 'git-watch.log')
const IGNORE = /(^|\/)(\.git|logs|data|backups|bin|node_modules)(\/|$)/
const DEBOUNCE_MS = 8000

mkdirSync(dirname(LOG), { recursive: true })
const say = (m) => { try { appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}] ${m}\n`) } catch { /* 忽略 */ } }

let timer = null
let running = false
function schedule() {
  clearTimeout(timer)
  timer = setTimeout(run, DEBOUNCE_MS)
}
function run() {
  if (running) { schedule(); return }   // 上一轮还没跑完 → 再等一轮
  running = true
  say('检测到本地修改，触发同步')
  execFile('/bin/bash', [SYNC], { timeout: 120_000 }, (err) => {
    running = false
    if (err) say(`⚠️ 同步脚本执行异常：${String(err.message).slice(0, 120)}`)
  })
}

let watched = 0
for (const repo of REPOS) {
  try {
    watch(repo, { recursive: true }, (_ev, fn) => {
      if (!fn || IGNORE.test(fn)) return
      schedule()
    })
    watched++
    say(`开始监听：${repo}`)
  } catch (e) {
    say(`⚠️ 监听失败 ${repo}：${String(e.message).slice(0, 120)}`)
  }
}
if (watched === 0) { say('⚠️ 两个仓库都没监听上，退出'); process.exit(1) }
say(`watcher 就绪（${watched} 个仓库，debounce ${DEBOUNCE_MS / 1000}s）`)
// 常驻：不让事件循环空转退出
setInterval(() => {}, 60_000)
