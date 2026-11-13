/**
 * 钥匙串原语：acct-manager 的两个常驻密钥。
 *  - master-key     ：池文件加密主密钥（AES-256-GCM）
 *  - gateway-secret ：网关 bearer（agent 侧配置一次长期有效）
 * 均一次生成永久复用。首次运行可能弹钥匙串授权框（点"始终允许"）。
 * ⚠️ base64url 校验按解码字节数（32B 是 43 字符——按字符串长度判断曾把老密钥
 *    误判无效、反复 -U 重写，导致池里密文永远解不开，2026-11-01 实测踩坑）。
 * @module acct-manager/keychain
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const SERVICE = 'acct-manager'
const SECURITY = '/usr/bin/security'

function kcFind(account) {
  try {
    return execFileSync(SECURITY, ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return '' }
}
function kcSet(account, value) {
  execFileSync(SECURITY, ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', value])
}
/** 通用"取或建"：valid 判据可注入；生成后永久复用不再轮转。 */
function getOrCreate(account, generate, valid) {
  const existing = kcFind(account)
  if (existing && valid(existing)) return existing
  const fresh = generate()
  kcSet(account, fresh)
  return fresh
}

const isKey32 = (s) => /^[A-Za-z0-9_-]+$/.test(s) && Buffer.from(s, 'base64url').length === 32

export function getOrCreateMasterKey() {
  return getOrCreate('master-key', () => randomBytes(32).toString('base64url'), isKey32)
}
export function getOrCreateGatewaySecret() {
  return getOrCreate('gateway-secret', () => randomBytes(32).toString('base64url'), isKey32)
}
/** 面板令牌：HTML 只发给浏览器渲染、跨站读不到内容；换网关进程不失效。 */
export function getOrCreatePanelToken() {
  return getOrCreate('panel-token', () => randomBytes(32).toString('base64url'), isKey32)
}
