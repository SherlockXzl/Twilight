#!/usr/bin/env python3
"""隧道看门狗（tools/tunnel-watchdog.sh）的用例。

    python3 tools/test_tunnel_watchdog.py

**不碰真实隧道、不联网**：把 curl / launchctl 换成桩程序、把日志与状态文件指到
临时目录、用 WATCHDOG_IP_OVERRIDE 跳过 DoH 解析，每条分支都能在本地验一遍。

为什么值得测：
  · 看门狗是**会自己改系统状态**的脚本（真的去 kickstart 隧道服务）。判错一次
    就会把好好的隧道白重启一遍 —— 分支必须逐条钉死。
  · 判据里最容易写错的两处：① `530` 还得看 body 是不是 `1033`（别的 530 不该动手）；
    ② 回源 `502` **绝不能**重启隧道（那是 8787 上的事，重启治不了还盖掉线索）。
  · `--install` 的 plist 是 heredoc 拼出来的，变量没展开、多打一个引号都不会报错，
    只有把它读回来断言才看得见（和 tools/test_tunnel.py 同一个道理）。
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "tools" / "tunnel-watchdog.sh"
UID = os.getuid()
TUNNEL_LABEL = "com.chenhunxian.us-movers-tunnel"

passed = 0
failed = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✓ {label}")
    else:
        failed += 1
        print(f"  ✗ {label}")
        if detail:
            print(f"      {detail.strip()[:400]}")


# ── 桩 curl：按 STUB_SEQ 逐次返回 "code:body"，调用次数记到 STUB_CALLS ──
CURL_STUB = r"""#!/bin/bash
set -u
out=""; fmt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) fmt="$2"; shift 2 ;;
    -s) shift ;;
    --noproxy|--resolve|--max-time|-H) shift 2 ;;
    *) shift ;;
  esac
done
n=0
[ -f "${STUB_CALLS}" ] && n=$(cat "${STUB_CALLS}" 2>/dev/null)
n=$(( n + 1 ))
printf '%s' "$n" > "${STUB_CALLS}"
line=$(sed -n "${n}p" "${STUB_SEQ}" 2>/dev/null)
[ -z "$line" ] && line=$(tail -1 "${STUB_SEQ}" 2>/dev/null)
code="${line%%:*}"
body="${line#*:}"
[ -n "$out" ] && printf '%s' "$body" > "$out"
[ -n "$fmt" ] && printf '%s' "$code"
exit 0
"""

# ── 桩 launchctl：把参数追加到 STUB_LAUNCHCTL_CALLS，退出码取 STUB_LAUNCHCTL_RC ──
LAUNCHCTL_STUB = r"""#!/bin/bash
set -u
printf '%s\n' "$*" >> "${STUB_LAUNCHCTL_CALLS}"
exit "${STUB_LAUNCHCTL_RC:-0}"
"""


def run_case(seq, *, state_age=None, args=(), launchctl_rc=0, ip="1.2.3.4", extra_env=None):
    """跑一次看门狗，返回 {rc, out, log, beat, calls}。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        (tmp / "stubs").mkdir()
        curl = tmp / "stubs" / "curl"
        curl.write_text(CURL_STUB, encoding="utf-8")
        curl.chmod(0o755)
        lctl = tmp / "stubs" / "launchctl"
        lctl.write_text(LAUNCHCTL_STUB, encoding="utf-8")
        lctl.chmod(0o755)

        (tmp / "seq").write_text("\n".join(seq) + "\n", encoding="utf-8")
        if state_age is not None:
            (tmp / "wd.state").write_text(str(int(time.time()) - state_age), encoding="utf-8")

        env = os.environ.copy()
        env.update({
            "WATCHDOG_HOST": "probe.example.com",
            "WATCHDOG_PATH": "/morning",
            "WATCHDOG_LOG": str(tmp / "wd.log"),
            "WATCHDOG_HEARTBEAT": str(tmp / "wd.beat"),
            "WATCHDOG_STATE": str(tmp / "wd.state"),
            "WATCHDOG_CURL": str(curl),
            "WATCHDOG_LAUNCHCTL": str(lctl),
            "TUNNEL_LABEL": TUNNEL_LABEL,
            "MIN_RESTART_INTERVAL": "600",
            "POST_RESTART_WAIT": "0",
            "STUB_SEQ": str(tmp / "seq"),
            "STUB_CALLS": str(tmp / "calls"),
            "STUB_LAUNCHCTL_CALLS": str(tmp / "lctl.calls"),
            "STUB_LAUNCHCTL_RC": str(launchctl_rc),
        })
        if ip is not None:
            env["WATCHDOG_IP_OVERRIDE"] = ip
        else:
            env.pop("WATCHDOG_IP_OVERRIDE", None)
        if extra_env:
            env.update(extra_env)

        p = subprocess.run(["bash", str(SCRIPT), *args], env=env,
                           capture_output=True, text=True, timeout=60)

        def rd(name):
            f = tmp / name
            return f.read_text(encoding="utf-8") if f.exists() else ""

        return {
            "rc": p.returncode,
            "out": (p.stdout or "") + (p.stderr or ""),
            "log": rd("wd.log"),
            "beat": rd("wd.beat"),
            "calls": rd("lctl.calls"),
        }


def main() -> int:
    print("── 健康路径 ─────────────────────────────")
    r = run_case(["200:<html>ok</html>"])
    check("200 → 退出 0", r["rc"] == 0, f'rc={r["rc"]} {r["out"]}')
    check("200 → 一个 launchctl 都不调", r["calls"] == "", r["calls"])
    check("200 → 心跳写「健康」", "健康" in r["beat"], r["beat"])
    check("200 → 不写日志（健康时保持安静）", r["log"] == "", r["log"])

    print("── 假连接（1033）→ 重建 ─────────────────")
    r = run_case(["530:error code: 1033", "200:<html>ok</html>"])
    check("1033 → 恰好重建一次", r["calls"].count("kickstart") == 1, r["calls"])
    check("1033 → kickstart 参数是 -k gui/<uid>/<label>",
          f"kickstart -k gui/{UID}/{TUNNEL_LABEL}" in r["calls"], r["calls"])
    check("1033 → 复测恢复后退出 0", r["rc"] == 0, f'rc={r["rc"]} {r["out"]}')
    check("1033 → 心跳记「恢复」", "恢复" in r["beat"], r["beat"])
    check("1033 → 日志留了重建记录", "重建隧道" in r["log"], r["log"])

    print("── 防重启风暴 ───────────────────────────")
    r = run_case(["530:error code: 1033"], state_age=100)
    check("距上次重建 100s（<600s）→ 不重启", r["calls"] == "", r["calls"])
    check("被限速时退出 3（区别于「没事做」的 0）", r["rc"] == 3, f'rc={r["rc"]}')
    check("限速理由写进日志", "防重启风暴" in r["log"], r["log"])

    r = run_case(["530:error code: 1033", "200:"], state_age=9999)
    check("距上次重建 9999s（>600s）→ 照常重启", r["calls"].count("kickstart") == 1, r["calls"])

    print("── 不该动手的三种情况 ───────────────────")
    r = run_case(["502:"])
    check("回源 502 → 绝不重启隧道", r["calls"] == "", r["calls"])
    check("回源 502 → 日志点明是 8787 的事", "回源" in r["log"], r["log"])

    r = run_case(["530:<html>some other cloudflare page</html>"])
    check("530 但 body 不是 1033 → 不动手", r["calls"] == "", r["calls"])
    check("530 非 1033 → 心跳如实标注", "非 1033" in r["beat"], r["beat"])

    r = run_case(["000:"])
    check("连不通（不辨真伪）→ 不动手", r["calls"] == "", r["calls"])
    check("连不通 → 退出 0（不是错误）", r["rc"] == 0, f'rc={r["rc"]}')

    r = run_case(["200:"], ip=None, extra_env={"WATCHDOG_RESOLVER_CMD": "/bin/false"})
    check("解析不到真实 IP → 不探测、不动手", r["calls"] == "", r["calls"])
    check("解析不到 IP → 心跳标 no-ip", "no-ip" in r["beat"], r["beat"])

    print("── dry-run ──────────────────────────────")
    r = run_case(["530:error code: 1033"], args=("--dry-run",))
    check("dry-run → 不调 launchctl", r["calls"] == "", r["calls"])
    check("dry-run → 日志写明本该做什么", "dry-run" in r["log"], r["log"])

    print("── 重建没成功 ───────────────────────────")
    r = run_case(["530:error code: 1033"], launchctl_rc=1)
    check("kickstart 被拒 → 退出 1", r["rc"] == 1, f'rc={r["rc"]}')
    check("kickstart 被拒 → 日志给出人工命令", "重建失败" in r["log"], r["log"])

    r = run_case(["530:error code: 1033", "530:error code: 1033"])
    check("重建后仍 1033 → 退出 1（不谎报成功）", r["rc"] == 1, f'rc={r["rc"]}')
    check("重建后仍 1033 → 心跳如实写", "仍" in r["beat"], r["beat"])

    print("── --install 生成的 plist ───────────────")
    with tempfile.TemporaryDirectory() as td:
        plist = Path(td) / "com.chenhunxian.us-movers-watchdog.plist"
        env = os.environ.copy()
        env["WATCHDOG_PLIST"] = str(plist)
        env["WATCHDOG_INTERVAL"] = "300"
        p = subprocess.run(["bash", str(SCRIPT), "--install"], env=env,
                           capture_output=True, text=True, timeout=30)
        text = plist.read_text(encoding="utf-8") if plist.exists() else ""
        # 断言"没有某个键"之前**必须先剔掉 XML 注释** —— 注释里正大光明写着
        # "故意不写 KeepAlive"，不剔就会把注释当成代码去守（本项目 2026-10-08 踩过同款）。
        body = re.sub(r"<!--.*?-->", "", text, flags=re.S)
        check("--install 写出了 plist", plist.exists(), p.stderr)
        check("plist 带 StartInterval 300",
              "<key>StartInterval</key>" in body and "<integer>300</integer>" in body, body)
        check("plist 不带 KeepAlive（周期任务，不是常驻服务）", "KeepAlive" not in body, body)
        check("plist 指向脚本绝对路径", str(SCRIPT) in body, body)
        check("--install 打印注册命令（launchctl bootstrap）", "launchctl bootstrap" in p.stdout, p.stdout)

    print()
    if failed == 0:
        print(f"\033[32m全部通过 ✓\033[0m（{passed} 项）")
    else:
        print(f"\033[31m有失败项 ✗\033[0m（通过 {passed} / 失败 {failed}）")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
