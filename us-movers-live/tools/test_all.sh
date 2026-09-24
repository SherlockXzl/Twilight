#!/usr/bin/env bash
# 一次跑完所有用例与静态自检。
#
#   bash tools/test_all.sh
#
# 为什么需要它：这几个脚本平时各跑各的，很容易只跑其中一个就以为"没问题"。
# 比如改了 shell.js 的页头，只跑 test_filters.js 是发现不了的。
#
# 退出码 0 = 全部通过。

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

NODE=${NODE:-/Users/xuzhuoli/.workbuddy/binaries/node/versions/22.22.2/bin/node}
PY=${PY:-/Users/xuzhuoli/.workbuddy/binaries/python/versions/3.13.12/bin/python3}

fail=0
run() {
  local name="$1"; shift
  printf '\n\033[1m──── %s ────\033[0m\n' "$name"
  if "$@"; then
    printf '  \033[32m通过\033[0m\n'
  else
    printf '  \033[31m失败\033[0m\n'
    fail=1
  fi
}

# 1) 语法自检 —— 最快的失败点，先跑
run "语法自检（JS + Python + shell）" bash -c "
  # JS 清单也**从文件系统推导**，不手写。
  # 2026-09-24 之前这里是手写的 7 个文件名，新增 modal.js / sharemap.js 时
  # 这两个新文件压根没被检查过 —— 和下面 Python 那处是同一个毛病。
  for f in static/*.js; do
    $NODE --check \"\$f\" || exit 1
  done
  echo \"  JS 语法 OK（\$(ls static/*.js | wc -l | tr -d ' ') 个）\"

  # Python 清单**从文件系统推导**，不手写。
  # 2026-09-23 之前这里是硬编码的 6 个文件名，alpaca/night_fetch/settings
  # 都没被检查 —— 同一个毛病也出现在 Dockerfile 的 COPY 清单上（只在
  # Render 上炸）。硬编码的清单迟早落后于代码，所以改成推导。
  # 排除 build_*.py（一次性的数据快照生成脚本，不进运行时依赖）。
  PYS=\$(ls *.py | grep -v '^build_' | tr '\n' ' ')
  $PY -m py_compile \$PYS || exit 1
  echo \"  Python 语法 OK（\$(echo \$PYS | wc -w | tr -d ' ') 个）：\$PYS\"

  # shell 脚本：语法 + 多字节变量陷阱（macOS bash 3.2 会把中文并进变量名）
  for f in tools/*.sh; do bash -n \"\$f\" || exit 1; done
  $PY tools/lint_shell_vars.py || exit 1

  $PY - <<'EOF' || exit 1
s = open('static/style.css', encoding='utf-8').read()
assert s.count('{') == s.count('}'), 'CSS 花括号不配对'
print('  CSS 花括号 %d/%d 配对' % (s.count('{'), s.count('}')))
EOF
  echo '  JS 语法 + shell 语法 + shell 多字节变量 OK'
"

# 2) 用例
run "筛选与下拉搜索（夜盘 + 早盘）" "$NODE" tools/test_filters.js
run "输入建议下拉（组件）"           "$NODE" tools/test_suggest.js
run "两组标签必须样式可区分"         "$NODE" tools/test_tab_styles.js
run "站点标（logo + 晨昏线）"         "$NODE" tools/test_brand.js
run "早盘异动榜分档筛选"             "$NODE" tools/test_morning_bands.js
run "早盘两列表的排序"               "$NODE" tools/test_morning_order.js
run "关注池自定义增删"               "$NODE" tools/test_morning_watchlist.js
run "美股代码目录（解析 + 排名）"     "$PY"   tools/test_symbols.py
run "早盘全档校验（提前退出 / 阈值 / 缓存）" "$PY" tools/test_wide_scan.py
run "夜盘标签页：点击反馈与跨页记忆" "$NODE" tools/test_evening_tabs.js
run "夜盘 A 股映射（列 · 弹窗内容 · 组件）" "$NODE" tools/test_sharemap.js
run "驱动原因 / A 股映射（字段透传）" "$PY"   tools/test_reasons.py
run "外壳：轮询调度与页头"           "$NODE" tools/test_polling.js
run "早盘总结页头（daily 模式）"     "$NODE" tools/test_daily_header.js
run "早盘总结标签页记忆"             "$NODE" tools/test_morning_tabs.js
run "后端：夜盘口径（窗口/基准/扫描/冻结）" "$PY" tools/test_night.py
run "固定链接：命名隧道配置（config.yml + plist）" "$PY" tools/test_tunnel.py

printf '\n'
if [ "$fail" = "0" ]; then
  printf '\033[32m全部通过 ✓\033[0m\n'
else
  printf '\033[31m有失败项 ✗\033[0m\n'
fi
exit "$fail"
