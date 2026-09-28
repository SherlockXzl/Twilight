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
#
# ⚠️ 2026-09-28 修：「重启」必须带 --restart
# ------------------------------------------
# 这个文件以前只有一句 `bash tools/start.sh`，而 start.sh 是**幂等启动**：
# 端口活着就打印"已经在运行，跳过"。于是服务在跑的时候双击它，**什么都不会发生** ——
# 名字叫 restart，行为是 start，改了 server.py 永远加载不进去。
# （那天 /api/us-business-map 换了响应结构，服务从早上跑到下午一直是旧代码，
# 页面表现为"所有按钮变灰、点开说没有映射数据"，就是这么来的。）
# --restart 会先停掉旧进程、等端口释放，再用当前代码起。
cd "$(dirname "$0")/.." || exit 1
bash tools/start.sh --restart
echo
echo "—— 完成，本窗口可以关闭 ——"
