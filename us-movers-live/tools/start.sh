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
#
# 想要**固定不变的链接**（重启也不换域名）：本脚本起的 quick tunnel 做不到，
# 那种模式天生随机。走 Cloudflare 命名隧道：
#   bash tools/tunnel-setup.sh movers.你的域名.com
# 配过之后本脚本会自动认出固定链接模式，不再另起 quick tunnel。

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
#: 物理路径版本，只用于一件事：和 `lsof -d cwd` 给出来的工作目录比对。
#: lsof 报的永远是**解析过符号链接**的路径，而 `pwd` 给的是逻辑路径 ——
#: 两者不等时 stop_stale_server 会把手伸向自己的服务当成"别人的程序"而拒绝重启。
#: 这是 fail-safe 的方向（不会误杀），但会让用户完全重启不了，所以两个都认。
ROOT_PHYS="$(cd "$ROOT" && pwd -P)"
PY=/Users/xuzhuoli/.workbuddy/binaries/python/versions/3.13.12/bin/python3
CLOUDFLARED="$HOME/.local/bin/cloudflared"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }
step() { printf "\n\033[1m%s\033[0m\n" "$1"; }

# ---------------------------------------------------------------- 重启开关
#
#   bash tools/start.sh            幂等启动：端口活着就跳过（默认）
#   bash tools/start.sh --restart  先停掉在跑的旧进程，再用当前代码起
#
# 为什么必须有 --restart：本脚本默认不碰已经跑着的服务，所以
# **"改了 server.py 再跑一次 start.sh"是没有任何效果的** —— 服务会一直是旧代码。
# 2026-09-28 就是栽在这里：那天把 /api/us-business-map 的响应结构从"逐家展开"
# 改成了"引用式三表"，前端也换新了，但服务进程从早上连续跑到下午一直没换过代码，
# 期间每次"重启"都只打印一句"已经在运行，跳过"。页面的表现是**所有按钮变灰、
# 点开说这家公司没有映射数据** —— 数据一份不少地躺在磁盘上，只是没人读得到。
RESTART=0
case "${1:-}" in
  --restart|-r) RESTART=1 ;;
  "")           ;;
  *) echo "用法: bash tools/start.sh [--restart]"; exit 2 ;;
esac

# 停掉占用 8787 的**本项目**服务。
# 只动确认是自己人的进程：先取监听 8787 的 pid，再核对它的工作目录就是本项目根目录。
# 万一是别的程序占了 8787，报错退出，绝不盲杀。
stop_stale_server() {
  local pid cwd i
  pid=$(lsof -nP -iTCP:8787 -sTCP:LISTEN -t 2>/dev/null | head -1)
  if [ -z "$pid" ]; then
    ok "没有在跑的服务"
    return 0
  fi
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  if [ "$cwd" != "$ROOT" ] && [ "$cwd" != "$ROOT_PHYS" ]; then
    bad "8787 被别的程序占用（pid ${pid}，工作目录 ${cwd:-未知}）—— 不是本项目，不结束它"
    return 1
  fi
  kill "$pid" 2>/dev/null || { bad "结束进程 ${pid} 失败"; return 1; }
  # 等端口真正释放。kill 之后监听套接字可能还留一小会儿，
  # 不等就起新进程会撞上 "Address already in use" —— 症状同样是"重启了但没变化"。
  for i in $(seq 1 15); do
    curl -s --noproxy '*' --max-time 1 http://127.0.0.1:8787/healthz >/dev/null 2>&1 || break
    sleep 1
  done
  if curl -s --noproxy '*' --max-time 1 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    bad "旧进程（pid ${pid}）没停下来 —— 手动 kill 它再重试"
    return 1
  fi
  ok "已停掉旧服务（pid ${pid}）"
  return 0
}

step "① 看板服务（127.0.0.1:8787）"
if [ "$RESTART" = "1" ]; then
  stop_stale_server || exit 1
fi

if curl -s --noproxy '*' --max-time 3 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
  if [ "$RESTART" = "1" ]; then
    # --restart 模式下还能走到这里，说明上面**没能**把它停掉
    # （最可能是 lsof 列不出占用端口的进程）。这时候绝不能打印"跳过"就收工：
    # 用户会以为代码换新了，实际还跑着旧的 —— 正是这个脚本今天要根治的那类假象。
    bad "重启失败：8787 仍被占用，但没能识别出占用它的进程（lsof 看不到）"
    bad "手动处理：lsof -nP -iTCP:8787 -sTCP:LISTEN 找到 pid，kill 掉，再跑一次本脚本"
    exit 1
  fi
  ok "已经在运行，跳过"
  printf "  \033[33m!\033[0m %s\n" "注意：这不会重新加载 server.py。改了服务端代码要跑 bash tools/start.sh --restart"
else
  cd "$ROOT" || exit 1
  nohup "$PY" server.py >> /tmp/us-movers-live.log 2>&1 &
  disown
  for _ in $(seq 1 20); do
    sleep 1
    curl -s --noproxy '*' --max-time 2 http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break
  done
  if curl -s --noproxy '*' --max-time 3 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    ok "已启动（日志 /tmp/us-movers-live.log）"
  else
    bad "起不来，看 /tmp/us-movers-live.log"
    exit 1
  fi
fi

step "② 公网隧道"

# 命名隧道（固定链接）配过之后，就**不要再起 quick tunnel** 了：
# 两个隧道会同时挂着，quick 那个还会白白占一个随机域名，排障时容易看错是哪个在起作用。
NAMED_HOST=""
if [ -f "$HOME/.cloudflared/config.yml" ]; then
  NAMED_HOST=$(grep -E '^[[:space:]]*-[[:space:]]*hostname:' "$HOME/.cloudflared/config.yml" 2>/dev/null \
    | head -1 | sed -E 's/^[[:space:]]*-[[:space:]]*hostname:[[:space:]]*//' | tr -d '"'"'"' ')
fi
if [ -n "$NAMED_HOST" ]; then
  ok "已配置固定链接：https://$NAMED_HOST"
  if curl -s --noproxy '*' --max-time 3 http://127.0.0.1:20241/metrics 2>/dev/null \
       | grep -q 'cloudflared_tunnel_ha_connections [1-9]'; then
    ok "隧道在运行，跳过"
  else
    P="$HOME/Library/LaunchAgents/com.chenhunxian.us-movers-tunnel.plist"
    if launchctl bootstrap "gui/$(id -u)" "$P" >/dev/null 2>&1; then
      ok "已拉起隧道"
    else
      warn_like="手动跑一次：launchctl bootstrap gui/\$(id -u) $P"
      printf "  \033[33m!\033[0m %s\n" "$warn_like"
    fi
    for _ in $(seq 1 45); do
      sleep 1
      curl -s --noproxy '*' --max-time 2 http://127.0.0.1:20241/metrics 2>/dev/null \
        | grep -q 'cloudflared_tunnel_ha_connections [1-9]' && break
    done
  fi
  exec bash "$ROOT/tools/share-url.sh"
fi

if curl -s --max-time 3 http://127.0.0.1:20241/metrics 2>/dev/null \
     | grep -q 'cloudflared_tunnel_ha_connections [1-9]'; then
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
      | grep -q 'cloudflared_tunnel_ha_connections [1-9]' && break
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
