#!/bin/bash
# 打印当前对外的分享地址，并顺手体检一遍。
#
#   bash tools/share-url.sh
#
# 背景：quick tunnel 每次**重新启动**都会换一个新域名，所以地址不能写死在
# 文档或聊天记录里 —— 一律用这个脚本现取。它同时会验证整条链路：
#   服务在监听？ → 隧道进程活着？ → 域名解析正常？ → 端到端返回 200？

set -u

LOG=/tmp/cfd-tunnel.log
DOMAIN=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1)

echo "── 本地服务 ─────────────────────────────"
if curl -s --max-time 5 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
  echo "  ✓ 8787 在监听"
else
  echo "  ✗ 8787 无响应 —— 服务没起来（launchctl list | grep chenhunxian）"
fi

echo "── 隧道进程 ─────────────────────────────"
if curl -s --noproxy '*' --max-time 5 http://127.0.0.1:20241/metrics 2>/dev/null \
     | grep -q 'cloudflared_tunnel_ha_connections 1'; then
  echo "  ✓ 隧道已连接 Cloudflare"
else
  echo "  ✗ 隧道未连接（cloudflared 可能正在重启，等十几秒再试）"
fi

if [ -z "$DOMAIN" ]; then
  echo "── 分享地址 ─────────────────────────────"
  echo "  ✗ 日志里还没有地址：$LOG"
  exit 1
fi

echo "── 分享地址 ─────────────────────────────"
echo "  夜盘异动  $DOMAIN/evening"
echo "  早盘总结  $DOMAIN/morning"
echo

# 端到端验证。**必须指定真实 IP**：本机 DNS 被代理接管成 fake-ip（198.18.x.x），
# 直接用域名 curl 永远不通，会误判成"隧道坏了"。
IP=$(curl -s --noproxy '*' --max-time 10 \
       -H 'accept: application/dns-json' \
       "https://1.1.1.1/dns-query?name=${DOMAIN#https://}&type=A" 2>/dev/null \
     | /Users/xuzhuoli/.workbuddy/binaries/python/versions/3.13.12/bin/python3 -c \
       "import sys,json
try:
    d=json.load(sys.stdin)
    print(next(a['data'] for a in d.get('Answer',[]) if a.get('type')==1))
except Exception:
    print('')" 2>/dev/null)

if [ -z "$IP" ]; then
  echo "  （拿不到真实 IP，跳过端到端验证）"
  exit 0
fi

CODE=$(curl -s --noproxy '*' --resolve "${DOMAIN#https://}:443:$IP" \
         -o /dev/null --max-time 20 -w '%{http_code}' "$DOMAIN/evening" 2>/dev/null)
if [ "$CODE" = "200" ]; then
  echo "  ✓ 端到端验证通过（$DOMAIN/evening → 200）"
else
  echo "  ✗ 端到端返回 $CODE —— 隧道活着但回源失败，看 $LOG 里的 'Unable to reach the origin service'"
fi
