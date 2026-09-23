#!/usr/bin/env python3
"""命名隧道配置脚本的用例（tools/tunnel-setup.sh）。

    python3 tools/test_tunnel.py

这里**不碰真实 Cloudflare**：把 HOME 指向临时目录、把 CLOUDFLARED 指向一个桩程序，
就能在本地验证脚本真正产出的东西对不对 —— 也就是 config.yml 和 launchd plist。

为什么值得测这两份文件：
  · config.yml 的 ingress **最后一条必须是兜底规则**，否则 cloudflared 直接
    拒绝启动；写错顺序的表现是"隧道起不来"，日志还不一定直说原因。
  · plist 里的参数顺序错了（`--config` 必须在外层、`run` 在后面）就静默不生效，
    表现为"地址能解析但 502"。
  · 这两份文件都是 heredoc 拼出来的，变量没展开、多打一个引号都不会报错 ——
    只有把它们读回来断言才看得见。
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "tools" / "tunnel-setup.sh"
HOST = "movers.example.com"
TUNNEL_ID = "11111111-2222-3333-4444-555555555555"

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
            print(f"      {detail}")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


STUB = r"""#!/bin/bash
# cloudflared 桩：只实现 tunnel-setup.sh 用到的三个子命令。
set -u
case "$*" in
  "tunnel list --output json")
    if [ -f "$STUB_STATE" ]; then
      printf '[{"id":"%s","name":"chenhunxian-movers"}]' "$STUB_TUNNEL_ID"
    else
      printf '[]'
    fi
    ;;
  "tunnel create "*)
    : > "$STUB_STATE"
    mkdir -p "$STUB_CF_DIR"
    printf '{}' > "$STUB_CF_DIR/$STUB_TUNNEL_ID.json"
    printf 'Created tunnel chenhunxian-movers with id %s\n' "$STUB_TUNNEL_ID"
    ;;
  "tunnel route dns "*)
    # 第二次调用模拟"记录已存在"——这正是重跑脚本时会遇到的真实情况，
    # 脚本必须把它当作幂等成功而不是报错退出。
    N=$(cat "$STUB_ROUTE_COUNT" 2>/dev/null || echo 0)
    N=$((N + 1))
    printf '%s' "$N" > "$STUB_ROUTE_COUNT"
    if [ "$N" -gt 1 ]; then
      printf 'Failed to add route: record with that host already exists\n' >&2
      exit 1
    fi
    printf 'Added CNAME %s\n' "$*"
    ;;
  *)
    printf 'stub 不认识这个调用：%s\n' "$*" >&2
    exit 2
    ;;
esac
"""


def run_setup(tmp: Path, port: int, args: list[str], *, cert: bool = True,
              stub_state_ready: bool = False) -> subprocess.CompletedProcess:
    cf_dir = tmp / ".cloudflared"
    if cert:
        cf_dir.mkdir(parents=True, exist_ok=True)
        (cf_dir / "cert.pem").write_text("-----BEGIN CERTIFICATE-----\nstub\n")
    if stub_state_ready:
        (tmp / "state").write_text("x")

    stub_bin = tmp / "bin" / "cloudflared"
    stub_bin.parent.mkdir(parents=True, exist_ok=True)
    stub_bin.write_text(STUB)
    stub_bin.chmod(0o755)

    env = {
        **os.environ,
        "HOME": str(tmp),
        "CLOUDFLARED": str(stub_bin),
        "CF_DIR": str(cf_dir),
        "PLIST": str(tmp / "tunnel.plist"),
        "LOCAL_PORT": str(port),
        "SKIP_SYSTEM": "1",
        "STUB_STATE": str(tmp / "state"),
        "STUB_ROUTE_COUNT": str(tmp / "route-count"),
        "STUB_CF_DIR": str(cf_dir),
        "STUB_TUNNEL_ID": TUNNEL_ID,
    }
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=60,
    )


def main() -> int:
    # ── 起一个哑服务，让脚本的"本地服务在不在"这一步通过 ──
    port = free_port()
    srv = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.2)

    try:
        # ── 1. 参数校验 ──
        print("\n参数校验")
        with tempfile.TemporaryDirectory() as d:
            r = run_setup(Path(d), port, [])
            check("无参数 → 退出码 1", r.returncode == 1, f"实际 {r.returncode}")
            check("无参数 → 打印用法", "用法：" in r.stdout)
            check("无参数 → 提到域名注册入口",
                  "domains.cloudflare.com" in r.stdout)

        with tempfile.TemporaryDirectory() as d:
            r = run_setup(Path(d), port, ["notadomain"])
            check("非完整域名 → 退出码 1", r.returncode == 1, f"实际 {r.returncode}")
            check("非完整域名 → 提示要完整域名", "完整域名" in r.stdout)
            # 这条同时是**多字节变量陷阱**的回归：早先写成 $HOST」
            # 会被 bash 3.2 解析成变量 HOST<乱码>，报 unbound variable。
            check("非完整域名 → 没有 unbound variable",
                  "unbound variable" not in (r.stdout + r.stderr),
                  (r.stdout + r.stderr)[:200])

        # ── 2. 未登录 Cloudflare ──
        print("\n未登录 Cloudflare")
        with tempfile.TemporaryDirectory() as d:
            r = run_setup(Path(d), port, [HOST], cert=False)
            check("缺 cert.pem → 退出码 1", r.returncode == 1, f"实际 {r.returncode}")
            check("缺 cert.pem → 提示先跑 tunnel login",
                  "tunnel login" in r.stdout)
            check("缺 cert.pem → 说明域名要先加进账号",
                  "Add a site" in r.stdout)

        # ── 3. 正常路径（首次创建） ──
        print("\n正常路径：首次创建")
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            r = run_setup(tmp, port, [f"https://{HOST}/"])  # 顺带验证能容忍带协议和斜杠
            out = r.stdout + r.stderr
            check("退出码 0", r.returncode == 0, out[-500:])
            check("建了隧道", "已创建" in r.stdout)

            cfg = tmp / ".cloudflared" / "config.yml"
            check("生成 config.yml", cfg.exists())
            if cfg.exists():
                text = cfg.read_text()
                check("config.yml 隧道 id 正确",
                      f"tunnel: {TUNNEL_ID}" in text, text[:300])
                check("config.yml 凭证路径正确",
                      f"{tmp}/.cloudflared/{TUNNEL_ID}.json" in text)
                check("config.yml hostname 正确（去掉了 https:// 与斜杠）",
                      f"hostname: {HOST}" in text, text[:300])
                check("config.yml 回源端口正确",
                      f"service: http://127.0.0.1:{port}" in text)
                check("config.yml 固定了 metrics 端口（share-url.sh 依赖它）",
                      "metrics: 127.0.0.1:20241" in text)

                # ingress 顺序：hostname 规则在前，兜底 404 必须在最后一条。
                lines = [l.strip() for l in text.splitlines()]
                idx_host = next((i for i, l in enumerate(lines)
                                 if l.startswith("- hostname:")), -1)
                idx_catch = next((i for i, l in enumerate(lines)
                                  if l == "- service: http_status:404"), -1)
                check("ingress 有 hostname 规则", idx_host >= 0)
                check("ingress 有兜底 http_status:404", idx_catch >= 0)
                check("兜底规则在最后（否则 cloudflared 拒绝启动）",
                      idx_catch > idx_host, f"hostname@{idx_host} catchall@{idx_catch}")
                check("config.yml 权限 600",
                      oct(cfg.stat().st_mode)[-3:] == "600",
                      oct(cfg.stat().st_mode)[-3:])

            plist = tmp / "tunnel.plist"
            check("生成 launchd plist", plist.exists())
            if plist.exists():
                p = plist.read_text()
                check("plist 指向 cloudflared 桩", "cloudflared" in p)
                # 参数顺序：`tunnel --config <path> --no-autoupdate run <name>`
                for frag in ["<string>tunnel</string>",
                             "<string>--config</string>",
                             f"<string>{tmp}/.cloudflared/config.yml</string>",
                             "<string>--no-autoupdate</string>",
                             "<string>run</string>",
                             "<string>chenhunxian-movers</string>"]:
                    check(f"plist 含 {frag.removeprefix('<string>').removesuffix('</string>')}",
                          frag in p, p[:600])
                check("plist --config 在 run 之前", p.index("--config") < p.index("<string>run</string>"))
                check("plist 有 RunAtLoad", "<key>RunAtLoad</key>" in p)
                check("plist 有 KeepAlive", "<key>KeepAlive</key>" in p)
                if shutil.which("plutil"):
                    lint = subprocess.run(["plutil", "-lint", str(plist)],
                                          capture_output=True, text=True)
                    check("plist 能被 plutil 通过", lint.returncode == 0,
                          lint.stdout + lint.stderr)

        # ── 4. 幂等：隧道已存在 + DNS 记录已存在 ──
        print("\n幂等重跑")
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            first = run_setup(tmp, port, [HOST])
            check("首次跑通", first.returncode == 0, first.stdout[-300:])
            second = run_setup(tmp, port, [HOST], stub_state_ready=True)
            check("重跑仍退出码 0", second.returncode == 0,
                  (second.stdout + second.stderr)[-400:])
            check("重跑识别出隧道已存在并复用", "复用" in second.stdout)
            check("重跑把 DNS『已存在』当成功而不是报错",
                  "DNS 记录已存在" in second.stdout, second.stdout[-300:])
            check("重跑不再调用 create", "已创建" not in second.stdout)
    finally:
        srv.terminate()
        srv.wait(timeout=10)

    print(f"\n通过 {passed}，失败 {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
