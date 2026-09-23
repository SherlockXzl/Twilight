#!/bin/bash
# 一键启动「夜盘异动」看板 + 公网隧道，并打印可以直接发给朋友的地址。
#
#   bash tools/start.sh
#
# 为什么需要你手动跑一次：看板的两个进程（Python 服务 + cloudflared 隧道）
# 如果由 AI 助手侧的会话启动，会话结束就会被系统连带清理 —— nohup、disown、
# 新会话都挡不住。放在你自己的终端里跑，进程就归你的 shell，能一直活着。
#
# 想彻底免手动（开机自启 + 崩溃自启），跑：
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.chenhunxian.us-movers-live.plist
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.chenhunxian.us-movers-tunnel.plist
# （plist 已经写好放在 ~/Library/LaunchAgents/，本脚本会自动尝试一次）

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY=/Users/xuzhuoli/.workbuddy/binaries/python/versions/3.13.12/bin/python3
CLOUDFLARED="$HOME/.local/bin/cloudflared"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }
step() { printf "\n\033[1m%s\033[0m\n" "$1"; }

step "① 看板服务（127.0.0.1:8787）"
if curl -s --max-time 3 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
  ok "已经在运行，跳过"
else
  cd "$ROOT" || exit 1
  nohup "$PY" server.py >> /tmp/us-movers-live.log 2>&1 &
  disown
  for _ in $(seq 1 20); do
    sleep 1
    curl -s --max-time 2 http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break
  done
  if curl -s --max-time 3 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    ok "已启动（日志 /tmp/us-movers-live.log）"
  else
    bad "起不来，看 /tmp/us-movers-live.log"
    exit 1
  fi
fi

step "② 公网隧道"
if curl -s --max-time 3 http://127.0.0.1:20241/metrics 2>/dev/null \
     | grep -q 'cloudflared_tunnel_ha_connections 1'; then
  ok "已经在运行，跳过"
else
  if [ ! -x "$CLOUDFLARED" ]; then
    bad "找不到 $CLOUDFLARED"
    exit 1
  fi
  : > /tmp/cfd-tunnel.log                    # 清空，免得读到上一次的旧地址
  nohup "$CLOUDFLARED" tunnel --url http://127.0.0.1:8787 --no-autoupdate \
        >> /tmp/cfd-tunnel.log 2>&1 &
  disown
  # 注意匹配的是**完整地址**而不是 'trycloudflare.com'：日志里
  # "Requesting new quick Tunnel on trycloudflare.com..." 那行也含这个字样，
  # 用它当条件会在隧道还没分配地址时就误判成功（踩过）。
  URL_RE='https://[a-z0-9-]+\.trycloudflare\.com'
  printf "  等待分配地址"
  for _ in $(seq 1 60); do
    sleep 1
    printf "."
    grep -qE "$URL_RE" /tmp/cfd-tunnel.log && break
  done
  printf "\n"
  if ! grep -qE "$URL_RE" /tmp/cfd-tunnel.log; then
    bad "60 秒没拿到地址，看 /tmp/cfd-tunnel.log"
    exit 1
  fi
  ok "已分配地址"

  # 再等「隧道真的连上 Cloudflare」——地址一行出来时握手可能还没完成，
  # 这时候去访问会得到 502，容易被误当成配置错误。
  printf "  等待隧道连上 Cloudflare"
  for _ in $(seq 1 40); do
    sleep 1
    printf "."
    curl -s --max-time 2 http://127.0.0.1:20241/metrics 2>/dev/null \
      | grep -q 'cloudflared_tunnel_ha_connections 1' && break
  done
  printf "\n"
  ok "隧道已就绪"
fi

step "③ 尝试设为开机自启（失败不影响本次使用）"
LOADED=1
for L in us-movers-live us-movers-tunnel; do
  P="$HOME/Library/LaunchAgents/com.chenhunxian.$L.plist"
  [ -f "$P" ] || { LOADED=0; continue; }
  if launchctl print "gui/$(id -u)/com.chenhunxian.$L" >/dev/null 2>&1; then
    ok "$L 已注册"
  elif launchctl bootstrap "gui/$(id -u)" "$P" >/dev/null 2>&1; then
    ok "$L 已注册（以后开机自动起）"
  else
    LOADED=0
  fi
done
[ "$LOADED" = "0" ] && printf "  \033[33m·\033[0m 跳过（本机 launchctl 不可用或已被上一步手动启动覆盖）—— 不影响本次分享\n"

# 打印地址（顺便做一次端到端体检）
exec bash "$ROOT/tools/share-url.sh"
