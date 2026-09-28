#!/bin/bash
# 双击即可重启「夜盘异动」看板（服务 + 隧道）。
# 由 open 命令或 Finder 双击触发 —— 走 LaunchServices，不需要"自动化"权限。
#
# 为什么要有这个文件
# ------------------
# 服务是 tools/start.sh 里的 `nohup python3 server.py &` 起的，没有 KeepAlive ——
# 进程一旦退出（kill、崩溃、关机）就不会自己回来，页面直接 502。
# 而"帮你看一下服务在不在"的智能体会话碰不到你的 launchd（`launchctl` 写操作报
# `Bootstrap failed: 5: Input/output error`），osascript 控制 Terminal 也被
# Automation 权限挡（-10004）—— 结果就是：发现服务停了，却没法帮你拉起来。
# 于是留这个双击入口，走 Finder / LaunchServices，绕开上面两条限制。
# 终端用户仍然可以直接 `bash tools/start.sh`，两者等价。
cd "$(dirname "$0")/.." || exit 1
bash tools/start.sh
echo
echo "—— 完成，本窗口可以关闭 ——"
