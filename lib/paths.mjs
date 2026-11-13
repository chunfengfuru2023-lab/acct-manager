/**
 * 外部依赖路径解析（2026-11-13 开源化：去掉硬编码的本机绝对路径）。
 *
 * 管家复用 dsh-workbuddy-qoder-connect 的两套现成库：
 *   workbuddy/index.js   —— WB 协议客户端 + 登录态 store
 *   qoder/lib/*.js       —— Qoder 号池 / 协议 / 记账
 * 原来这两处写死 /Users/<用户名>/...，克隆到别的机器直接跑不起来，也暴露用户名。
 *
 * 解析顺序（先命中先用）：
 *   1. 环境变量 ACCT_CONNECT_DIR（显式指定 connect 仓库根）
 *   2. 本仓库同级的 dsh-workbuddy-qoder-connect（推荐布局：两个仓库并排放）
 *   3. 本仓库内的 vendor/dsh-workbuddy-qoder-connect（自带副本）
 *   4. ~/Documents/dsh/dsh-workbuddy-qoder-connect（本机历史布局，兜底）
 *
 * @module acct-manager/paths
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(HERE, '..')

/** connect 仓库根：按上面的顺序探测，全都没有时返回第一个候选（让报错带上路径）。 */
export function connectRoot() {
  const candidates = [
    process.env.ACCT_CONNECT_DIR?.trim(),
    join(REPO_ROOT, '..', 'dsh-workbuddy-qoder-connect'),
    join(REPO_ROOT, 'vendor', 'dsh-workbuddy-qoder-connect'),
    join(homedir(), 'Documents', 'dsh', 'dsh-workbuddy-qoder-connect'),
  ].filter((p) => typeof p === 'string' && p.length > 0)
  for (const p of candidates) if (existsSync(join(p, 'workbuddy', 'index.js'))) return p
  return candidates[0]
}

/** WB 协议客户端入口（workbuddy/index.js）。 */
export function wbEntry() { return join(connectRoot(), 'workbuddy', 'index.js') }

/** Qoder 路由库目录（qoder/lib）。 */
export function qoderLib() { return join(connectRoot(), 'qoder', 'lib') }

/** Qoder 路由库内某个模块的绝对路径。 */
export function qoderModule(name) { return join(qoderLib(), name) }
