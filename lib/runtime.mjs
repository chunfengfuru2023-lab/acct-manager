/**
 * acct-manager 运行时共享层：Electron env 兜底、变体表、store 工厂。
 * @module acct-manager/runtime
 */
import { existsSync } from 'node:fs'
import { wbEntry } from './paths.mjs'

const {
  WorkBuddyCredentialStore,
  WorkBuddyUpstreamClient,
  CN_VARIANT,
} = await import(wbEntry())

/**
 * 解密 5.6+ 登录态需借 App 自身 Electron 二进制。默认路径存在即自动配 env
 * （否则 connector discovery 走 none 分支报 electron-binary-unavailable）。
 * ⚠️ 必须先于任何 store/keyProvider 构造：keyProvider 在 new 时冻结 env 读值。
 */
export function ensureElectronEnv() {
  const path = '/Applications/WorkBuddy.app/Contents/MacOS/Electron'
  if (!process.env.WORKBUDDY_ELECTRON_BIN?.trim() && existsSync(path)) process.env.WORKBUDDY_ELECTRON_BIN = path
}

// 2026-11-02 用户定：WorkBuddy AI（国际版）不再使用，只保留国内版 cn。
// VARIANTS 是唯一真源——目录/余额/面板/巡检/加号全部遍历它，删这行即全链路移除。
export const VARIANTS = {
  cn: { variant: CN_VARIANT, label: 'WorkBuddy' },
}

export const CLIENT = new WorkBuddyUpstreamClient()

export function buildStore(variantKey) {
  return new WorkBuddyCredentialStore({
    variant: VARIANTS[variantKey].variant,
    refresh: (cred) => CLIENT.refreshToken(cred),
  })
}
