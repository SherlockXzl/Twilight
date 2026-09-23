#!/bin/bash
# 打印当前对外的分享地址，并顺手体检一遍。
#
#   bash tools/share-url.sh
#
# 两种模式，脚本自动判断：
#
#   ① 固定链接（推荐）—— 命名隧道。Host 写在 ~/.cloudflared/config.yml 里，
#      **重启也不变**，可以直接发出去、存进收藏夹。用 tools/tunnel-setup.sh 配。
#   ② 临时链接 —— quick tunnel。每次重启换新域名，所以地址不能写死在文档或
#      聊天记录里，一律用这个脚本现取。
#
# 体检链路顺序是有讲究的（每一步失败都对应一类不同的故障）：
#   本机服务在监听？ → 隧道进程连着 Cloudflare？ → 域名解析得出真实 IP？ → 端到端 200？

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY=/Users/xuzhuoli/.workbuddy/binaries/python/versions/3.13.12/bin/python3
LOG=/tmp/cfd-tunnel.log
CONFIG="$HOME/.cloudflared/config.yml"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }
info() { printf "  \033[33m·\033[0m %s\n" "$1"; }

# ── 固定链接模式？判断依据是 config.yml 里第一条 ingress 的 hostname ──
# 用 config.yml 而不是别的缓存文件：它是 cloudflared 真正读的那份，天生单一真源。
FIXED_HOST=""
if [ -f "$CONFIG" ]; then
  FIXED_HOST=$(grep -E '^[[:space:]]*-[[:space:]]*hostname:' "$CONFIG" 2>/dev/null \
    | head -1 | sed -E 's/^[[:space:]]*-[[:space:]]*hostname:[[:space:]]*//' | tr -d '"'"'"' ')
fi

# ── 临时链接模式：从日志里抓完整的 https://xxx.trycloudflare.com ──
# 必须匹配**完整地址**而不是 'trycloudflare.com'：日志里
# "Requesting new quick Tunnel on trycloudflare.com..." 那行也含这个字样，
# 用它当条件会在隧道还没分配地址时就误判成功（踩过）。
QUICK_HOST=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1)

if [ -n "$FIXED_HOST" ]; then
  DOMAIN="https://$FIXED_HOST"
  MODE="固定链接（命名隧道）"
elif [ -n "$QUICK_HOST" ]; then
  DOMAIN="$QUICK_HOST"
  MODE="临时链接（quick tunnel，重启会变）"
else
  DOMAIN=""
  MODE="未知"
fi

echo "── 本地服务 ─────────────────────────────"
if curl -s --max-time 5 "http://127.0.0.1:8787/healthz" >/dev/null 2>&1; then
  ok "8787 在监听"
else
  bad "8787 无响应 —— 服务没起来（bash tools/start.sh）"
fi

echo "── 隧道进程 ─────────────────────────────"
if curl -s --noproxy '*' --max-time 5 http://127.0.0.1:20241/metrics 2>/dev/null \
     | grep -q 'cloudflared_tunnel_ha_connections [1-9]'; then
  ok "隧道已连接 Cloudflare"
else
  bad "隧道未连接（刚重启的话等十几秒；还不通看 $LOG / launchctl list | grep chenhunxian）"
fi

if [ -z "$DOMAIN" ]; then
  echo "── 分享地址 ─────────────────────────────"
  bad "拿不到地址。既没有 $CONFIG 里的 hostname，日志 $LOG 里也没有 quick tunnel 地址。"
  echo "    固定链接：bash tools/tunnel-setup.sh <你的域名>"
  echo "    临时链接：bash tools/start.sh"
  exit 1
fi

echo "── 分享地址 ─────────────────────────────"
info "$MODE"
echo "  夜盘异动  $DOMAIN/evening"
echo "  早盘总结  $DOMAIN/morning"
if [ -n "$FIXED_HOST" ]; then
  echo
  ok "这个地址是固定的，重启/换网络都不会变，可以直接发出去"
fi
echo

# ── 端到端验证 ──
# 必须解析出**真实 IP** 再 curl：本机 DNS 被代理接管成 fake-ip（198.18.x.x），
# 直接用域名 curl 永远不通，会误判成"隧道坏了"。
# 解析逻辑（多源 + 国内源优先）在 tools/lib-doh.sh 里，和 tunnel-setup.sh 共用。
DOMAIN_HOST="${DOMAIN#https://}"
DOH_PY="$PY"          # 复用同一个解释器，别让 lib 自己再猜一遍路径
# shellcheck source=tools/lib-doh.sh
. "$ROOT/tools/lib-doh.sh"

IP=$(doh_resolve_ip "$DOMAIN_HOST") || IP=""
if [ -z "$IP" ]; then
  info "所有解析源都拿不到 IP，跳过端到端验证"
  echo "    （DNS 可能还在生效中 —— 新加的记录一般 1~5 分钟；本机路由器还可能缓存着旧结果）"
  exit 0
fi

CODE=$(curl -s --noproxy '*' --resolve "$DOMAIN_HOST:443:$IP" \
         -o /dev/null --max-time 25 -w '%{http_code}' "$DOMAIN/evening" 2>/dev/null)
if [ "$CODE" = "200" ]; then
  ok "端到端验证通过（$DOMAIN/evening → 200，解析 IP ${IP}）"
else
  bad "端到端返回 $CODE —— 隧道活着但回源失败，看 $LOG 里的 'Unable to reach the origin service'"
fi

