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
#    注意这里的文件名要和 static/ 下实际的脚本一致：漏一个就等于那个文件
#    的语法错误不会被任何用例挡下（suggest.js 曾经就漏在这张清单外）。
run "语法自检（JS + Python）" bash -c "
  for f in util icons combo suggest shell morning evening; do
    $NODE --check static/\$f.js || exit 1
  done
  $PY -m py_compile server.py screening.py providers.py taxonomy_zh.py symbols.py morning_fetch.py || exit 1
  $PY - <<'EOF' || exit 1
s = open('static/style.css', encoding='utf-8').read()
assert s.count('{') == s.count('}'), 'CSS 花括号不配对'
print('  CSS 花括号 %d/%d 配对' % (s.count('{'), s.count('}')))
EOF
  echo '  7 个 JS + 6 个 Python 文件语法 OK'
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
run "夜盘标签页：点击反馈与跨页记忆" "$NODE" tools/test_evening_tabs.js
run "外壳：轮询调度与页头"           "$NODE" tools/test_polling.js
run "早盘总结页头（daily 模式）"     "$NODE" tools/test_daily_header.js
run "早盘总结标签页记忆"             "$NODE" tools/test_morning_tabs.js
run "后端：夜盘口径（窗口/基准/扫描/冻结）" "$PY" tools/test_night.py

printf '\n'
if [ "$fail" = "0" ]; then
  printf '\033[32m全部通过 ✓\033[0m\n'
else
  printf '\033[31m有失败项 ✗\033[0m\n'
fi
exit "$fail"
