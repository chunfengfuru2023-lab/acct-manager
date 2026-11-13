#!/usr/bin/env node
/**
 * 实测日探针 B：用本机已解密登录态（现成 accessToken，不 refresh）拉一次
 * 模型目录 + 积分余额。只读 GET/查询类调用；不碰 chat、不发消息、不刷新令牌。
 */
import { wbEntry } from '../lib/paths.mjs'
const { WorkBuddyCredentialStore, WorkBuddyUpstreamClient, CN_VARIANT, AI_VARIANT } = await import(wbEntry())

const client = new WorkBuddyUpstreamClient()

for (const variant of [CN_VARIANT, AI_VARIANT]) {
  console.log(`\n===== ${variant.displayName} =====`)
  const store = new WorkBuddyCredentialStore({ variant })
  const cred = await store.current()
  if (!cred) { console.log('无登录态，跳过'); continue }

  // 1. 模型目录
  try {
    const models = await client.fetchModels(cred)
    console.log(`模型目录: ${models.length} 个`)
    for (const m of models.slice(0, 8)) {
      console.log(`  - ${m.id}${m.name ? ` (${m.name})` : ''}${m.credits ? ` · x${m.credits}` : ''}`)
    }
    if (models.length > 8) console.log(`  … 其余 ${models.length - 8} 个略`)
  } catch (e) { console.log('目录失败:', String(e).slice(0, 200)) }

  // 2. 积分余额
  try {
    const credits = await client.fetchCredits(cred)
    console.log('积分:', JSON.stringify(credits).slice(0, 300))
  } catch (e) { console.log('余额失败:', String(e).slice(0, 200)) }
}
console.log('\n探针 B 结束')
