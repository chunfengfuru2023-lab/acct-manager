#!/bin/bash
# acct-manager / qoder-switch 自动同步 GitHub（2026-11-13 用户需求）
# 纪律：
#  · 只处理白名单里的两个仓库，绝不碰 ~/Documents/dsh 大仓库（无远程、禁推）
#  · 推送前敏感扫描：命中令牌/密钥/本机路径 → 跳过该仓库并记日志，绝不带脏推送
#  · acct-manager 是公开仓库，扫描更严（多查真实账号痕迹/内部称呼）
#  · 有改动才提交，有提交才推送；无变化零操作
#  · 日志：~/Documents/dsh/acct-manager/logs/git-sync.log（logs/ 已被 gitignore）
set -uo pipefail

LOG="$HOME/Documents/dsh/acct-manager/logs/git-sync.log"
mkdir -p "$(dirname "$LOG")"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
say() { echo "[$(ts)] $*" >> "$LOG"; }

# 敏感模式（ERE）：令牌/密钥/本机用户名路径/内网IP/手机号
PATTERNS='eyJ[A-Za-z0-9_-]{20}|gh[op]_[A-Za-z0-9]{20}|sk-[A-Za-z0-9]{20}|drt-[A-Za-z0-9]{20}|-----BEGIN|/Users/dandan|192\.168\.[0-9]+\.[0-9]+|18116272161'
# 公开仓库额外：真实账号昵称/uid 前缀/内部称呼
PUBLIC_EXTRA='似虎|莫从心|吴先生|蛋蛋|50594f0e|1eb84683|862769a2|3570c70a|f66c5f6a|主人'

sync_repo() {
  local dir="$1" public="$2"
  local name
  name=$(basename "$dir")
  cd "$dir" || { say "$name: 目录不存在，跳过"; return; }

  # 无远程的仓库绝不推（防误配）
  git remote get-url origin >/dev/null 2>&1 || { say "$name: 无 origin，跳过"; return; }

  # 有改动 → 提交
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    # 只扫新增内容（+行），避免把删除行里的旧串误判。
    # 排除脚本自身：git-sync.sh 里的敏感模式是「检测规则字面量」，不是真凭据。
    local diffbody
    diffbody=$(git diff --cached -- . ':(exclude)tools/git-sync.sh' | grep '^+' || true)
    local hits
    hits=$(printf '%s' "$diffbody" | grep -cE "$PATTERNS" || true)
    if [ "$public" = "1" ]; then
      hits=$((hits + $(printf '%s' "$diffbody" | grep -cE "$PUBLIC_EXTRA" || true)))
    fi
    if [ "$hits" -gt 0 ]; then
      git reset -q
      say "$name: ⚠️ 暂存内容命中敏感模式 ${hits} 处，已取消提交，人工检查后再推"
      return
    fi
    git commit -q -m "auto-sync: 本地改动 $(date '+%Y-%m-%d %H:%M')" || { say "$name: 提交失败"; return; }
    say "$name: 已提交本地改动"
  fi

  # 有未推提交 → 推送
  local ahead
  ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
  if [ "$ahead" -gt 0 ]; then
    if git push -q origin main 2>>"$LOG"; then
      say "$name: 已推送 ${ahead} 个提交"
    else
      say "$name: ⚠️ 推送失败（网络/权限？），下轮重试"
    fi
  fi
}

sync_repo "$HOME/Documents/dsh/acct-manager" 1
sync_repo "$HOME/Documents/dsh/qoder-switch" 0

# 日志保 500 行
tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
