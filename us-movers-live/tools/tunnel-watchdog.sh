#!/bin/bash
# 「隧道看门狗」—— 定时从**公网侧**探测固定域名，发现 Cloudflare 1033（假连接）就重建隧道。
#
#   bash tools/tunnel-watchdog.sh              # 探测一次，必要时自动重建
#   bash tools/tunnel-watchdog.sh --dry-run    # 只报告，不动手（排障用）
#   bash tools/tunnel-watchdog.sh --verbose    # 连 IP 解析过程一起打出来
#   bash tools/tunnel-watchdog.sh --status     # 看最近一次探测的结论（心跳）
#   bash tools/tunnel-watchdog.sh --install    # 写 launchd plist + 打印注册命令
#
# ── 为什么需要它（2026-10-13 的真实故障） ──────────────────────────────
# 隧道在 http2（TCP）下，链路中断（笔记本休眠 / 换 Wi-Fi / 路由抖动）会留下
# **"假连接"**：本机 metrics 里 `cloudflared_tunnel_ha_connections` 仍是 4、
# 进程活着、socket 也不报错 —— 所以 launchd 的 KeepAlive **不会**拉它
# （进程没死，它没有理由重启）；而 Cloudflare 边缘早已判它离线，
# 访客看到的就是 `Error 1033`。`/tmp/cfd-tunnel.log` 上尤其干净：
# 最后一次 `Registered tunnel connection` 之后一条 `Lost connection` 都没有，
# 肉眼根本看不出异常。这种状态**不会自愈**，只能从外面重建一次。本脚本就是那只手。
#
# ── 判据为什么不是本机 metrics ────────────────────────────────────
# 那次事故里本地 metrics 说"4 条连接都在"，Cloudflare 边缘说"没有连接器"，
# 两边各说各话。唯一可信的是**端到端实测公网域名**（与 share-url.sh 的最后一步同源）。
#
# ── 为什么必须借 lib-doh.sh 解析真实 IP ────────────────────────────
# 本机 DNS 被代理接管成 **fake-ip**（198.18.x.x），直接 `curl https://域名/...`
# 永远不通 —— 会把"好好的"误判成"隧道坏了"，于是每 5 分钟白重启一次。
# 解析 + `--resolve` 那套在 tools/lib-doh.sh 里，本脚本 source 它，别再写第二份。
#
# ── 它明确不做的事 ───────────────────────────────────────────────
# 回源 502/504（8787 上的服务挂了）**不重启隧道**：那是另一类故障，重启治不了，
# 还会把"服务没起来"这条线索盖掉。只有确认是 1033 才动手。

set -u

VERBOSE=0
DRY_RUN=0

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="${DOH_PY:-/Users/xuzhuoli/.workbuddy/binaries/python/versions/3.13.12/bin/python3}"

# ── 可覆盖项：**不是为了灵活，是为了可测** ──
# tools/test_tunnel_watchdog.py 会把 LOG / HEARTBEAT / STATE 指到临时目录、
# 把 CURL / LAUNCHCTL 换成桩程序，并用 WATCHDOG_IP_OVERRIDE / WATCHDOG_RESOLVER_CMD
# 跳过 DoH 解析，从而在没有真实隧道、不联网的情况下把每一条分支都验一遍。
LOG="${WATCHDOG_LOG:-/tmp/cfd-watchdog.log}"
HEARTBEAT="${WATCHDOG_HEARTBEAT:-/tmp/cfd-watchdog.heartbeat}"
STATE="${WATCHDOG_STATE:-/tmp/cfd-watchdog.state}"
CURL="${WATCHDOG_CURL:-curl}"
LAUNCHCTL="${WATCHDOG_LAUNCHCTL:-launchctl}"
CONFIG="${CLOUDFLARE_CONFIG:-$HOME/.cloudflared/config.yml}"
# 隧道服务的标签：重建就是 kickstart 它，别写错（写错会去踢一个不存在的服务）
LABEL="${TUNNEL_LABEL:-com.chenhunxian.us-movers-tunnel}"
WATCHDOG_LABEL="com.chenhunxian.us-movers-watchdog"
PLIST="${WATCHDOG_PLIST:-$HOME/Library/LaunchAgents/${WATCHDOG_LABEL}.plist}"
INTERVAL="${WATCHDOG_INTERVAL:-300}"          # launchd 的 StartInterval（秒）
PROBE_PATH="${WATCHDOG_PATH:-/morning}"
MIN_RESTART_INTERVAL="${MIN_RESTART_INTERVAL:-600}"   # 两次重建的最小间隔（防重启风暴）
POST_RESTART_WAIT="${POST_RESTART_WAIT:-12}"          # 重建后等多久再复测
#: 观测用的两个文件：日志只记**异常与动作**（健康时静默，不然 5 分钟一条会淹掉），
#: 心跳每轮覆盖写一行，解答"它到底还在不在跑"。
CF_LOG="/tmp/cfd-tunnel.log"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"${LOG}" 2>/dev/null || true
}

beat() {
  printf '%s\tcode=%s\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "$2" >"${HEARTBEAT}" 2>/dev/null || true
}

say() {
  if [ "${VERBOSE}" = "1" ]; then printf '%s\n' "$1" >&2; fi
}

# ── 找域名：以 cloudflared 真正读的那份 config.yml 为单一真源（同 share-url.sh） ──
resolve_host() {
  local host="${WATCHDOG_HOST:-}"
  if [ -z "${host}" ] && [ -f "${CONFIG}" ]; then
    host=$(grep -E '^[[:space:]]*-[[:space:]]*hostname:' "${CONFIG}" 2>/dev/null \
      | head -1 | sed -E 's/^[[:space:]]*-[[:space:]]*hostname:[[:space:]]*//' | tr -d '"'"'"' ')
  fi
  printf '%s' "${host}"
}

# 探一次：HTTP 码打到 stdout，响应体落 BODY_FILE。
# 用 --resolve 直连真实 IP：绕开被接管的 fake-ip 解析器（见文件头）。
probe() {
  local ip="$1" code
  code=$("${CURL}" -s --noproxy '*' --resolve "${HOST}:443:${ip}" \
           -o "${BODY_FILE}" --max-time 20 -w '%{http_code}' \
           "https://${HOST}${PROBE_PATH}" 2>/dev/null)
  printf '%s' "${code:-000}"
}

# ── 重建：kickstart 隧道服务 ──
rebuild() {
  local now last
  now=$(date +%s)
  last=0
  if [ -f "${STATE}" ]; then
    last=$(cat "${STATE}" 2>/dev/null || echo 0)
  fi
  case "${last}" in ''|*[!0-9]*) last=0 ;; esac

  # 限速：如果是 Cloudflare 侧的问题（重启也白搭），别每 5 分钟踢一次
  if [ "${last}" -gt 0 ] && [ $(( now - last )) -lt "${MIN_RESTART_INTERVAL}" ]; then
    log "距上次重建仅 $(( now - last ))s（门槛 ${MIN_RESTART_INTERVAL}s），本轮跳过（防重启风暴）"
    beat "${CODE}" "1033 · 距上次重建过近，跳过"
    return 3
  fi

  if [ "${DRY_RUN}" = "1" ]; then
    log "dry-run：本该执行 ${LAUNCHCTL} kickstart -k gui/$(id -u)/${LABEL}"
    beat "${CODE}" "1033 · dry-run，未动手"
    return 0
  fi

  printf '%s' "${now}" >"${STATE}" 2>/dev/null || true
  log "重建隧道：${LAUNCHCTL} kickstart -k gui/$(id -u)/${LABEL}"
  if ! "${LAUNCHCTL}" kickstart -k "gui/$(id -u)/${LABEL}" >>"${LOG}" 2>&1; then
    log "重建失败 —— 看门狗无权或 ${LABEL} 未注册。请人工跑：launchctl kickstart -k gui/\$(id -u)/${LABEL}"
    beat "${CODE}" "重建失败（看 launchctl 权限/注册）"
    return 1
  fi

  sleep "${POST_RESTART_WAIT}"
  local code2
  code2=$(probe "${IP}")
  if [ "${code2}" = "200" ]; then
    log "重建后复测 ${code2} —— 已恢复"
    beat "${code2}" "重建后恢复"
    return 0
  fi
  log "重建后复测 ${code2} —— 仍未恢复（边缘收敛中，或另有故障）"
  beat "${code2}" "重建后仍 ${code2}"
  return 1
}

do_install() {
  mkdir -p "$(dirname "${PLIST}")" 2>/dev/null
  cat >"${PLIST}" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- 隧道看门狗。由 tools/tunnel-watchdog.sh --install 生成 —— 重跑会覆盖本文件，别手改。
     周期任务而非常驻服务：**故意不写 KeepAlive**（探测完就该退出），
     靠 StartInterval 每 ${INTERVAL} 秒被叫醒一次；隧道本身的重启由脚本里的 kickstart 负责。 -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WATCHDOG_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${ROOT}/tools/tunnel-watchdog.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>${INTERVAL}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
</dict>
</plist>
PLIST_EOF
  echo "已写入 ${PLIST}（每 ${INTERVAL} 秒探测一次 ${PROBE_PATH}）"
  echo
  echo "注册（在你自己的终端跑一次，launchd 的注册在 AI 会话里做不了）："
  echo "  launchctl bootstrap gui/\$(id -u) \"${PLIST}\""
  echo
  echo "看状态：bash tools/tunnel-watchdog.sh --status"
  echo "卸载：  launchctl bootout gui/\$(id -u)/${WATCHDOG_LABEL}"
}

do_status() {
  echo "── 看门狗心跳 ─────────────────────────"
  if [ -f "${HEARTBEAT}" ]; then cat "${HEARTBEAT}"; else echo "  （无 —— 还没跑过，或还没注册）"; fi
  echo
  echo "── 最近动作（${LOG}） ──────────────"
  if [ -f "${LOG}" ]; then tail -15 "${LOG}"; else echo "  （无 —— 说明一直健康，脚本只在异常时写日志）"; fi
  echo
  echo "── launchd ────────────────────────────"
  "${LAUNCHCTL}" print "gui/$(id -u)/${WATCHDOG_LABEL}" 2>&1 \
    | grep -E "state =|pid =|runs =|last exit code" | head -5
  return 0
}

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
}

# ────────────────────────────── 入口 ──────────────────────────────
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  -v|--verbose) VERBOSE=1 ;;
  --install) do_install; exit $? ;;
  --status) do_status; exit $? ;;
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) echo "用法: bash tools/tunnel-watchdog.sh [--dry-run|--verbose|--install|--status]"; exit 2 ;;
esac

HOST="$(resolve_host)"
if [ -z "${HOST}" ]; then
  log "拿不到域名（${CONFIG} 里没有 hostname，也没给 WATCHDOG_HOST）—— 跳过"
  beat "n/a" "没有域名可探测"
  exit 0
fi

# 响应体临时文件（macOS / Linux 的 mktemp 都能 -t）
BODY_FILE="$(mktemp -t cfd-watchdog-body 2>/dev/null || echo "/tmp/cfd-watchdog-body.$$")"
trap 'rm -f "${BODY_FILE}"' EXIT

# ── 解析真实 IP（fake-ip 坑见文件头）；测试可直接注入 ──
IP="${WATCHDOG_IP_OVERRIDE:-}"
if [ -z "${IP}" ]; then
  if [ -n "${WATCHDOG_RESOLVER_CMD:-}" ]; then
    # 只为可测：整体换掉解析器，用例便不必联网（见上面「可覆盖项」）
    IP=$("${WATCHDOG_RESOLVER_CMD}" "${HOST}" 2>/dev/null) || IP=""
  else
    DOH_PY="${PY}"
    # shellcheck source=tools/lib-doh.sh
    . "${ROOT}/tools/lib-doh.sh"
    if [ "${VERBOSE}" = "1" ]; then
      IP=$(doh_resolve_ip "${HOST}") || IP=""
    else
      IP=$(doh_resolve_ip "${HOST}" 2>/dev/null) || IP=""
    fi
  fi
fi
if [ -z "${IP}" ]; then
  log "解析不到 ${HOST} 的真实 IP —— 跳过（这是本机网络/DNS 的问题，不是隧道）"
  beat "no-ip" "解析不到真实 IP，跳过"
  exit 0
fi

CODE=$(probe "${IP}")
BODY=$(cat "${BODY_FILE}" 2>/dev/null || true)

case "${CODE}" in
  2*)
    beat "${CODE}" "健康"
    say "✓ https://${HOST}${PROBE_PATH} → ${CODE}（健康）"
    exit 0
    ;;
  530)
    if printf '%s' "${BODY}" | grep -q '1033'; then
      log "端到端 ${CODE} + 1033 —— 隧道假连接，准备重建"
    else
      log "端到端 ${CODE}（并非 1033）—— 不动手，人工看 ${CF_LOG}"
      beat "${CODE}" "530 但非 1033，未处理"
      exit 0
    fi
    ;;
  000)
    log "端到端连不通（curl 未拿到响应）—— 本机网络问题，跳过"
    beat "000" "连不通，跳过"
    exit 0
    ;;
  *)
    log "端到端返回 ${CODE} —— 疑似回源故障（8787 上的服务），**不**重启隧道"
    beat "${CODE}" "非 1033，不重启隧道"
    exit 0
    ;;
esac

rebuild
exit $?
