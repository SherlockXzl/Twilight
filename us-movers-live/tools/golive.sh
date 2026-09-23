#!/bin/bash
# 把「晨昏线」的两个进程**交给 launchd 托管**（开机自启 + 崩溃自启）。
#
#   bash tools/golive.sh
#
# 为什么需要这一步：
# 开发期间这两个进程常常是从 AI 会话或某个临时终端里起的，而**会话一结束
# 就被系统连带回收** —— `nohup`、`disown`、`setsid` 都挡不住。症状是
# "某天打开链接发现打不开了"，日志停在某一刻、**没有任何报错**，很难判断
# 到底是进程没了还是隧道坏了。交给 launchd 才真正长期活着：
#   · RunAtLoad —— 登录即启动
#   · KeepAlive —— 进程死了自动拉起（网络抖动、崩溃都能自愈）
#
# 本脚本做三件事：
#   ① 检查 plist
#   ② 对每个服务：先 `bootout`（卸掉托管实例，没有就跳过）→ 再收掉**仍占着端口**
#      的进程 → `bootstrap` 重新拉起
#   ③ 等两个都健康，然后打印固定链接
#
# ⚠️ 必须在**你自己的终端**里跑：AI 助手的沙箱里 `launchctl bootstrap` 会被
#    系统拒绝（报 `Bootstrap failed: 5: Input/output error`）。
#
# 关于"怎么判断哪个进程该收"：不靠猜。**先 bootout**，之后任何仍占着该端口的
# 进程就必然不是托管实例，只能是从会话/终端里起来的野进程。
# （试过用 `ps -o ppid=` 看父进程是不是 launchd，但这个环境读不到别人的进程，
#   返回空 —— 空值会被误判成"野进程"，判据本身不可靠。）
#
# 幂等：重复跑只是把两个服务各重启一遍。

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UID_NUM="$(id -u)"
DOMAIN_GUI="gui/$UID_NUM"

SVC_LABEL="com.chenhunxian.us-movers-live"
TUN_LABEL="com.chenhunxian.us-movers-tunnel"
SVC_PLIST="$HOME/Library/LaunchAgents/$SVC_LABEL.plist"
TUN_PLIST="$HOME/Library/LaunchAgents/$TUN_LABEL.plist"

SVC_PORT=8787
TUN_PORT=20241

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
step() { printf "\n\033[1m%s\033[0m\n" "$1"; }

# 端口的占用者：返回 "PID 命令名"，没有则返回空。
# 用 lsof 而不是 ps —— 这个环境下 `ps -p <别人的PID>` 读不到，lsof 可以。
port_holder() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null \
    | awk 'NR==2 {print $2" "$1}'
}

# ── ① plist ──
step "① 检查配置文件"
MISSING=0
for P in "$SVC_PLIST" "$TUN_PLIST"; do
  if [ -f "$P" ]; then
    ok "$(basename "$P")"
  else
    bad "缺少 $(basename "$P")"
    MISSING=1
  fi
done
if [ "$MISSING" = "1" ]; then
  echo
  echo "  看板服务的 plist 由仓库自带；隧道的 plist 由这条命令生成："
  echo "      bash tools/tunnel-setup.sh <你的域名>"
  exit 1
fi

# ── ② 交接 ──
# 一个服务的完整交接：bootout → 收掉残留 → bootstrap。
# 注意 launchd 的 bootout/bootstrap 对"本来就没注册"的 label 会返回非 0，
# 这属于正常情况（第一次部署就是），所以不看退出码，只看最终端口状态。
handover() {
  local label="$1" plist="$2" port="$3" what="$4" pid cmd

  if launchctl print "$DOMAIN_GUI/$label" >/dev/null 2>&1; then
    printf "  · %s 已在托管，先卸下来\n" "$what"
    launchctl bootout "$DOMAIN_GUI/$label" >/dev/null 2>&1
    sleep 2
  fi

  # bootout 之后还占着端口的，必然是会话/终端里起的野进程
  local holder
  holder=$(port_holder "$port")
  if [ -n "$holder" ]; then
    pid=${holder%% *}
    cmd=${holder##* }
    warn "$port 被野进程占着（PID ${pid}，${cmd}）——收掉它"
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 8); do
      sleep 1
      kill -0 "$pid" 2>/dev/null || break
    done
    if kill -0 "$pid" 2>/dev/null; then
      warn "还没退，强制收掉"
      kill -9 "$pid" 2>/dev/null
      sleep 2
    fi
  fi

  if [ -n "$(port_holder "$port")" ]; then
    bad "$port 仍被占用，${what} 大概起不来"
    return 1
  fi
  ok "$port 已释放"

  if launchctl bootstrap "$DOMAIN_GUI" "$plist" >/dev/null 2>&1; then
    ok "${what} 已注册（以后开机自动起、崩了自动拉）"
  else
    bad "${what} 注册失败 —— 确认是在**你自己的终端**里跑的（不是 AI 沙箱）"
    return 1
  fi
  return 0
}

step "② 交接给 launchd"
FAIL=0
handover "$SVC_LABEL" "$SVC_PLIST" "$SVC_PORT" "看板服务" || FAIL=1
handover "$TUN_LABEL" "$TUN_PLIST" "$TUN_PORT" "隧道" || FAIL=1

# ── ③ 等健康 ──
step "③ 等两个进程就绪"

printf "  看板服务 8787 "
SVC_OK=0
for _ in $(seq 1 40); do
  sleep 1
  printf "."
  if curl -s --noproxy '*' --max-time 2 "http://127.0.0.1:$SVC_PORT/healthz" 2>/dev/null \
       | grep -q '"ok"'; then
    SVC_OK=1
    break
  fi
done
printf "\n"
[ "$SVC_OK" = "1" ] && ok "看板服务健康" || bad "看板服务没起来 —— 看 /tmp/us-movers-live.log"

printf "  隧道连 Cloudflare "
TUN_OK=0
for _ in $(seq 1 45); do
  sleep 1
  printf "."
  if curl -s --noproxy '*' --max-time 2 "http://127.0.0.1:$TUN_PORT/metrics" 2>/dev/null \
       | grep -q 'cloudflared_tunnel_ha_connections [1-9]'; then
    TUN_OK=1
    break
  fi
done
printf "\n"
[ "$TUN_OK" = "1" ] && ok "隧道已连接" || bad "隧道没连上 —— 看 /tmp/cfd-tunnel.log"

if [ "$FAIL" = "1" ] || [ "$SVC_OK" != "1" ] || [ "$TUN_OK" != "1" ]; then
  echo
  bad "没全部就绪，先别急着分享链接。排查："
  echo "      launchctl list | grep chenhunxian"
  echo "      tail -30 /tmp/us-movers-live.log"
  echo "      tail -30 /tmp/cfd-tunnel.log"
  exit 1
fi

step "④ 完成"
echo
exec bash "$ROOT/tools/share-url.sh"
